// Runs the traffic simulation for game.html: one weekday at a time, on a road network
// the player edits while it runs. Times here are sim seconds; the game clock is
// STRETCH × faster (see time.mjs).
// Two models: "queues" (sim/core.mjs, default; cars are drawn by positions.mjs chasing the
// queue model's spots) and "lanes" (sim/micro.mjs — every car has a place on a lane, and that
// is what's drawn; game.html?sim=lanes).
import { Network, Simulation, scaleTrips } from "../sim/core.mjs";
import { MicroSim, microCarInfo } from "../sim/micro.mjs";
import { applyPatch, twinIndex, shapeOf, pointAt, laneOffset, touchesRoads } from "./network.mjs";
import { CarDisplay } from "./positions.mjs";
import { TIME, gameTrips, simOptions, clockToSim } from "./time.mjs";

const JAM_WINDOW = 15, JAM_SAMPLE_SEC = clockToSim(60); // road colours: rolling 15-game-minute average

let graph, demand, calibration, baseline, net, sim, trips, zoneWeight, lanes = true;
let shapes = [], twin;
const display = new CarDisplay(); // where to draw each car (see positions.mjs)
let demolished = [], cancelledBy = new Map(); // building id → trip indices it cancelled today
let sample = null; // stats at the last baseline sample time, so the HUD compares like with like
let speed = clockToSim(3600) / TIME.realSecPerGameHour, playing = false, simClock = 0, lastReal = 0, lastCongestion = 0, timer = null, skipTarget = null, dayOver = false;
let jamR, jamOcc, jamSlot = 0, jamFilled = 0;

const load = async (area, suffix) => {
  const res = await fetch(`../data/${area}${suffix}.json`);
  return res.ok ? res.json() : null;
};

function rebuildShapes(from = 0) {
  twin = twinIndex(graph);
  for (let e = from; e < graph.edges.length; e++) shapes[e] = shapeOf(graph.edges[e].geom);
  display.setNetwork(graph, shapes, twin);
}

// --- Congestion colours ---------------------------------------------------------------
function resetJam() {
  jamR = Array.from({ length: JAM_WINDOW }, () => new Float32Array(net.E));
  jamOcc = Array.from({ length: JAM_WINDOW }, () => new Uint8Array(net.E));
  jamSlot = jamFilled = 0;
  sampleJam();
}
function growJam() {
  const grow = (a) => { const b = new a.constructor(net.E); b.set(a.subarray(0, Math.min(a.length, net.E))); return b; };
  jamR = jamR.map(grow); jamOcc = jamOcc.map(grow);
}
function sampleJam() {
  const r = sim.congestion(jamR[jamSlot]), occ = jamOcc[jamSlot];
  if (lanes) for (let e = 0; e < net.E; e++) { occ[e] = r[e] >= 0; if (r[e] < 0) r[e] = 1; } // lane model: −1 = no car
  else for (let e = 0; e < net.E; e++) occ[e] = sim.count[e] > 0;
  jamSlot = (jamSlot + 1) % JAM_WINDOW;
  jamFilled = Math.min(JAM_WINDOW, jamFilled + 1);
}
function averagedCongestion() { // -1 = no car on the road for the whole window
  const c = new Float32Array(net.E), seen = new Uint8Array(net.E);
  for (let k = 0; k < jamFilled; k++) {
    const r = jamR[k], occ = jamOcc[k];
    for (let e = 0; e < net.E; e++) { c[e] += r[e]; seen[e] |= occ[e]; }
  }
  for (let e = 0; e < net.E; e++) c[e] = seen[e] ? c[e] / jamFilled : -1;
  return c;
}

// --- Demolitions remove the trips their homes and jobs made ---------------------------
// Demand is aggregated per road node, so a building takes away its share of that node's
// trips (its homes + jobs over the node's total), chosen with a fixed per-building seed.
function cancelTrips(b, fromTrip) {
  const total = zoneWeight.get(b.node);
  if (!total || b.node < 0) return 0;
  const share = Math.min(1, (b.homes + b.jobs) / total);
  let s = (b.id * 2654435761) >>> 0 || 1, n = 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const mine = [];
  for (let v = fromTrip; v < trips.length; v++) {
    const t = trips[v];
    if ((t[0] === b.node || t[1] === b.node) && rand() < share && !sim.cancelled[v]) { sim.cancelled[v] = 1; mine.push(v); n++; }
  }
  cancelledBy.set(b.id, mine);
  // the building's demand is gone from the node too, so later buildings there get a fair share
  zoneWeight.set(b.node, Math.max(0, total - b.homes - b.jobs));
  return n;
}

// Undoing a demolition: trips that haven't set off yet happen again
function restoreTrips(b) {
  for (const v of cancelledBy.get(b.id) ?? []) if (v >= sim.nextTrip) sim.cancelled[v] = 0;
  cancelledBy.delete(b.id);
  if (b.node >= 0) zoneWeight.set(b.node, (zoneWeight.get(b.node) ?? 0) + b.homes + b.jobs);
}
const demolishedAfter = (patches) => {
  const out = new Map();
  for (const p of patches) { for (const b of p.demolish ?? []) out.set(b.id, b); for (const b of p.restore ?? []) out.delete(b.id); }
  return [...out.values()];
};

// --- Frames -----------------------------------------------------------------------------
function postFrame(withCongestion) {
  // lane model: the sim is at or just behind the clock; cars glide on by their speed
  const at = lanes ? simClock : Math.min(sim.t - 1, Math.max(sim.t - 2, simClock));
  const { pos, head, ids } = lanes ? sim.positions(Math.max(0, Math.min(sim.o.dt, simClock - sim.t))) : display.frame(sim, at);
  const msg = { type: "frame", at, stats: sim.stats(), sample, pos, head, ids, done: dayOver };
  const transfer = [pos.buffer, head.buffer, ids.buffer];
  if (withCongestion) { msg.congestion = averagedCongestion(); transfer.push(msg.congestion.buffer); }
  postMessage(msg, transfer);
}

// One car's trip, for the "follow" card: where it's going, how it's doing, the road ahead
function carInfo(v) {
  if (lanes) return microCarInfo(sim, v);
  const t = trips[v];
  if (!t) return { id: v, gone: true };
  const base = { id: v, purpose: t[3], from: t[0], to: t[1], depart: t[2] };
  const route = sim.vRoute[v];
  if (!route) return { ...base, arrived: sim.nextTrip > v };
  const pos = sim.vPos[v];
  let passedFree = 0;
  for (let k = 0; k < pos; k++) passedFree += net.freeTime[route[k]];
  passedFree += Math.min(sim.t - sim.vEnter[v], net.freeTime[route[pos]]);
  return { ...base, onRoad: sim.t - sim.vDepart[v], delay: Math.max(0, sim.t - sim.vDepart[v] - passedFree), freeTotal: sim.vFreeTime[v], edge: route[pos], ahead: Array.prototype.slice.call(route, pos) };
}

function loop() {
  timer = null;
  if (!sim || (!playing && skipTarget === null) || dayOver) return; // nothing to run until init is done
  const now = performance.now();
  const ahead = lanes ? -sim.o.dt : 1; // the queue model runs a step ahead of what's drawn
  if (skipTarget !== null) {
    simClock = skipTarget;
    if (sim.t >= skipTarget + Math.min(0, ahead) || sim.done) { skipTarget = null; simClock = Math.max(simClock, sim.t); postMessage({ type: "skipped" }); }
  } else simClock += ((now - lastReal) / 1000) * speed;
  lastReal = now;
  const budgetEnd = now + (skipTarget !== null ? 200 : 30);
  while (sim.t < simClock + ahead + (lanes ? 1e-9 : 0) && performance.now() < budgetEnd && !sim.done && sim.t < sim.o.maxSimSec) {
    sim.step(1);
    if (sim.t % JAM_SAMPLE_SEC === 0) sampleJam();
    if (baseline && sim.t % baseline.every === 0) sample = sim.stats(true);
  }
  if (sim.t < simClock - speed) simClock = sim.t; // can't keep up: don't build a backlog
  const withCongestion = now - lastCongestion > 250;
  if (withCongestion) lastCongestion = now;
  if (sim.done || sim.t >= sim.o.maxSimSec) {
    dayOver = true; playing = false; skipTarget = null;
    postFrame(true);
    postMessage({ type: "dayEnd", stats: sim.stats(true) });
    return;
  }
  postFrame(withCongestion);
  timer = setTimeout(loop, skipTarget !== null ? 0 : 16);
}

function newDay() {
  zoneWeight = new Map();
  for (const [n, w] of [...demand.zones.homes, ...demand.zones.jobs]) zoneWeight.set(n, (zoneWeight.get(n) ?? 0) + w);
  sim = lanes ? new MicroSim(graph, trips, simOptions()) : new Simulation(net, trips, simOptions());
  if (lanes) net = sim.net;
  sample = null;
  display.reset(trips.length);
  cancelledBy = new Map();
  for (const b of demolished) cancelTrips(b, 0);
  simClock = 0; lastCongestion = 0; dayOver = false; skipTarget = null;
  resetJam();
  postFrame(true);
}

function patch(p) {
  const firstNew = graph.edges.length;
  applyPatch(graph, p);
  if (touchesRoads(p)) {
    rebuildShapes(firstNew);
    let rerouted;
    if (lanes) { rerouted = sim.setNetwork(graph); net = sim.net; }
    else { net = new Network(graph); rerouted = sim.applyNetwork(net); }
    growJam();
    postMessage({ type: "patched", rerouted });
  }
  for (const b of p.demolish ?? []) {
    demolished.push(b);
    postMessage({ type: "demolished", id: b.id, trips: cancelTrips(b, sim.nextTrip) });
  }
  for (const b of p.restore ?? []) {
    demolished = demolished.filter((d) => d.id !== b.id);
    restoreTrips(b);
  }
}

onmessage = async ({ data: msg }) => {
  if (msg.cmd === "init") {
    lanes = msg.model === "lanes";
    [graph, demand, calibration, baseline] = await Promise.all(
      [".graph", ".demand", ".calibration", lanes ? ".baseline-lanes" : ".baseline"].map((s) => load(msg.area, s)));
    trips = gameTrips(scaleTrips(demand.trips, calibration?.perTrip ?? null), lanes ? TIME.lanesDemandBoost : TIME.demandBoost);
    if (baseline?.stretch !== TIME.stretch) console.warn(`baseline was made for stretch ${baseline?.stretch}, game uses ${TIME.stretch}: run node scripts/baseline.mjs`);
    for (const p of msg.patches ?? []) applyPatch(graph, p);
    demolished = demolishedAfter(msg.patches ?? []);
    rebuildShapes();
    net = new Network(graph);
    postMessage({ type: "ready", area: graph.area, baseline, trips: trips.length, model: lanes ? "lanes" : "queues" });
    const pendingSkip = skipTarget; // asked to run while still loading
    newDay();
    skipTarget = pendingSkip;
    if (playing || skipTarget !== null) loop();
  } else if (msg.cmd === "play") {
    if (dayOver) return;
    playing = true; lastReal = performance.now();
    if (!timer) loop();
  } else if (msg.cmd === "pause") {
    playing = false;
  } else if (msg.cmd === "skipTo") {
    skipTarget = msg.t;
    if (!timer) loop();
  } else if (msg.cmd === "speed") {
    speed = msg.speed;
  } else if (msg.cmd === "patch") {
    patch(msg.patch);
    if (!playing) postFrame(true);
  } else if (msg.cmd === "smoothing") { // tuning from the console
    display.smoothing = msg.on ?? display.smoothing;
    Object.assign(display.p, msg.params ?? {});
  } else if (msg.cmd === "car") {
    if (sim) postMessage({ type: "car", car: carInfo(msg.id) });
  } else if (msg.cmd === "newDay") {
    playing = false; newDay();
  }
};
