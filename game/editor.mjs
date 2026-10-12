// Road editing on the page side: what the player points at, what a change would cost and
// what's in the way, and the patch that makes it happen (see network.mjs).
//
// A "segment" is one street piece between two graph nodes with up to two directed edges:
// `fwd` runs a → b along `geom`, `bwd` runs b → a.
//
// Heights: an edge is at `level` × GRADE.levelH metres (OSM bridges/tunnels, see
// render.applyLevels), or, for player-built ramps, goes linearly from `z0` to `z1` (its own
// direction). Roads only meet where they share a node, so crossing at a different height
// is simply not making a junction there.
import { applyPatch, twinIndex, polyLength, offsetLine, touchesRoads } from "./network.mjs";
import { LANE_W, PRICE, GRADE, SLIP, capacityFor, laneMetreCost, buildingCost, minRadius } from "./rules.mjs";

const CELL = 40;
const cellKey = (cx, cy) => cx * 100003 + cy;

export class Editor {
  constructor(graph, footprints) {
    this.graph = graph;
    this.buildings = footprints.buildings;
    this.demolished = new Set();
    this.nextWayId = -1; // player-built streets get negative way ids
    this.bGrid = new Map();
    this.water = footprints.areas.filter((a) => a.kind === "water").flatMap((a) => a.rings).map((ring) => ({ ring, box: boxOf(ring) }));
    this.buildings.forEach((b, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of b.ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      b.box = [x0, y0, x1, y1];
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) push(this.bGrid, cellKey(cx, cy), i);
    });
    this.reindex();
  }

  apply(patch) {
    applyPatch(this.graph, patch);
    for (const b of patch.demolish ?? []) this.demolished.add(b.index);
    for (const b of patch.restore ?? []) this.demolished.delete(b.index);
    for (const e of patch.add ?? []) if (e.wayId <= this.nextWayId) this.nextWayId = e.wayId - 1;
    if (touchesRoads(patch)) this.reindex();
  }

  // Segments + spatial grids over segments and junction nodes
  reindex() {
    const { graph } = this, twin = twinIndex(graph);
    this.twin = twin;
    const segs = [], segOf = new Int32Array(graph.edges.length).fill(-1);
    graph.edges.forEach((e, i) => {
      if (e.dead || segOf[i] >= 0) return;
      const t = twin[i];
      const seg = { id: segs.length, a: e.from, b: e.to, fwd: i, bwd: t, geom: e.geom, hw: e.highway, name: e.name, wayId: e.wayId, level: e.level ?? 0 };
      seg.len = polyLength(seg.geom);
      seg.fwdLanes = e.lanes; seg.bwdLanes = t >= 0 ? graph.edges[t].lanes : 0;
      segOf[i] = seg.id; if (t >= 0) segOf[t] = seg.id;
      segs.push(seg);
    });
    this.segs = segs; this.segOf = segOf;
    this.sGrid = new Map(); this.nGrid = new Map();
    const deg = new Map(), nodeZ = new Map();
    // a node's height: of the roads ending there, the one nearest the ground (an OSM bridge
    // ends on the street it lands on)
    const setZ = (v, z) => { const o = nodeZ.get(v); if (o === undefined || Math.abs(z) < Math.abs(o)) nodeZ.set(v, z); };
    for (const s of segs) {
      const g = s.geom;
      for (let k = 1; k < g.length; k++) {
        const [ax, ay] = g[k - 1], [bx, by] = g[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 2)));
        const seen = new Set();
        for (let j = 0; j <= n; j++) {
          const key = cellKey(Math.floor((ax + (bx - ax) * j / n) / CELL), Math.floor((ay + (by - ay) * j / n) / CELL));
          if (!seen.has(key)) { seen.add(key); push(this.sGrid, key, s.id); }
        }
      }
      for (const v of [s.a, s.b]) deg.set(v, (deg.get(v) ?? 0) + 1);
      setZ(s.a, this.segZ(s, 0)); setZ(s.b, this.segZ(s, s.len));
    }
    this.degree = deg; this.nodeZ = nodeZ;
    for (const v of deg.keys()) { const n = graph.nodes[v]; push(this.nGrid, cellKey(Math.floor(n.x / CELL), Math.floor(n.y / CELL)), v); }
  }

  near(grid, x, y, r) {
    const out = new Set();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
        for (const v of grid.get(cellKey(cx, cy)) ?? []) out.add(v);
    return out;
  }
  // Grid entries along a straight piece, padded by r
  along(grid, p, q, r) {
    const out = new Set(), n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (CELL / 2)));
    for (let j = 0; j <= n; j++) for (const v of this.near(grid, p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n, r)) out.add(v);
    return out;
  }

  segWidth(s) { return (s.fwdLanes + s.bwdLanes) * LANE_W; }
  // Height (m) of a segment at distance s along its geom
  segZ(seg, s) {
    const fwd = seg.fwd >= 0, e = this.graph.edges[fwd ? seg.fwd : seg.bwd], f = seg.len ? Math.max(0, Math.min(1, s / seg.len)) : 0;
    return edgeZ(e, fwd ? f : 1 - f);
  }

  // `reachable(z)`: only snap to roads at a height the road being built can join
  hitNode(x, y, r, reachable) {
    let best = -1, bd = r;
    for (const v of this.near(this.nGrid, x, y, r)) {
      if (reachable && !reachable(this.nodeZ.get(v) ?? 0)) continue;
      const n = this.graph.nodes[v], d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  // Where roads overlap (a bridge over a street) the one on top wins
  hitSegment(x, y, r, reachable) {
    let best = null, bd = Infinity;
    for (const id of this.near(this.sGrid, x, y, r)) {
      const s = this.segs[id], h = projectOnLine(s.geom, x, y);
      if (reachable && !reachable(this.segZ(s, h.s))) continue;
      const reach = r + this.segWidth(s) / 2, score = h.d - reach - s.level * 3;
      if (h.d < reach && score < bd) { bd = score; best = { seg: s, ...h }; }
    }
    return best;
  }
  hitBuilding(x, y) {
    for (const i of this.near(this.bGrid, x, y, 0)) {
      if (this.demolished.has(i)) continue;
      if (pointInRing(this.buildings[i].ring, x, y)) return i;
    }
    return -1;
  }

  // Where a click lands: an existing junction/end, a point on a street, or open ground.
  // With `level`, roads on another level (a bridge overhead while building at ground) are
  // passed over; ground roads always count, since a new bridge can ramp down to them.
  snap(x, y, r, level) {
    const zWant = (level ?? 0) * GRADE.levelH;
    const reachable = level === undefined ? null : (z) => Math.abs(z) < GRADE.atGrade || Math.abs(z - zWant) < GRADE.atGrade;
    const node = (v) => ({ kind: "node", node: v, x: this.graph.nodes[v].x, y: this.graph.nodes[v].y, z: this.nodeZ.get(v) ?? 0 });
    const v = this.hitNode(x, y, r, reachable);
    if (v >= 0) return node(v);
    const h = this.hitSegment(x, y, r * 0.6, reachable);
    if (h) {
      const { seg, s } = h;
      // too close to the segment's end: use the end node
      if (s < 6) return node(seg.a);
      if (s > seg.len - 6) return node(seg.b);
      return { kind: "seg", seg: seg.id, s, x: h.x, y: h.y, z: this.segZ(seg, s) };
    }
    return { kind: "free", x, y, z: zWant };
  }
  inWater(x, y) {
    for (const w of this.water) if (x >= w.box[0] && x <= w.box[2] && y >= w.box[1] && y <= w.box[3] && pointInRing(w.ring, x, y)) return true;
    return false;
  }

  // Buildings a straight band p → q of the given half-width would touch
  blockers(p, q, halfW) {
    const out = [];
    for (const i of this.along(this.bGrid, p, q, halfW)) {
      if (this.demolished.has(i)) continue;
      const b = this.buildings[i];
      if (ringNearSegment(b.ring, p, q, halfW)) out.push(i);
    }
    return out;
  }

  // ---------------------------------------------------------------- new road
  // Directions (unit vectors) of the roads at a snap target, pointing away from it
  headingsAt(t) {
    const out = [];
    if (t.kind === "node") {
      for (const id of this.near(this.sGrid, t.x, t.y, 1)) {
        const s = this.segs[id], g = s.geom;
        if (s.a === t.node) out.push(unit(g[0], g[1]));
        else if (s.b === t.node) out.push(unit(g.at(-1), g.at(-2)));
      }
    } else if (t.kind === "seg") {
      const g = this.segs[t.seg].geom, a = pointOnLine(g, Math.max(0, t.s - 2)), b = pointOnLine(g, t.s + 2);
      const d = unit(a, b);
      out.push(d, [-d[0], -d[1]]);
    }
    return out;
  }

  // geom: the road's centre line from t0 to t1 — two points for a straight road, more for a curve.
  // opts.level: −1 tunnel, 0 ground, 1+ bridge; the road climbs / dips from the height of
  // whatever its ends join at GRADE.maxGrade. opts.laneGain: slip roads add a lane.
  planRoad(t0, t1, type, geom = [[t0.x, t0.y], [t1.x, t1.y]], opts = {}) {
    geom = [[t0.x, t0.y], ...geom.slice(1, -1), [t1.x, t1.y]];
    const p = geom[0], q = geom.at(-1), len = polyLength(geom), cum = geom.map((_, k) => cumAt(geom, k));
    const level = opts.level ?? 0, zWant = level * GRADE.levelH;
    const zA = t0.z ?? zWant, zB = t1.z ?? zWant, g = GRADE.maxGrade;
    // height profile: as close to the chosen level as the ramps from both ends allow
    const zAt = (s) => {
      const lo = Math.max(zA - g * s, zB - g * (len - s)), hi = Math.min(zA + g * s, zB + g * (len - s));
      return Math.max(lo, Math.min(hi, zWant));
    };
    const plan = { t0, t1, type, len, p, q, geom, level, zAt, crossings: [], passes: [], clashes: [], slips: [], wet: [], blockers: [], cost: 0, junctions: 0 };
    if (len < 8) return { ...plan, error: "Too short" };
    if (t0.kind === "node" && t1.kind === "node" && t0.node === t1.node) return { ...plan, error: "Too short" };
    if (selfCrosses(geom)) return { ...plan, error: "The road crosses itself" };
    if (Math.abs(zA - zB) > g * len + 0.05) return { ...plan, error: `Too steep: ${Math.round(Math.abs(zA - zB))} m up in ${Math.round(len)} m` };
    const lanes = type.fwd + type.bwd, halfW = (lanes * LANE_W) / 2;
    const tight = geom.length > 2 ? sharpestRadius(geom) : Infinity;
    if (tight < minRadius(lanes)) plan.error = `Curve too tight for ${lanes} lanes`;
    const endNodes = new Set([t0.node, t1.node].filter((v) => v !== undefined));
    // crossings: at the same height they become junctions, far enough apart the road passes
    // over / under, anything in between is a clash
    for (let j = 1; j < geom.length; j++) {
      const pj = geom[j - 1], qj = geom[j], lj = cum[j] - cum[j - 1];
      for (const id of this.along(this.sGrid, pj, qj, 2)) {
        const s = this.segs[id], gs = s.geom;
        for (let k = 1; k < gs.length; k++) {
          const hit = segIntersect(pj, qj, gs[k - 1], gs[k]);
          if (!hit) continue;
          const along = cum[j - 1] + hit.t * lj;
          if (along < 3 || along > len - 3) continue; // at our own end points
          const sAlong = cumAt(gs, k - 1) + hit.u * Math.hypot(gs[k][0] - gs[k - 1][0], gs[k][1] - gs[k - 1][1]);
          const x = pj[0] + (qj[0] - pj[0]) * hit.t, y = pj[1] + (qj[1] - pj[1]) * hit.t;
          const dz = zAt(along) - this.segZ(s, sAlong);
          if (Math.abs(dz) >= GRADE.clearance) { plan.passes.push({ x, y, over: dz > 0 }); continue; }
          if (Math.abs(dz) >= GRADE.atGrade) { plan.clashes.push({ x, y, name: s.name }); continue; }
          let c;
          if (sAlong < 5) c = { node: s.a };
          else if (sAlong > s.len - 5) c = { node: s.b };
          else c = { seg: s.id, s: sAlong };
          if (c.node !== undefined && endNodes.has(c.node)) continue;
          plan.crossings.push({ ...c, t: along / len, along, x, y, hw: s.hw });
        }
      }
    }
    plan.crossings.sort((a, b) => a.t - b.t);
    plan.crossings = plan.crossings.filter((c, i, a) => !i || (c.t - a[i - 1].t) * len > 3 || (c.node ?? -1) !== (a[i - 1].node ?? -2));
    if (plan.clashes.length) plan.error ??= `Too low to pass ${plan.clashes[0].name ?? "the road"} — ramp too close to it`;
    if (plan.crossings.some((c) => c.hw === "motorway" || c.hw === "motorway_link")) plan.error ??= "Can't cross a motorway at grade — bridge (PgUp) or tunnel (PgDn)";
    // slip roads: a one-way road joining a road at a shallow angle merges / peels off
    if (!type.bwd) for (const k of [0, 1]) {
      const t = k ? t1 : t0;
      if (t.kind !== "seg") continue;
      const h = k ? unit(pointOnLine(geom, len - 6), q) : unit(p, pointOnLine(geom, 6)), side = pointOnLine(geom, k ? Math.max(0, len - 15) : Math.min(len, 15));
      const slip = this.slipAt(t, h, side, k ? "merge" : "diverge", type.fwd, opts.laneGain !== false);
      if (slip) plan.slips.push({ ...slip, end: k });
    }
    // what's underneath: buildings block anything but a deep tunnel, water needs a bridge or one
    const blockers = new Set(), pieces = densify(geom, 10);
    let cost = 0;
    for (let j = 1; j < pieces.length; j++) {
      const [a, sa] = pieces[j - 1], [b, sb] = pieces[j], z = zAt((sa + sb) / 2), l = sb - sa;
      if (z > GRADE.underBuildings) for (const i of this.blockers(a, b, halfW + 0.5)) blockers.add(i);
      if (z > GRADE.underBuildings && z < GRADE.airborne) {
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (this.inWater(m[0], m[1])) plan.wet.push(m);
      }
      const f = z >= GRADE.airborne ? PRICE.bridge : z <= -GRADE.airborne ? PRICE.tunnel : Math.abs(z) >= GRADE.atGrade ? PRICE.ramp : 1;
      cost += l * lanes * laneMetreCost(type.hw) * f;
    }
    if (plan.wet.length) plan.error ??= "Water in the way — build a bridge (PgUp) or tunnel (PgDn)";
    for (const sl of plan.slips) {
      cost += PRICE.slip + sl.aux * sl.auxLen * laneMetreCost(sl.hw);
      for (const b of sl.blockers) blockers.add(b);
    }
    plan.blockers = [...blockers];
    const slipEnds = new Set(plan.slips.map((sl) => sl.end));
    plan.junctions = plan.crossings.filter((c) => c.seg !== undefined).length + [t0, t1].filter((t, k) => t.kind === "seg" && !slipEnds.has(k)).length;
    plan.cost = Math.round(cost + plan.junctions * PRICE.junction);
    plan.turn = turnOf(geom);
    return plan;
  }

  // A one-way road meeting segment point t heading `h` (its direction of travel there):
  // which direction of the segment it merges into / peels off, and the extra lane that goes
  // with it — after the merge point (merge) or before the exit (diverge). On a two-way road
  // it must join from the kerb side (UK: the left), else it cuts across oncoming traffic and
  // is an ordinary junction; `side` is a point of the slip road just off the join.
  slipAt(t, h, side, kind, lanes, laneGain) {
    const seg = this.segs[t.seg];
    const d = unit(pointOnLine(seg.geom, Math.max(0, t.s - 3)), pointOnLine(seg.geom, Math.min(seg.len, t.s + 3)));
    const cos = Math.cos((SLIP.maxAngleDeg * Math.PI) / 180);
    for (const [dir, sign] of [["fwd", 1], ["bwd", -1]]) {
      if (seg[dir] < 0 || (h[0] * d[0] + h[1] * d[1]) * sign < cos) continue;
      const left = [d[1] * sign, -d[0] * sign]; // left of the traffic's heading (x east, y south)
      if (seg.fwd >= 0 && seg.bwd >= 0 && (side[0] - t.x) * left[0] + (side[1] - t.y) * left[1] < 0) continue;
      // the added lane runs downstream of a merge, upstream of an exit
      const ahead = (kind === "merge") === (sign > 0), room = ahead ? seg.len - t.s : t.s;
      let auxLen = Math.min(SLIP.auxLaneM, room - 8), aux = lanes;
      if (!laneGain || auxLen < SLIP.minAuxM) { aux = 0; auxLen = 0; }
      const sAux = ahead ? t.s + auxLen : t.s - auxLen;
      const blockers = [];
      if (aux) {
        const halfW = ((seg.fwdLanes + seg.bwdLanes + aux) * LANE_W) / 2 - 2, gl = subLine(seg.geom, Math.min(t.s, sAux), Math.max(t.s, sAux));
        for (let k = 1; k < gl.length; k++) blockers.push(...this.blockers(gl[k - 1], gl[k], halfW));
      }
      return { kind, seg: seg.id, dir, s: t.s, sAux, aux, auxLen, hw: seg.hw, blockers: [...new Set(blockers)] };
    }
    return null;
  }

  commitRoad(plan) {
    const tx = new Tx(this.graph);
    const { type, t0, t1, zAt, len } = plan;
    // splits per existing segment: [{s, ref}] → node ids
    const splits = new Map();
    const want = (segId, s, ref) => push(splits, segId, { s, ref });
    const stops = []; // { ref, along } — where the new road meets a node
    const ends = [t0, t1].map((t) => (t.kind === "node" ? { node: t.node } : t.kind === "seg" ? { split: true } : { node: tx.node(t.x, t.y) }));
    if (t0.kind === "seg") want(t0.seg, t0.s, (ends[0] = {}));
    if (t1.kind === "seg") want(t1.seg, t1.s, (ends[1] = {}));
    const auxRefs = plan.slips.map((sl) => {
      if (!sl.aux) return null;
      const ref = {};
      want(sl.seg, sl.sAux, ref);
      return ref;
    });
    stops.push({ ref: ends[0], along: 0 });
    for (const c of plan.crossings) {
      const ref = c.node !== undefined ? { node: c.node } : {};
      if (c.seg !== undefined) want(c.seg, c.s, ref);
      stops.push({ ref, along: c.along });
    }
    stops.push({ ref: ends[1], along: len });
    // pass-through nodes where the slope changes and where the road leaves / reaches the
    // ground, so every piece's height is linear and bridge / tunnel pieces are their own edges
    for (const s of heightBreaks(zAt, len)) {
      if (stops.some((st) => Math.abs(st.along - s) < 3)) continue;
      const pt = pointOnLine(plan.geom, s);
      stops.push({ ref: { node: tx.node(pt[0], pt[1]) }, along: s });
    }
    stops.sort((a, b) => a.along - b.along);
    const added = [];
    for (const [segId, list] of splits) added.push(...this.splitSegment(tx, this.segs[segId], list));
    // slip roads: widen the piece of the main road between the join and the end of the added lane
    plan.slips.forEach((sl, i) => {
      const ref = auxRefs[i];
      if (!ref) return;
      const join = ends[sl.end].node, [from, to] = sl.kind === "merge" ? [join, ref.node] : [ref.node, join];
      const e = added.find((x) => x.from === from && x.to === to);
      if (!e) return;
      e.lanes += sl.aux; e.capacity = capacityFor(e.highway, e.lanes); e.auxLane = sl.kind;
    });
    const pts = stops.map(({ ref, along }) => ({ node: ref.node, along })).filter((v, i, a) => i === 0 || v.node !== a[i - 1].node);
    const wayId = this.nextWayId--;
    const speedKmh = Math.round(type.mph * 1.609);
    const r1 = (v) => Math.round(v * 10) / 10;
    for (let i = 1; i < pts.length; i++) {
      const nodes = [pts[i - 1].node, pts[i].node];
      // our own line between the two stops, pinned to the exact node positions at its ends
      const geom = subLine(plan.geom, pts[i - 1].along, pts[i].along);
      geom[0] = tx.xy(nodes[0]).map(r1);
      geom[geom.length - 1] = tx.xy(nodes[1]).map(r1);
      const z0 = r1(zAt(pts[i - 1].along)), z1 = r1(zAt(pts[i].along)), zm = (z0 + z1) / 2;
      const lv = zm >= GRADE.airborne ? Math.max(1, Math.round(zm / GRADE.levelH)) : zm <= -GRADE.airborne ? Math.min(-1, Math.round(zm / GRADE.levelH)) : 0;
      const height = z0 || z1 ? { z0, z1 } : {}, back = z0 || z1 ? { z0: z1, z1: z0 } : {};
      const base = { wayId, highway: type.hw, name: null, ref: null, speedKmh, length: Math.max(1, r1(polyLength(geom))), built: true, ...(lv ? { level: lv } : {}) };
      if (type.fwd) tx.edge({ ...base, ...height, from: nodes[0], to: nodes[1], lanes: type.fwd, capacity: capacityFor(type.hw, type.fwd), geom });
      if (type.bwd) tx.edge({ ...base, ...back, from: nodes[1], to: nodes[0], lanes: type.bwd, capacity: capacityFor(type.hw, type.bwd), geom: [...geom].reverse() });
    }
    return tx.patch;
  }

  // Cut a segment at several distances along it; each list item's `ref.node` gets the new node.
  // Returns the new edges (still unapplied patch entries).
  splitSegment(tx, seg, list) {
    list.sort((a, b) => a.s - b.s);
    const cuts = [];
    for (const it of list) {
      const last = cuts.at(-1);
      if (last && it.s - last.s < 3) { it.ref.node = last.node; continue; }
      const pt = pointOnLine(seg.geom, it.s);
      it.ref.node = tx.node(pt[0], pt[1]);
      cuts.push({ s: it.s, node: it.ref.node, pt });
    }
    const pieces = [];
    let prevS = 0, prevNode = seg.a;
    for (const c of [...cuts, { s: seg.len, node: seg.b }]) {
      pieces.push({ from: prevNode, to: c.node, s0: prevS, s1: c.s, geom: subLine(seg.geom, prevS, c.s) });
      prevS = c.s; prevNode = c.node;
    }
    const out = [];
    for (const [dir, eid] of [["fwd", seg.fwd], ["bwd", seg.bwd]]) {
      if (eid < 0) continue;
      const e = this.graph.edges[eid];
      tx.kill(eid);
      for (const pc of pieces) {
        const geom = dir === "fwd" ? pc.geom : [...pc.geom].reverse();
        const { id, dead, geom: _g, from, to, length, ...attrs } = e;
        if (e.z0 !== undefined) { // a ramp: each piece keeps its share of the climb
          const za = Math.round(this.segZ(seg, pc.s0) * 10) / 10, zb = Math.round(this.segZ(seg, pc.s1) * 10) / 10;
          [attrs.z0, attrs.z1] = dir === "fwd" ? [za, zb] : [zb, za];
        }
        tx.edge({ ...attrs, from: dir === "fwd" ? pc.from : pc.to, to: dir === "fwd" ? pc.to : pc.from, geom, length: Math.max(1, Math.round(polyLength(geom) * 10) / 10) });
        out.push(tx.patch.add.at(-1));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- lanes / upgrade
  // spec: { hw?, speedKmh?, fwd, bwd } per segment (fwd along seg.geom)
  planChange(changes) {
    let cost = 0;
    const blockers = new Set();
    for (const { seg, spec } of changes) {
      const hw = spec.hw ?? seg.hw;
      const oldL = seg.fwdLanes + seg.bwdLanes, newL = spec.fwd + spec.bwd;
      if (newL > oldL) cost += (newL - oldL) * seg.len * laneMetreCost(hw);
      if (newL < oldL) cost += (oldL - newL) * seg.len * PRICE.removeLaneM;
      if (hw !== seg.hw) cost += Math.min(oldL, newL) * seg.len * laneMetreCost(hw) * PRICE.reclassShare;
      // existing streets already have a footway; only real widening reaches the buildings
      if (newL > oldL) {
        const halfW = (newL * LANE_W) / 2 - 2;
        const g = seg.geom;
        for (let k = 1; k < g.length; k++) for (const b of this.blockers(g[k - 1], g[k], halfW)) blockers.add(b);
      }
    }
    return { cost: Math.round(cost), blockers: [...blockers] };
  }

  commitChange(changes) {
    const tx = new Tx(this.graph);
    for (const { seg, spec } of changes) {
      const hw = spec.hw ?? seg.hw;
      const template = this.graph.edges[seg.fwd >= 0 ? seg.fwd : seg.bwd];
      const speedKmh = spec.speedKmh ?? template.speedKmh;
      for (const [dir, eid, lanes] of [["fwd", seg.fwd, spec.fwd], ["bwd", seg.bwd, spec.bwd]]) {
        if (lanes > 0 && eid >= 0) tx.mod(eid, { lanes, capacity: capacityFor(hw, lanes), highway: hw, speedKmh });
        else if (lanes > 0) {
          const geom = dir === "fwd" ? seg.geom.map((p) => [...p]) : [...seg.geom].reverse().map((p) => [...p]);
          const { id, dead, geom: _g, from, to, ...attrs } = template;
          tx.edge({ ...attrs, from: dir === "fwd" ? seg.a : seg.b, to: dir === "fwd" ? seg.b : seg.a, geom, lanes, capacity: capacityFor(hw, lanes), highway: hw, speedKmh });
        } else if (eid >= 0) tx.kill(eid);
      }
    }
    return tx.patch;
  }

  // ---------------------------------------------------------------- bulldoze / demolish
  planRemove(segs) {
    return { cost: Math.round(segs.reduce((c, s) => c + (s.fwdLanes + s.bwdLanes) * s.len * PRICE.removeLaneM, 0)) };
  }
  commitRemove(segs) {
    const tx = new Tx(this.graph);
    for (const s of segs) for (const e of [s.fwd, s.bwd]) if (e >= 0) tx.kill(e);
    return tx.patch;
  }
  demolishPatch(i) {
    const b = this.buildings[i];
    return { demolish: [{ index: i, id: b.id, node: b.node, homes: b.homes, jobs: b.jobs, cost: buildingCost(b) }] };
  }
}

// Collects a patch with ids continuing from the graph's current size
class Tx {
  constructor(graph) { this.graph = graph; this.patch = { nodes: [], add: [], kill: [], mod: [] }; }
  node(x, y) {
    const id = this.graph.nodes.length + this.patch.nodes.length;
    this.patch.nodes.push({ id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, inside: true, core: true, built: true });
    return id;
  }
  xy(v) { const n = v < this.graph.nodes.length ? this.graph.nodes[v] : this.patch.nodes[v - this.graph.nodes.length]; return [n.x, n.y]; }
  edge(e) { const id = this.graph.edges.length + this.patch.add.length; this.patch.add.push({ id, ...e }); return id; }
  kill(id) { this.patch.kill.push(id); }
  mod(id, fields) { this.patch.mod.push({ id, ...fields }); }
}

// ---------------------------------------------------------------- geometry helpers
function push(map, k, v) { const a = map.get(k); a ? a.push(v) : map.set(k, [v]); }
// Height (m) of an edge at fraction f along it (its own direction)
export const edgeZ = (e, f) => (e.z0 !== undefined ? e.z0 + (e.z1 - e.z0) * f : (e.level ?? 0) * GRADE.levelH);
const boxOf = (ring) => ring.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
// Polyline as [point, distance] every ≤ step metres (keeps the original vertices)
function densify(g, step) {
  const out = [[g[0], 0]];
  let acc = 0;
  for (let k = 1; k < g.length; k++) {
    const l = Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]), n = Math.max(1, Math.ceil(l / step));
    for (let i = 1; i <= n; i++) out.push([[g[k - 1][0] + (g[k][0] - g[k - 1][0]) * i / n, g[k - 1][1] + (g[k][1] - g[k - 1][1]) * i / n], acc + l * i / n]);
    acc += l;
  }
  return out;
}
// Distances where a height profile bends (foot / top of a ramp) or crosses ±GRADE.airborne
function heightBreaks(zAt, len) {
  const out = [], step = 1;
  let prevSlope = null;
  for (let s = step; s < len; s += step) {
    const slope = zAt(s) - zAt(s - step);
    if (prevSlope !== null && Math.abs(slope - prevSlope) > 1e-3 && s - step > 3 && s - step < len - 3) out.push(s - step);
    prevSlope = slope;
    for (const edge of [GRADE.airborne, -GRADE.airborne]) {
      const a = zAt(s - step) - edge, b = zAt(s) - edge;
      if ((a < 0) !== (b < 0)) { const t = a / (a - b), at = s - step + t * step; if (at > 3 && at < len - 3) out.push(at); }
    }
  }
  return out.sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > 3);
}
// Smallest turning radius along a polyline (m)
function sharpestRadius(g) {
  let r = Infinity;
  for (let k = 1; k < g.length - 1; k++) {
    const a = unit(g[k - 1], g[k]), b = unit(g[k], g[k + 1]);
    const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
    if (ang < 1e-4) continue;
    const l = Math.min(Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]), Math.hypot(g[k + 1][0] - g[k][0], g[k + 1][1] - g[k][1]));
    r = Math.min(r, l / ang);
  }
  return r;
}
// Total heading change from start to end (degrees, unsigned)
function turnOf(g) {
  if (g.length < 3) return 0;
  const a = unit(g[0], g[1]), b = unit(g.at(-2), g.at(-1));
  return Math.abs((Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180) / Math.PI);
}
// Circular arc from p leaving in direction `tan` (unit) and ending at q, as ~6 m pieces.
// Null when q is (almost) straight behind. turn = heading change in degrees.
export function arcLine(p, tan, q) {
  const cx = q[0] - p[0], cy = q[1] - p[1], c = Math.hypot(cx, cy);
  const th = Math.atan2(tan[0] * cy - tan[1] * cx, tan[0] * cx + tan[1] * cy);
  if (c < 1e-6) return null;
  if (Math.abs(th) < 0.01) return { geom: [p, q], turn: 0, radius: Infinity };
  if (Math.abs(th) > (170 * Math.PI) / 180) return null;
  const R = c / (2 * Math.sin(Math.abs(th))), sg = Math.sign(th);
  const o = [p[0] - sg * tan[1] * R, p[1] + sg * tan[0] * R]; // centre, on the inside of the bend
  const sweep = 2 * th, n = Math.max(2, Math.min(96, Math.ceil((Math.abs(sweep) * R) / 6)));
  const vx = p[0] - o[0], vy = p[1] - o[1], out = [];
  for (let i = 0; i <= n; i++) {
    const a = (sweep * i) / n, cs = Math.cos(a), sn = Math.sin(a);
    out.push([o[0] + vx * cs - vy * sn, o[1] + vx * sn + vy * cs]);
  }
  out[n] = [q[0], q[1]];
  return { geom: out, turn: Math.abs((sweep * 180) / Math.PI), radius: R };
}
const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
function selfCrosses(g) {
  for (let i = 1; i < g.length; i++) for (let j = i + 2; j < g.length; j++) if (segIntersect(g[i - 1], g[i], g[j - 1], g[j])) return true;
  return false;
}
// Quadratic Bézier p → q bent towards control point c, as a polyline of ~8 m pieces
export function curveLine(p, c, q) {
  const approx = Math.hypot(c[0] - p[0], c[1] - p[1]) + Math.hypot(q[0] - c[0], q[1] - c[1]);
  const n = Math.max(2, Math.min(48, Math.ceil(approx / 8)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]]);
  }
  return out;
}
export { pointOnLine, unit };
function cumAt(g, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]); return s; }

export function projectOnLine(g, x, y) {
  let best = { d: Infinity }, acc = 0;
  for (let k = 1; k < g.length; k++) {
    const [ax, ay] = g[k - 1], [bx, by] = g[k], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { d, x: px, y: py, s: acc + t * l };
    acc += l;
  }
  return best;
}
function pointOnLine(g, s) {
  let acc = 0;
  for (let k = 1; k < g.length; k++) {
    const l = Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
    if (acc + l >= s || k === g.length - 1) { const t = l ? Math.max(0, Math.min(1, (s - acc) / l)) : 0; return [g[k - 1][0] + (g[k][0] - g[k - 1][0]) * t, g[k - 1][1] + (g[k][1] - g[k - 1][1]) * t]; }
    acc += l;
  }
  return [...g.at(-1)];
}
function subLine(g, s0, s1) {
  const out = [pointOnLine(g, s0)];
  let acc = 0;
  for (let k = 1; k < g.length; k++) {
    acc += Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
    if (acc > s0 + 0.5 && acc < s1 - 0.5) out.push([...g[k]]);
  }
  out.push(pointOnLine(g, s1));
  return out.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}
function segIntersect(p, q, a, b) {
  const rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / den, u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}
export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distPointSeg(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}
function ringNearSegment(ring, p, q, r) {
  if (pointInRing(ring, p[0], p[1]) || pointInRing(ring, q[0], q[1])) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segIntersect(p, q, ring[j], ring[i])) return true;
    if (distPointSeg(ring[i][0], ring[i][1], p, q) < r) return true;
  }
  // band edges crossing the polygon without any vertex inside the band
  return distPointSeg(...centroid(ring), p, q) < r;
}
const centroid = (ring) => ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
export { offsetLine };
