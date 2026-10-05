/**
 * Daily challenge rules (pure). One seeded route, mode, car and condition per UTC day, the same for every player:
 * the seed is the UTC date string, so no server is needed to agree on it.
 *
 *   dailySpec(day)        what today's challenge is ("Seven Bends drift attack in the Cybertruck")
 *   dailyOutcome(...)     does a finished run count for the daily board and reward
 *   dailyTiersFor(medal)  which reward tiers a counted run unlocks (finish, bronze, silver, gold)
 *   dailyStreak(days)     consecutive days with a counted run, ending today or yesterday
 */
import type { CarId, LightingPreset, Medal, RunResult } from '../../contracts/runtime-contracts';
import { ROUTES } from '../../content/events/catalog';
import { PLAYABLE_ROUTE_IDS, type PlayableRouteId } from '../world/route-registry';

export type DailyMode = 'drift-attack' | 'time-trial';
/** Extra condition: 'no-reset' means the run must finish without a single recovery (R or auto). */
export type DailyRule = 'none' | 'no-reset';
export interface DailySpec {
  readonly day: string;
  readonly route: PlayableRouteId;
  readonly routeName: string;
  readonly mode: DailyMode;
  readonly modeName: string;
  readonly car: CarId;
  readonly carName: string;
  readonly lighting: LightingPreset;
  readonly rule: DailyRule;
  /** "Seven Bends drift attack in the Cybertruck". */
  readonly title: string;
  /** Short condition line: "Blue hour. No resets." */
  readonly condition: string;
}

export const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Daily car pools. The Lancia Delta (CAR-05) and Agera (CAR-06) join from DAILY_POOL_V2_FROM; earlier days keep the
 * original pool so their specs (and any board rows written for them) never change. Same single random draw either way,
 * so the lighting and rule picks of every day are unaffected.
 */
export const DAILY_POOL_V2_FROM = '2026-10-04';
const DAILY_CAR_WEIGHTS_V1: readonly (readonly [CarId, number])[] = [['CAR-01', 4], ['CAR-02', 3], ['CAR-04', 3]];
const DAILY_CAR_WEIGHTS_V2: readonly (readonly [CarId, number])[] = [['CAR-01', 3], ['CAR-02', 2], ['CAR-04', 2], ['CAR-05', 2], ['CAR-06', 2]];
/** The weighted car pool for a UTC day (ISO dates compare as strings). */
export function dailyCarWeights(day: string): readonly (readonly [CarId, number])[] { return day >= DAILY_POOL_V2_FROM ? DAILY_CAR_WEIGHTS_V2 : DAILY_CAR_WEIGHTS_V1; }
/** Every car a daily can pick from today on. */
export const DAILY_CARS: readonly CarId[] = DAILY_CAR_WEIGHTS_V2.map(([car]) => car);
export const DAILY_CAR_NAMES: Readonly<Partial<Record<CarId, string>>> = { 'CAR-01': 'Challenger', 'CAR-02': 'Cybertruck', 'CAR-04': 'McLaren F1', 'CAR-05': 'Lancia Delta', 'CAR-06': 'Agera' };
const MODE_NAMES: Readonly<Record<DailyMode, string>> = { 'drift-attack': 'Drift attack', 'time-trial': 'Time trial' };

/** Reward tiers, paid once per day each. The sum is the daily cap of the daily challenge earn source. */
export const DAILY_TIERS: readonly { readonly id: 'finish' | 'bronze' | 'silver' | 'gold'; readonly marks: number; readonly label: string }[] = [
  { id: 'finish', marks: 30, label: 'Finish a counted run' },
  { id: 'bronze', marks: 15, label: 'Bronze medal' },
  { id: 'silver', marks: 15, label: 'Silver medal' },
  { id: 'gold', marks: 20, label: 'Gold medal' },
];
export type DailyTier = typeof DAILY_TIERS[number]['id'];
export const DAILY_MAX_MARKS = DAILY_TIERS.reduce((sum, tier) => sum + tier.marks, 0);

export function utcDay(nowMs: number): string { return new Date(nowMs).toISOString().slice(0, 10); }
export function isDay(value: unknown): value is string { return typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
/** ms until the next UTC midnight (never 0: at midnight exactly it is a full day). */
export function msUntilReset(nowMs: number): number { const left = DAY_MS - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS); return left; }
export function previousDay(day: string): string { return utcDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS); }

/** "05:12:33" (hours can exceed 24 only for bad input; clamped at 0). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** FNV-1a 32 bit. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}
/** Small deterministic PRNG (mulberry32), returns [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weighted<T>(rand: number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let at = rand * total;
  for (const [item, w] of items) { if (at < w) return item; at -= w; }
  return items[items.length - 1]![0];
}

function rawRouteIndex(day: string): number { return Math.floor(seededRandom(hashString(`lateral-daily-route:${day}`))() * PLAYABLE_ROUTE_IDS.length); }

/** Today's challenge. Invalid days fall back to 1970-01-01 so the function never throws. */
export function dailySpec(dayInput: string): DailySpec {
  const day = isDay(dayInput) ? dayInput : '1970-01-01';
  const rand = seededRandom(hashString(`lateral-daily:${day}`));
  // The route never repeats yesterday's (raw) pick, so two days in a row feel different.
  let routeIndex = rawRouteIndex(day);
  if (routeIndex === rawRouteIndex(previousDay(day))) routeIndex = (routeIndex + 1 + (hashString(day) % (PLAYABLE_ROUTE_IDS.length - 1))) % PLAYABLE_ROUTE_IDS.length;
  const route = PLAYABLE_ROUTE_IDS[routeIndex]!;
  const mode = weighted<DailyMode>(rand(), [['drift-attack', 1], ['time-trial', 1]]);
  const car = weighted<CarId>(rand(), dailyCarWeights(day));
  const lighting = weighted<LightingPreset>(rand(), [['golden-hour', 1], ['blue-hour', 1]]);
  const rule = weighted<DailyRule>(rand(), [['none', 65], ['no-reset', 35]]);
  const routeName = ROUTES.find(entry => entry.routeId === route)?.name ?? route;
  const carName = DAILY_CAR_NAMES[car] ?? car;
  const modeName = MODE_NAMES[mode];
  const title = `${routeName} ${modeName.toLowerCase()} in the ${carName}`;
  const condition = `${lighting === 'blue-hour' ? 'Blue hour' : 'Golden hour'}.${rule === 'no-reset' ? ' No resets.' : ''}`;
  return { day, route, routeName, mode, modeName, car, carName, lighting, rule, title, condition };
}

export interface DailyRunContext {
  /** UTC day when the run started and when it finished: a run across midnight counts for neither day. */
  readonly startedDay: string;
  readonly finishedDay: string;
  /** Recoveries during the run (RuntimeView.recovery.count at the result). */
  readonly recoveries: number;
}
export interface DailyOutcome { readonly counts: boolean; readonly reason: string | null; readonly value: number }

/** Board value of a run: milliseconds for time trial, banked points for drift attack. */
export function dailyValue(mode: DailyMode, result: Pick<RunResult, 'elapsedActiveSeconds' | 'bankedScore'>): number {
  return mode === 'time-trial' ? Math.round(result.elapsedActiveSeconds * 1000) : Math.round(result.bankedScore);
}

/** Whether a finished run counts for this daily. The reason is short player-facing text. */
export function dailyOutcome(spec: DailySpec, result: RunResult | null | undefined, context: DailyRunContext): DailyOutcome {
  const no = (reason: string): DailyOutcome => ({ counts: false, reason, value: 0 });
  if (!result) return no('No result.');
  if (result.routeId !== spec.route || result.mode !== spec.mode || result.carId !== spec.car) return no('Not today\'s route, mode and car.');
  if (context.startedDay !== spec.day || context.finishedDay !== spec.day) return no('The daily changed during the run.');
  if (!result.valid) return no('Run not recorded.');
  if (spec.rule === 'no-reset' && !(context.recoveries === 0)) return no('Today is a no reset day.');
  const value = dailyValue(spec.mode, result);
  if (!Number.isSafeInteger(value) || value <= 0) return no('Run not recorded.');
  return { counts: true, reason: null, value };
}

/** Tiers a counted run unlocks: finish always, then each medal tier up to the one earned. */
export function dailyTiersFor(medal: Medal | null | undefined): DailyTier[] {
  const rank = medal === 'gold' ? 3 : medal === 'silver' ? 2 : medal === 'bronze' ? 1 : 0;
  return DAILY_TIERS.filter((_, index) => index <= rank).map(tier => tier.id);
}

/** Consecutive days in `days` ending today (or yesterday, so a streak survives until you play today). */
export function dailyStreak(days: readonly string[], today: string): number {
  const set = new Set(days.filter(isDay));
  let cursor = set.has(today) ? today : previousDay(today);
  let streak = 0;
  while (set.has(cursor) && streak < 3660) { streak++; cursor = previousDay(cursor); }
  return streak;
}
