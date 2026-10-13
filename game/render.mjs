// Map drawing for game.html (Canvas 2D, world units = metres, x east, y south).
// Static layers (land, buildings, roads) are cached Path2Ds rebuilt only after an edit.
import { offsetLine, bandOffset, laneOffset } from "./network.mjs";
import { LANE_W } from "./rules.mjs";

export const COLORS = {
  land: "#eceeec", water: "#bfe0ee", park: "#d3e8bf", wood: "#c2dfab",
  building: "#d6dadb", buildingEdge: "#c3c8ca", lot: "#e7dcc7", lotEdge: "#cdbd9f",
  kerb: "#7f878e", asphalt: "#a9afb4", marking: "#ffffff", deck: "#2b3035",
  jam: ["#dc2626", "#f97316", "#eab308"], // jammed, heavy, slow
  free: "#22a35a", // cars on it, flowing
  car: ["#2a78d6", "#eb6834", "#1baf7a", "#7a5af5"],
};
export const jamBucket = (c) => (c < 0 || c >= 0.75 ? -1 : c < 0.3 ? 0 : c < 0.5 ? 1 : 2);

// Bridges and tunnels (data/<area>.levels.json, wayId → level): sets `level` on the graph's
// edges, for drawing only. Split pieces inherit it; player-built roads carry their own.
export function applyLevels(graph, levels) {
  if (!levels) return;
  for (const e of graph.edges) { const l = levels[e.wayId]; if (l) e.level = l; }
}
const levelOf = (e) => e.level ?? 0;

const linePath = (pts, path = new Path2D()) => { pts.forEach(([x, y], k) => (k ? path.lineTo(x, y) : path.moveTo(x, y))); return path; };
const ringsPath = (rings, path = new Path2D()) => { for (const r of rings) { linePath(r, path); path.closePath(); } return path; };
const boxOf = (pts) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
};
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// Culling: every shape also goes into the tile holding the centre of its bounding box, and
// the tile's box grows to cover it, so a tile is drawn only when something in it can be on
// screen. Stroking the whole city's paths at street zoom was ~90 ms a frame (mostly building
// outlines). When most tiles are in view the whole-map paths are cheaper (fewer calls).
const TILE = 250; // metres
class Tiles {
  constructor(make) { this.make = make; this.tiles = new Map(); }
  at(box) {
    const key = Math.floor((box[0] + box[2]) / 2 / TILE) * 100003 + Math.floor((box[1] + box[3]) / 2 / TILE);
    let t = this.tiles.get(key);
    if (!t) this.tiles.set(key, (t = { box: [Infinity, Infinity, -Infinity, -Infinity], ...this.make() }));
    const b = t.box;
    b[0] = Math.min(b[0], box[0]); b[1] = Math.min(b[1], box[1]); b[2] = Math.max(b[2], box[2]); b[3] = Math.max(b[3], box[3]);
    return t;
  }
  // the tiles that reach into `view`, or [whole] when that's most of them
  pick(view, whole) {
    const out = [];
    for (const t of this.tiles.values()) if (overlaps(t.box, view)) out.push(t);
    return out.length > this.tiles.size / 2 ? [whole] : out;
  }
}
const roadLayer = () => ({ bands: new Map(), centre: new Path2D(), dividers: new Path2D(), arrows: null });
const levelIn = (o, lv) => o.levels.get(lv) ?? o.levels.set(lv, roadLayer()).get(lv);

export class MapRenderer {
  constructor(editor, footprints) {
    this.ed = editor;
    this.areas = {};
    this.areaTiles = new Tiles(() => ({}));
    for (const a of footprints.areas) {
      ringsPath(a.rings, (this.areas[a.kind] ??= new Path2D()));
      const t = this.areaTiles.at(boxOf(a.rings.flat()));
      ringsPath(a.rings, (t[a.kind] ??= new Path2D()));
    }
    this.rebuildBuildings();
    this.rebuildRoads();
  }

  rebuildBuildings() {
    const { buildings, demolished } = this.ed;
    this.bPath = new Path2D(); this.lotPath = new Path2D();
    this.bTiles = new Tiles(() => ({ bPath: new Path2D(), lotPath: new Path2D() }));
    buildings.forEach((b, i) => {
      const k = demolished.has(i) ? "lotPath" : "bPath";
      ringsPath([b.ring], this[k]);
      ringsPath([b.ring], this.bTiles.at(boxOf(b.ring))[k]);
    });
  }

  // One band per directed edge, offset to its side of the street; grouped by level (tunnel,
  // ground, bridge…) and then by lane count
  rebuildRoads() {
    const { graph, twin, segs } = this.ed;
    this.edgePath = new Array(graph.edges.length);
    this.edgeBox = new Array(graph.edges.length);
    this.levels = new Map(); // level → { bands: lanes → Path2D, centre, dividers, arrows }
    this.rTiles = new Tiles(() => ({ levels: new Map() }));
    graph.edges.forEach((e, i) => {
      if (e.dead) return;
      const lanes = Math.max(1, Math.round(e.lanes)), hasTwin = twin[i] >= 0, lv = levelOf(e);
      const line = offsetLine(e.geom, bandOffset(lanes, hasTwin)), box = boxOf(line);
      const p = linePath(line);
      this.edgePath[i] = p; this.edgeBox[i] = box;
      for (const L of [levelIn(this, lv), levelIn(this.rTiles.at(box), lv)]) {
        (L.bands.get(lanes) ?? L.bands.set(lanes, new Path2D()).get(lanes)).addPath(p);
        for (let k = 1; k < lanes; k++) linePath(offsetLine(e.geom, (hasTwin ? k : k - lanes / 2) * LANE_W), L.dividers);
      }
    });
    for (const s of segs) if (s.bwd >= 0) {
      const lv = levelOf(graph.edges[s.fwd]);
      for (const L of [levelIn(this, lv), levelIn(this.rTiles.at(boxOf(s.geom)), lv)]) linePath(s.geom, L.centre);
    }
    laneArrows(graph, twin, (lv, box) => [levelIn(this, lv), levelIn(this.rTiles.at(box), lv)].map((L) => (L.arrows ??= new Path2D())));
    this.order = [...this.levels.keys()].sort((a, b) => a - b);
  }

  // scale = screen px per metre. What is on screen comes from the context's transform.
  // showFree: green on roads flowing freely (the game shows it only while cars are hidden)
  draw(g, scale, { congestion, showJams, showFree = false }) {
    const t = g.getTransform(), pad = 20 + 10 / scale;
    const view = [-t.e / t.a - pad, -t.f / t.d - pad, (g.canvas.width - t.e) / t.a + pad, (g.canvas.height - t.f) / t.d + pad];
    g.fillStyle = COLORS.land; g.fillRect(view[0], view[1], view[2] - view[0], view[3] - view[1]);
    const A = this.areaTiles.pick(view, this.areas);
    for (const [k, c] of [["park", COLORS.park], ["wood", COLORS.wood], ["water", COLORS.water]]) { g.fillStyle = c; for (const a of A) if (a[k]) g.fill(a[k]); }
    const B = this.bTiles.pick(view, this);
    g.fillStyle = COLORS.building; for (const b of B) g.fill(b.bPath);
    g.fillStyle = COLORS.lot; for (const b of B) g.fill(b.lotPath);
    // big landmarks that aren't plain buildings (the O2): drawn like one, never demolished
    if (this.areas.landmark) { g.fillStyle = COLORS.building; g.fill(this.areas.landmark); g.lineWidth = 1.2 / scale; g.strokeStyle = COLORS.buildingEdge; g.stroke(this.areas.landmark); }
    if (scale > 1.2) {
      g.lineWidth = 0.6 / scale * 1.5;
      g.strokeStyle = COLORS.buildingEdge; for (const b of B) g.stroke(b.bPath);
      g.strokeStyle = COLORS.lotEdge; g.setLineDash([2, 1.5]); for (const b of B) g.stroke(b.lotPath); g.setLineDash([]);
    }
    g.lineCap = g.lineJoin = "round";
    const minPx = 1.3 / scale;
    // traffic colours per level, so a jam in a tunnel doesn't paint over the street above it;
    // bucket 3 = flowing freely (green), empty roads stay grey
    const jams = new Map();
    if (showJams && congestion) {
      const { graph } = this.ed;
      for (let e = 0; e < congestion.length && e < graph.edges.length; e++) {
        const c = congestion[e], b = c >= 0.75 && showFree ? 3 : jamBucket(c);
        if (b < 0 || !this.edgePath[e] || !overlaps(this.edgeBox[e], view)) continue;
        const lv = levelOf(graph.edges[e]), lanes = Math.max(1, Math.round(graph.edges[e].lanes));
        const buckets = jams.get(lv) ?? jams.set(lv, [new Map(), new Map(), new Map(), new Map()]).get(lv), m = buckets[b];
        (m.get(lanes) ?? m.set(lanes, new Path2D()).get(lanes)).addPath(this.edgePath[e]);
      }
    }
    const R = this.rTiles.pick(view, this);
    for (const lv of this.order) {
      const Ls = R.map((r) => r.levels.get(lv)).filter(Boolean);
      const tunnel = lv < 0, bridge = lv > 0;
      g.globalAlpha = tunnel ? 0.32 : 1;
      if (bridge) { // drop shadow on whatever is below
        g.save(); g.translate(1.6, 2.4); g.strokeStyle = "#1f232633";
        for (const { bands } of Ls) for (const [lanes, p] of bands) { g.lineWidth = Math.max(lanes * LANE_W + 4, minPx + 3 / scale); g.stroke(p); }
        g.restore();
      }
      if (tunnel) g.setLineDash([4, 3]);
      g.strokeStyle = bridge ? COLORS.deck : COLORS.kerb;
      for (const { bands } of Ls) for (const [lanes, p] of bands) { g.lineWidth = Math.max(lanes * LANE_W + (bridge ? 2.2 : 1.4), minPx + (bridge ? 2 : 1) / scale); g.stroke(p); }
      g.setLineDash([]);
      g.strokeStyle = COLORS.asphalt;
      for (const { bands } of Ls) for (const [lanes, p] of bands) { g.lineWidth = Math.max(lanes * LANE_W, minPx); g.stroke(p); }
      const jl = jams.get(lv);
      if (jl) {
        g.globalAlpha = tunnel ? 0.32 : 0.85;
        for (const b of [3, 2, 1, 0]) { // worst on top
          g.strokeStyle = b === 3 ? COLORS.free : COLORS.jam[b];
          for (const [lanes, p] of jl[b]) { g.lineWidth = Math.max(lanes * LANE_W * 0.7, 3 / scale); g.stroke(p); }
        }
      }
      if (scale > 1.4 && !tunnel) {
        const a = Math.min(1, (scale - 1.4) / 1.2);
        g.globalAlpha = a; g.strokeStyle = COLORS.marking;
        g.lineWidth = Math.max(0.2, 0.9 / scale); g.lineCap = "butt";
        g.setLineDash([3, 6]); for (const L of Ls) g.stroke(L.dividers);
        g.setLineDash([]); g.lineWidth = Math.max(0.25, 1.1 / scale); for (const L of Ls) g.stroke(L.centre);
        g.lineCap = "round";
        if (scale > 2.6) { g.globalAlpha = Math.min(1, (scale - 2.6) / 1.2) * 0.9; g.lineWidth = 0.45; for (const L of Ls) if (L.arrows) g.stroke(L.arrows); }
      }
      g.globalAlpha = 1;
    }
  }
}

// Lane arrows (Trafficity-style) near the end of every approach to a real junction, by the
// same UK lane-use rule as the lane sim (sim/micro.mjs): left turns from the kerb lane, right
// turns from the offside lane, straight on from any lane. Glyphs go into the paths that
// `into(level, box)` returns.
function laneArrows(graph, twin, into) {
  const N = graph.nodes.length, outE = Array.from({ length: N }, () => []), nb = Array.from({ length: N }, () => new Set());
  graph.edges.forEach((e, i) => { if (!e.dead) { outE[e.from].push(i); nb[e.from].add(e.to); nb[e.to].add(e.from); } });
  const dir = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  graph.edges.forEach((e, i) => {
    if (e.dead || nb[e.to].size < 3 || e.length < 18) return;
    const g = e.geom, dIn = dir(g.at(-2), g.at(-1));
    const kinds = new Set();
    for (const b of outE[e.to]) {
      const eb = graph.edges[b];
      if (eb.to === e.from && eb.wayId === e.wayId) continue; // U-turn
      const dOut = dir(eb.geom[0], eb.geom[1]), turn = Math.atan2(dIn[0] * dOut[1] - dIn[1] * dOut[0], dIn[0] * dOut[0] + dIn[1] * dOut[1]);
      kinds.add(turn < -0.5 ? "L" : turn > 0.5 ? "R" : "S");
    }
    if (!kinds.size) return;
    const nl = Math.max(1, Math.round(e.lanes)), paths = into(e.level ?? 0, boxOf(g));
    for (let j = 0; j < nl; j++) { // j = 0 is the kerb lane
      const ks = [...kinds].filter((k) => nl === 1 || kinds.size === 1 || k === "S" || (k === "L" && j === 0) || (k === "R" && j === nl - 1));
      if (!ks.length) continue;
      const line = offsetLine(g, laneOffset(nl, nl - 1 - j, twin[i] >= 0));
      const [x, y, hx, hy] = backFromEnd(line, 9);
      for (const path of paths) arrowGlyph(path, x, y, hx, hy, ks);
    }
  });
}
// Point `d` metres before the end of a polyline, and the heading there
function backFromEnd(g, d) {
  for (let k = g.length - 1; k > 0; k--) {
    const a = g[k - 1], b = g[k], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l >= d || k === 1) { const t = Math.max(0, 1 - d / (l || 1)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / (l || 1), (b[1] - a[1]) / (l || 1)]; }
    d -= l;
  }
}
// Arrow pointing along (hx, hy) at (x, y): a stem and one head per movement (local: +u ahead, −v left)
function arrowGlyph(path, x, y, hx, hy, kinds) {
  const K = 1.5, P = (u, v) => [x + hx * u * K - hy * v * K, y + hy * u * K + hx * v * K];
  const line = (...pts) => pts.map(([u, v], k) => (k ? path.lineTo(...P(u, v)) : path.moveTo(...P(u, v))));
  line([-2.6, 0], [0, 0]);
  for (const k of kinds) {
    if (k === "S") { line([0, 0], [1.4, 0]); line([0.6, -0.6], [1.4, 0], [0.6, 0.6]); }
    else {
      const s = k === "L" ? -1 : 1; // left = −v
      line([0, 0], [0.9, 1.1 * s]);
      line([0.9 - 0.75, 1.1 * s - 0.05 * s], [0.9, 1.1 * s], [0.9 + 0.05, 1.1 * s - 0.75 * s]);
    }
  }
}
