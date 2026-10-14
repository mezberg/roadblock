// Game time. The sim keeps real physics (speeds, capacities, queues, all in "sim seconds");
// the game clock runs STRETCH times faster than sim time, so a 20-minute commute takes four
// game hours and you can follow a car across the map.
//
// To keep congestion close to the calibrated sim, only about one in STRETCH trips is simulated
// and departures keep their real clock times, so each road gets about the real number of cars
// per sim second. See demandBoost for the correction that makes up for the short peaks.
export const TIME = {
  stretch: 12,           // game seconds per sim second
  demandBoost: 1.67,     // × the share of trips simulated. A stretched peak is short in sim time, so
                         // queues build less than in a real 3-hour peak; 1.67 brings the untouched
                         // city back to its calibrated ×2.0 delay (avg trip ≈ 4 game hours).
                         // (1.43 before roads kept their fractional outflow per second and 1.6
                         // before short lane-tag dips were bridged, both in sim/core.mjs)
  lanesDemandBoost: 1.05, // the same for the lane model (sim/micro.mjs): its junctions pass fewer cars
                         // than the queue model's calibrated capacities; 1.05 gives the untouched
                         // city ×2.0 delay and roads that empty at night
  realSecPerGameHour: 60, // at ×1
  dayEndHour: 34,        // game clock limit for the last long trips (they run past midnight)
  baselineEvery: 300,    // game seconds between baseline samples (5 game minutes)
};
export const simToClock = (t) => t * TIME.stretch;
export const clockToSim = (c) => c / TIME.stretch;
export const simOptions = () => ({ maxSimSec: clockToSim(TIME.dayEndHour * 3600) });

const hash32 = (x) => { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; };

// Real trips [origin, dest, departSec, type, …] → the game's trips: one in STRETCH (× demandBoost),
// picked by a fixed hash so it's the same cars every day, departing at the same clock time.
export function gameTrips(trips, boost = TIME.demandBoost) {
  const out = [];
  const keep = Math.round((2 ** 24 * boost) / TIME.stretch);
  trips.forEach((t, i) => { if ((hash32(i + 1) >>> 8) < keep) out.push([t[0], t[1], clockToSim(t[2]), t[3], i]); });
  return out;
}

// What each car looks like — a fixed mix close to DfT's London traffic shares
export const VEHICLES = [
  { name: "Car", len: 4.5, w: 1.9 },
  { name: "Van", len: 5.6, w: 2.1 },
  { name: "Lorry", len: 8.5, w: 2.5 },
  { name: "Bus", len: 10.5, w: 2.6 },
];
export const vehicleOf = (id) => { const h = hash32(id * 7 + 3) % 100; return h < 78 ? 0 : h < 94 ? 1 : h < 98 ? 2 : 3; };
export const colourOf = (id) => hash32(id * 13 + 5) % 8;
export const PURPOSE = ["Local trip", "Resident", "Visitor", "Passing through"];
