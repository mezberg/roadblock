// The editable road graph, shared by the page (editing, drawing) and the sim worker.
//
// The player never renumbers anything: a patch appends nodes and edges, flags edges
// `dead`, or changes fields of an edge in place. Both sides start from the same
// data/<area>.graph.json and apply the same patches, so ids always agree.
import { LANE_W } from "./rules.mjs";

// patch = { nodes: [{id, x, y}], add: [edge], kill: [edgeId], revive: [edgeId], mod: [{id, ...fields}],
//           demolish: [building], restore: [building] }
// `revive` and `restore` only appear in undo patches (see invertPatch), so undo never renumbers.
export function applyPatch(graph, p) {
  for (const n of p.nodes ?? []) {
    if (n.id !== graph.nodes.length) throw new Error(`patch node id ${n.id} ≠ ${graph.nodes.length}`);
    graph.nodes.push({ ...n });
  }
  for (const e of p.add ?? []) {
    if (e.id !== graph.edges.length) throw new Error(`patch edge id ${e.id} ≠ ${graph.edges.length}`);
    graph.edges.push({ ...e, geom: e.geom.map((q) => [...q]) });
  }
  for (const id of p.kill ?? []) graph.edges[id].dead = true;
  for (const id of p.revive ?? []) delete graph.edges[id].dead;
  for (const m of p.mod ?? []) Object.assign(graph.edges[m.id], m);
}

// The patch that takes `p` back out. Call it before `p` is applied (it reads the old field
// values `p.mod` overwrites). New nodes stay as unused points; new edges are killed.
export function invertPatch(graph, p) {
  const inv = { nodes: [], add: [], kill: [], revive: [], mod: [], demolish: [], restore: [] };
  for (const e of p.add ?? []) inv.kill.push(e.id);
  for (const id of p.kill ?? []) inv.revive.push(id);
  for (const id of p.revive ?? []) inv.kill.push(id);
  for (const m of [...(p.mod ?? [])].reverse()) {
    const old = graph.edges[m.id], back = { id: m.id };
    for (const k of Object.keys(m)) if (k !== "id") back[k] = old[k];
    inv.mod.push(back);
  }
  inv.restore = [...(p.demolish ?? [])];
  inv.demolish = [...(p.restore ?? [])];
  return inv;
}
export const touchesRoads = (p) => !!(p.add?.length || p.kill?.length || p.revive?.length || p.mod?.length);

const pairKey = (wayId, a, b) => `${wayId}:${a}:${b}`;
// Opposite direction of the same street piece, or -1
export function twinIndex(graph) {
  const byKey = new Map();
  graph.edges.forEach((e, i) => { if (!e.dead) byKey.set(pairKey(e.wayId, e.from, e.to), i); });
  return Int32Array.from(graph.edges, (e) => (e.dead ? -1 : byKey.get(pairKey(e.wayId, e.to, e.from)) ?? -1));
}

export const polyLength = (g) => { let l = 0; for (let k = 1; k < g.length; k++) l += Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]); return l; };

// Cumulative lengths and left-hand unit normals per vertex (x east, y south: left of
// heading (dx, dy) is (dy, −dx)). UK traffic keeps left, so each direction of a two-way
// street lies on the left of its centre line.
export function shapeOf(geom) {
  const n = geom.length, cum = new Float32Array(n), nx = new Float32Array(n), ny = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (k) cum[k] = cum[k - 1] + Math.hypot(geom[k][0] - geom[k - 1][0], geom[k][1] - geom[k - 1][1]);
    const a = geom[Math.max(0, k - 1)], b = geom[Math.min(n - 1, k + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    nx[k] = dy / l; ny[k] = -dx / l;
  }
  return { geom, cum, nx, ny, len: cum[n - 1] };
}

// Lateral offset (metres, to the left) of the middle of lane k of an edge
export const laneOffset = (lanes, k, hasTwin) => (hasTwin ? (k + 0.5) * LANE_W : (k + 0.5 - lanes / 2) * LANE_W);
// Offset of the centre of the whole carriageway for that direction
export const bandOffset = (lanes, hasTwin) => (hasTwin ? (lanes * LANE_W) / 2 : 0);

// Point at distance d along the shape, shifted `off` metres to the left; with `head`, also
// the heading there (radians, x east, y south) into head[h]
export function pointAt(s, d, off, out, o, head, h) {
  const { geom, cum, nx, ny } = s, n = geom.length;
  d = Math.max(0, Math.min(s.len, d));
  let k = 1;
  while (k < n - 1 && cum[k] < d) k++;
  const t = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
  const a = geom[k - 1], b = geom[k];
  const mx = nx[k - 1] + (nx[k] - nx[k - 1]) * t, my = ny[k - 1] + (ny[k] - ny[k - 1]) * t;
  out[o] = a[0] + (b[0] - a[0]) * t + mx * off;
  out[o + 1] = a[1] + (b[1] - a[1]) * t + my * off;
  if (head) head[h] = Math.atan2(b[1] - a[1], b[0] - a[0]);
}

// Polyline offset to the left by `off` metres (mitred at vertices)
export function offsetLine(geom, off) {
  if (!off) return geom;
  const n = geom.length, out = [];
  for (let k = 0; k < n; k++) {
    const p = geom[k];
    const d0 = k > 0 ? dirOf(geom[k - 1], p) : null, d1 = k < n - 1 ? dirOf(p, geom[k + 1]) : null;
    let mx, my;
    if (d0 && d1) {
      const bx = d0[0] + d1[0], by = d0[1] + d1[1], bl = Math.hypot(bx, by);
      if (bl < 1e-6) { mx = d1[1]; my = -d1[0]; }
      else {
        const ux = bx / bl, uy = by / bl, cos = ux * d1[0] + uy * d1[1];
        const k2 = 1 / Math.max(0.35, cos); // cap the mitre on sharp turns
        mx = uy * k2; my = -ux * k2;
      }
    } else { const d = d0 ?? d1; mx = d[1]; my = -d[0]; }
    out.push([p[0] + mx * off, p[1] + my * off]);
  }
  return out;
}
const dirOf = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
