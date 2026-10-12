// Where to draw each car, from the queue sim's state (used by game/worker.mjs; also runs in
// Node so smoothness can be measured and tuned without a browser).
//
// The sim moves cars a road or a car length at a time and lets them leave a queue at full
// speed. What the player sees is, per car, a distance along its route that chases the sim's
// position with limited acceleration and braking: queues creep forward, cars pull away from
// stop lines, and a car changing lanes slides across.
import { pointAt, laneOffset } from "./network.mjs";
import { LANE_W } from "./rules.mjs";
import { VEHICLES, vehicleOf } from "./time.mjs";

const SPACING_M = 7.5, CAR_HALF = 2.3, CLOSEST_M = 5.5, BUMPER_GAP = 0.6;
const lengthOf = (v) => VEHICLES[vehicleOf(v)].len;

export const DISPLAY = {
  accel: 3,      // m/s² pulling away
  brake: 5,      // m/s² hardest stop
  comfort: 2.5,  // m/s² planned braking towards where the sim has it
  catchUp: 1,    // s to close the gap to the sim's spot
  sideways: 2.5, // m/s across lanes
  snap: Infinity, // m behind the sim before a car is just moved up (off: catching up looks better than a jump)
  topSpeed: 1.6, // × the road's free speed it may drive to catch up
  boostV: 0.5,   // m/s extra top speed per m fallen behind (past 10 m)
  backOff: 3,    // m/s an overlapping car may ease back to clear the one ahead
  boostA: 0,     // m/s² extra acceleration per m fallen behind (off: measured no better)
};

export class CarDisplay {
  constructor(params = {}) { this.p = { ...DISPLAY, ...params }; this.smoothing = true; this.stopBack = new Float32Array(0); }

  // Stop lines: at a real junction (3+ neighbouring nodes) the first car waits clear of the
  // widest road it crosses; at a plain cut in a road it just keeps its nose out of the next piece.
  setNetwork(graph, shapes, twin) {
    this.shapes = shapes; this.twin = twin;
    const E = graph.edges.length, N = graph.nodes.length;
    const neigh = Array.from({ length: N }, () => new Set()), halfW = new Float32Array(N);
    graph.edges.forEach((e, i) => {
      if (e.dead) return;
      neigh[e.from].add(e.to); neigh[e.to].add(e.from);
      const w = ((e.lanes + (twin[i] >= 0 ? graph.edges[twin[i]].lanes : 0)) * LANE_W) / 2;
      halfW[e.from] = Math.max(halfW[e.from], w); halfW[e.to] = Math.max(halfW[e.to], w);
    });
    this.stopBack = new Float32Array(E);
    graph.edges.forEach((e, i) => {
      if (e.dead) return;
      const back = neigh[e.to].size >= 3 ? halfW[e.to] + 1 + CAR_HALF : CAR_HALF;
      this.stopBack[i] = Math.min(back, shapes[i].len * 0.45);
    });
  }

  reset(V) {
    this.dispD = new Float64Array(V); this.dispV = new Float32Array(V); this.prevT = new Float64Array(V);
    this.base = new Float64Array(V); this.edgeOf = new Int32Array(V).fill(-1); this.off = new Float32Array(V).fill(NaN);
    this.held = new Uint8Array(V); // held back by the car in front last frame
    this.lastAt = -1;
  }

  grow(m) {
    this.cv = new Int32Array(m); this.ck = new Int32Array(m); this.cedge = new Int32Array(m);
    this.clocal = new Float64Array(m); this.cpush = new Float64Array(m); this.cadv = new Float64Array(m); this.leadV = new Float32Array(m);
    this.cfree = new Uint8Array(m); // just appeared or was moved: can be placed anywhere
    this.tEdge = new Int32Array(m); this.tLocal = new Float64Array(m); // debug: where the sim has it
  }

  // No two cars overlap: in each lane, each car keeps half its length + half the next one's +
  // a metre behind the car in front — also across into the next road on its route. A car
  // that would run into the one ahead stops short and takes its speed, so a jam grows
  // backwards. It is never pulled back past where it was last frame (that would be a jump).
  separate(sim, n, dt) {
    const net = sim.net, { cv, ck, cedge, clocal, cpush, cadv, cfree, leadV, dispV } = this, back = this.p.backOff * dt;
    const laneKey = (edge, v) => edge * 8 + (v % Math.min(8, Math.max(1, Math.round(net.lanes[edge]))));
    for (let pass = 0; pass < 3; pass++) {
      const groups = new Map(); // lane → car slots
      for (let j = 0; j < n; j++) { const key = laneKey(cedge[j], cv[j]); const g = groups.get(key); g ? g.push(j) : groups.set(key, [j]); }
      for (const g of groups.values()) g.sort((a, b) => clocal[b] - clocal[a]);
      let moved = false;
      for (const g of groups.values()) {
        for (let x = 0; x < g.length; x++) {
          const j = g[x], v = cv[j], r = sim.vRoute[v];
          let limit = Infinity, lv = 0;
          if (x > 0) { const f = g[x - 1]; limit = clocal[f] - (lengthOf(cv[f]) + lengthOf(v)) / 2 - BUMPER_GAP; lv = dispV[cv[f]]; }
          else if (r && ck[j] < r.length - 1) { // the last car in its lane on the next road
            const ne = r[ck[j] + 1], ng = groups.get(laneKey(ne, v));
            if (ng) { const f = ng[ng.length - 1]; limit = net.length[cedge[j]] + clocal[f] - (lengthOf(cv[f]) + lengthOf(v)) / 2 - BUMPER_GAP; lv = dispV[cv[f]]; }
          }
          if (clocal[j] <= limit) continue;
          // only undo this frame's advance (+ a slow ease back), unless it has just appeared
          const push = cfree[j] ? clocal[j] - limit : Math.min(clocal[j] - limit, cadv[j] + back - cpush[j]);
          if (push <= 0) continue;
          clocal[j] -= push; cpush[j] += push; leadV[j] = lv;
          while (clocal[j] < 0 && r && ck[j] > 0) { ck[j]--; cedge[j] = r[ck[j]]; clocal[j] += net.length[cedge[j]]; moved = true; }
        }
      }
      void moved;
    }
  }

  // Positions, headings and trip ids of every car on the road at (fractional) sim time `at`.
  // The sim runs one step ahead of `at`, so a car is already on its next road when it reaches
  // a junction; one that (by `at`) hasn't got there yet is still finishing the road before.
  frame(sim, at) {
    const net = sim.net, { shapes, twin, stopBack, p: P } = this;
    const { dispD, dispV, prevT, base, edgeOf, off: dispOff } = this;
    const n = sim.onRoad, pos = new Float32Array(n * 2), head = new Float32Array(n), ids = new Int32Array(n);
    const queued = new Int32Array(8), standing = new Int32Array(8), gapOf = new Float32Array(8); // per lane
    const dt = this.lastAt < 0 ? 0 : at - this.lastAt;
    this.lastAt = at;
    if (!this.cv || this.cv.length < n) this.grow(n * 2 + 64);
    const { cv, ck, cedge, clocal, cpush, cadv } = this;
    let i = 0;
    for (const e of sim.active) {
      const q = sim.queue[e], s = shapes[e], len = net.length[e], lanes = Math.min(8, Math.max(1, Math.round(net.lanes[e])));
      const line = len - (stopBack[e] * len) / s.len; // stop line, in sim metres
      // The sim can hold more cars on a road than physically fit (stuck cars squeeze on). Then
      // the standing ones close up, down to bumper to bumper, before the queue backs out of the road.
      queued.fill(0); standing.fill(0);
      for (let h = sim.qHead[e]; h < q.length; h++) { const v = q[h]; if (sim.vReady[v] <= at && at >= sim.vEnter[v]) standing[v % lanes]++; }
      for (let k = 0; k < lanes; k++) gapOf[k] = standing[k] > 1 ? Math.min(SPACING_M, Math.max(CLOSEST_M, line / standing[k])) : SPACING_M;
      for (let h = sim.qHead[e]; h < q.length && i < n; h++) {
        const v = q[h], lane = v % lanes, r = sim.vRoute[v], p = sim.vPos[v];
        const tail = line - queued[lane] * gapOf[lane]; // where the next car in its lane would stand
        // where the sim has it, as metres from the start of this road (negative: still on the one before)
        let d;
        if (at < sim.vEnter[v] && p > 0) d = -((sim.vEnter[v] - at) / net.freeTime[r[p - 1]]) * net.length[r[p - 1]];
        else if (sim.vReady[v] <= at) { d = tail; queued[lane]++; }
        else { d = Math.max(0, (at - sim.vEnter[v]) / net.freeTime[e]) * len; if (queued[lane]) d = Math.min(d, tail); }
        // keep a running distance along the route
        if (edgeOf[v] !== e) {
          let k = p - 1, add = 0; // the roads passed since the last frame (one, or several short ones)
          while (k >= 0 && k >= p - 6 && r[k] !== edgeOf[v]) add += net.length[r[k--]];
          if (edgeOf[v] >= 0 && k >= 0 && r[k] === edgeOf[v]) base[v] += net.length[edgeOf[v]] + add;
          else { // new car (already moving at road speed if the sim has it moving), or rerouted
            base[v] = 0; dispD[v] = d; prevT[v] = d; dispOff[v] = NaN; this.isFresh = true;
            dispV[v] = sim.vReady[v] > at ? len / net.freeTime[e] : 0;
          }
          edgeOf[v] = e;
        }
        let fresh = this.isFresh; this.isFresh = false; // new or rerouted: may be placed anywhere
        const T = base[v] + d, before = dispD[v];
        // way behind (a skip, a reroute): move it. Way ahead (an overfull road's queue suddenly
        // reaching back past it): don't pull it back, it just waits there for the sim to catch up
        // (not when a jam is what's holding it back: then it's meant to be behind the sim)
        if (!this.smoothing || dt > 4 || (T - dispD[v] > P.snap && !this.held[v])) { dispD[v] = T; dispV[v] = 0; fresh = true; }
        else if (dt > 0) {
          const tv = Math.max(0, (T - prevT[v]) / dt), gap = T - dispD[v];
          // fallen well behind (it left a queue at full speed in the sim): catch up harder
          const behind = Math.max(0, gap - 10), cap = (len / net.freeTime[e]) * P.topSpeed + 3 + behind * P.boostV;
          // never faster than lets it stop at the sim's spot with comfortable braking
          const safe = Math.sqrt(tv * tv + 2 * P.comfort * Math.max(0, gap));
          const want = Math.min(cap, safe, Math.max(0, tv + gap / P.catchUp));
          const accel = P.accel + behind * P.boostA;
          dispV[v] = Math.max(0, dispV[v] + Math.max(-P.brake * dt, Math.min(accel * dt, want - dispV[v])));
          dispD[v] += dispV[v] * dt; // a queue that grows back past it: it brakes, it isn't pulled back
        }
        prevT[v] = T;
        // where to draw it: on this road, back along the roads before it, or (when it runs a
        // little ahead of the sim) on into the next one, so it never waits at a road's end
        let k = p, edge = e, local = dispD[v] - base[v];
        while (local < 0 && k > 0) { k--; edge = r[k]; local += net.length[edge]; }
        while (local > net.length[edge] && k < r.length - 1) { local -= net.length[edge]; k++; edge = r[k]; }
        cv[i] = v; ck[i] = k; cedge[i] = edge; clocal[i] = local; cpush[i] = 0; cadv[i] = Math.max(0, dispD[v] - before); this.cfree[i] = fresh ? 1 : 0;
        if (this.debug) { // the sim's own spot for this car, on the same route
          let tk = p, te = e, tl = d;
          while (tl < 0 && tk > 0) { tk--; te = r[tk]; tl += net.length[te]; }
          this.tEdge[i] = te; this.tLocal[i] = tl;
        }
        i++;
      }
    }
    this.n = i;
    if (this.smoothing) this.separate(sim, i, Math.max(0, dt));
    // draw — except cars whose place in the queue is still before the start of their route
    // (waiting to come onto the map, or out of a side road): they appear when there's room
    let m = 0;
    const dbg = this.debug ? (this.dbgOut = { target: new Float32Array(i * 2), held: new Uint8Array(i), lag: new Float32Array(i), hidden: [] }) : null;
    for (let j = 0; j < i; j++) {
      const v = cv[j], edge = cedge[j], sh = shapes[edge];
      this.held[v] = cpush[j] > 0 ? 1 : 0;
      if (cpush[j] > 0) { // held back: its speed is what it actually moved
        dispD[v] -= cpush[j];
        dispV[v] = dt > 0 ? Math.max(0, Math.min(this.leadV[j], (cadv[j] - cpush[j]) / dt)) : 0;
      }
      if (clocal[j] < -0.5 && ck[j] === 0) { if (dbg) dbg.hidden.push(v); continue; }
      const ed = Math.max(0, Math.min(net.length[edge], clocal[j]));
      const el = Math.min(8, Math.max(1, Math.round(net.lanes[edge])));
      const o = laneOffset(el, v % el, twin[edge] >= 0);
      if (!this.smoothing || Number.isNaN(dispOff[v]) || dt > 4) dispOff[v] = o;
      else if (dt > 0) dispOff[v] += Math.max(-P.sideways * dt, Math.min(P.sideways * dt, o - dispOff[v]));
      pointAt(sh, (ed / net.length[edge]) * sh.len, dispOff[v], pos, m * 2, head, m);
      if (dbg) {
        const te = this.tEdge[j], ts = shapes[te], tel = Math.min(8, Math.max(1, Math.round(net.lanes[te])));
        const tmp = new Float32Array(2);
        pointAt(ts, (Math.max(0, Math.min(net.length[te], this.tLocal[j])) / net.length[te]) * ts.len, laneOffset(tel, v % tel, twin[te] >= 0), tmp, 0);
        dbg.target[m * 2] = tmp[0]; dbg.target[m * 2 + 1] = tmp[1]; dbg.held[m] = cpush[j] > 0 ? 1 : 0; dbg.lag[m] = prevT[v] - dispD[v];
      }
      ids[m++] = v;
    }
    return { pos: pos.subarray(0, m * 2), head: head.subarray(0, m), ids: ids.subarray(0, m) };
  }
}
