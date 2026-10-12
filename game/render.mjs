// Map drawing for game.html (Canvas 2D, world units = metres, x east, y south).
// Static layers (land, buildings, roads) are cached Path2Ds rebuilt only after an edit.
import { offsetLine, bandOffset, laneOffset } from "./network.mjs";
import { LANE_W } from "./rules.mjs";

export const COLORS = {
  land: "#eceeec", water: "#bfe0ee", park: "#d3e8bf", wood: "#c2dfab",
  building: "#d6dadb", buildingEdge: "#c3c8ca", lot: "#e7dcc7", lotEdge: "#cdbd9f",
  kerb: "#7f878e", asphalt: "#a9afb4", marking: "#ffffff", deck: "#2b3035",
  jam: ["#dc2626", "#f97316", "#eab308"], // jammed, heavy, slow
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

export class MapRenderer {
  constructor(editor, footprints) {
    this.ed = editor;
    this.areas = {};
    for (const a of footprints.areas) ringsPath(a.rings, (this.areas[a.kind] ??= new Path2D()));
    this.rebuildBuildings();
    this.rebuildRoads();
  }

  rebuildBuildings() {
    const { buildings, demolished } = this.ed;
    this.bPath = new Path2D(); this.lotPath = new Path2D();
    buildings.forEach((b, i) => { ringsPath([b.ring], demolished.has(i) ? this.lotPath : this.bPath); });
  }

  // One band per directed edge, offset to its side of the street; grouped by level (tunnel,
  // ground, bridge…) and then by lane count
  rebuildRoads() {
    const { graph, twin, segs } = this.ed;
    this.edgePath = new Array(graph.edges.length);
    this.levels = new Map(); // level → { bands: lanes → Path2D, centre, dividers, outline }
    const at = (lv) => this.levels.get(lv) ?? this.levels.set(lv, { bands: new Map(), centre: new Path2D(), dividers: new Path2D() }).get(lv);
    this.arrows = laneArrows(graph, twin);
    graph.edges.forEach((e, i) => {
      if (e.dead) return;
      const lanes = Math.max(1, Math.round(e.lanes)), hasTwin = twin[i] >= 0, L = at(levelOf(e));
      const p = linePath(offsetLine(e.geom, bandOffset(lanes, hasTwin)));
      this.edgePath[i] = p;
      (L.bands.get(lanes) ?? L.bands.set(lanes, new Path2D()).get(lanes)).addPath(p);
      for (let k = 1; k < lanes; k++) linePath(offsetLine(e.geom, (hasTwin ? k : k - lanes / 2) * LANE_W), L.dividers);
    });
    for (const s of segs) if (s.bwd >= 0) linePath(s.geom, at(levelOf(graph.edges[s.fwd])).centre);
    this.order = [...this.levels.keys()].sort((a, b) => a - b);
  }

  // scale = screen px per metre
  draw(g, scale, { congestion, showJams }) {
    g.fillStyle = COLORS.land; g.fill(new Path2D("M-1e5 -1e5 H1e5 V1e5 H-1e5 Z"));
    for (const [k, c] of [["park", COLORS.park], ["wood", COLORS.wood], ["water", COLORS.water]]) if (this.areas[k]) { g.fillStyle = c; g.fill(this.areas[k]); }
    g.fillStyle = COLORS.building; g.fill(this.bPath);
    g.fillStyle = COLORS.lot; g.fill(this.lotPath);
    if (scale > 1.2) {
      g.lineWidth = 0.6 / scale * 1.5;
      g.strokeStyle = COLORS.buildingEdge; g.stroke(this.bPath);
      g.strokeStyle = COLORS.lotEdge; g.setLineDash([2, 1.5]); g.stroke(this.lotPath); g.setLineDash([]);
    }
    g.lineCap = g.lineJoin = "round";
    const minPx = 1.3 / scale;
    // jam colours per level, so a jam in a tunnel doesn't paint over the street above it
    const jams = new Map();
    if (showJams && congestion) {
      const { graph } = this.ed;
      for (let e = 0; e < congestion.length && e < graph.edges.length; e++) {
        const b = jamBucket(congestion[e]);
        if (b < 0 || !this.edgePath[e]) continue;
        const lv = levelOf(graph.edges[e]), lanes = Math.max(1, Math.round(graph.edges[e].lanes));
        const buckets = jams.get(lv) ?? jams.set(lv, [new Map(), new Map(), new Map()]).get(lv), m = buckets[b];
        (m.get(lanes) ?? m.set(lanes, new Path2D()).get(lanes)).addPath(this.edgePath[e]);
      }
    }
    for (const lv of this.order) {
      const { bands, centre, dividers } = this.levels.get(lv);
      const tunnel = lv < 0, bridge = lv > 0;
      g.globalAlpha = tunnel ? 0.32 : 1;
      if (bridge) { // drop shadow on whatever is below
        g.save(); g.translate(1.6, 2.4); g.strokeStyle = "#1f232633";
        for (const [lanes, p] of bands) { g.lineWidth = Math.max(lanes * LANE_W + 4, minPx + 3 / scale); g.stroke(p); }
        g.restore();
      }
      if (tunnel) g.setLineDash([4, 3]);
      for (const [lanes, p] of bands) { g.strokeStyle = bridge ? COLORS.deck : COLORS.kerb; g.lineWidth = Math.max(lanes * LANE_W + (bridge ? 2.2 : 1.4), minPx + (bridge ? 2 : 1) / scale); g.stroke(p); }
      g.setLineDash([]);
      for (const [lanes, p] of bands) { g.strokeStyle = COLORS.asphalt; g.lineWidth = Math.max(lanes * LANE_W, minPx); g.stroke(p); }
      const jl = jams.get(lv);
      if (jl) {
        g.globalAlpha = tunnel ? 0.32 : 0.85;
        jl.forEach((m, b) => { g.strokeStyle = COLORS.jam[b]; for (const [lanes, p] of m) { g.lineWidth = Math.max(lanes * LANE_W * 0.7, minPx * 1.2); g.stroke(p); } });
      }
      if (scale > 1.4 && !tunnel) {
        const a = Math.min(1, (scale - 1.4) / 1.2);
        g.globalAlpha = a; g.strokeStyle = COLORS.marking;
        g.lineWidth = Math.max(0.2, 0.9 / scale); g.lineCap = "butt";
        g.setLineDash([3, 6]); g.stroke(dividers);
        g.setLineDash([]); g.lineWidth = Math.max(0.25, 1.1 / scale); g.stroke(centre);
        g.lineCap = "round";
        const arrows = this.arrows.get(lv);
        if (arrows && scale > 2.6) { g.globalAlpha = Math.min(1, (scale - 2.6) / 1.2) * 0.9; g.lineWidth = 0.45; g.stroke(arrows); }
      }
      g.globalAlpha = 1;
    }
  }
}

// Lane arrows (Trafficity-style) near the end of every approach to a real junction, by the
// same UK lane-use rule as the lane sim (sim/micro.mjs): left turns from the kerb lane, right
// turns from the offside lane, straight on from any lane. level → Path2D.
function laneArrows(graph, twin) {
  const N = graph.nodes.length, outE = Array.from({ length: N }, () => []), nb = Array.from({ length: N }, () => new Set());
  graph.edges.forEach((e, i) => { if (!e.dead) { outE[e.from].push(i); nb[e.from].add(e.to); nb[e.to].add(e.from); } });
  const out = new Map(), dir = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
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
    const nl = Math.max(1, Math.round(e.lanes)), path = out.get(e.level ?? 0) ?? out.set(e.level ?? 0, new Path2D()).get(e.level ?? 0);
    for (let j = 0; j < nl; j++) { // j = 0 is the kerb lane
      const ks = [...kinds].filter((k) => nl === 1 || kinds.size === 1 || k === "S" || (k === "L" && j === 0) || (k === "R" && j === nl - 1));
      if (!ks.length) continue;
      const line = offsetLine(g, laneOffset(nl, nl - 1 - j, twin[i] >= 0));
      const [x, y, hx, hy] = backFromEnd(line, 9);
      arrowGlyph(path, x, y, hx, hy, ks);
    }
  });
  return out;
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
