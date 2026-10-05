import type { CarId, EventMode, Medal, RouteId } from '../../contracts/runtime-contracts.js';

/** Time trial and rival ghost: seconds (lower is better). Drift attack: banked points (higher is better). */
export interface MedalTargets { readonly gold: number; readonly silver: number; readonly bronze: number }
export type MedalMode = 'time-trial' | 'drift-attack';
/** Targets a route can declare on its own RouteDefinition (route.medalTargets) instead of using the table below. */
export type RouteMedalTargets = Readonly<Partial<Record<MedalMode, MedalTargets>>>;

interface MedalTableEntry {
  /** Targets only apply to this geometry version; a re-authored route gets no medals until it is re-measured. */
  readonly routeVersion: string;
  readonly targets: Readonly<Record<MedalMode, MedalTargets>>;
}

/**
 * Calibrated on the Challenger (CAR-01, the starter) on the Balanced tune with the medal probe
 * (notes/probes/medal-probe.ts, 2026-10-02). There are no car classes yet. The Cybertruck runs within 1% of these
 * times and the McLaren about 4% faster.
 *
 * Time trial, seconds:
 * - bronze: a newcomer on Assist High (full throttle, keyboard steering) or a careful cruise reaches it with room
 *   to spare. HW-01 newcomer 58.3 s, cruise 65.1 s. RP-01 cruise 126.3 s. CL-01 newcomer 63.6 s, cruise 76.0 s.
 * - silver: a good run with sensible braking points. Pursuit driver at 5.5 m/s^2 cornering: 54.1 / 108.0 / 61.0 s.
 * - gold: a very clean run at the car's limit on High, or a strong run with assists off. The scripted driver at
 *   8.5 m/s^2 cornering on High managed 49.1 / 99.4 / 53.0 s.
 *
 * Drift attack, points: re-checked 2026-10-03 with the skilled scripted drifter (notes/probes/drift-skill-probe.ts:
 * handbrake entry, throttle holds the slip angle, front wheels on the wanted course, chains banked before the
 * walls) on the Challenger with the default Drift assist. Banked scores, best runs and the usual spread:
 * HW-01 1030 (475 to 1030), RP-01 488 (45 to 490, the bot is weakest in hairpins), CL-01 2112 (980 to 2110,
 * wide sweepers let it link most of the lap). A quick clean lap with no deliberate drifting scores 79 / 59 / 57.
 * Bronze is a quick lap with a few slides, silver a decent linked run, gold just above the best scripted run.
 * HW-01 already matched that; RP-01 and CL-01 were far too easy and are scaled up. Re-measure against real
 * leaderboard data once it exists.
 */
export const MEDAL_TABLE: Readonly<Partial<Record<RouteId, MedalTableEntry>>> = {
  'HW-01': { routeVersion: '1.0.3', targets: {
    'time-trial': { gold: 50, silver: 55, bronze: 66 },
    'drift-attack': { gold: 1200, silver: 400, bronze: 100 },
  } },
  'RP-01': { routeVersion: 'rp01-v1', targets: {
    'time-trial': { gold: 100, silver: 109, bronze: 130 },
    'drift-attack': { gold: 650, silver: 200, bronze: 60 },
  } },
  'CL-01': { routeVersion: 'cl01-v1', targets: {
    'time-trial': { gold: 53.5, silver: 61.5, bronze: 76 },
    'drift-attack': { gold: 2500, silver: 700, bronze: 120 },
  } },
};

/**
 * Car pace factors for the time medals. The table above is calibrated on the Challenger (1.0); a car's time targets
 * are the table times multiplied by its factor, so a faster car needs proportionally faster laps for the same medal.
 * Drift points are not scaled. Each factor is the measured lap time ratio against the Challenger for the scripted
 * driver the gold times were set with (medal probe quick:8.5 on Assist Beginner, all three routes, 2026-10-02):
 * Cybertruck 1.011 / 1.012 / 1.005, McLaren 0.915 / 0.897 / 0.898 (HW-01 / RP-01 / CL-01). A car without an entry
 * keeps the table times. Re-measure with notes/probes/medal-probe.ts when a car's physics change.
 */
export const CAR_MEDAL_PACE: Readonly<Partial<Record<CarId, number>>> = { 'CAR-01': 1, 'CAR-02': 1.01, 'CAR-04': 0.9, 'CAR-05': 0.97, 'CAR-06': 0.88 };

/** The time-target factor for a car: 1 when unknown or out of the sane 0.5 to 1.5 range. */
export function carMedalPace(carId?: CarId | null): number {
  const factor = carId ? CAR_MEDAL_PACE[carId] : undefined;
  return typeof factor === 'number' && Number.isFinite(factor) && factor >= 0.5 && factor <= 1.5 ? factor : 1;
}

/** Scales time targets by a pace factor (rounded to 0.1 s); drift attack targets are returned unchanged. */
export function scaleMedalTargets(mode: EventMode, targets: MedalTargets, pace: number): MedalTargets {
  if (medalModeOf(mode) !== 'time-trial' || pace === 1 || !Number.isFinite(pace) || pace <= 0) return targets;
  const scale = (seconds: number): number => Math.round(seconds * pace * 10) / 10;
  return { gold: scale(targets.gold), silver: scale(targets.silver), bronze: scale(targets.bronze) };
}

/** Rival ghost races the same lap as time trial, so it uses the time targets. */
export const medalModeOf = (mode: EventMode): MedalMode => mode === 'drift-attack' ? 'drift-attack' : 'time-trial';

/** Time targets must get stricter bronze to gold (falling), score targets rising; all positive and finite. */
export function validMedalTargets(mode: EventMode, targets: MedalTargets | null | undefined): targets is MedalTargets {
  if (!targets) return false;
  const { gold, silver, bronze } = targets;
  if (![gold, silver, bronze].every(value => Number.isFinite(value) && value > 0)) return false;
  return medalModeOf(mode) === 'time-trial' ? gold < silver && silver < bronze : gold > silver && silver > bronze;
}

/**
 * The medal targets for a run. A route's own declared targets win; otherwise the calibrated table applies when the
 * route version matches. Time targets are then scaled by the car's pace factor (CAR_MEDAL_PACE). Returns undefined
 * when nothing calibrated applies (no medals, as before).
 */
export function medalTargetsFor(route: Readonly<{ id: RouteId; version: string; medalTargets?: RouteMedalTargets }>, mode: EventMode, carId?: CarId | null): MedalTargets | undefined {
  const key = medalModeOf(mode);
  const declared = route.medalTargets?.[key];
  const entry = MEDAL_TABLE[route.id];
  const tabled = entry && entry.routeVersion === route.version ? entry.targets[key] : undefined;
  const base = validMedalTargets(mode, declared) ? declared : validMedalTargets(mode, tabled) ? tabled : undefined;
  return base ? scaleMedalTargets(mode, base, carMedalPace(carId)) : undefined;
}

/** The best medal still in reach (time) or the next one to beat (score), for the HUD. Null once gold is secured or lost. */
export function nextMedalTarget(mode: EventMode, targets: MedalTargets, value: number): { readonly medal: Exclude<Medal, 'none'>; readonly target: number } | null {
  const order = ['gold', 'silver', 'bronze'] as const;
  if (medalModeOf(mode) === 'time-trial') {
    for (const medal of order) if (value <= targets[medal]) return { medal, target: targets[medal] };
    return null;
  }
  for (const medal of [...order].reverse()) if (value < targets[medal]) return { medal, target: targets[medal] };
  return null;
}
