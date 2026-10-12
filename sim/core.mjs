// Roadblock traffic simulation core — shared by the browser (sim/worker.mjs) and Node
// (scripts/calibrate.mjs). No DOM or Node APIs here.
//
// Model: mesoscopic queue simulation (in the spirit of MATSim's QSim).
//   - Every directed edge is a FIFO queue with a free-flow travel time, an outflow
//     capacity (veh/s) and a storage capacity (how many cars physically fit).
//   - A car can leave an edge once its free-flow time has elapsed, the edge has outflow
//     capacity left this tick and the next edge has room — so queues form at bottlenecks
//     and spill back upstream. Cars stuck longer than `stuckTimeSec` squeeze through
//     anyway, which prevents total gridlock.
//   - Cars are routed when they depart, by Dijkstra on current travel-time estimates.

export const TRIP_TYPES = ["internal", "residents", "visitors", "through"];

// Per road class: share of the speed limit actually driven in free flow (humps, parked
// cars, give-ways on minor streets), and a route-choice penalty — drivers prefer main
// roads over rat-runs even when the clock says they're equally fast.
export const ROAD_CLASS = {
  motorway:      { speed: 0.9,  routePenalty: 1 },
  trunk:         { speed: 0.85, routePenalty: 1 },
  primary:       { speed: 0.8,  routePenalty: 1 },
  secondary:     { speed: 0.8,  routePenalty: 1.05 },
  tertiary:      { speed: 0.75, routePenalty: 1.15 },
  unclassified:  { speed: 0.7,  routePenalty: 1.3 },
  residential:   { speed: 0.6,  routePenalty: 1.5 },
  living_street: { speed: 0.5,  routePenalty: 2 },
  service:       { speed: 0.5,  routePenalty: 2 },
};
const classOf = (highway) => ROAD_CLASS[highway.replace("_link", "")] ?? ROAD_CLASS.service;

export const DEFAULTS = {
  // Trip suppression: if the best route is this much slower than free flow (and by at
  // least `suppressMinDelaySec`), the trip isn't made — people go later, another way or
  // not at all. Without this, queues behind a saturated bottleneck grow all day.
  suppressDelayRatio: 3,
  suppressMinDelaySec: 20 * 60,
  vehicleSpacingM: 7.5,  // road length one queued car occupies
  stuckTimeSec: 10,     // as MATSim: a car blocked this long squeezes onto the next road anyway
  costUpdateSec: 30,     // how often router travel-time estimates refresh
  maxSimSec: 27 * 3600, // a weekday from 00:00, plus time for late trips to finish
};

// --- Network: typed-array view of data/<area>.graph.json ------------------------------
// Edges flagged `dead` (removed by the player) keep their id and their arrays — cars still
// on them drain to the end node — but they are left out of the adjacency, so no new route
// uses them. Ids only ever grow, so per-edge simulation state survives a network edit.
export class Network {
  constructor(graph, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const N = graph.nodes.length, E = graph.edges.length;
    this.graph = graph; this.N = N; this.E = E;
    this.from = new Int32Array(E); this.to = new Int32Array(E);
    this.length = new Float64Array(E); this.lanes = new Float64Array(E);
    this.freeTime = new Float64Array(E); this.capPerSec = new Float64Array(E);
    this.routePenalty = new Float64Array(E);
    this.storage = new Int32Array(E);
    this.dead = new Uint8Array(E);
    graph.edges.forEach((e, i) => {
      this.dead[i] = e.dead ? 1 : 0;
      this.from[i] = e.from; this.to[i] = e.to;
      this.length[i] = e.length; this.lanes[i] = e.lanes;
      const cls = classOf(e.highway);
      this.freeTime[i] = Math.max(1, e.length / ((e.speedKmh / 3.6) * cls.speed));
      this.routePenalty[i] = cls.routePenalty;
      this.capPerSec[i] = e.capacity / 3600;
      this.storage[i] = Math.max(1, Math.floor((e.length * e.lanes) / o.vehicleSpacingM));
    });
    // Node coordinates and the fastest possible speed per unit of route cost — the A*
    // heuristic (straight-line distance / this speed) never overestimates, because costs
    // only grow from free flow (penalties ≥ 1, queues ≥ 0) and edges are at least as long
    // as the straight line between their ends.
    this.nodeX = Float64Array.from(graph.nodes, (n) => n.x);
    this.nodeY = Float64Array.from(graph.nodes, (n) => n.y);
    this.maxSpeed = 0;
    graph.edges.forEach((e, i) => {
      if (!this.dead[i]) this.maxSpeed = Math.max(this.maxSpeed, e.length / (this.freeTime[i] * this.routePenalty[i]));
    });
    // Outgoing / incoming adjacency in CSR form (live edges only)
    const live = [];
    for (let i = 0; i < E; i++) if (!this.dead[i]) live.push(i);
    this.outStart = new Int32Array(N + 1);
    for (const i of live) this.outStart[this.from[i] + 1]++;
    for (let n = 0; n < N; n++) this.outStart[n + 1] += this.outStart[n];
    this.outEdges = new Int32Array(live.length);
    const fill = this.outStart.slice(0, N);
    for (const i of live) this.outEdges[fill[this.from[i]]++] = i;
    this.inStart = new Int32Array(N + 1);
    for (const i of live) this.inStart[this.to[i] + 1]++;
    for (let n = 0; n < N; n++) this.inStart[n + 1] += this.inStart[n];
    this.inEdges = new Int32Array(live.length);
    const fillIn = this.inStart.slice(0, N);
    for (const i of live) this.inEdges[fillIn[this.to[i]]++] = i;
    this.buildLandmarks(o.landmarks ?? 8);
  }

  // ALT landmarks for the A* heuristic: exact free-flow costs from and to a few nodes
  // spread around the edge of the network. By the triangle inequality
  //   cost(v → t) ≥ max(d(L, t) − d(L, v), d(v, L) − d(t, L))
  // and live costs are never below free-flow costs, so the bound stays admissible.
  buildLandmarks(k) {
    const free = Float64Array.from(this.freeTime, (t, e) => t * this.routePenalty[e]);
    const full = (src, reverse) => {
      const dist = new Float64Array(this.N).fill(Infinity);
      const heap = new Router(this, true);
      dist[src] = 0; heap.size = 0; heap.push(0, src);
      const [start, list, other] = reverse ? [this.inStart, this.inEdges, this.from] : [this.outStart, this.outEdges, this.to];
      while (heap.size) {
        const u = heap.pop(), du = heap.popKey;
        if (du > dist[u]) continue;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const e = list[j], v = other[e], dv = du + free[e];
          if (dv < dist[v]) { dist[v] = dv; heap.push(dv, v); }
        }
      }
      return dist;
    };
    // farthest-first selection, starting from the node farthest from the centre
    const picks = [];
    let best = 0;
    for (let n = 0; n < this.N; n++) if (Math.hypot(this.nodeX[n], this.nodeY[n]) > Math.hypot(this.nodeX[best], this.nodeY[best])) best = n;
    const minD = new Float64Array(this.N).fill(Infinity);
    for (let i = 0; i < k; i++) {
      picks.push(best);
      for (let n = 0; n < this.N; n++) minD[n] = Math.min(minD[n], Math.hypot(this.nodeX[n] - this.nodeX[best], this.nodeY[n] - this.nodeY[best]));
      best = minD.indexOf(Math.max(...minD));
    }
    // Flattened, node-major: lm[(v * k + i) * 2] = d(L_i, v), [... + 1] = d(v, L_i)
    this.lmCount = k;
    this.lm = new Float64Array(this.N * k * 2);
    picks.forEach((l, i) => {
      const from = full(l, false), to = full(l, true);
      for (let v = 0; v < this.N; v++) { this.lm[(v * k + i) * 2] = from[v]; this.lm[(v * k + i) * 2 + 1] = to[v]; }
    });
  }
}

// --- Router: A* with a binary heap and lazy reset ---------------------------------------
export class Router {
  constructor(net, heapOnly = false) {
    this.hk = new Float64Array(1024); this.hv = new Int32Array(1024); this.size = 0;
    if (heapOnly) return;
    this.net = net;
    this.dist = new Float64Array(net.N);
    this.prevEdge = new Int32Array(net.N);
    this.stamp = new Uint32Array(net.N);
    this.done = new Uint32Array(net.N);
    this.cur = 0;
  }
  push(k, v) {
    if (this.size === this.hk.length) {
      const hk = new Float64Array(this.size * 2); hk.set(this.hk); this.hk = hk;
      const hv = new Int32Array(this.size * 2); hv.set(this.hv); this.hv = hv;
    }
    let i = this.size++;
    const { hk, hv } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = k; hv[i] = v;
  }
  pop() {
    const { hk, hv } = this;
    const v = hv[0], k = hk[0];
    const lk = hk[--this.size], lv = hv[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= lk) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = lk; hv[i] = lv;
    this.popKey = k;
    return v;
  }
  // Returns the edge ids from origin to destination node, or null if unreachable
  route(origin, dest, cost) {
    const { net, dist, prevEdge, stamp, done } = this;
    const id = ++this.cur;
    const { nodeX, nodeY, lm, lmCount: L } = net;
    const dx = nodeX[dest], dy = nodeY[dest], inv = 1 / net.maxSpeed, tBase = dest * L * 2;
    this.size = 0;
    stamp[origin] = id; dist[origin] = 0; prevEdge[origin] = -1;
    this.push(0, origin);
    while (this.size) {
      const u = this.pop();
      if (done[u] === id) continue;
      done[u] = id;
      if (u === dest) break;
      const du = dist[u];
      for (let j = net.outStart[u]; j < net.outStart[u + 1]; j++) {
        const e = net.outEdges[j], v = net.to[e], dv = du + cost[e];
        if (done[v] !== id && (stamp[v] !== id || dv < dist[v])) {
          stamp[v] = id; dist[v] = dv; prevEdge[v] = e;
          // heuristic: best lower bound from straight line and ALT landmarks
          const ex = nodeX[v] - dx, ey = nodeY[v] - dy;
          let hv = Math.sqrt(ex * ex + ey * ey) * inv;
          for (let i = 0, vb = v * L * 2; i < L; i++) {
            const a = lm[tBase + 2 * i] - lm[vb + 2 * i], c = lm[vb + 2 * i + 1] - lm[tBase + 2 * i + 1];
            if (a > hv) hv = a;
            if (c > hv) hv = c;
          }
          this.push(dv + hv, v);
        }
      }
    }
    if (done[dest] !== id) return null;
    const path = [];
    for (let n = dest; n !== origin; n = net.from[prevEdge[n]]) path.push(prevEdge[n]);
    return Int32Array.from(path.reverse());
  }
}

// --- Demand scaling ---------------------------------------------------------------------
// Applies a multiplier per trip (calibration output) by deterministic resampling: a trip
// with multiplier 2.3 appears twice, and a third time with probability 0.3. Extra copies
// get a fresh departure time within the same hour. Each output trip keeps its source
// index as element [4].
export function scaleTrips(trips, perTrip = null, seed = 7) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  trips.forEach((t, i) => {
    const m = perTrip ? perTrip[i] : 1;
    const copies = Math.floor(m) + (rand() < m % 1 ? 1 : 0);
    const hour = Math.floor(t[2] / 3600) * 3600;
    for (let c = 0; c < copies; c++) out.push([t[0], t[1], c === 0 ? t[2] : hour + Math.floor(rand() * 3600), t[3], i]);
  });
  return out.sort((a, b) => a[2] - b[2]);
}

// --- Simulation -----------------------------------------------------------------------
const EDGE_SLOTS = 2 ** 24; // edge ids stay below this
const hash32 = (x) => { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; };

export class Simulation {
  constructor(net, trips, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.net = net;
    this.router = new Router(net);
    this.trips = trips; // [origin, dest, departSec, type], sorted by departSec
    this.nextTrip = 0;
    this.t = 0;
    let seed = this.o.seed ?? 12345;
    this.rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

    const E = net.E, V = trips.length;
    this.queue = Array.from({ length: E }, () => []);
    this.qHead = new Int32Array(E);
    this.count = new Int32Array(E);
    this.budget = new Float64Array(E);
    // When each idle edge last had a car leave (its budget keeps filling while no one uses it)
    this.idleSince = new Float64Array(E).fill(-1e9);
    this.cost = Float64Array.from(net.freeTime, (t, e) => t * net.routePenalty[e]);
    this.freeCost = Float64Array.from(this.cost);
    this.lastCostUpdate = 0;
    this.isActive = new Uint8Array(E);
    this.active = [];

    // Results
    this.flow = new Int32Array(E);              // cars that entered each edge
    this.plannedFlow = new Int32Array(E);       // cars whose route uses each edge (demand)
    this.flowByType = new Int32Array(E * 4);
    this.delaySec = new Float64Array(E);        // total time spent beyond free flow

    // Per vehicle
    this.vRoute = new Array(V);
    this.vPos = new Int32Array(V);
    this.vEnter = new Float64Array(V);
    this.vReady = new Float64Array(V);
    this.vType = new Uint8Array(V);
    this.vDepart = new Float64Array(V);
    this.vFreeTime = new Float64Array(V);
    this.cancelled = new Uint8Array(V); // trips that no longer happen (their building was demolished)
    this.removed = 0;
    this.onRoad = 0; this.arrived = 0; this.unroutable = 0; this.suppressed = 0; this.totalTripSec = 0; this.totalFreeSec = 0;
    this.routeCache = new Map(); this.routeCacheEpoch = -1;
    // Optional: record which watched edges (e.g. DfT count sites) each vehicle's route uses
    this.watch = opts.watchEdges ?? null; // Int32Array edge → site index, -1 if not watched
    this.vSites = this.watch ? new Array(V) : null;
  }

  get done() { return this.nextTrip >= this.trips.length && this.onRoad === 0; }

  // `at`: when the car got here — within the last second if it rolled straight on from the
  // previous road, so it doesn't lose the rest of that second at every junction
  enterEdge(v, e, at = this.t) {
    const { net } = this;
    this.queue[e].push(v);
    this.count[e]++;
    this.flow[e]++;
    this.flowByType[e * 4 + this.vType[v]]++;
    this.vEnter[v] = at;
    this.vReady[v] = at + net.freeTime[e];
    if (!this.isActive[e]) {
      this.isActive[e] = 1; this.active.push(e);
      // The stop line has been free since the last car left, so a car on an empty road may
      // leave as soon as it gets there — not wait 1/capacity from when it came on (up to
      // 18 s on a 200 veh/h side street: a car stopping at a clear junction). Busy roads
      // never go idle, so their flow limit is unchanged.
      const cap = net.capPerSec[e];
      this.budget[e] = Math.min(Math.max(1, cap), this.budget[e] + cap * Math.max(0, at - this.idleSince[e]));
    }
  }

  routeFor(o, d) {
    const epoch = Math.floor(this.t / this.o.costUpdateSec);
    if (epoch !== this.routeCacheEpoch) { this.routeCache.clear(); this.routeCacheEpoch = epoch; }
    const key = o * this.net.N + d;
    let r = this.routeCache.get(key);
    if (r === undefined) { r = this.router.route(o, d, this.cost); this.routeCache.set(key, r); }
    return r;
  }

  // Busy edges in a random order that depends only on each edge's id and the clock, not on
  // a shared random stream: an edit then reorders only the edges it touches, instead of
  // reshuffling the whole city (which made any change swing the day's total by ±1–2%).
  orderActive() {
    const act = this.active;
    if (this.o.legacyShuffle) {
      for (let i = act.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        const tmp = act[i]; act[i] = act[j]; act[j] = tmp;
      }
      return act;
    }
    const n = act.length, keys = (this.orderKeys?.length >= n ? this.orderKeys : (this.orderKeys = new Float64Array(Math.max(1024, n * 2)))).subarray(0, n);
    const salt = Math.imul(this.t + 1, 0x9e3779b1);
    for (let i = 0; i < n; i++) keys[i] = (hash32(act[i] ^ salt) >>> 8) * EDGE_SLOTS + act[i]; // 24-bit priority, then edge id
    keys.sort();
    for (let i = 0; i < n; i++) act[i] = keys[i] % EDGE_SLOTS;
    return act;
  }

  updateCosts() {
    // Travel time = free-flow time + time to discharge the cars that can't be moving freely
    const { net, cost, count } = this;
    for (let e = 0; e < net.E; e++) {
      const cap = net.capPerSec[e], free = net.freeTime[e];
      const excess = count[e] - cap * free;
      cost[e] = (excess > 0 ? free + excess / cap : free) * net.routePenalty[e];
    }
    this.lastCostUpdate = this.t;
  }

  step(dt = 1) {
    const { net, trips, queue, qHead, count, budget } = this;

    // Departures
    while (this.nextTrip < trips.length && trips[this.nextTrip][2] <= this.t) {
      const v = this.nextTrip++;
      if (this.cancelled[v]) { this.removed++; continue; }
      const [o, d, , type] = trips[v];
      const route = o === d ? null : this.routeFor(o, d);
      if (!route || !route.length) { this.unroutable++; continue; }
      let cost = 0, freeCost = 0;
      for (const e of route) { cost += this.cost[e]; freeCost += this.freeCost[e]; }
      if (cost > freeCost * this.o.suppressDelayRatio && cost - freeCost > this.o.suppressMinDelaySec) { this.suppressed++; continue; }
      this.vRoute[v] = route; this.vPos[v] = 0; this.vType[v] = type; this.vDepart[v] = this.t;
      let free = 0;
      for (const e of route) free += net.freeTime[e];
      this.vFreeTime[v] = free;
      for (const e of route) {
        this.plannedFlow[e]++;
        if (this.watch && this.watch[e] >= 0) (this.vSites[v] ??= []).push(this.watch[e]);
      }
      this.onRoad++;
      this.enterEdge(v, route[0]);
    }

    // Movement — visit busy edges in random order so no approach always has priority
    const act = this.orderActive();
    for (const e of act) {
      const capDt = net.capPerSec[e] * dt;
      budget[e] = Math.min(budget[e] + capDt, Math.max(1, capDt));
      const q = queue[e];
      while (qHead[e] < q.length && budget[e] >= 1) {
        const v = q[qHead[e]];
        if (this.vReady[v] > this.t) break;
        const route = this.vRoute[v], pos = this.vPos[v];
        const last = pos === route.length - 1;
        if (!last) {
          const next = route[pos + 1];
          if (count[next] >= net.storage[next] && this.t - this.vReady[v] < this.o.stuckTimeSec) break;
        }
        qHead[e]++; count[e]--; budget[e] -= 1;
        // ready during the last second → it left when it got to the end; held longer → now
        const left = this.vReady[v] > this.t - 1 ? this.vReady[v] : this.t;
        this.delaySec[e] += Math.max(0, left - this.vEnter[v] - net.freeTime[e]);
        if (last) {
          this.onRoad--; this.arrived++; this.vRoute[v] = null;
          this.totalTripSec += left - this.vDepart[v];
          this.totalFreeSec += this.vFreeTime[v];
        } else {
          this.vPos[v] = pos + 1;
          this.enterEdge(v, route[pos + 1], left);
        }
      }
      if (qHead[e] > 64 && qHead[e] * 2 > q.length) { q.splice(0, qHead[e]); qHead[e] = 0; }
    }
    this.active = act.filter((e) => {
      if (count[e] > 0) return true;
      this.isActive[e] = 0; queue[e].length = 0; qHead[e] = 0; this.idleSince[e] = this.t + dt; // budget[e] is kept
      return false;
    });

    this.t += dt;
    if (this.t - this.lastCostUpdate >= this.o.costUpdateSec) this.updateCosts();
  }

  // Swap in an edited network mid-run (same edge ids, maybe more of them). Cars keep their
  // place; any car whose remaining route uses a removed edge is re-routed from the end of
  // the edge it is on now, and simply finishes there if no route is left.
  applyNetwork(net) {
    const oldE = this.net.E, E = net.E;
    if (E > oldE) {
      const grow = (a) => { const b = new a.constructor(a.length / oldE * E); b.set(a); return b; };
      for (const k of ["qHead", "count", "budget", "idleSince", "isActive", "flow", "plannedFlow", "flowByType", "delaySec"]) this[k] = grow(this[k]);
      for (let e = oldE; e < E; e++) this.queue.push([]);
    }
    this.net = net;
    this.router = new Router(net);
    this.freeCost = Float64Array.from(net.freeTime, (t, e) => t * net.routePenalty[e]);
    this.cost = new Float64Array(E);
    this.updateCosts();
    this.routeCache.clear();
    let rerouted = 0;
    for (const e of this.active) {
      const q = this.queue[e];
      for (let h = this.qHead[e]; h < q.length; h++) {
        const v = q[h], route = this.vRoute[v], pos = this.vPos[v];
        let broken = false;
        for (let k = pos + 1; k < route.length && !broken; k++) broken = net.dead[route[k]] === 1;
        if (!broken) continue;
        const rest = this.router.route(net.to[e], this.trips[v][1], this.cost);
        const r = new Int32Array(1 + (rest?.length ?? 0));
        r[0] = e; if (rest) r.set(rest, 1);
        this.vRoute[v] = r; this.vPos[v] = 0; rerouted++;
      }
    }
    return rerouted;
  }

  run(onProgress, everySec = 600) {
    while (!this.done && this.t < this.o.maxSimSec) {
      this.step(1);
      if (onProgress && this.t % everySec === 0) onProgress(this);
    }
    return this;
  }

  // Travel time / free-flow time ratio per edge (1 = free flowing), from current queues
  congestion(out = new Float32Array(this.net.E)) {
    const { net, count } = this;
    for (let e = 0; e < net.E; e++) {
      const cap = net.capPerSec[e], free = net.freeTime[e];
      const excess = count[e] - cap * free;
      out[e] = excess > 0 ? free / (free + excess / cap) : 1;
    }
    return out;
  }

  stats() {
    return {
      t: this.t, onRoad: this.onRoad, arrived: this.arrived, unroutable: this.unroutable, suppressed: this.suppressed,
      departed: this.nextTrip - this.removed, total: this.trips.length - this.removed, removed: this.removed,
      tripSec: this.totalTripSec, freeSec: this.totalFreeSec,
      avgTripMin: this.arrived ? this.totalTripSec / this.arrived / 60 : 0,
      delayIndex: this.totalFreeSec ? this.totalTripSec / this.totalFreeSec : 1,
    };
  }
}
