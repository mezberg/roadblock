// Roadblock game page: budget, road tools (build / upgrade / lanes / bulldoze),
// building demolition, and the day-by-day traffic simulation (game/worker.mjs).
import { Editor, curveLine, arcLine, unit, pointOnLine } from "./editor.mjs";
import { MapRenderer, COLORS, applyLevels } from "./render.mjs";
import { offsetLine, bandOffset, invertPatch, touchesRoads } from "./network.mjs";
import { ROAD_TYPES, ECONOMY, LANE_W, GRADE, LEVELS, money, lostHours, buildingCost, dayResult, vsUntouched, beyondNoise } from "./rules.mjs";
import { TIME, simToClock, clockToSim, VEHICLES, vehicleOf, colourOf, PURPOSE } from "./time.mjs";

const $ = (id) => document.getElementById(id);
const AREA = new URLSearchParams(location.search).get("area") ?? "greenwich";
const SLOT = new URLSearchParams(location.search).get("slot"); // separate save slots, e.g. ?slot=test
const SAVE_KEY = `roadblock-game-v1-${AREA}${SLOT ? `-${SLOT}` : ""}`;
// Game clock (game seconds) → "07:45"; after midnight the day's last trips are still running
const fmtClock = (c) => { const m = Math.floor(c / 60), h = Math.floor(m / 60); return `${String(h % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
// Game seconds → "4 h 05 min" / "35 min"
const fmtDur = (c) => { const m = Math.round(c / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
const clockOf = (t) => simToClock(t);
const PERIODS = [[0, "Night"], [6, "Morning peak"], [10, "Daytime"], [15, "Evening peak"], [19, "Evening"], [24, "After midnight · last trips home"]];

// --- Save game (edits are replayed on the original OSM graph) ---------------------------
function loadSave() {
  const fresh = { budget: ECONOMY.startBudget, day: 1, patches: [], undo: [], redo: [], strikes: 0, cuts: 0 };
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY)); if (s?.patches && !s.fired) return { ...fresh, ...s }; } catch {}
  return fresh;
}
let save = loadSave();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {} }

const optional = (s) => fetch(`data/${AREA}${s}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const [graph, footprints, levels, extra] = await Promise.all([
  ...[".graph", ".footprints"].map((s) => fetch(`data/${AREA}${s}.json`).then((r) => r.json())),
  optional(".levels"), // bridges & tunnels, drawing only
  // what footprints miss: the Thames round the Greenwich peninsula (its OSM relation didn't
  // stitch) and the O2 (a multipolygon); picture only, nothing is built or demolished there
  optional(".extra-map"),
]);
applyLevels(graph, levels);
const editor = new Editor(graph, footprints);
for (const p of save.patches) editor.apply(p);
const map = new MapRenderer(editor, extra ? { ...footprints, areas: [...footprints.areas, { kind: "water", rings: extra.rings }, { kind: "landmark", rings: extra.o2.rings }] } : footprints);
$("areaName").textContent = graph.area.title;
document.title = `Roadblock — ${graph.area.title}`;

// --- Simulation worker ----------------------------------------------------------------
const worker = new Worker("game/worker.mjs", { type: "module" });
// ?sim=lanes: the lane model (every car on its lane, drawn where the sim has it) instead of
// the queue model. Not the default yet: a small edit can still tip its day by ~10% (a jam
// that forms or doesn't), which would make scores unfair.
worker.postMessage({ cmd: "init", area: AREA, patches: save.patches, model: new URLSearchParams(location.search).get("sim") ?? "queues" });
let baseline = null, frame = null, congestion = null, stats = null, playing = false, dayOver = false;
const onWorker = ({ data }) => {
  if (data.type === "ready") { baseline = data.baseline; $("loading").remove(); }
  else if (data.type === "frame") {
    frame = data; stats = data.stats; onCars(data);
    if (data.congestion) { congestion = data.congestion; mapDirty = true; }
    updateHud();
  } else if (data.type === "skipped") { skipping = false; $("skip").textContent = "⏩ to 07:00"; updateHud(); }
  else if (data.type === "dayEnd") endOfDay(data.stats);
  else if (data.type === "car") showCar(data.car);
  else if (data.type === "patched" && data.rerouted) toast(`${data.rerouted.toLocaleString()} drivers re-routed`);
};

// --- View -----------------------------------------------------------------------------
const mapCanvas = $("map"), ov = $("overlay");
const mctx = mapCanvas.getContext("2d"), octx = ov.getContext("2d");
const [S, W, N, E] = graph.area.bbox, P = graph.projection;
const world = { w: (E - W) * P.mx, h: (N - S) * P.my };
let view = { cx: 0, cy: 0, scale: 1 };
let mapDirty = true;
function fit() { view.scale = Math.min(innerWidth / world.w, innerHeight / world.h) * 1.6; view.cx = 0; view.cy = -200; }
// where the map was left, per save slot (a convenience, so plain localStorage)
const VIEW_KEY = `${SAVE_KEY}-view`;
let viewTimer = null;
function rememberView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} }, 400);
}
function restoreView() {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY)); if (v && [v.cx, v.cy, v.scale].every(Number.isFinite)) { view = v; return true; } } catch {}
  return false;
}
function resize() {
  const dpr = devicePixelRatio;
  for (const c of [mapCanvas, ov]) { c.width = innerWidth * dpr; c.height = innerHeight * dpr; }
  mapDirty = true;
}
const toWorld = (sx, sy) => [view.cx + (sx - innerWidth / 2) / view.scale, view.cy + (sy - innerHeight / 2) / view.scale];
const setWorld = (g) => { const d = devicePixelRatio, k = view.scale * d; g.setTransform(k, 0, 0, k, d * innerWidth / 2 - view.cx * k, d * innerHeight / 2 - view.cy * k); };
if (!restoreView()) fit();
resize();
addEventListener("resize", resize);

// --- Tools ------------------------------------------------------------------------------
const ICONS = {
  pan: '<path d="M5 3l14 7-6 2-2 6z" fill="currentColor"/>',
  build: '<path d="M7 3L4 21M17 3l3 18M12 4v3M12 10v3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="18" cy="18" r="5" fill="currentColor"/><path d="M18 15.5v5M15.5 18h5" stroke="var(--panel)" stroke-width="1.8"/>',
  upgrade: '<path d="M7 3L4 21M17 3l3 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M12 6l4 5h-2.5v6h-3v-6H8z" fill="currentColor"/>',
  lanes: '<path d="M5 3v18M19 3v18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 4v3M10 10v3M10 16v3M14 4v3M14 10v3M14 16v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  bulldoze: '<path d="M7 3L4 21M17 3l3 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#dc2626" stroke-width="2.6" stroke-linecap="round"/>',
  demolish: '<path d="M3 11l9-7 9 7v10H3z" fill="currentColor"/><path d="M8.5 11.5l7 7M15.5 11.5l-7 7" stroke="#dc2626" stroke-width="2.6" stroke-linecap="round"/>',
};
const TOOLS = [
  { id: "pan", name: "Look", key: "1" }, { id: "build", name: "Build road", key: "2" },
  { id: "upgrade", name: "Upgrade", key: "3" }, { id: "lanes", name: "Lanes", key: "4" },
  { id: "bulldoze", name: "Remove road", key: "5" }, { id: "demolish", name: "Demolish", key: "6" },
];
let tool = "pan", roadType = ROAD_TYPES[0];
$("tools").innerHTML = TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.name} (${t.key})"><svg viewBox="0 0 24 24">${ICONS[t.id]}</svg>${t.name}<kbd>${t.key}</kbd></button>`).join("");
$("types").innerHTML = ROAD_TYPES.map((t) => `<button data-type="${t.id}"><span>${t.name}</span><span class="lanes">${'<i class="back"></i>'.repeat(t.bwd)}${"<i></i>".repeat(t.fwd)}</span><small>${t.hint}</small></button>`).join("");
// pointerdown rather than click: a click is dropped if the press and release land on
// different elements, which happened right after dragging the map
const onPress = (el, fn) => el.addEventListener("pointerdown", (ev) => { if (ev.button === 0) fn(ev); });
onPress($("tools"), (ev) => { const b = ev.target.closest("button"); if (b) setTool(b.dataset.tool); });
onPress($("types"), (ev) => { const b = ev.target.closest("button"); if (b) { roadType = ROAD_TYPES.find((t) => t.id === b.dataset.type); syncToolbar(); } });
onPress($("buildMode"), (ev) => { const b = ev.target.closest("button"); if (b) setBuildMode(b.dataset.m); });
onPress($("buildLevel"), (ev) => { const b = ev.target.closest("button"); if (b) setBuildLevel(Number(b.dataset.l)); });
$("laneGain").onchange = () => { laneGain = $("laneGain").checked; updateHover(); };
function setTool(id) {
  tool = id; resetPointerState();
  syncToolbar(); updateHover();
}
function resetPointerState() { buildStart = null; curveCtrl = null; selection = []; closeLanes(); pendingDemolish = -1; hover = null; }
// smooth: each piece leaves tangent to the road it starts from (Trafficity / CS2 "continuous")
let buildMode = "smooth", buildLevel = 0, laneGain = true;
const BUILD_MODES = ["smooth", "straight", "curve"];
function setBuildMode(m) { buildMode = m; curveCtrl = null; syncToolbar(); updateHover(); }
function setBuildLevel(l) {
  buildLevel = Math.max(LEVELS[0].level, Math.min(LEVELS.at(-1).level, l));
  syncToolbar(); updateHover();
}
function syncToolbar() {
  for (const b of $("tools").children) b.classList.toggle("on", b.dataset.tool === tool);
  for (const b of $("types").children) b.classList.toggle("on", b.dataset.type === roadType.id);
  $("types").style.display = tool === "build" || tool === "upgrade" ? "" : "none";
  $("buildOpts").style.display = tool === "build" ? "" : "none";
  for (const b of $("buildMode").children) b.classList.toggle("on", b.dataset.m === buildMode);
  for (const b of $("buildLevel").children) b.classList.toggle("on", Number(b.dataset.l) === buildLevel);
  ov.classList.toggle("pan", tool === "pan");
}

// --- Money ----------------------------------------------------------------------------
function spend(cost, patch, what) {
  if (cost > save.budget) { toast(`Not enough money: ${what} costs ${money(cost)}`); return false; }
  save.undo.push({ inverse: invertPatch(graph, patch), cost, what });
  save.redo = [];
  save.budget -= cost;
  commit(patch);
  toast(`${what} · ${money(-cost)}`);
  return true;
}
// Apply a patch everywhere: page graph, map, sim, save
function commit(patch) {
  patch.at ??= stats?.t ?? 0; // sim time of the edit (replays ignore it; the trailer uses it)
  editor.apply(patch);
  if (patch.demolish?.length || patch.restore?.length) map.rebuildBuildings();
  if (touchesRoads(patch)) map.rebuildRoads();
  worker.postMessage({ cmd: "patch", patch });
  save.patches.push(patch); persist();
  mapDirty = true; updateHud();
}

// --- Undo / redo ------------------------------------------------------------------------
// Edits are never taken out of save.patches (ids must keep lining up); undo appends the
// inverse patch and refunds the cost. Only today's edits can be undone.
function undo() {
  const u = save.undo.pop();
  if (!u) return;
  save.redo.push({ inverse: invertPatch(graph, u.inverse), cost: u.cost, what: u.what });
  save.budget += u.cost;
  resetPointerState();
  commit(u.inverse);
  toast(`Undone: ${u.what} · ${money(u.cost)} back`);
}
function redo() {
  const r = save.redo.at(-1);
  if (!r) return;
  if (r.cost > save.budget) return toast(`Not enough money to redo: ${r.what} costs ${money(r.cost)}`);
  save.redo.pop();
  save.undo.push({ inverse: invertPatch(graph, r.inverse), cost: r.cost, what: r.what });
  save.budget -= r.cost;
  resetPointerState();
  commit(r.inverse);
  toast(`Redone: ${r.what} · ${money(-r.cost)}`);
}
$("undo").onclick = undo;
$("redo").onclick = redo;

// --- Pointer --------------------------------------------------------------------------
let mouse = null, down = null, buildStart = null, curveCtrl = null, selection = [], pendingDemolish = -1, hover = null, freeAim = false;
const snapR = () => 14 / view.scale;
const segsFromSelection = () => selection.map((id) => editor.segs[id]);

ov.addEventListener("contextmenu", (e) => e.preventDefault());
ov.addEventListener("pointerdown", (e) => {
  ov.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, pan: e.button !== 0 || ["pan", "build", "demolish"].includes(tool) };
  if (e.button === 2 && buildStart) { if (curveCtrl) curveCtrl = null; else buildStart = null; down.pan = true; }
  if (!down.pan) { selection = []; addToSelection(e); closeLanes(); }
});
ov.addEventListener("pointermove", (e) => {
  mouse = { x: e.clientX, y: e.clientY }; freeAim = e.altKey;
  if (down) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
    if (down.pan && down.moved) {
      view.cx -= e.movementX / view.scale; view.cy -= e.movementY / view.scale; mapDirty = true; rememberView();
      ov.style.cursor = "grabbing";
    } else if (!down.pan) addToSelection(e);
  }
  updateHover();
});
ov.addEventListener("pointerup", (e) => {
  const d = down; down = null; ov.style.cursor = "";
  if (!d) return;
  if (d.pan && d.moved) return;
  if (d.button === 2) return;
  mouse = { x: e.clientX, y: e.clientY }; freeAim = e.altKey;
  const [x, y] = toWorld(e.clientX, e.clientY);
  if (tool === "build") clickBuild();
  else if (tool === "demolish") clickDemolish(x, y);
  else if (tool === "upgrade") applyUpgrade();
  else if (tool === "bulldoze") applyBulldoze();
  else if (tool === "lanes") openLanes(e.clientX, e.clientY);
  else if (tool === "pan") follow(carAt(e.clientX, e.clientY));
  updateHover();
});
ov.addEventListener("pointerleave", () => { mouse = null; $("tip").style.display = "none"; });
for (const ev of ["pointercancel", "lostpointercapture"]) ov.addEventListener(ev, () => { down = null; ov.style.cursor = ""; });
ov.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  view.scale = Math.min(14, Math.max(0.08, view.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
  view.cx = wx - (e.clientX - innerWidth / 2) / view.scale; view.cy = wy - (e.clientY - innerHeight / 2) / view.scale;
  mapDirty = true; rememberView(); updateHover();
}, { passive: false });

function addToSelection(e) {
  const [x, y] = toWorld(e.clientX, e.clientY);
  const h = editor.hitSegment(x, y, 8 / view.scale);
  if (h && !selection.includes(h.seg.id)) selection.push(h.seg.id);
}

// Orientation of each selected segment relative to the first one (true = same way)
function alignment(segs) {
  const out = [true];
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], s = segs[i], pEnd = out[i - 1] ? p.b : p.a, pStart = out[i - 1] ? p.a : p.b;
    if (s.a === pEnd || s.b === pStart) out.push(true);
    else if (s.b === pEnd || s.a === pStart) out.push(false);
    else {
      const dir = (g) => [g.at(-1)[0] - g[0][0], g.at(-1)[1] - g[0][1]], a = dir(p.geom), b = dir(s.geom);
      out.push((a[0] * b[0] + a[1] * b[1] > 0) === out[i - 1]);
    }
  }
  return out;
}

// --- Build ----------------------------------------------------------------------------
// Snapping while drawing: an existing road or junction under the cursor wins; otherwise
// the piece being drawn locks to "straight on" / square to / along the road it starts
// from, or to 15° steps. Alt places freely.
const ROAD_SNAP_DEG = 6, STEP_DEG = 15, STEP_SNAP_DEG = 2.5;
const deg = (r) => (r * 180) / Math.PI;
const angleDiff = (a, b) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
function aim(x, y, from, refs) {
  const t = editor.snap(x, y, snapR(), buildLevel);
  const v = from && [x - from.x, y - from.y], len = v && Math.hypot(v[0], v[1]);
  if (!from || len < 1) return { t };
  if (t.kind !== "free" || freeAim) return { t, len };
  const ang = Math.atan2(v[1], v[0]);
  let best = null;
  for (const h of refs) {
    const a = Math.atan2(h[1], h[0]);
    for (const [off, label] of [[Math.PI, "straight on"], [Math.PI / 2, "90° to road"], [-Math.PI / 2, "90° to road"], [0, "along road"]]) {
      const c = a + off, dd = angleDiff(ang, c);
      if (dd < (ROAD_SNAP_DEG * Math.PI) / 180 && (!best || dd < best.dd)) best = { ang: c, dd, label };
    }
  }
  if (!best) {
    const step = (STEP_DEG * Math.PI) / 180, c = Math.round(ang / step) * step;
    if (angleDiff(ang, c) < (STEP_SNAP_DEG * Math.PI) / 180) best = { ang: c, label: null };
  }
  if (!best) return { t, len };
  const sx = from.x + Math.cos(best.ang) * len, sy = from.y + Math.sin(best.ang) * len;
  const t2 = editor.snap(sx, sy, snapR() * 0.4, buildLevel); // a road right at the snapped spot still makes a junction
  return { t: t2, len, guide: { from, ang: best.ang, label: best.label } };
}
// Compass bearing of a heading (x east, y south): 0° = north, clockwise
const bearing = (a) => Math.round((deg(a) + 90 + 360) % 360);
// What the cursor is aiming at, for the leg being drawn now
function currentAim() {
  if (!mouse) return null;
  const [x, y] = toWorld(mouse.x, mouse.y);
  if (!buildStart) return aim(x, y, null, []);
  if (buildMode === "curve" && curveCtrl) return aim(x, y, curveCtrl, []);
  if (buildMode === "smooth" && startTangent(x, y)) {
    // nearly straight on: lock to the tangent, so long straights are easy
    const tan = startTangent(x, y), t = editor.snap(x, y, snapR(), buildLevel), v = [x - buildStart.x, y - buildStart.y];
    const len = Math.hypot(v[0], v[1]), along = v[0] * tan.dir[0] + v[1] * tan.dir[1];
    if (t.kind === "free" && !freeAim && along > 0 && Math.abs(v[0] * tan.dir[1] - v[1] * tan.dir[0]) / len < Math.sin((1.5 * Math.PI) / 180)) {
      const sx = buildStart.x + tan.dir[0] * along, sy = buildStart.y + tan.dir[1] * along;
      return { t: editor.snap(sx, sy, snapR() * 0.4, buildLevel), len, guide: { from: buildStart, ang: Math.atan2(tan.dir[1], tan.dir[0]), label: "straight on" } };
    }
    return { t, len };
  }
  return aim(x, y, buildStart, editor.headingsAt(buildStart));
}
// Smooth mode: the direction a new piece leaves buildStart in, or null (then it's a straight
// piece with angle snapping). Carries on from the piece just built, straight out of a dead
// end, or off the middle of a road: square to it, or along it for a slip road.
function startTangent(x, y) {
  const t = buildStart;
  if (t.tan) return { dir: t.tan, label: null };
  const hs = editor.headingsAt(t);
  if (t.kind === "node" && hs.length === 1) return { dir: [-hs[0][0], -hs[0][1]], label: "straight on" };
  if (t.kind !== "seg") return null;
  const d = hs[0], v = unit([t.x, t.y], [x, y]), along = v[0] * d[0] + v[1] * d[1];
  if (Math.abs(along) > Math.cos((40 * Math.PI) / 180)) return { dir: along > 0 ? d : [-d[0], -d[1]], label: "Along road" };
  const n = [-d[1], d[0]], side = v[0] * n[0] + v[1] * n[1] >= 0 ? 1 : -1;
  return { dir: [n[0] * side, n[1] * side], label: "Perpendicular" };
}
function currentPlan() {
  if (!buildStart || !mouse) return null;
  const a = currentAim();
  if (buildMode === "curve" && !curveCtrl) return null; // still placing the bend
  let geom;
  if (buildMode === "curve") geom = curveLine([buildStart.x, buildStart.y], [curveCtrl.x, curveCtrl.y], [a.t.x, a.t.y]);
  else if (buildMode === "smooth") {
    const tan = startTangent(a.t.x, a.t.y);
    if (tan) {
      const arc = arcLine([buildStart.x, buildStart.y], tan.dir, [a.t.x, a.t.y]);
      if (!arc) return { ...editor.planRoad(buildStart, a.t, roadType, undefined, buildOpts()), error: "Can't turn back on itself", tangent: tan };
      return { ...editor.planRoad(buildStart, a.t, roadType, arc.geom, buildOpts()), tangent: tan };
    }
  }
  return editor.planRoad(buildStart, a.t, roadType, geom, buildOpts());
}
const buildOpts = () => ({ level: buildLevel, laneGain });
function clickBuild() {
  const a = currentAim();
  if (!a) return;
  // a road started on open ground starts at ground level and ramps up / down to its level;
  // a free end stays at the chosen level, so the next piece carries on from there
  if (!buildStart) { buildStart = a.t.kind === "free" ? { ...a.t, z: 0 } : a.t; return; }
  if (buildMode === "curve" && !curveCtrl) {
    if (a.len < 4) return;
    curveCtrl = { x: a.t.x, y: a.t.y };
    return;
  }
  const plan = currentPlan();
  if (plan.error) return toast(plan.error);
  if (plan.blockers.length) return toast(`${plan.blockers.length} building${plan.blockers.length > 1 ? "s" : ""} in the way — demolish first (6)`);
  const patch = editor.commitRoad(plan);
  const lv = plan.level ? ` ${LEVELS.find((l) => l.level === plan.level).name.toLowerCase()}` : "";
  const slips = plan.slips.length ? ` + ${plan.slips.map((s) => s.kind === "merge" ? "merge" : "exit").join(", ")}` : "";
  if (!spend(plan.cost, patch, `${roadType.name}${lv}, ${Math.round(plan.len)} m${plan.junctions ? ` + ${plan.junctions} junction${plan.junctions > 1 ? "s" : ""}` : ""}${slips}`)) return;
  // keep drawing from the end of the new piece, carrying on in the direction it ended
  const v = editor.hitNode(plan.q[0], plan.q[1], 0.5);
  const g = plan.geom, tan = unit(pointOnLine(g, Math.max(0, plan.len - 2)), g.at(-1));
  buildStart = v >= 0 && plan.t1.kind === "free" ? { kind: "node", node: v, x: plan.q[0], y: plan.q[1], z: editor.nodeZ.get(v) ?? 0, tan } : null;
  curveCtrl = null;
}

// --- Upgrade / bulldoze / lanes -------------------------------------------------------
function upgradeChanges(segs) {
  const t = roadType, speedKmh = Math.round(t.mph * 1.609);
  return segs.map((seg) => {
    let fwd = t.fwd, bwd = t.bwd;
    if (!t.bwd && !seg.fwdLanes) { fwd = 0; bwd = t.fwd; } // one-way stays the way it ran
    return { seg, spec: { hw: t.hw, speedKmh, fwd, bwd } };
  });
}
function applyUpgrade() {
  const segs = segsFromSelection(); selection = [];
  if (!segs.length) return;
  const changes = upgradeChanges(segs), plan = editor.planChange(changes);
  if (plan.blockers.length) { flashBlockers(plan.blockers); return toast(`Widening hits ${plan.blockers.length} building${plan.blockers.length > 1 ? "s" : ""} — demolish first`); }
  spend(plan.cost, editor.commitChange(changes), `Upgraded ${segs.length} piece${segs.length > 1 ? "s" : ""} to ${roadType.name}`);
}
function applyBulldoze() {
  const segs = segsFromSelection(); selection = [];
  if (!segs.length) return;
  const plan = editor.planRemove(segs);
  spend(plan.cost, editor.commitRemove(segs), `Removed ${Math.round(segs.reduce((s, g) => s + g.len, 0))} m of road`);
}

let lanesState = null;
function openLanes(sx, sy) {
  const segs = segsFromSelection();
  if (!segs.length) return;
  const first = segs[0], tmpl = graph.edges[first.fwd >= 0 ? first.fwd : first.bwd];
  // untouched settings keep each piece's own lanes / speed; a stepper sets all pieces
  lanesState = { segs, aligned: alignment(segs), fwd: first.fwdLanes, bwd: first.bwdLanes, set: {}, reversed: false, mph: [20, 30, 40].reduce((b, m) => (Math.abs(m - tmpl.speedKmh / 1.609) < Math.abs(b - tmpl.speedKmh / 1.609) ? m : b), 30) };
  const names = [...new Set(segs.map((s) => s.name).filter(Boolean))];
  $("lanesTitle").textContent = names.join(", ") || "Unnamed road";
  $("lanesSub").textContent = `${segs.length} piece${segs.length > 1 ? "s" : ""} · ${Math.round(segs.reduce((s, g) => s + g.len, 0))} m · ${first.hw.replace("_", " ")}`;
  $("lspeed").value = lanesState.mph;
  const el = $("lanes");
  el.style.display = "block";
  el.style.left = Math.min(innerWidth - 270, Math.max(12, sx + 16)) + "px";
  el.style.top = Math.min(innerHeight - el.offsetHeight - 12, Math.max(12, sy - 40)) + "px";
  refreshLanes();
}
function lanesChanges() {
  const st = lanesState, speedKmh = st.set.mph ? Math.round(st.mph * 1.609) : undefined;
  return st.segs.map((seg, i) => {
    // lanes relative to the first piece's direction
    let f = st.aligned[i] ? seg.fwdLanes : seg.bwdLanes, b = st.aligned[i] ? seg.bwdLanes : seg.fwdLanes;
    if (st.reversed) [f, b] = [b, f];
    if (st.set.fwd) f = st.fwd;
    if (st.set.bwd) b = st.bwd;
    return { seg, spec: st.aligned[i] ? { fwd: f, bwd: b, speedKmh } : { fwd: b, bwd: f, speedKmh } };
  });
}
function refreshLanes() {
  const st = lanesState, changes = lanesChanges();
  // show "1–2" when pieces differ and the stepper hasn't been touched
  for (const d of ["fwd", "bwd"]) {
    const vals = changes.map(({ spec }, i) => (st.aligned[i] === (d === "fwd") ? spec.fwd : spec.bwd));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    $(d === "fwd" ? "lfwd" : "lbwd").textContent = lo === hi ? lo : `${lo}–${hi}`;
    if (!st.set[d]) st[d] = vals[0];
  }
  const plan = editor.planChange(changes);
  $("lcost").textContent = money(plan.cost);
  $("lcost").className = plan.cost > save.budget ? "num bad" : "num";
  const err = changes.some(({ spec }) => spec.fwd + spec.bwd === 0) ? "A road needs at least one lane — use Remove road instead"
    : plan.blockers.length ? `Widening hits ${plan.blockers.length} building${plan.blockers.length > 1 ? "s" : ""} (red) — demolish first` : "";
  $("lerr").textContent = err; $("lerr").className = err ? "bad" : "muted";
  st.blockers = plan.blockers;
  $("lapply").disabled = !!err || plan.cost > save.budget;
}
function closeLanes() { lanesState = null; $("lanes").style.display = "none"; }
$("lanes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-d]");
  if (!b || !lanesState) return;
  const d = b.dataset.d;
  lanesState[d] = Math.max(0, Math.min(5, lanesState[d] + Number(b.dataset.k)));
  lanesState.set[d] = true;
  refreshLanes();
});
$("lspeed").onchange = () => { lanesState.mph = Number($("lspeed").value); lanesState.set.mph = true; refreshLanes(); };
$("lswap").onclick = () => {
  const st = lanesState;
  [st.fwd, st.bwd] = [st.bwd, st.fwd]; [st.set.fwd, st.set.bwd] = [st.set.bwd, st.set.fwd]; st.reversed = !st.reversed;
  refreshLanes();
};
$("lcancel").onclick = () => { closeLanes(); selection = []; };
$("lapply").onclick = () => {
  const changes = lanesChanges().filter(({ seg, spec }) => spec.fwd !== seg.fwdLanes || spec.bwd !== seg.bwdLanes || spec.speedKmh !== undefined);
  if (!changes.length) { closeLanes(); selection = []; return; }
  const plan = editor.planChange(changes);
  if (spend(plan.cost, editor.commitChange(changes), `Lanes changed on ${changes.length} piece${changes.length > 1 ? "s" : ""}`)) { closeLanes(); selection = []; }
};

// --- Demolish -------------------------------------------------------------------------
function describeBuilding(b) {
  const what = b.name ?? (b.kind === "yes" ? "Building" : b.kind[0].toUpperCase() + b.kind.slice(1).replace("_", " "));
  const people = [b.homes && `${Math.round(b.homes * 10) / 10} home${b.homes === 1 ? "" : "s"}`, b.jobs && `${Math.round(b.jobs)} jobs`].filter(Boolean).join(" · ");
  return { what, people };
}
function clickDemolish(x, y) {
  const i = editor.hitBuilding(x, y);
  if (i < 0) { pendingDemolish = -1; return; }
  const b = editor.buildings[i], cost = buildingCost(b);
  // pricey buildings take a second click to confirm
  if (cost >= 1_000_000 && pendingDemolish !== i) { pendingDemolish = i; return; }
  pendingDemolish = -1;
  spend(cost, editor.demolishPatch(i), `Demolished ${describeBuilding(b).what.toLowerCase()}`);
}
let flash = null;
function flashBlockers(list) { flash = { list, until: performance.now() + 2500 }; }

// --- Hover tooltip --------------------------------------------------------------------
function updateHover() {
  const tip = $("tip");
  if (!mouse || (down && down.pan && down.moved) || lanesState) { tip.style.display = "none"; return; }
  const [x, y] = toWorld(mouse.x, mouse.y);
  hover = null;
  let html = "";
  tip.classList.toggle("chips", tool === "build");
  if (tool === "build") {
    // Trafficity-style chips next to the cursor: price · angle · snap · level · slip road
    const plan = currentPlan(), a = currentAim(), chip = (t, cls = "") => `<span class="chip ${cls}">${t}</span>`;
    const lvName = LEVELS.find((l) => l.level === buildLevel).name;
    const chips = [];
    if (!buildStart) chips.push(chip(buildMode === "smooth" ? "Click to start" : buildMode === "curve" ? "Click to start a curve" : "Click to start a straight road"));
    else if (buildMode === "curve" && !curveCtrl) chips.push(chip(a?.len >= 1 ? `${Math.round(a.len)} m` : "Click to set the bend"));
    if (buildLevel) chips.push(chip(`${buildLevel > 0 ? "▲" : "▼"} ${lvName}`, "lvl"));
    if (plan && plan.len >= 1) {
      const err = plan.error ?? (plan.blockers.length ? `${plan.blockers.length} building${plan.blockers.length > 1 ? "s" : ""} in the way` : plan.cost > save.budget ? "Not enough money" : "");
      chips.unshift(chip(money(plan.cost), "cost"));
      chips.splice(1, 0, chip(`${Math.round(plan.len)} m`));
      const turn = plan.turn || 0;
      if (turn >= 0.5) chips.push(chip(`↻ ${turn.toFixed(1)}°`));
      else if (a?.guide) chips.push(chip(a.guide.label ?? `${bearing(a.guide.ang)}°`));
      const label = plan.tangent?.label;
      if (label && !(a?.guide && a.guide.label === label)) chips.push(chip(label));
      if (plan.passes.length) chips.push(chip(`${plan.passes.some((p) => p.over) ? "over" : "under"} ${plan.passes.length} road${plan.passes.length > 1 ? "s" : ""}`));
      if (plan.junctions) chips.push(chip(`${plan.junctions} junction${plan.junctions > 1 ? "s" : ""}`));
      for (const sl of plan.slips) chips.push(chip(`${sl.kind === "merge" ? "Merge" : "Exit"}${sl.aux ? ` · +${sl.aux} lane ${Math.round(sl.auxLen)} m` : ""}`, "slip"));
      if (err) chips.push(`<br>${chip(err, "err")}`);
    }
    const hint = !buildStart ? "PgUp/PgDn: bridge / tunnel · C: mode" : buildMode === "curve" && !curveCtrl ? "right-click / Esc to stop" : "click to build · right-click / Esc to stop";
    html = chips.join("") + `<div class="hint">${hint}</div>`;
  } else if (tool === "demolish") {
    const i = editor.hitBuilding(x, y);
    if (i >= 0) {
      hover = { building: i };
      const b = editor.buildings[i], { what, people } = describeBuilding(b), cost = buildingCost(b);
      html = `<b>${what}</b>${people ? `<br>${people}` : ""}<br><span class="cost">${money(cost)}</span>` +
        (cost > save.budget ? `<br><span class="err">Not enough money</span>` : cost >= 1_000_000 ? `<br><span style='opacity:.7'>${pendingDemolish === i ? "Click again to demolish" : "Click twice to demolish"}</span>` : "");
    }
  } else {
    const h = editor.hitSegment(x, y, 8 / view.scale);
    const i = h ? -1 : tool === "pan" ? editor.hitBuilding(x, y) : -1;
    if (h) {
      hover = { seg: h.seg.id };
      const s = h.seg, name = s.name ?? "Unnamed road";
      const lanes = s.bwdLanes ? `${s.fwdLanes} + ${s.bwdLanes} lanes` : `one-way, ${s.fwdLanes} lane${s.fwdLanes > 1 ? "s" : ""}`;
      html = `<b>${name}</b><br>${s.hw.replace("_", " ")} · ${lanes}`;
      const c = congestion ? Math.min(...[s.fwd, s.bwd].filter((e) => e >= 0).map((e) => (congestion[e] < 0 ? 1 : congestion[e]))) : 1;
      if (tool === "pan") html += `<br>${c >= 0.75 ? "flowing freely" : `traffic at ${Math.round(c * 100)}% of free-flow speed`}`;
      const segs = selection.length ? segsFromSelection() : [s];
      if (tool === "upgrade") { const p = editor.planChange(upgradeChanges(segs)); html += `<br>→ ${roadType.name}: <span class="cost">${money(p.cost)}</span>${p.blockers.length ? `<br><span class="err">${p.blockers.length} building(s) in the way</span>` : ""}`; }
      if (tool === "bulldoze") html += `<br>Remove: <span class="cost">${money(editor.planRemove(segs).cost)}</span>`;
      if (tool === "lanes") html += "<br><span style='opacity:.7'>Click or drag along the road to edit lanes</span>";
    } else if (i >= 0) {
      const { what, people } = describeBuilding(editor.buildings[i]);
      html = `<b>${what}</b>${people ? `<br>${people}` : ""}`;
    }
  }
  tip.innerHTML = html;
  tip.style.display = html ? "block" : "none";
  tip.style.left = Math.min(mouse.x + 16, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.min(mouse.y + 16, innerHeight - tip.offsetHeight - 8) + "px";
}

// --- Keys -----------------------------------------------------------------------------
addEventListener("keydown", (e) => {
  if (e.target.closest?.("select, input")) return;
  if (e.key === "Alt") { freeAim = true; updateHover(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); updateHover(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); updateHover(); return; }
  if (e.metaKey || e.ctrlKey) return;
  const t = TOOLS.find((t) => t.key === e.key);
  if (t) setTool(t.id);
  else if (e.key.toLowerCase() === "c" && tool === "build") setBuildMode(BUILD_MODES[(BUILD_MODES.indexOf(buildMode) + 1) % BUILD_MODES.length]);
  else if ((e.key === "PageUp" || e.key === "]") && tool === "build") { e.preventDefault(); setBuildLevel(buildLevel + 1); }
  else if ((e.key === "PageDown" || e.key === "[") && tool === "build") { e.preventDefault(); setBuildLevel(buildLevel - 1); }
  else if (e.key.toLowerCase() === "g" && tool === "build") { laneGain = !laneGain; $("laneGain").checked = laneGain; updateHover(); }
  else if (e.key === "Escape") { if (curveCtrl) curveCtrl = null; else if (followed !== null) follow(null); else resetPointerState(); updateHover(); }
  else if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
});
addEventListener("keyup", (e) => { if (e.key === "Alt") { freeAim = false; updateHover(); } });

// --- Time controls & HUD ----------------------------------------------------------------
function setPlaying(p) {
  if (dayOver) return;
  playing = p;
  $("play").textContent = p ? "❚❚" : "▶";
  worker.postMessage({ cmd: p ? "play" : "pause" });
}
onPress($("play"), () => setPlaying(!playing));
onPress($("speeds"), (e) => {
  const b = e.target.closest("button"); if (!b) return;
  for (const x of $("speeds").children) x.classList.toggle("on", x === b);
  setSpeed(Number(b.dataset.s));
});
// ×1 = one game hour per real minute
function setSpeed(mult) { worker.postMessage({ cmd: "speed", speed: (clockToSim(3600) / TIME.realSecPerGameHour) * mult }); }
setSpeed(1);
function skipTo(clockSec, label) {
  $("skip").textContent = label; $("skip").disabled = true; skipping = true;
  worker.postMessage({ cmd: "skipTo", t: clockToSim(clockSec) });
}
let skipping = false;
$("skip").onclick = () => skipTo(7 * 3600, "⏩ skipping…");
for (const id of ["showJams", "showCars"]) $(id).onchange = () => (mapDirty = true);


// Baseline totals at sim time t (untouched network, same demand), sampled every 5 game minutes.
// The live comparison uses the worker's stats from the same sample time, so nothing is
// interpolated (that was 0.3% off at 07:43 before anything was built).
function baselineAt(t) {
  const { series, every, fields } = baseline;
  if (t >= (series.length - 1) * every) return baseline.final;
  const k = Math.floor(t / every), f = t / every - k, out = {};
  fields.forEach((key, j) => (out[key] = series[k][j] * (1 - f) + series[k + 1][j] * f));
  return out;
}

function updateHud() {
  $("budget").textContent = money(save.budget).replace("M", " M");
  $("budget").classList.toggle("neg", save.budget < 0);
  $("dayLabel").textContent = dayOver ? `Day ${save.day - 1} · finished` : `Day ${save.day} · Weekday`;
  const u = save.undo.at(-1), r = save.redo.at(-1);
  $("undo").disabled = !u; $("undo").title = u ? `Undo: ${u.what} (${money(u.cost)} back) · ⌘Z` : "Nothing to undo today";
  $("redo").disabled = !r; $("redo").title = r ? `Redo: ${r.what} · ⇧⌘Z` : "Nothing to redo";
  const left = ECONOMY.strikesBeforeCut - save.strikes;
  $("council").textContent = !save.strikes ? "" : `Council: ${save.strikes} day${save.strikes > 1 ? "s" : ""} worse than the untouched city. ${left} more and ${save.cuts >= ECONOMY.cutsBeforeFired ? "you're fired" : `they cut your budget by ${ECONOMY.budgetCut * 100}%`}.`;
  if (!stats) return;
  const clock = clockOf(stats.t);
  $("clock").textContent = dayOver ? "24:00" : fmtClock(clock);
  $("period").textContent = dayOver ? "Day over" : PERIODS.filter(([h]) => clock / 3600 >= h).at(-1)[1];
  $("skip").disabled = clock >= 7 * 3600 || dayOver || skipping;
  // after midnight only the last long trips are left: run them out quickly
  if (clock >= 24 * 3600 && playing && !skipping && !dayOver) skipTo(TIME.dayEndHour * 3600, "⏩ finishing the day…");
  const lost = lostHours(stats);
  const rows = [
    ["Cars on the road", stats.onRoad.toLocaleString()],
    ["Trips so far", `${(stats.departed - stats.unroutable).toLocaleString()} / ${stats.total.toLocaleString()}`],
    ["Average trip", stats.arrived ? fmtDur(stats.avgTripMin * 60 * TIME.stretch) : "—"],
    ["Hours lost in traffic", Math.round(lost).toLocaleString()],
  ];
  if (baseline) {
    const sample = frame?.sample, base = sample && lostHours(baselineAt(sample.t)), mine = sample && lostHours(sample);
    if (base > 200) {
      rows.push([`vs. untouched city <span class="muted">(${fmtClock(clockOf(sample.t))})</span>`, vsUntouched((base - mine) / base)]);
    } else rows.push(["vs. untouched city", "<span class='muted'>from 07:00</span>"]);
  }
  if (stats.suppressed) rows.push(["Trips given up (jams)", stats.suppressed.toLocaleString()]);
  if (stats.unroutable) rows.push(["<span class='bad'>Trips with no route</span>", `<b class="bad">${stats.unroutable.toLocaleString()}</b>`]);
  if (stats.removed) rows.push(["Trips gone with demolished homes/jobs", stats.removed.toLocaleString()]);
  $("stats").innerHTML = rows.map(([k, v]) => `<span>${k}</span><span class="num">${v}</span>`).join("");
}

function endOfDay(st) {
  dayOver = true; playing = false; $("play").textContent = "▶";
  hover = null;
  const lost = lostHours(st), base = lostHours(baseline.final);
  const r = dayResult(lost, base, save);
  $("deTitle").textContent = r.fired ? "You're fired" : `Day ${save.day} complete`;
  const vs = !beyondNoise(r.d) ? `Delay <b>about the same</b> as (within ±${ECONOMY.noiseBand * 100}%)` : `Delay ${vsUntouched(r.d)} than`;
  $("deSub").innerHTML = `${vs} the untouched city · ${st.arrived.toLocaleString()} trips, average ${fmtDur(st.avgTripMin * 60 * TIME.stretch)} (untouched: ${fmtDur(baseline.final.avgTripMin * 60 * TIME.stretch)})`;
  $("deStats").innerHTML = [
    ["Hours lost in traffic", `${Math.round(lost).toLocaleString()}`],
    ["Untouched city", `${Math.round(base).toLocaleString()}`],
    [`Council grant (${money(ECONOMY.baseGrant)} ± ${money(ECONOMY.performanceGrant)} on results)`, `<b class="${r.grant >= ECONOMY.baseGrant ? "good" : "bad"}">${money(r.grant)}</b>`],
    [r.bonus >= 0 ? `Bonus for time saved beyond ±${ECONOMY.noiseBand * 100}% (£${ECONOMY.perHourSaved}/h)` : `Penalty for extra delay beyond ${ECONOMY.noiseBand * 100}% (£${ECONOMY.perHourSaved}/h)`, `<b class="${r.bonus >= 0 ? "good" : "bad"}">${r.bonus >= 0 ? "+" : ""}${money(r.bonus)}</b>`],
    ...(r.cut ? [["Council budget cut", `<b class="bad">${money(-r.cut)}</b>`]] : []),
    ["Income", `<span class="total ${r.income < 0 ? "bad" : ""}">${money(r.income)}</span>`],
  ].map(([k, v]) => `<span>${k}</span><span class="num">${v}</span>`).join("");
  const council = $("deCouncil");
  council.className = r.fired || r.councilCut || r.strikes ? "bad" : "muted";
  council.textContent = r.fired === "broke" ? "The transport budget is overspent. The council has replaced you."
    : r.fired ? `${ECONOMY.strikesBeforeCut} more days worse than doing nothing, after a budget cut. The council has replaced you.`
    : r.councilCut ? `${ECONOMY.strikesBeforeCut} days in a row worse than the untouched city: the council has ${r.cut ? `taken back ${money(r.cut)}` : "put you on notice"}. Another run like that and you're out.`
    : r.strikes ? `Worse than the untouched city ${r.strikes} day${r.strikes > 1 ? "s" : ""} running. ${ECONOMY.strikesBeforeCut - r.strikes} more and the council steps in.`
    : "";
  $("deNext").textContent = r.fired ? "Start again" : "Start next day";
  save.fired = r.fired;
  save.budget += r.income; save.day += 1; save.strikes = r.strikes; save.cuts = r.cuts;
  save.undo = []; save.redo = []; // a finished day's edits are final
  persist(); updateHud();
  $("dayEnd").style.display = "block";
}
$("deNext").onclick = () => {
  if (save.fired) {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
    location.reload();
    return;
  }
  $("dayEnd").style.display = "none"; dayOver = false;
  $("skip").textContent = "⏩ to 07:00"; skipping = false;
  follow(null);
  worker.postMessage({ cmd: "newDay" });
  updateHud();
};

function toast(text) {
  const el = document.createElement("div");
  el.textContent = text;
  $("toast").append(el);
  setTimeout(() => (el.style.opacity = 0), 2600);
  setTimeout(() => el.remove(), 3100);
}

// --- Drawing --------------------------------------------------------------------------
function drawMap() {
  const g = mctx;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  setWorld(g);
  // green for free flow only where cars aren't drawn; zoomed in, the cars show it
  map.draw(g, view.scale, { congestion, showJams: $("showJams").checked, showFree: !carsShown() || !$("showCars").checked });
}

function strokeSeg(g, s, color, extra = 2) {
  g.strokeStyle = color; g.lineWidth = Math.max(editor.segWidth(s) + extra, 6 / view.scale);
  const p = new Path2D(); s.geom.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y)));
  // two-way: band is centred on the geometry; one-way: also centred
  g.stroke(p);
}
function fillBuilding(g, i, color) {
  const p = new Path2D(); editor.buildings[i].ring.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath();
  g.fillStyle = color; g.fill(p);
}
// The road being planned, drawn like a real one: kerb + asphalt + lane lines; bridge parts on
// a dark deck with a shadow, tunnel parts dashed and faint (Trafficity-style), node dots
function drawPlan(g, plan, bad) {
  const { geom, zAt, type } = plan, lanes = type.fwd + type.bwd, w = lanes * LANE_W, px = 1 / view.scale;
  // split the centre line into runs by how it's built (ground / bridge / tunnel)
  const runs = [], step = 4;
  let cur = null;
  for (let s = 0; s <= plan.len + step - 0.01; s += step) {
    const d = Math.min(s, plan.len), z = zAt(d), kind = z >= GRADE.airborne ? 1 : z <= -GRADE.airborne ? -1 : 0, pt = pointOnLine(geom, d);
    if (!cur || cur.kind !== kind) { if (cur) cur.pts.push(pt); cur = { kind, pts: [pt] }; runs.push(cur); }
    else cur.pts.push(pt);
  }
  const path = (pts) => { const p = new Path2D(); pts.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y))); return p; };
  g.save(); g.lineCap = "butt"; g.lineJoin = "round";
  for (const r of runs) {
    const p = path(r.pts);
    g.globalAlpha = r.kind < 0 ? 0.45 : 0.92;
    if (r.kind > 0) { g.save(); g.translate(1.6, 2.4); g.strokeStyle = "#1f232633"; g.lineWidth = w + 4; g.stroke(p); g.restore(); }
    if (r.kind < 0) g.setLineDash([4, 3]);
    g.strokeStyle = bad ? "#b91c1c" : r.kind > 0 ? COLORS.deck : "#1f2326"; g.lineWidth = w + (r.kind > 0 ? 2.2 : 1.4); g.stroke(p);
    g.setLineDash([]);
    g.strokeStyle = bad ? "#fca5a5" : "#f4f5f6"; g.lineWidth = w; g.stroke(p);
  }
  // lane lines and direction arrows
  g.globalAlpha = 0.9; g.strokeStyle = bad ? "#b91c1c" : "#9aa1a6"; g.lineWidth = Math.max(0.2, 0.9 * px);
  for (let k = 1; k < lanes; k++) {
    const off = (type.bwd ? k - type.bwd : k - lanes / 2) * LANE_W;
    if (type.bwd && k === type.bwd) { g.strokeStyle = bad ? "#b91c1c" : "#e0b400"; g.setLineDash([]); }
    else { g.strokeStyle = bad ? "#b91c1c" : "#9aa1a6"; g.setLineDash([3, 4]); }
    g.stroke(path(offsetLine(geom, off)));
  }
  g.setLineDash([]);
  // node dots at both ends and where the road changes level, like Trafficity's handles
  g.globalAlpha = 1; g.fillStyle = "#1f2326";
  const dot = ([x, y]) => { g.beginPath(); g.arc(x, y, Math.max(0.9, 3.2 * px), 0, Math.PI * 2); g.fill(); };
  for (const r of runs) { const half = (w / 2) + 0.6, a = r.pts[0], b = r.pts.at(-1);
    for (const [pt, nb] of [[a, r.pts[1] ?? b], [b, r.pts.at(-2) ?? a]]) {
      const d = unit(pt, nb), n = [-d[1], d[0]];
      dot([pt[0] + n[0] * half, pt[1] + n[1] * half]); dot([pt[0] - n[0] * half, pt[1] - n[1] * half]);
    } }
  // slip roads: the lane the main road gains
  for (const sl of plan.slips) {
    if (!sl.aux) continue;
    const seg = editor.segs[sl.seg], a = Math.min(sl.s, sl.sAux), b = Math.max(sl.s, sl.sAux);
    const pts = []; for (let s = a; s <= b; s += 3) pts.push(pointOnLine(seg.geom, s));
    pts.push(pointOnLine(seg.geom, b));
    const lanesHere = sl.dir === "fwd" ? seg.fwdLanes : seg.bwdLanes, twin = seg.fwd >= 0 && seg.bwd >= 0;
    const line = sl.dir === "fwd" ? pts : [...pts].reverse();
    const off = twin ? (lanesHere + sl.aux / 2) * LANE_W : (lanesHere / 2 + sl.aux / 2) * LANE_W;
    g.globalAlpha = 0.7; g.strokeStyle = bad ? "#dc2626" : "#38bdf8"; g.lineWidth = sl.aux * LANE_W; g.stroke(path(offsetLine(line, off)));
  }
  g.restore();
}
// Where the planned road passes over / under another one
function passMarker(g, c) {
  const r = 5 / view.scale;
  g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
  g.lineWidth = 1.5 / view.scale; g.strokeStyle = "#1f2326"; g.stroke();
  g.beginPath(); const s = c.over ? -1 : 1;
  g.moveTo(c.x - r * 0.5, c.y - s * r * 0.2); g.lineTo(c.x, c.y + s * r * 0.35); g.lineTo(c.x + r * 0.5, c.y - s * r * 0.2);
  g.moveTo(c.x - r * 0.5, c.y - s * r * 0.2); g.lineTo(c.x, c.y - s * r * 0.55); g.lineTo(c.x + r * 0.5, c.y - s * r * 0.2);
  g.stroke();
}
function snapMarker(g, t, color) {
  g.beginPath(); g.arc(t.x, t.y, (t.kind === "free" ? 4 : 6) / view.scale, 0, Math.PI * 2);
  g.fillStyle = "#fff"; g.fill(); g.lineWidth = 2.5 / view.scale; g.strokeStyle = color; g.stroke();
}

function drawOverlay() {
  const g = octx;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ov.width, ov.height);
  setWorld(g);
  g.lineCap = g.lineJoin = "round";
  if ($("showCars").checked) drawCars(g);
  g.globalAlpha = 0.55;
  const selColor = tool === "bulldoze" ? "#dc2626" : "#2563eb";
  for (const id of selection) strokeSeg(g, editor.segs[id], selColor, 3);
  if (lanesState) { for (const s of lanesState.segs) strokeSeg(g, s, "#2563eb", 3); for (const b of lanesState.blockers ?? []) fillBuilding(g, b, "#dc2626"); }
  if (hover?.seg !== undefined && !selection.includes(hover.seg) && tool !== "build") strokeSeg(g, editor.segs[hover.seg], tool === "bulldoze" ? "#dc2626" : tool === "pan" ? "#1f2326" : "#2563eb", 2);
  if (hover?.building !== undefined && tool === "demolish") fillBuilding(g, hover.building, pendingDemolish === hover.building ? "#b91c1c" : "#dc2626");
  if (flash && performance.now() < flash.until) for (const b of flash.list) fillBuilding(g, b, "#dc2626");
  g.globalAlpha = 1;
  if (tool === "build" && mouse) {
    const a = currentAim(), t = a.t;
    const plan = currentPlan();
    if (a.guide) { // dashed guide along the snapped direction
      const { from, ang } = a.guide, L = a.len + 60 / view.scale;
      g.save(); g.setLineDash([6 / view.scale, 5 / view.scale]); g.lineWidth = 1.5 / view.scale; g.strokeStyle = "#2563eb"; g.globalAlpha = 0.8;
      g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(from.x + Math.cos(ang) * L, from.y + Math.sin(ang) * L); g.stroke(); g.restore();
    }
    if (buildMode === "curve" && buildStart && !curveCtrl) { // first leg of a curve: where the bend goes
      g.save(); g.setLineDash([4 / view.scale, 4 / view.scale]); g.lineWidth = 2 / view.scale; g.strokeStyle = "#64748b";
      g.beginPath(); g.moveTo(buildStart.x, buildStart.y); g.lineTo(t.x, t.y); g.stroke(); g.restore();
      snapMarker(g, buildStart, "#2563eb");
    }
    if (plan) {
      const bad = plan.error || plan.blockers.length || plan.cost > save.budget;
      drawPlan(g, plan, bad);
      g.globalAlpha = 0.6;
      for (const b of plan.blockers) fillBuilding(g, b, "#dc2626");
      g.globalAlpha = 1;
      if (curveCtrl) { // the bend's handles
        g.save(); g.setLineDash([4 / view.scale, 4 / view.scale]); g.lineWidth = 1.2 / view.scale; g.strokeStyle = "#64748b";
        g.beginPath(); g.moveTo(buildStart.x, buildStart.y); g.lineTo(curveCtrl.x, curveCtrl.y); g.lineTo(t.x, t.y); g.stroke(); g.restore();
        snapMarker(g, { ...curveCtrl, kind: "free" }, "#64748b");
      }
      for (const c of plan.passes) passMarker(g, c);
      for (const c of plan.clashes) snapMarker(g, { ...c, kind: "node" }, "#dc2626");
      for (const c of plan.crossings) snapMarker(g, { ...c, kind: "node" }, "#f59e0b");
      snapMarker(g, buildStart, "#2563eb");
    }
    snapMarker(g, t, t.kind === "free" ? "#64748b" : "#2563eb");
  }
}

// --- Cars -------------------------------------------------------------------------------
// Each frame from the worker gives every car's spot, heading and trip id. Cars glide towards
// their latest spot between frames, so queues creep forward instead of jumping.
const shown = new Map(); // trip id → [x, y, heading, stamp]
let stamp = 0, lastDraw = performance.now();
function onCars(data) {
  stamp++;
  const { pos, head, ids } = data;
  for (let i = 0; i < ids.length; i++) {
    let p = shown.get(ids[i]);
    const x = pos[i * 2], y = pos[i * 2 + 1];
    // new car, or too far from where it's drawn to glide (e.g. the page wasn't drawing): jump
    if (!p || Math.hypot(p[0] - x, p[1] - y) > 25) { p = [x, y, head[i], stamp, x, y, head[i]]; shown.set(ids[i], p); }
    p[3] = stamp; p[4] = x; p[5] = y; p[6] = head[i];
  }
  if (shown.size > ids.length * 1.3 + 100) for (const [id, p] of shown) if (p[3] !== stamp) shown.delete(id);
  if (followed !== null && !shown.has(followed)) refreshCar();
}
const BODY = ["#f4f5f6", "#2b2f33", "#8d959c", "#2563eb", "#d93a32", "#1e3a5f", "#3f7d4f", "#e8b931"];
const LORRY = "#5b6770", BUS = "#c8312a";
// Zoomed out further than this (px per metre), cars are hidden (only a followed one stays)
// and the jam colours tell the story. Cars are drawn at least 9 px long, so below ~0.6 even
// moving traffic (~20 m apart) is a solid smear covering the red it sits on (checked on
// frames at 0.3 / 0.45 / 0.6 / 0.9 at the 08:40 peak); and ~8k cars cost more than the map.
const CARS_MIN_SCALE = 0.6;
const carsShown = () => view.scale >= CARS_MIN_SCALE;
let carHint = null;
function drawCars(g) {
  const now = performance.now(), dt = now - lastDraw; lastDraw = now;
  const a = dt > 250 ? 1 : 1 - Math.exp(-dt / 90);
  const all = carsShown();
  if (carHint !== all) { carHint = all; $("carHint").textContent = all ? "Click a car to follow it" : "Zoom in to see cars"; }
  // on screen, with room for a car drawn up to 5× long
  const [x0, y0] = toWorld(-60, -60), [x1, y1] = toWorld(innerWidth + 60, innerHeight + 60);
  // cars are drawn at least ~9 px long so you can see and follow them when zoomed out
  const grow = Math.min(5, Math.max(1, 9 / (VEHICLES[0].len * view.scale)));
  const asDots = VEHICLES[0].len * view.scale * grow < 6;
  const fills = new Map(), glass = new Path2D();
  const pathFor = (c) => fills.get(c) ?? fills.set(c, new Path2D()).get(c);
  const detail = VEHICLES[0].len * view.scale * grow > 16;
  for (const [id, p] of shown) {
    if (p[3] !== stamp) continue;
    p[0] += (p[4] - p[0]) * a; p[1] += (p[5] - p[1]) * a;
    let dh = p[6] - p[2]; dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI; p[2] += dh * a;
    if (all ? p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1 : id !== followed) continue;
    const kind = vehicleOf(id), col = kind === 3 ? BUS : kind === 2 ? LORRY : BODY[colourOf(id)];
    if (asDots) { const sz = 2.2 / view.scale; pathFor(col).rect(p[0] - sz / 2, p[1] - sz / 2, sz, sz); continue; }
    const v = VEHICLES[kind], hl = (v.len * grow) / 2, hw = (v.w * Math.min(grow, 1.8)) / 2;
    const cx = Math.cos(p[2]), cy = Math.sin(p[2]);
    const path = pathFor(col);
    path.moveTo(p[0] + cx * hl - cy * hw, p[1] + cy * hl + cx * hw);
    path.lineTo(p[0] + cx * hl + cy * hw, p[1] + cy * hl - cx * hw);
    path.lineTo(p[0] - cx * hl + cy * hw, p[1] - cy * hl - cx * hw);
    path.lineTo(p[0] - cx * hl - cy * hw, p[1] - cy * hl + cx * hw);
    path.closePath();
    if (detail) { // windscreen
      const f0 = hl * (kind >= 2 ? 0.92 : 0.45), f1 = hl * (kind >= 2 ? 0.7 : 0.1), w = hw * 0.82;
      glass.moveTo(p[0] + cx * f0 - cy * w, p[1] + cy * f0 + cx * w);
      glass.lineTo(p[0] + cx * f0 + cy * w, p[1] + cy * f0 - cx * w);
      glass.lineTo(p[0] + cx * f1 + cy * w, p[1] + cy * f1 - cx * w);
      glass.lineTo(p[0] + cx * f1 - cy * w, p[1] + cy * f1 + cx * w);
      glass.closePath();
    }
  }
  if (followed !== null) drawFollowedRoute(g);
  g.lineWidth = 0.9 / view.scale; g.strokeStyle = "#1f232699";
  for (const [col, path] of fills) { g.fillStyle = col; g.fill(path); if (!asDots) g.stroke(path); }
  if (detail) { g.fillStyle = "#1f2a36cc"; g.fill(glass); }
  const p = followed !== null && shown.get(followed);
  if (p) {
    g.beginPath(); g.arc(p[0], p[1], 14 / view.scale, 0, Math.PI * 2);
    g.lineWidth = 3 / view.scale; g.strokeStyle = "#2563eb"; g.stroke();
    keepInView(p);
  }
}

// --- Following one car ------------------------------------------------------------------
let followed = null, carInfo = null, carTimer = null, arrivedAt = null;
function carAt(sx, sy) {
  if (!carsShown() || !$("showCars").checked) return null;
  const [x, y] = toWorld(sx, sy), r = 14 / view.scale;
  let best = null, bd = r;
  for (const [id, p] of shown) {
    if (p[3] !== stamp) continue;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
function follow(id) {
  followed = id; carInfo = null; arrivedAt = null;
  clearInterval(carTimer);
  if (id === null) { $("carCard").style.display = "none"; return; }
  refreshCar();
  carTimer = setInterval(refreshCar, 300);
}
function refreshCar() { if (followed !== null) worker.postMessage({ cmd: "car", id: followed }); }
const roadName = (() => {
  let byNode = null;
  return (node) => {
    if (!byNode) { byNode = new Map(); for (const e of graph.edges) if (e.name && !e.dead) for (const v of [e.from, e.to]) if (!byNode.has(v)) byNode.set(v, e.name); }
    return byNode.get(node) ?? null;
  };
})();
function showCar(c) {
  if (c.id !== followed) return;
  carInfo = c;
  const v = VEHICLES[vehicleOf(c.id)], card = $("carCard");
  card.style.display = "block";
  const from = roadName(c.from), to = roadName(c.to);
  let html = `<div class="row1"><b>${v.name}</b><span class="muted">${PURPOSE[c.purpose] ?? ""}</span><button id="unfollow" title="Stop following (Esc)">✕</button></div>`;
  html += `<div class="muted">${from ? `from ${from}` : "from the edge of the map"}<br>${to ? `to ${to}` : "to the edge of the map"}</div>`;
  if (c.onRoad !== undefined) {
    const now = clockOf(c.depart + c.onRoad);
    html += `<div class="stats"><span>Left at</span><span class="num">${fmtClock(clockOf(c.depart))}</span>` +
      `<span>On the road</span><span class="num">${fmtDur(clockOf(c.onRoad))}</span>` +
      `<span>Stuck in traffic</span><span class="num ${c.delay * TIME.stretch > 600 ? "bad" : ""}">${fmtDur(clockOf(c.delay))}</span>` +
      `<span>Now on</span><span>${graph.edges[c.edge]?.name ?? graph.edges[c.edge]?.highway.replace("_", " ") ?? "—"}</span>` +
      `<span>Expected</span><span class="num">${fmtClock(now + clockOf(Math.max(0, c.freeTotal - (c.onRoad - c.delay))))}${c.delay > 0 ? " if clear" : ""}</span></div>`;
  } else if (c.arrived) {
    arrivedAt ??= stats ? clockOf(stats.t) : null;
    html += `<div class="good" style="margin-top:6px"><b>Arrived${arrivedAt !== null ? ` at ${fmtClock(arrivedAt)}` : ""}</b></div>`;
    clearInterval(carTimer);
  } else html += `<div class="muted" style="margin-top:6px">Not on the road</div>`;
  card.innerHTML = html;
  $("unfollow").onclick = () => follow(null);
}
function drawFollowedRoute(g) {
  if (!carInfo?.ahead) return;
  const p = new Path2D();
  for (const e of carInfo.ahead) { const geom = graph.edges[e]?.geom; if (geom) geom.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y))); }
  g.save(); g.globalAlpha = 0.5; g.strokeStyle = "#2563eb"; g.lineWidth = Math.max(3, 5 / view.scale); g.lineCap = g.lineJoin = "round"; g.stroke(p); g.restore();
}
// Glide the map along when the followed car nears the edge of the screen
function keepInView(p) {
  const sx = (p[0] - view.cx) * view.scale, sy = (p[1] - view.cy) * view.scale;
  const mx = innerWidth * 0.25, my = innerHeight * 0.25;
  if (Math.abs(sx) > mx || Math.abs(sy) > my) {
    view.cx += (sx / view.scale) * 0.08; view.cy += (sy / view.scale) * 0.08;
    mapDirty = true; rememberView();
  }
}

function tick() {
  if (mapDirty) { drawMap(); mapDirty = false; }
  drawOverlay();
  requestAnimationFrame(tick);
}
setTool("pan");
worker.onmessage = onWorker;
// console handle for debugging and scripted tests
window.roadblock = { editor, map, save, worker, cars: shown, get congestion() { return congestion; }, get view() { return view; }, setView(v) { Object.assign(view, v); mapDirty = true; }, toWorld };
updateHud();
requestAnimationFrame(tick);
