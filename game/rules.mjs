// Game rules: road types, prices and the daily economy. All money in £.
import { TIME } from "./time.mjs";

export const LANE_W = 3.3; // metres per lane, as drawn and as checked against buildings

// Same per-class values as scripts/build-graph.mjs (capacity per lane, veh/h)
export const PER_LANE = {
  motorway: 2000, trunk: 1800, primary: 1000, secondary: 900, tertiary: 800,
  unclassified: 600, residential: 500, living_street: 200, service: 200,
};
export const baseClass = (hw) => hw.replace("_link", "");
export const capacityFor = (hw, lanes) => lanes * (PER_LANE[baseClass(hw)] ?? 200);

// What the player can build. fwd = lanes in the drawing direction, bwd = lanes back.
export const ROAD_TYPES = [
  { id: "street",   name: "Street",        hint: "1 + 1 · 20 mph",  hw: "residential", fwd: 1, bwd: 1, mph: 20 },
  { id: "oneway1",  name: "One-way",       hint: "1 lane · 20 mph", hw: "tertiary",    fwd: 1, bwd: 0, mph: 20 },
  { id: "oneway2",  name: "One-way wide",  hint: "2 lanes · 30 mph", hw: "secondary",  fwd: 2, bwd: 0, mph: 30 },
  { id: "avenue",   name: "Avenue",        hint: "2 + 2 · 30 mph",  hw: "secondary",   fwd: 2, bwd: 2, mph: 30 },
  { id: "boulevard", name: "Boulevard",    hint: "3 + 3 · 30 mph",  hw: "primary",     fwd: 3, bwd: 3, mph: 30 },
  { id: "arterial", name: "Arterial",      hint: "2 + 2 · 40 mph",  hw: "trunk",       fwd: 2, bwd: 2, mph: 40 },
];

// £ per lane-metre of new road, by class (bigger roads need deeper foundations, signals …)
const LANE_M = { residential: 1500, living_street: 1500, service: 1200, unclassified: 1500, tertiary: 1800, secondary: 2200, primary: 2800, trunk: 3800, motorway: 5000 };
export const laneMetreCost = (hw) => LANE_M[baseClass(hw)] ?? 1500;
export const PRICE = {
  junction: 120_000,          // new junction on an existing road
  removeLaneM: 250,           // digging up a lane-metre
  reclassShare: 0.3,          // changing a road's class re-does 30% of its surface
  home: 350_000,              // compulsory purchase per home
  job: 60_000,                // per job relocated
  minBuilding: 150_000,       // sheds, garages …
  slip: 60_000,               // a slip road merging into / peeling off an existing road
  bridge: 2.5,                // × the lane-metre price where the deck is in the air
  tunnel: 4,                  // × where it runs underground
  ramp: 1.5,                  // × on the climb / dip between ground and deck / tunnel
};

// Bridges and tunnels: heights in metres. Every level is LEVEL_H up (bridge) or down
// (tunnel); OSM bridges/tunnels (data/<area>.levels.json) sit at level × LEVEL_H.
export const GRADE = {
  levelH: 5,          // m per level
  maxGrade: 0.1,      // 10%: a bridge needs a 50 m ramp each end
  clearance: 4.5,     // m between two roads that cross without meeting
  atGrade: 1,         // m: closer than this, two crossing roads meet in a junction
  airborne: 2.5,      // m: above this a piece is drawn and priced as bridge, below −this as tunnel
  underBuildings: -4.5, // a tunnel this deep passes under buildings and water
};
export const LEVELS = [
  { level: -1, name: "Tunnel", key: "PageDown" },
  { level: 0, name: "Ground" },
  { level: 1, name: "Bridge", key: "PageUp" },
  { level: 2, name: "High bridge" },
];

// Slip roads (Trafficity-style lane logic): a one-way road joining an existing road at a
// shallow angle merges into it (or peels off it) instead of making a junction, and the
// road gets an extra lane for the merge / the exit.
export const SLIP = {
  maxAngleDeg: 35,    // sharper than this it's an ordinary junction
  auxLaneM: 150,      // length of the added lane after a merge / before an exit
  minAuxM: 30,        // shorter than this, no added lane
};
// Tightest curve a road can take: radius in metres by total lanes
export const minRadius = (lanes) => 8 + lanes * 3;
export const buildingCost = (b) => Math.round(Math.max(PRICE.minBuilding, b.homes * PRICE.home + b.jobs * PRICE.job) / 10_000) * 10_000;

export const ECONOMY = {
  startBudget: 30_000_000,
  baseGrant: 1_500_000,       // the council's daily transport budget when you match the untouched city …
  performanceGrant: 1_000_000, // … plus or minus up to this much, depending on how you did
  fullGrantAt: 0.05,          // 5% less delay than the untouched city earns the whole extra; 5% more loses it
  perHourSaved: 500,          // £ bonus per vehicle-hour of delay saved vs. the untouched city
  strikesBeforeCut: 3,        // days in a row worse than the untouched city before the council steps in
  budgetCut: 0.25,            // share of your budget the council takes back the first time
  cutsBeforeFired: 1,         // after this many cuts, the next run of bad days ends the game
  noiseBand: 0.01,            // results within ±1% of the untouched city count as "the same": the sim
                              // reacts to any edit by about that much, so smaller gaps aren't your doing
  suppressedTripHours: 0.5,   // a trip not made because of jams counts as half an hour lost
  noRouteHours: 1,            // a trip with no road to its destination at all: a long detour
};

// Money and council patience at the end of a day. d = share of delay saved vs. the untouched
// city (negative = worse). Returns the day's numbers and the save's new strike / cut state.
export function dayResult(lost, base, { budget, strikes = 0, cuts = 0 }) {
  const d = base > 0 ? (base - lost) / base : 0;
  const counted = beyondNoise(d); // the part of the gap that's really yours
  const perf = Math.max(-1, Math.min(1, counted / ECONOMY.fullGrantAt));
  const grant = Math.round((ECONOMY.baseGrant + perf * ECONOMY.performanceGrant) / 10_000) * 10_000;
  const bonus = Math.round((counted * base * ECONOMY.perHourSaved) / 10_000) * 10_000;
  const worse = counted < 0;
  strikes = worse ? strikes + 1 : 0;
  let cut = 0, councilCut = false, fired = null;
  if (strikes >= ECONOMY.strikesBeforeCut) {
    if (cuts >= ECONOMY.cutsBeforeFired) fired = "council";
    else { councilCut = true; cut = Math.round((Math.max(0, budget + grant + bonus) * ECONOMY.budgetCut) / 10_000) * 10_000; cuts++; strikes = 0; }
  }
  const income = grant + bonus - cut;
  if (!fired && budget + income < 0) fired = "broke";
  return { d, grant, bonus, cut, councilCut, income, strikes, cuts, fired };
}

// "3.1% better" / "0.2% worse" against the untouched city, coloured; d as in dayResult
export const beyondNoise = (d) => Math.sign(d) * Math.max(0, Math.abs(d) - ECONOMY.noiseBand);
export function vsUntouched(d) {
  if (!beyondNoise(d)) return `<b>about the same</b>`;
  const pct = Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0);
  return d > 0 ? `<b class="good">${pct}% better</b>` : `<b class="bad">${pct}% worse</b>`;
}

// Car-hours lost to congestion: time beyond free flow + trips given up or cut off, on the
// game clock (sim-time delay × STRETCH)
export const lostHours = (st) => TIME.stretch * ((st.tripSec - st.freeSec) / 3600 + st.suppressed * ECONOMY.suppressedTripHours + (st.unroutable ?? 0) * ECONOMY.noRouteHours);

export const money = (v) => {
  const a = Math.abs(v), s = v < 0 ? "−£" : "£";
  return a >= 1e6 ? `${s}${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M` : a >= 1e3 ? `${s}${Math.round(a / 1e3)}k` : `${s}${Math.round(a)}`;
};
