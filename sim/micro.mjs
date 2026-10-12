// Lane-level microscopic traffic: every car has a place on a lane, a speed, and the car in
// front of it. What the game draws is exactly where the sim has each car.
//
// Network (from the same graph the game edits):
//   - Links: chains of graph edges between real junctions. Where OSM merely cut a road in
//     two (a node with nothing to turn into, same lanes on both sides) the pieces are glued
//     into one lane, so cars never see those cuts. Routes and demand stay on graph edges:
//     a car on a link knows which of its edges it is on (for costs, colours and the HUD).
//   - Each link has its own lanes (0 = kerb side, UK). At a link's end lanes are trimmed back
//     from real junctions and joined by connector lanes: left turns from the kerb lane, right
//     turns from the offside lane, straight on from any (UK lane use).
//   - Connectors of one junction that cross, pass within a car's width or merge into the same
//     lane conflict; the conflict point is known along both.
// Movement:
//   - Cars follow the car ahead with IDM (Treiber), choose lanes up to 400 m ahead for their
//     turns, pass slow queues, and cross junctions on connectors.
//   - A car may enter a junction once it has booked its connector: room beyond the junction
//     for it (don't block the box), every conflict point free when it gets there, and no car
//     from a bigger road arriving at that point about then. Long waits skip the rank rule;
//     a car stuck very long goes anyway (breaks rare circular waits).
//   - Routes: A* on graph edges (core Router) with travel times measured from car speeds.
import { Network, Router, ROAD_CLASS } from "./core.mjs";
import { offsetLine, shapeOf, pointAt, laneOffset } from "../game/network.mjs";

export const MICRO = {
  dt: 0.5,            // s per step
  carLen: 4.5, s0: 1.5, T: 1.0, a: 2.0, b: 2.5, // IDM, dense urban driving (calibrated 2026-10-07)
  turnSpeed: 7,       // m/s through a turning connector
  trim: 6,            // m lanes stop short of a real junction
  yieldT: 3,          // s: a higher-rank car this close to the conflict point has priority
  margin: 0.5,        // s between two cars at a conflict point
  forceAfter: 8,      // s waiting at the line: ignore rank, then even the wrong lane
  releaseAfter: 6,    // s stopped with a booking it can't use: give it back
  squeezeAfter: 20,   // s stuck at the line: go anyway
  teleportAfter: 90,  // s stuck: move on along the route to where there's room (as SUMO does) —
                      // the only cure for circular waits round gyratories and blocks
  costUpdateSec: 30,
  maxSimSec: 30 * 3600,
  suppressDelayRatio: 3, suppressMinDelaySec: 20 * 60,
};

const RANK = { motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, unclassified: 4, residential: 3, living_street: 2, service: 1 };
const base = (hw) => hw.replace("_link", "");
const rankOf = (hw) => RANK[base(hw)] ?? 1;
const speedShare = (hw) => (ROAD_CLASS[base(hw)] ?? ROAD_CLASS.service).speed;
const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
const key = (a, b) => a * 65536 + b;

// ------------------------------------------------------------------ lane network
export function buildLanes(graph, o = MICRO) {
  const N = graph.nodes.length, E = graph.edges.length, edges = graph.edges;
  const inE = Array.from({ length: N }, () => []), outE = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => { if (!e.dead) { outE[e.from].push(i); inE[e.to].push(i); } });
  const neigh = new Int32Array(N);
  for (let v = 0; v < N; v++) {
    const s = new Set();
    for (const i of inE[v]) s.add(edges[i].from);
    for (const i of outE[v]) s.add(edges[i].to);
    neigh[v] = s.size;
  }
  const isJunction = (v) => neigh[v] >= 3;
  const twinKey = new Set();
  edges.forEach((e) => { if (!e.dead) twinKey.add(`${e.wayId}:${e.from}:${e.to}`); });
  const hasTwin = (i) => { const e = edges[i]; return twinKey.has(`${e.wayId}:${e.to}:${e.from}`); }; // i: edge index
  const lanesOf = (e) => Math.max(1, Math.round(edges[e].lanes));
  const notUturn = (a, b) => !(edges[b].to === edges[a].from && edges[b].wayId === edges[a].wayId);

  // --- links: glue a → b at node v when v is a plain cut: not a junction, b is the only way
  // on from a, a the only way into b, and both have the same lanes and two-way-ness
  const nextOf = new Int32Array(E).fill(-1), prevOf = new Int32Array(E).fill(-1);
  for (let v = 0; v < N; v++) {
    if (isJunction(v)) continue;
    for (const a of inE[v]) {
      const outs = outE[v].filter((b) => notUturn(a, b)), ins = outs.length === 1 ? inE[v].filter((x) => notUturn(x, outs[0])) : [];
      if (outs.length !== 1 || ins.length !== 1) continue;
      const b = outs[0];
      if (o.glue === false || lanesOf(a) !== lanesOf(b) || hasTwin(a) !== hasTwin(b) || a === b) continue;
      nextOf[a] = b; prevOf[b] = a;
    }
  }
  const linkOf = new Int32Array(E).fill(-1), idxInLink = new Int32Array(E), offOf = new Float64Array(E), endOf = new Float64Array(E);
  const links = [];
  const makeLink = (first) => {
    const chain = [];
    for (let e = first; e >= 0 && linkOf[e] < 0; e = nextOf[e]) { linkOf[e] = links.length; chain.push(e); }
    links.push({ edges: chain });
  };
  edges.forEach((e, i) => { if (!e.dead && prevOf[i] < 0) makeLink(i); });
  edges.forEach((e, i) => { if (!e.dead && linkOf[i] < 0) makeLink(i); }); // loops with no start

  // --- road lanes, one set per link
  const L = { len: [], v0: [], link: [], idx: [], conn: [], inLane: [], outLane: [], node: [], rank: [], geom: [], hIn: [], hOut: [] };
  const endPt = [], startPt = [], endDir = [], startDir = [];
  for (const [li, lk] of links.entries()) {
    const es = lk.edges, first = edges[es[0]], last = edges[es.at(-1)], nl = lanesOf(es[0]);
    let simLen = 0;
    const geom = [];
    for (const e of es) { simLen += edges[e].length; for (const p of edges[e].geom) if (!geom.length || geom.at(-1)[0] !== p[0] || geom.at(-1)[1] !== p[1]) geom.push(p); }
    const glen = polyLen(geom), k = glen / Math.max(1, simLen);
    const t0 = isJunction(first.from) ? Math.min(o.trim, 0.3 * edges[es[0]].length) : 0;
    const t1 = isJunction(last.to) ? Math.min(o.trim, 0.3 * edges[es.at(-1)].length) : 0;
    let acc = -t0;
    es.forEach((e, j) => { idxInLink[e] = j; offOf[e] = Math.max(0, acc); acc += edges[e].length; endOf[e] = Math.max(0, acc); });
    const len = Math.max(1, simLen - t0 - t1);
    endOf[es.at(-1)] = len;
    Object.assign(lk, { nl, len, laneBase: L.len.length, from: first.from, to: last.to });
    const v0 = Math.max(2, (first.speedKmh / 3.6) * speedShare(first.highway));
    for (let j = 0; j < nl; j++) {
      const lg = cut(offsetLine(geom, laneOffset(nl, nl - 1 - j, hasTwin(es[0]))), t0 * k, glen - t1 * k);
      const id = L.len.length;
      L.len.push(len); L.v0.push(v0); L.link.push(li); L.idx.push(j); L.conn.push(0);
      L.inLane.push(-1); L.outLane.push(-1); L.node.push(-1); L.rank.push(rankOf(first.highway));
      L.geom.push(lg); L.hIn.push(NaN); L.hOut.push(NaN);
      endPt[id] = lg.at(-1); startPt[id] = lg[0];
      endDir[id] = endHeading(lg, -1); startDir[id] = endHeading(lg, 1);
    }
  }
  const roadLanes = L.len.length;

  // --- movements and connectors at link ends
  const moveRange = new Map();  // key(last edge of a link, first edge of the next) → [lo, hi] lanes allowed
  const connOf = new Map();     // key(lane, next edge) → connector lane
  const nodeConns = new Map();  // node → connector lanes
  for (const lk of links) {
    const a = lk.edges.at(-1), v = lk.to, ea = edges[a], ga = ea.geom, dIn = unit(ga[ga.length - 2], ga[ga.length - 1]);
    let outs = outE[v].filter((b) => notUturn(a, b));
    if (!outs.length) outs = outE[v].slice(); // dead end: turn round
    const M = outs.length, nl = lk.nl;
    for (const b of outs) {
      const gb = edges[b].geom, dOut = unit(gb[0], gb[1]), lb = links[linkOf[b]];
      const turn = Math.atan2(dIn[0] * dOut[1] - dIn[1] * dOut[0], dIn[0] * dOut[0] + dIn[1] * dOut[1]);
      // UK lane use: left turns from the kerb lane, right turns from the offside lane, straight from any
      const kind = M === 1 ? "S" : turn < -0.5 ? "L" : turn > 0.5 ? "R" : "S";
      const lo = kind === "R" ? nl - 1 : 0, hi = kind === "L" ? 0 : nl - 1;
      moveRange.set(key(a, b), [lo, hi]);
      for (let j = lo; j <= hi; j++) {
        const tj = kind === "L" ? 0 : kind === "R" ? lb.nl - 1 : Math.min(lb.nl - 1, j);
        const li = lk.laneBase + j, lo2 = lb.laneBase + tj, p = endPt[li], q = startPt[lo2];
        const gap = Math.hypot(q[0] - p[0], q[1] - p[1]);
        // ends meet, or the lanes overlap round the inside of a bend (the exit starts behind
        // the entry): a short piece the way the car is already heading, never a turn-about
        const behind = (q[0] - p[0]) * endDir[li][0] + (q[1] - p[1]) * endDir[li][1] < 0;
        const geom = gap < 0.5 || behind
          ? [p, [p[0] + endDir[li][0] * 0.5, p[1] + endDir[li][1] * 0.5]]
          : turnCurve(p, endDir[li], q, startDir[lo2]);
        const id = L.len.length;
        L.len.push(Math.max(1, polyLen(geom)));
        L.v0.push(Math.abs(turn) > 0.5 ? o.turnSpeed : Math.min(L.v0[li], L.v0[lo2]));
        L.link.push(-1); L.idx.push(0); L.conn.push(1); L.inLane.push(li); L.outLane.push(lo2); L.node.push(v);
        L.rank.push(rankOf(ea.highway) + (Math.abs(turn) < 0.5 ? 0.5 : 0));
        L.geom.push(geom);
        // headings of the lanes it joins: a near-straight connector is drawn as a lane shift
        L.hIn.push(Math.atan2(endDir[li][1], endDir[li][0])); L.hOut.push(Math.atan2(startDir[lo2][1], startDir[lo2][0]));
        connOf.set(key(li, b), id);
        (nodeConns.get(v) ?? nodeConns.set(v, []).get(v)).push(id);
      }
    }
  }

  // --- conflicts at real junctions, with where along both paths they happen
  const conflicts = Array.from({ length: L.len.length }, () => []);
  const conflictS = Array.from({ length: L.len.length }, () => []), conflictSo = Array.from({ length: L.len.length }, () => []);
  const add = (c1, c2, s1, s2) => { conflicts[c1].push(c2); conflictS[c1].push(s1); conflictSo[c1].push(s2); conflicts[c2].push(c1); conflictS[c2].push(s2); conflictSo[c2].push(s1); };
  for (const [v, list] of nodeConns) {
    const junction = isJunction(v);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const c1 = list[i], c2 = list[j];
      if (!junction) { // a lane drop: two lanes into one take turns
        if (L.outLane[c1] === L.outLane[c2]) add(c1, c2, L.len[c1], L.len[c2]);
        continue;
      }
      if (L.link[L.inLane[c1]] === L.link[L.inLane[c2]]) continue; // same approach: one after another
      if (L.outLane[c1] === L.outLane[c2]) { add(c1, c2, L.len[c1], L.len[c2]); continue; } // merge
      if (L.link[L.outLane[c1]] === L.link[L.outLane[c2]]) continue; // side by side into one road
      const m = meet(L.geom[c1], L.geom[c2], 2.2);
      if (m) add(c1, c2, (m[0] * L.len[c1]) / Math.max(1e-6, polyLen(L.geom[c1])), (m[1] * L.len[c2]) / Math.max(1e-6, polyLen(L.geom[c2])));
    }
  }
  return {
    nLanes: L.len.length, roadLanes, links, linkOf, idxInLink, offOf, endOf, moveRange, connOf, conflicts, conflictS, conflictSo,
    len: Float64Array.from(L.len), v0: Float64Array.from(L.v0), link: Int32Array.from(L.link), idx: Int32Array.from(L.idx),
    isConn: Uint8Array.from(L.conn), inLane: Int32Array.from(L.inLane), outLane: Int32Array.from(L.outLane),
    node: Int32Array.from(L.node), rank: Float64Array.from(L.rank), geom: L.geom, hIn: Float64Array.from(L.hIn), hOut: Float64Array.from(L.hOut),
    junctions: [...nodeConns.keys()].filter(isJunction).length,
  };
}

// Where c is on its trip, for the "follow" card: same fields as the queue sim's car info
export function microCarInfo(sim, c) {
  const t = sim.trips[c];
  if (!t) return { id: c, gone: true };
  const base = { id: c, purpose: t[3], from: t[0], to: t[1], depart: t[2] };
  const r = sim.route[c];
  if (!r) return { ...base, arrived: sim.nextTrip > c };
  const net = sim.net, L = sim.lanes, p = sim.pos[c], e = r[p];
  let passedFree = 0;
  for (let k = 0; k < p; k++) passedFree += net.freeTime[r[k]];
  if (sim.cLane[c] >= 0 && !L.isConn[sim.cLane[c]]) passedFree += Math.min(1, Math.max(0, sim.s[c] - L.offOf[e]) / Math.max(1, net.length[e])) * net.freeTime[e];
  const onRoad = sim.t - sim.depart[c];
  return { ...base, onRoad, delay: Math.max(0, onRoad - passedFree), freeTotal: sim.free[c], edge: e, ahead: Array.prototype.slice.call(r, p) };
}

// ------------------------------------------------------------------ simulation
export class MicroSim {
  constructor(graph, trips, opts = {}) {
    this.o = { ...MICRO, ...opts };
    this.graph = graph; this.trips = trips;
    const V = trips.length;
    this.cLane = new Int32Array(V).fill(-1); this.s = new Float64Array(V); this.v = new Float64Array(V); this.acc = new Float64Array(V);
    this.ahead = new Int32Array(V).fill(-1); this.behind = new Int32Array(V).fill(-1);
    this.route = new Array(V); this.pos = new Int32Array(V); this.cEnd = new Int32Array(V);
    this.depart = new Float64Array(V); this.free = new Float64Array(V); this.enterT = new Float64Array(V);
    this.wait = new Float64Array(V); this.reserved = new Int32Array(V).fill(-1); this.lcCool = new Float64Array(V);
    this.lcFrom = new Int32Array(V).fill(-1); this.lcT = new Float64Array(V);
    this.squeeze = new Uint8Array(V); // this car may enter the junction without room
    this.cancelled = new Uint8Array(V); // trips that no longer happen (their building was demolished)
    this.pending = [];
    this.t = 0; this.stepNo = 0; this.nextTrip = 0;
    this.onRoad = 0; this.arrived = 0; this.unroutable = 0; this.suppressed = 0; this.removed = 0; this.tripSec = 0; this.freeSec = 0;
    this.forced = 0; this.squeezed = 0; this.teleported = 0;
    this.setNetwork(graph);
  }
  get done() { return this.nextTrip >= this.trips.length && this.onRoad === 0; }
  // full: also count the cars still on their way (time so far, free-flow time of the roads
  // they've done) — scores must not reward a day that leaves more trips unfinished
  stats(full = false) {
    let tripSec = this.tripSec, freeSec = this.freeSec;
    if (full) {
      const ft = this.net.freeTime, add = (c) => { const r = this.route[c]; tripSec += this.t - this.depart[c]; if (r) for (let k = 0; k < this.pos[c]; k++) freeSec += ft[r[k]]; };
      for (const l of this.active) for (let c = this.head[l]; c >= 0; c = this.behind[c]) add(c);
      for (const c of this.pending) add(c);
    }
    return { t: this.t, onRoad: this.onRoad, arrived: this.arrived, departed: this.nextTrip - this.removed, total: this.trips.length - this.removed,
      removed: this.removed, unroutable: this.unroutable, suppressed: this.suppressed, tripSec, freeSec,
      avgTripMin: this.arrived ? this.tripSec / this.arrived / 60 : 0, delayIndex: this.freeSec ? this.tripSec / this.freeSec : 1,
      forced: this.forced, squeezed: this.squeezed, teleported: this.teleported };
  }

  // (Re)build lanes for the graph as it is now; cars on the road keep their road and place
  setNetwork(graph) {
    const old = this.lanes ? { lanes: this.lanes, cars: this.onLanes() } : null;
    this.net = new Network(graph);
    this.router = new Router(this.net);
    this.lanes = buildLanes(graph, this.o);
    this.shapes = null;
    const nL = this.lanes.nLanes;
    this.head = new Int32Array(nL).fill(-1); this.tail = new Int32Array(nL).fill(-1); this.count = new Int32Array(nL);
    this.resv = Array.from({ length: nL }, () => []);
    this.isActive = new Uint8Array(nL); this.active = [];
    // travel times: keep what's been measured on the roads that are still there (resetting
    // them sent every car leaving in the next half minute into the jams)
    const before = this.cost;
    this.cost = Float64Array.from(this.net.freeTime, (t, e) => t * this.net.routePenalty[e]);
    this.freeCost = Float64Array.from(this.cost);
    if (before) for (let e = 0; e < Math.min(before.length, this.cost.length); e++) if (!this.net.dead[e]) this.cost[e] = before[e];
    this.routeCache = new Map(); this.cacheEpoch = -1;
    if (!old) return 0;
    let rerouted = 0;
    const L = this.lanes, net = this.net;
    const laneOn = (edge, j) => { const lk = L.links[L.linkOf[edge]]; return lk ? lk.laneBase + Math.min(lk.nl - 1, j) : -1; };
    // the rest of a route uses a removed road: reroute from the end of the road it is on
    const fix = (c, p) => {
      const r = this.route[c];
      let broken = false;
      for (let q = p + 1; q < r.length && !broken; q++) broken = net.dead[r[q]] === 1;
      if (!broken) return false;
      const e = r[p], rest = this.router.route(net.to[e], this.trips[c][1], this.cost);
      this.route[c] = Int32Array.from([e, ...(rest ?? [])]); this.pos[c] = 0;
      return true;
    };
    for (const c of this.pending) { // not on the road yet: a fresh route from home
      const r = this.route[c];
      if (r.some((e) => net.dead[e])) { const nr = this.router.route(this.trips[c][0], this.trips[c][1], this.cost); if (nr?.length) { this.route[c] = nr; this.cEnd[c] = this.linkEnd(nr, 0); rerouted++; } }
      else this.cEnd[c] = this.linkEnd(r, 0);
    }
    this.pending = this.pending.filter((c) => !this.route[c].some((e) => net.dead[e]) || ((this.onRoad--, this.unroutable++), false));
    for (const { c, p: at, e, into, j, turn, booked } of old.cars) {
      this.ahead[c] = this.behind[c] = -1; this.cLane[c] = -1; this.reserved[c] = -1; this.squeeze[c] = 0;
      this.lcT[c] = 0; this.lcFrom[c] = -1; // old lane ids mean nothing in the new network
      this.pos[c] = at;
      if (turn && !net.dead[turn.from] && !net.dead[turn.to]) { // still on the same turn: stay on it
        if (fix(c, at)) rerouted++; // (then its route starts with the road it's turning into)
        const r = this.route[c], p = this.pos[c], from = r[p - 1] === turn.from ? r[p - 1] : -1;
        const conn = from >= 0 ? L.connOf.get(key(laneOn(turn.from, turn.j), turn.to)) : undefined;
        if (conn !== undefined) { this.pos[c] = p - 1; this.cEnd[c] = p - 1; this.link(c, conn, Math.min(L.len[conn] - 0.01, turn.s)); continue; }
      }
      if (!turn && fix(c, at)) rerouted++;
      const r = this.route[c], p = this.pos[c];
      if (net.dead[e] || L.linkOf[e] < 0) { this.finish(c); continue; } // its road is gone: it turns off here
      const lk = L.links[L.linkOf[e]];
      this.cEnd[c] = this.linkEnd(r, p);
      const lane = lk.laneBase + Math.min(lk.nl - 1, j);
      this.link(c, lane, Math.min(lk.len - 0.01, L.offOf[e] + into));
      if (booked >= 0 && r[this.cEnd[c] + 1] === booked) { const conn = L.connOf.get(key(lane, booked)); if (conn !== undefined) this.book(c, conn); }
    }
    return rerouted;
  }
  // cars on lanes: which graph edge they are on, how far into it, which lane index
  onLanes() {
    const L = this.lanes, out = [];
    for (const l of this.active) for (let c = this.head[l]; c >= 0; c = this.behind[c]) {
      const r = this.route[c];
      if (L.isConn[l]) { // on a junction: which turn, from which lane, how far along
        const p = Math.min(this.pos[c] + 1, r.length - 1);
        out.push({ c, p, e: r[p], into: 0, j: L.idx[L.outLane[l]], turn: { from: r[this.pos[c]], j: L.idx[L.inLane[l]], to: r[p], s: this.s[c] } });
      } else {
        const p = this.pos[c], e = r[p], k = this.reserved[c];
        out.push({ c, p, e, into: Math.max(0, this.s[c] - L.offOf[e]), j: L.idx[l], booked: k >= 0 ? r[this.cEnd[c] + 1] : -1 });
      }
    }
    return out;
  }
  // route index of the last edge on the link that route index p is on
  linkEnd(r, p) {
    const L = this.lanes;
    while (p < r.length - 1 && L.linkOf[r[p + 1]] === L.linkOf[r[p]] && L.idxInLink[r[p + 1]] === L.idxInLink[r[p]] + 1) p++;
    return p;
  }

  // --- lane lists (head = front car) ---
  link(c, l, s) {
    const { head, tail, ahead, behind } = this;
    this.cLane[c] = l; this.s[c] = s;
    let f = head[l];
    while (f >= 0 && this.s[f] > s) f = behind[f]; // f = first car not ahead of c
    const p = f >= 0 ? ahead[f] : tail[l];
    ahead[c] = p; behind[c] = f;
    if (p >= 0) behind[p] = c; else head[l] = c;
    if (f >= 0) ahead[f] = c; else tail[l] = c;
    this.count[l]++;
    if (!this.isActive[l]) { this.isActive[l] = 1; this.active.push(l); }
  }
  unlink(c) {
    const l = this.cLane[c], p = this.ahead[c], f = this.behind[c];
    if (p >= 0) this.behind[p] = f; else this.head[l] = f;
    if (f >= 0) this.ahead[f] = p; else this.tail[l] = p;
    this.ahead[c] = this.behind[c] = -1; this.cLane[c] = -1;
    this.count[l]--;
  }

  routeFor(o, d) {
    const epoch = Math.floor(this.t / this.o.costUpdateSec);
    if (epoch !== this.cacheEpoch) { this.routeCache.clear(); this.cacheEpoch = epoch; }
    const k = o * this.net.N + d;
    let r = this.routeCache.get(k);
    if (r === undefined) { r = this.router.route(o, d, this.cost); this.routeCache.set(k, r); }
    return r;
  }
  // lanes of the current link that lead on to the next one
  rangeFor(c) {
    const r = this.route[c], q = this.cEnd[c];
    return q >= r.length - 1 ? null : this.lanes.moveRange.get(key(r[q], r[q + 1])) ?? null;
  }
  // lanes to aim for now: the next turn's, narrowed to suit the first turn within 400 m that
  // needs particular lanes (counted from the kerb)
  wantedRange(c) {
    const L = this.lanes, r = this.route[c], n = L.links[L.link[this.cLane[c]]].nl, own = this.rangeFor(c);
    let lo = own ? own[0] : 0, hi = own ? own[1] : n - 1;
    let dist = L.len[this.cLane[c]] - this.s[c];
    for (let q = this.cEnd[c] + 1; q < r.length - 1 && dist < 400; ) {
      const qe = this.linkEnd(r, q), lk = L.links[L.linkOf[r[q]]];
      if (qe >= r.length - 1) break;
      const m = L.moveRange.get(key(r[qe], r[qe + 1]));
      if (m && (m[0] > 0 || m[1] < lk.nl - 1)) {
        const a = Math.max(lo, Math.min(n - 1, m[0])), b = Math.min(hi, Math.min(n - 1, m[1] + Math.max(0, n - lk.nl)));
        if (a <= b) { lo = a; hi = b; }
        break;
      }
      dist += lk.len; q = qe + 1;
    }
    return [lo, hi];
  }
  connFor(c) {
    const r = this.route[c], q = this.cEnd[c];
    return q >= r.length - 1 ? -1 : this.lanes.connOf.get(key(this.cLane[c], r[q + 1])) ?? -1;
  }
  // the lane after `lane` on c's way (q: route index of the link end for a road lane, of the
  // edge before it for a connector): [lane, its q] or null
  nextLane(c, lane, q) {
    const L = this.lanes, r = this.route[c];
    if (L.isConn[lane]) return [L.outLane[lane], this.linkEnd(r, q + 1)];
    if (q >= r.length - 1) return null;
    let conn = L.connOf.get(key(lane, r[q + 1]));
    if (conn === undefined) { const m = L.moveRange.get(key(r[q], r[q + 1])); if (m) conn = L.connOf.get(key(L.links[L.link[lane]].laneBase + m[0], r[q + 1])); }
    return conn === undefined ? null : [conn, q];
  }
  book(c, conn) { this.reserved[c] = conn; this.resv[conn].push(c); }
  unbook(c) {
    const k = this.reserved[c];
    if (k < 0) return;
    const a = this.resv[k], i = a.indexOf(c);
    if (i >= 0) { a[i] = a[a.length - 1]; a.pop(); }
    this.reserved[c] = -1;
  }

  // --- one step ---
  step() {
    const { o } = this, dt = o.dt;
    this.departures();
    if (this.stepNo % 2 === 0) this.laneChanges();
    this.junctions();
    this.accelerate();
    this.integrate(dt);
    this.transfers();
    this.active = this.active.filter((l) => (this.count[l] > 0 ? true : ((this.isActive[l] = 0), false)));
    this.t += dt; this.stepNo++;
    if (this.stepNo % Math.round(o.costUpdateSec / dt) === 0) this.updateCosts();
  }

  departures() {
    const { trips, o } = this;
    if (this.pending.length) { const still = []; for (const c of this.pending) if (!this.spawn(c)) still.push(c); this.pending = still; }
    while (this.nextTrip < trips.length && trips[this.nextTrip][2] <= this.t) {
      const c = this.nextTrip++;
      if (this.cancelled[c]) { this.removed++; continue; }
      const [orig, dest] = trips[c];
      const route = orig === dest ? null : this.routeFor(orig, dest);
      if (!route || !route.length) { this.unroutable++; continue; }
      let cost = 0, freeCost = 0, free = 0;
      for (const e of route) { cost += this.cost[e]; freeCost += this.freeCost[e]; free += this.net.freeTime[e]; }
      if (cost > freeCost * o.suppressDelayRatio && cost - freeCost > o.suppressMinDelaySec) { this.suppressed++; continue; }
      this.route[c] = route; this.pos[c] = 0; this.cEnd[c] = this.linkEnd(route, 0);
      this.depart[c] = this.t; this.free[c] = free; this.enterT[c] = this.t;
      this.onRoad++;
      if (!this.spawn(c)) this.pending.push(c);
    }
  }
  // put c on the road at the start of its route, in a lane for its next turn, if there's room
  spawn(c) {
    const L = this.lanes, e = this.route[c][0], lk = L.links[L.linkOf[e]], s = L.offOf[e];
    const range = this.rangeFor(c), lo = range ? range[0] : 0, hi = range ? range[1] : lk.nl - 1;
    for (let j = lo; j <= hi; j++) {
      const l = lk.laneBase + j, g = this.gapIn(l, s);
      if (!g || g[0] < this.o.s0 || g[1] < this.o.s0 + 2) continue;
      this.link(c, l, s);
      this.v[c] = Math.min(L.v0[l] * 0.5, g[0] / 2);
      this.wait[c] = 0; this.reserved[c] = -1; this.lcCool[c] = 0; this.lcT[c] = 0; this.lcFrom[c] = -1;
      return true;
    }
    return false;
  }
  finish(c) { // arrived (or its road was removed under it)
    if (this.cLane[c] >= 0) this.unlink(c);
    this.unbook(c);
    this.onRoad--; this.arrived++; this.tripSec += this.t - this.depart[c]; this.freeSec += this.free[c];
    this.route[c] = null;
  }

  // gap to whatever is ahead of c, and its speed
  leader(c) {
    const L = this.lanes, o = this.o, l = this.cLane[c], p = this.ahead[c];
    if (p >= 0) return [this.s[p] - this.s[c] - o.carLen, this.v[p]];
    const rest = L.len[l] - this.s[c];
    let next, q;
    if (L.isConn[l]) { next = L.outLane[l]; q = this.linkEnd(this.route[c], this.pos[c] + 1); }
    else {
      if (this.cEnd[c] >= this.route[c].length - 1) return [1e4, 0]; // destination on this road
      const conn = this.connFor(c);
      if (conn < 0 || this.reserved[c] !== conn || !this.roomAfter(conn, c)) return [rest - 0.5, 0]; // stop at the line
      next = conn; q = this.cEnd[c];
    }
    let dist = rest, lane = next;
    for (let hop = 0; hop < 6 && dist < 150; hop++) {
      const t = this.tail[lane];
      if (t >= 0) return [dist + this.s[t] - o.carLen, this.v[t]];
      dist += L.len[lane];
      const nx = this.nextLane(c, lane, q);
      if (!nx) break;
      [lane, q] = nx;
    }
    return [dist + 30, this.v[c]];
  }

  accelerate() {
    const { o, lanes: L } = this, sqab = 2 * Math.sqrt(o.a * o.b);
    for (const l of this.active) {
      for (let c = this.head[l]; c >= 0; c = this.behind[c]) {
        const [gap, vl] = this.leader(c), v = this.v[c];
        let v0 = L.v0[l];
        if (!L.isConn[l] && this.ahead[c] < 0) { // slow down for a turn ahead
          const conn = this.reserved[c];
          if (conn >= 0 && L.v0[conn] < v0) v0 = Math.min(v0, Math.sqrt(L.v0[conn] ** 2 + 2 * o.b * 0.6 * Math.max(0, L.len[l] - this.s[c])));
        }
        const ss = o.s0 + Math.max(0, v * o.T + (v * (v - vl)) / sqab);
        this.acc[c] = Math.max(-9, o.a * (1 - (v / v0) ** 4 - (ss / Math.max(gap, 0.1)) ** 2));
      }
    }
  }
  integrate(dt) {
    const L = this.lanes, done = [];
    for (const l of this.active) {
      const road = !L.isConn[l];
      for (let c = this.head[l]; c >= 0; c = this.behind[c]) {
        const v = this.v[c], v2 = Math.max(0, v + this.acc[c] * dt);
        this.s[c] += (v + v2) * 0.5 * dt; this.v[c] = v2;
        const p = this.ahead[c];
        if (p >= 0 && this.s[c] > this.s[p] - this.o.carLen) { this.s[c] = Math.max(0, this.s[p] - this.o.carLen); this.v[c] = Math.min(this.v[c], this.v[p]); }
        if (this.lcCool[c] > 0) this.lcCool[c] -= dt;
        if (this.lcT[c] > 0) this.lcT[c] -= dt;
        if (v2 < 0.5 && L.len[l] - this.s[c] < 12) this.wait[c] += dt; else if (v2 > 2) this.wait[c] = 0;
        if (road) { // which of the link's graph edges it is on now; arrival mid-link
          const r = this.route[c];
          while (this.pos[c] < this.cEnd[c] && this.s[c] >= L.endOf[r[this.pos[c]]]) { this.pos[c]++; this.enterT[c] = this.t; }
          if (this.cEnd[c] === r.length - 1 && this.pos[c] === r.length - 1 && this.s[c] >= L.endOf[r[this.pos[c]]] - 0.01 && L.endOf[r[this.pos[c]]] < L.len[l]) done.push(c);
        }
      }
    }
    for (const c of done) this.finish(c);
  }

  // bookings for the front car of each road lane near a junction
  junctions() {
    const { o, lanes: L } = this;
    for (let i = 0; i < this.active.length; i++) {
      const l = this.active[i], c = this.head[l];
      if (c < 0) continue;
      if (this.wait[c] > o.teleportAfter) { this.teleport(c); continue; }
      if (L.isConn[l]) { // stuck on the junction itself: push on to the exit lane
        if (this.wait[c] > o.squeezeAfter) { this.s[c] = L.len[l]; this.squeezed++; this.wait[c] = 0; }
        continue;
      }
      if (this.cEnd[c] >= this.route[c].length - 1) continue;
      const rest = L.len[l] - this.s[c], v = this.v[c], conn = this.connFor(c);
      if (conn < 0) { // wrong lane at the line: after a while, squeeze over
        if (rest < 6 && this.wait[c] > o.forceAfter) this.forceLane(c);
        continue;
      }
      if (this.wait[c] > o.squeezeAfter && rest < 3) { // waited very long: go
        if (this.reserved[c] !== conn) { this.unbook(c); this.book(c, conn); }
        this.squeeze[c] = 1; this.s[c] = L.len[l]; this.squeezed++;
        continue;
      }
      if (this.reserved[c] === conn) {
        if (this.wait[c] > o.releaseAfter && v < 0.2 && !this.squeeze[c]) this.unbook(c);
        continue;
      }
      // decide before IDM would start braking for the line (s* ≈ s0 + vT + v²/2√ab), so a
      // car meeting a clear junction doesn't slow down for it; no conflicts: book at once
      const crossing = L.conflicts[conn].length > 0;
      if (crossing && rest > Math.max(20, o.s0 + v * o.T + (v * v) / (2 * Math.sqrt(o.a * o.b)) + 8)) continue;
      const tc = this.tail[conn];
      if (!this.roomAfter(conn, c)) continue; // don't block the box
      if (tc >= 0 && this.s[tc] < o.carLen + 1) continue;
      if (crossing && !this.clearFor(c, conn, rest, v)) continue;
      this.book(c, conn);
    }
  }
  // gap acceptance at each conflict point (see the header)
  clearFor(c, conn, rest, v) {
    const L = this.lanes, o = this.o, conf = L.conflicts[conn], sMe = L.conflictS[conn], sOt = L.conflictSo[conn];
    const vm = Math.max(v, 3), len = o.carLen + 2;
    const clash = (tin, tout, d, vx) => { const w = Math.max(vx, 2), a = Math.max(0, d) / w, b = (d + len) / w; return tin < b + o.margin && a < tout + o.margin; };
    for (let i = 0; i < conf.length; i++) {
      const k = conf[i], tin = (rest + sMe[i]) / vm, tout = (rest + sMe[i] + len) / vm;
      for (let x = this.head[k]; x >= 0; x = this.behind[x]) {
        const d = sOt[i] - this.s[x];
        if (d > -len && clash(tin, tout, d, this.v[x])) return false;
      }
      for (const x of this.resv[k]) if (clash(tin, tout, L.len[this.cLane[x]] - this.s[x] + sOt[i], this.v[x])) return false;
      if (this.wait[c] < o.forceAfter && L.rank[k] > L.rank[conn]) { // give way to the bigger road
        const f = this.head[L.inLane[k]];
        if (f >= 0 && this.reserved[f] !== k && this.connFor(f) === k) {
          const d = L.len[L.inLane[k]] - this.s[f] + sOt[i];
          if (d < 60 && Math.max(0, d) / Math.max(this.v[f], 2) < tout + o.yieldT * 0.5) return false;
        }
      }
    }
    return true;
  }
  // Stuck for good: move c along its route to the first link with room for it, or take it
  // off the map (the trip counts as made, with the time it took so far)
  teleport(c) {
    const L = this.lanes, r = this.route[c];
    this.teleported++;
    let q = L.isConn[this.cLane[c]] ? this.pos[c] + 1 : this.cEnd[c] + 1;
    for (let hops = 0; hops < 8 && q < r.length && L.linkOf[r[q]] >= 0; hops++) {
      const qe = this.linkEnd(r, q), lk = L.links[L.linkOf[r[q]]], s = L.offOf[r[q]];
      for (let j = 0; j < lk.nl; j++) {
        const l = lk.laneBase + j, g = this.gapIn(l, s);
        if (!g || g[0] < this.o.s0 + 2 || g[1] < this.o.s0 + 2) continue;
        this.unbook(c); this.unlink(c);
        this.pos[c] = q; this.cEnd[c] = qe; this.link(c, l, s);
        this.v[c] = 0; this.wait[c] = 0; this.squeeze[c] = 0; this.lcFrom[c] = -1; this.lcT[c] = 0;
        return;
      }
      q = qe + 1;
    }
    this.finish(c);
  }
  forceLane(c) {
    const range = this.rangeFor(c);
    if (!range) return;
    const L = this.lanes, lk = L.links[L.link[this.cLane[c]]], k = L.idx[this.cLane[c]];
    const target = lk.laneBase + Math.min(range[1], Math.max(range[0], k)), s = this.s[c], from = this.cLane[c];
    this.unlink(c); this.link(c, target, s);
    this.lcFrom[c] = from; this.lcT[c] = 1; this.forced++; this.wait[c] = 0;
  }

  laneChanges() {
    const L = this.lanes;
    for (const l of this.active) {
      if (L.isConn[l]) continue;
      const lk = L.links[L.link[l]];
      if (lk.nl < 2) continue;
      for (let c = this.head[l], next; c >= 0; c = next) {
        next = this.behind[c];
        if (this.lcCool[c] > 0 || this.reserved[c] >= 0) continue;
        const k = L.idx[l], [lo, hi] = this.wantedRange(c), rest = L.len[l] - this.s[c];
        const own = this.rangeFor(c), must = own && (k < own[0] || k > own[1]);
        let target = -1, urgent = false;
        if (k < lo) { target = k + 1; urgent = must; } else if (k > hi) { target = k - 1; urgent = must; }
        else if (this.v[c] < 0.7 * L.v0[l]) { // pass a slow queue if the next lane is clearly better
          const [gap] = this.leader(c);
          if (gap < 30) for (const d of [-1, 1]) {
            const kk = k + d;
            if (kk < lo || kk > hi) continue;
            const g2 = this.gapIn(lk.laneBase + kk, this.s[c]);
            if (g2 && g2[0] > gap + 15) { target = kk; break; }
          }
        }
        if (target < 0) continue;
        const tl = lk.laneBase + target, g = this.gapIn(tl, this.s[c]);
        if (!g) continue;
        const crawl = this.v[c] < 3 && g[2] < 3; // in a slow queue people let each other in
        const need = urgent && (rest < 40 || crawl) ? 0.3 : 2;
        if (g[0] < need + this.v[c] * 0.3 || g[1] < need + (crawl ? 0 : g[2] * 0.6)) continue;
        const s = this.s[c];
        this.unlink(c); this.link(c, tl, s);
        this.lcFrom[c] = l; this.lcT[c] = 1.5; this.lcCool[c] = 3;
      }
    }
  }
  // gaps at position s on lane l: [ahead, behind, speed of the car behind]
  gapIn(l, s) {
    const o = this.o;
    let f = this.head[l];
    while (f >= 0 && this.s[f] > s) f = this.behind[f];
    const p = f >= 0 ? this.ahead[f] : this.tail[l];
    if (f >= 0 && Math.abs(this.s[f] - s) < 0.01) return null;
    return [p >= 0 ? this.s[p] - s - o.carLen : 1e4, f >= 0 ? s - this.s[f] - o.carLen : 1e4, f >= 0 ? this.v[f] : 0];
  }

  transfers() {
    const L = this.lanes;
    for (let i = 0; i < this.active.length; i++) {
      const l = this.active[i];
      for (let c = this.head[l]; c >= 0 && this.s[c] >= L.len[l]; c = this.head[l]) if (!this.advance(c)) break;
    }
  }
  // c is past the end of its lane: move it on (possibly several short lanes). false = it stays.
  advance(c) {
    const L = this.lanes;
    for (;;) {
      const l = this.cLane[c], over = this.s[c] - L.len[l];
      if (over < 0) return true;
      const r = this.route[c];
      const hold = () => { this.s[c] = L.len[l] - 0.01; this.v[c] = 0; return false; };
      let next;
      if (L.isConn[l]) next = L.outLane[l];
      else {
        if (this.cEnd[c] >= r.length - 1) { this.pos[c] = r.length - 1; this.finish(c); return true; } // arrived
        const conn = this.connFor(c);
        // don't block the box: only go in if there's room for this car beyond the junction
        if (conn < 0 || this.reserved[c] !== conn || (!this.squeeze[c] && !this.roomAfter(conn, c))) return hold();
        next = conn;
      }
      // never onto a car: there must be a car length free at the start of the next lane
      const t = this.tail[next];
      if (t >= 0 && this.s[t] < this.o.carLen) return hold();
      if (L.isConn[l]) { this.pos[c]++; this.cEnd[c] = this.linkEnd(r, this.pos[c]); this.enterT[c] = this.t; }
      else { this.unbook(c); this.squeeze[c] = 0; this.pos[c] = this.cEnd[c]; }
      this.unlink(c);
      this.link(c, next, t >= 0 ? Math.min(over, this.s[t] - this.o.carLen) : over);
      this.wait[c] = 0; this.lcT[c] = 0; this.lcFrom[c] = -1;
    }
  }

  // room beyond the junction for one more car (counting those already on the connector),
  // looking along c's route through short lanes
  roomAfter(conn, c) {
    const L = this.lanes, o = this.o;
    if (!L.conflicts[conn].length) return true; // pass-through: just a queue
    const need = (o.carLen + o.s0) * (1 + this.count[conn]);
    let dist = 0, lane = L.outLane[conn], q = this.linkEnd(this.route[c], this.cEnd[c] + 1);
    for (let hop = 0; hop < 6; hop++) {
      const t = this.tail[lane];
      if (t >= 0) return dist + this.s[t] - o.carLen >= need - o.carLen || this.v[t] > 3;
      dist += L.len[lane];
      if (dist >= need) return true;
      const nx = this.nextLane(c, lane, q);
      if (!nx) return true;
      [lane, q] = nx;
    }
    return true;
  }

  // travel time per graph edge from the speeds of the cars on it
  updateCosts() {
    const { net, lanes: L } = this, sum = new Float64Array(net.E), n = new Int32Array(net.E);
    for (const l of this.active) {
      if (L.isConn[l]) continue;
      for (let c = this.head[l]; c >= 0; c = this.behind[c]) { const e = this.route[c][this.pos[c]]; sum[e] += this.v[c]; n[e]++; }
    }
    for (let e = 0; e < net.E; e++) {
      const free = net.freeTime[e];
      this.cost[e] = (n[e] ? Math.min(free * 20, Math.max(free, net.length[e] / Math.max(0.5, sum[e] / n[e]))) : free) * net.routePenalty[e];
    }
    this.costs = { sum, n };
  }
  // per graph edge: average speed of its cars over its free speed (1 = flowing), −1 = empty
  congestion(out = new Float32Array(this.net.E)) {
    const { net, lanes: L } = this, sum = new Float64Array(net.E), n = new Int32Array(net.E);
    for (const l of this.active) {
      if (L.isConn[l]) continue;
      const v0 = L.v0[l];
      for (let c = this.head[l]; c >= 0; c = this.behind[c]) { const e = this.route[c][this.pos[c]]; sum[e] += Math.min(1, this.v[c] / v0); n[e]++; }
    }
    for (let e = 0; e < out.length; e++) out[e] = n[e] ? sum[e] / n[e] : -1;
    return out;
  }

  // --- drawing: where each car is, `ahead` seconds after the last step ---
  positions(aheadSec = 0) {
    const L = this.lanes;
    if (!this.shapes) this.shapes = L.geom.map((g) => shapeOf(g.length > 1 ? g : [g[0], [g[0][0] + 0.01, g[0][1]]]));
    const n = this.onRoad, pos = new Float32Array(n * 2), head = new Float32Array(n), ids = new Int32Array(n), tmp = new Float32Array(2), th = new Float32Array(1);
    let i = 0;
    for (const l of this.active) {
      const sh = this.shapes[l], k = sh.len / L.len[l];
      for (let c = this.head[l]; c >= 0 && i < n; c = this.behind[c]) {
        // s is the front bumper: draw the car's middle, half a car further back; never past
        // the car in front's drawn spot
        let s = this.s[c] + this.v[c] * aheadSec;
        const p = this.ahead[c];
        if (p >= 0) s = Math.min(s, this.s[p] + this.v[p] * aheadSec - this.o.carLen);
        s = Math.max(0, Math.min(L.len[l], s) - this.o.carLen / 2);
        pointAt(sh, s * k, 0, pos, i * 2, head, i);
        const dh = L.isConn[l] ? Math.atan2(Math.sin(L.hOut[l] - L.hIn[l]), Math.cos(L.hOut[l] - L.hIn[l])) : 0;
        if (L.isConn[l] && Math.abs(dh) < 0.5) {
          // a near-straight connector (often a sideways step where lane counts change): face
          // along the road, leaning a little into the step, as in a lane change
          const f = Math.min(1, s / Math.max(0.1, L.len[l])), along = L.hIn[l] + dh * f;
          const g = L.geom[l], sx = g.at(-1)[0] - g[0][0], sy = g.at(-1)[1] - g[0][1];
          const side = Math.sign(Math.cos(along) * sy - Math.sin(along) * sx), off = Math.abs(-Math.sin(along) * sx + Math.cos(along) * sy);
          head[i] = along + side * Math.min(0.3, Math.atan2(off, Math.max(4, L.len[l]))) * Math.sin(Math.PI * f);
        } else if (sh.len > 3) { // heading along a 3 m chord: turns smoothly round the bends of the lane's polyline
          pointAt(sh, Math.max(0, s * k - 1.5), 0, tmp, 0); const x0 = tmp[0], y0 = tmp[1];
          pointAt(sh, Math.min(sh.len, s * k + 1.5), 0, tmp, 0); head[i] = Math.atan2(tmp[1] - y0, tmp[0] - x0);
        }
        if (this.lcT[c] > 0 && this.lcFrom[c] >= 0 && L.link[this.lcFrom[c]] === L.link[l]) { // sliding over from the old lane
          const sf = this.shapes[this.lcFrom[c]], f = Math.min(1, this.lcT[c] / 1.5);
          pointAt(sf, Math.min(sf.len, s * (sf.len / L.len[this.lcFrom[c]])), 0, tmp, 0, th, 0);
          const dx = pos[i * 2] - tmp[0], dy = pos[i * 2 + 1] - tmp[1]; // old lane → new lane
          pos[i * 2] -= dx * f; pos[i * 2 + 1] -= dy * f;
          // turn into the move: sideways speed (lane width over the slide) against forward speed
          const side = Math.sign(Math.cos(head[i]) * dy - Math.sin(head[i]) * dx);
          head[i] += side * Math.min(0.35, Math.atan2(Math.hypot(dx, dy) / 1.5, Math.max(3, this.v[c]))) * Math.sin(Math.PI * f);
        }
        ids[i++] = c;
      }
    }
    return { pos: pos.subarray(0, i * 2), head: head.subarray(0, i), ids: ids.subarray(0, i) };
  }
}

// ------------------------------------------------------------------ geometry
function polyLen(g) { let l = 0; for (let k = 1; k < g.length; k++) l += Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]); return l; }
function cut(g, s0, s1) { // polyline between distances s0 and s1
  if (s1 - s0 < 0.5) { // next to nothing left: a 0.5 m stub pointing the way the road goes
    const m = at(g, (s0 + s1) / 2), a = at(g, Math.max(0, (s0 + s1) / 2 - 1)), b = at(g, (s0 + s1) / 2 + 1);
    const d = unit(a, b);
    return [[m[0] - d[0] * 0.25, m[1] - d[1] * 0.25], [m[0] + d[0] * 0.25, m[1] + d[1] * 0.25]];
  }
  const out = [at(g, s0)];
  let acc = 0;
  for (let k = 1; k < g.length; k++) {
    acc += Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
    if (acc > s0 + 0.1 && acc < s1 - 0.1) out.push([g[k][0], g[k][1]]);
  }
  out.push(at(g, s1));
  return out;
}
function at(g, s) {
  let acc = 0;
  for (let k = 1; k < g.length; k++) {
    const l = Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
    if (acc + l >= s || k === g.length - 1) { const t = l ? Math.max(0, Math.min(1, (s - acc) / l)) : 0; return [g[k - 1][0] + (g[k][0] - g[k - 1][0]) * t, g[k - 1][1] + (g[k][1] - g[k - 1][1]) * t]; }
    acc += l;
  }
  return [g[0][0], g[0][1]];
}
// first place two polylines cross or pass closer than `gap` m: [distance along a, along b]
function meet(a, b, gap) {
  let best = null, bd = gap;
  for (let i = 1, sa = 0; i < a.length; i++) {
    const la = Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]);
    for (let j = 1, sb = 0; j < b.length; j++) {
      const lb = Math.hypot(b[j][0] - b[j - 1][0], b[j][1] - b[j - 1][1]);
      const rx = a[i][0] - a[i - 1][0], ry = a[i][1] - a[i - 1][1], qx = b[j][0] - b[j - 1][0], qy = b[j][1] - b[j - 1][1];
      const den = rx * qy - ry * qx;
      if (Math.abs(den) > 1e-9) {
        const t = ((b[j - 1][0] - a[i - 1][0]) * qy - (b[j - 1][1] - a[i - 1][1]) * qx) / den;
        const u = ((b[j - 1][0] - a[i - 1][0]) * ry - (b[j - 1][1] - a[i - 1][1]) * rx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [sa + t * la, sb + u * lb];
      }
      const d = Math.hypot(a[i][0] - b[j][0], a[i][1] - b[j][1]);
      if (d < bd) { bd = d; best = [sa + la, sb + lb]; }
      sb += lb;
    }
    sa += la;
  }
  return best;
}
// Control point for a turn: where the in-lane's heading line meets the out-lane's — if that
// lies ahead of the car and behind the exit, and not so far out that the curve would loop
function tangentMeet(p, dp, q, dq) {
  const den = dp[0] * dq[1] - dp[1] * dq[0];
  const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], span = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (Math.abs(den) < 0.15) return mid;
  const t = ((q[0] - p[0]) * dq[1] - (q[1] - p[1]) * dq[0]) / den;
  const u = ((q[0] - p[0]) * dp[1] - (q[1] - p[1]) * dp[0]) / den; // along the out-lane, from q
  if (t <= 0 || u >= 0) return mid;
  const x = [p[0] + dp[0] * t, p[1] + dp[1] * t];
  return Math.hypot(x[0] - mid[0], x[1] - mid[1]) > span ? mid : x;
}
// Direction at one end of a polyline (dir 1: start, -1: end), from the nearest segment that
// isn't zero-length — cut() can leave a doubled point at the ends
function endHeading(g, dir) {
  const n = g.length;
  if (dir > 0) { for (let k = 1; k < n; k++) if (Math.hypot(g[k][0] - g[0][0], g[k][1] - g[0][1]) > 0.05) return unit(g[0], g[k]); }
  else for (let k = n - 2; k >= 0; k--) if (Math.hypot(g[n - 1][0] - g[k][0], g[n - 1][1] - g[k][1]) > 0.05) return unit(g[k], g[n - 1]);
  return [1, 0];
}
// A turn from p (heading dp) to q (heading dq): cubic Bézier leaving and joining both lanes
// along their own direction, so a car's heading never jumps at either end
function turnCurve(p, dp, q, dq) {
  const span = Math.hypot(q[0] - p[0], q[1] - p[1]), k = span * 0.4;
  const a = [p[0] + dp[0] * k, p[1] + dp[1] * k], b = [q[0] - dq[0] * k, q[1] - dq[1] * k];
  const n = Math.max(4, Math.min(16, Math.ceil(span / 1.5))), out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * p[0] + w1 * a[0] + w2 * b[0] + w3 * q[0], w0 * p[1] + w1 * a[1] + w2 * b[1] + w3 * q[1]]);
  }
  return out;
}
function bezier(p, c, q, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]]); }
  return out;
}
