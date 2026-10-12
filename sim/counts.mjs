// Matching DfT count points to graph edges, and comparing simulated flows with them.
//
// DfT gives AADF: annual average daily two-way flow. The simulation covers a typical
// weekday, so the target is AADF × weekdayFactor (from TRA0307, ≈1.05), summed over
// both directions.

const MAX_MATCH_M = 60;

function nearestOnEdge(geom, x, y) {
  let best = Infinity, heading = [1, 0];
  for (let i = 1; i < geom.length; i++) {
    const [ax, ay] = geom[i - 1], [bx, by] = geom[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) { best = d; const l = Math.sqrt(l2); heading = [dx / l, dy / l]; }
  }
  return { d: best, heading };
}

const refMatches = (edgeRef, road) => !!edgeRef && edgeRef.split(";").map((r) => r.trim()).includes(road);
const isMajorRoad = (road) => /^[ABM]\d/.test(road);
const MINOR = new Set(["tertiary", "unclassified", "residential", "living_street", "service"]);

// Returns [{ count, edges: [edgeId, edgeId?], target }]; unmatched points dropped
export function matchCounts(graph, counts, factor = 1) {
  const { lat0, lon0, mx, my } = graph.projection;
  const out = [];
  for (const c of counts) {
    const x = (c.lon - lon0) * mx, y = -(c.lat - lat0) * my;
    let cands = [];
    for (const e of graph.edges) {
      const ok = isMajorRoad(c.road) ? refMatches(e.ref, c.road) : MINOR.has(e.highway);
      if (!ok) continue;
      // cheap bbox reject
      const g = e.geom;
      if (Math.abs(g[0][0] - x) > 3000 || Math.abs(g[0][1] - y) > 3000) continue;
      const m = nearestOnEdge(g, x, y);
      if (m.d <= MAX_MATCH_M) cands.push({ e: e.id, link: e.highway.endsWith("_link"), ...m });
    }
    if (cands.some((k) => !k.link)) cands = cands.filter((k) => !k.link);
    if (!cands.length) continue;
    cands.sort((a, b) => a.d - b.d);
    const first = cands[0];
    // the other direction: nearest candidate heading the opposite way
    const second = cands.find((k) => k.heading[0] * first.heading[0] + k.heading[1] * first.heading[1] < -0.5);
    out.push({
      count: c,
      edges: second ? [first.e, second.e] : [first.e],
      target: c.allMotorVehicles * factor,
    });
  }
  return out;
}

// GEH: standard traffic-model fit statistic for hourly flows; < 5 is a good match.
// For daily flows it's computed on the average hour (daily / 24).
export const geh = (sim, obs) => Math.sqrt((2 * (sim - obs) ** 2) / Math.max(1e-9, sim + obs));
const gehDaily = (sim, obs) => geh(sim / 24, obs / 24);

export function compare(matches, flow) {
  const rows = matches.map((m) => {
    const sim = m.edges.reduce((s, e) => s + flow[e], 0);
    return {
      countPointId: m.count.countPointId, road: m.count.road, method: m.count.method,
      lat: m.count.lat, lon: m.count.lon, edges: m.edges,
      sim, target: Math.round(m.target), geh: gehDaily(sim, m.target),
    };
  });
  const n = rows.length;
  const gehUnder5 = rows.filter((r) => r.geh < 5).length / (n || 1);
  const meanT = rows.reduce((s, r) => s + r.target, 0) / (n || 1);
  const ssTot = rows.reduce((s, r) => s + (r.target - meanT) ** 2, 0);
  const ssRes = rows.reduce((s, r) => s + (r.target - r.sim) ** 2, 0);
  return { rows, n, gehUnder5, r2: 1 - ssRes / (ssTot || 1), totalSim: rows.reduce((s, r) => s + r.sim, 0), totalTarget: Math.round(rows.reduce((s, r) => s + r.target, 0)) };
}
