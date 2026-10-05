/**
 * Mission content and the pure rules around it: the career list, the daily and weekly pools, the date seeded rotation,
 * how real game events turn into counters, and the largest amount the missions can ever pay (the plausibility ceiling
 * the wallet and remote verification use). No I/O, no DOM.
 *
 * Money rules (see SECURITY.md):
 *   - every mission has a FIXED reward, 25..250 Marks; the amount is looked up here, never taken from the caller;
 *   - a career mission pays once ever, a daily or weekly one once per period (keys below);
 *   - the most the missions can pay a wallet of a given age is  CAREER_TOTAL + DAILY_MAX x days + WEEKLY_MAX x weeks.
 *
 * Events that count are sanity checked (valid run, long enough, this physics version, an assist level recorded, finite
 * and in range numbers). A run's "grade" (0 to 3) is its real medal when the route has medal targets
 * (src/events/medal-targets.ts); on a route without targets a drift attack is graded from its score with
 * FALLBACK_GRADE_SCORE. Score and chain thresholds below are on the drift attack scale of the medal table
 * (HW-01: bronze 100, silver 400, gold 1200 points; the best scripted run scored 374).
 */
import type { RunResult } from '../../contracts/runtime-contracts';
import { VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';
import { MIN_RUN_SECONDS } from './gameplay';
import { applyStats, dayEndsAt, dayIdOf, weekEndsAt, weekIdOf, type Counters, type MissionProgress, type StatChange } from './mission-progress';
import { allowanceDays } from './wallet';

export type MissionKind = 'career' | 'daily' | 'weekly';
/** Unit of the counter, for the progress text: 'm' shows kilometres, 'ds' shows seconds. */
export type MissionUnit = '' | 'm' | 'ds' | 'kmh' | 'pts';
/**
 * What this build can actually do right now. A mission is only offered when it can be completed with this content:
 * a "finish on 3 routes" mission needs 3 playable routes, an online mission needs online racing, and so on. They
 * appear by themselves when the content does (a new map, online reaching the player). Every field but routes is
 * optional and defaults to "not available" (online, rival) or "available" (cars).
 */
export interface MissionContext {
  /** Playable route ids (runtime.routes()). */
  readonly routes: readonly string[];
  /** Online racing exists on this platform. Default false. */
  readonly online?: boolean;
  /** A rival ghost run can start. Default false. */
  readonly rival?: boolean;
  /** At least one car is for sale in the shop. Default true. */
  readonly cars?: boolean;
}
/** Everything available: the default for tests and tools, and what the budget assumes. */
export const ALL_AVAILABLE: MissionContext = Object.freeze({ routes: ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'], online: true, rival: true, cars: true });

export interface MissionDef {
  readonly id: string;
  readonly kind: MissionKind;
  readonly group: string;
  readonly title: string;
  readonly text: string;
  readonly reward: number;
  readonly unit: MissionUnit;
  readonly target: (ctx: MissionContext) => number;
  readonly measure: (counters: Counters, ctx: MissionContext) => number;
  /** When set, the mission is only offered while this is true (see MissionContext). */
  readonly needs?: (ctx: MissionContext) => boolean;
}

export const MIN_REWARD = 25;
export const MAX_REWARD = 250;
export const DAILY_SLOTS = 3;
export const WEEKLY_SLOTS = 2;
/**
 * Drift attack score grades (bronze, silver, gold) for a route that has NO medal targets yet. Between the calibrated
 * routes (HW-01 100/400/1200, RP-01 60/150/500, CL-01 60/160/500). Never used on a route that has targets: there
 * the real medal decides, so "no medal" means grade 0.
 */
export const FALLBACK_GRADE_SCORE: readonly [number, number, number] = [80, 250, 600];

/* ------------------------------------------------------------------ builders */

const stat = (key: string) => (c: Counters): number => c[key] ?? 0;
const fixed = (n: number) => (): number => n;
const routesWith = (prefix: string, min: number, only = '') => (c: Counters, ctx: MissionContext): number =>
  ctx.routes.filter(route => route.startsWith(only) && (c[`${prefix}:${route}`] ?? 0) >= min).length;
const routeCount = (only = '') => (ctx: MissionContext): number => Math.max(1, ctx.routes.filter(route => route.startsWith(only)).length);

const needsOnline = (ctx: MissionContext): boolean => ctx.online === true;
const needsRival = (ctx: MissionContext): boolean => ctx.rival === true;
const needsCars = (ctx: MissionContext): boolean => ctx.cars !== false;
/** At least `n` playable routes (optionally only those starting with `prefix`). */
const needsRoutes = (n: number, prefix = '') => (ctx: MissionContext): boolean => ctx.routes.filter(route => route.startsWith(prefix)).length >= n;
/** Marks a mission as needing something. */
const when = (mission: MissionDef, needs: MissionDef['needs']): MissionDef => ({ ...mission, needs });

function def(kind: MissionKind, group: string, id: string, title: string, text: string, reward: number, key: string, target: number, unit: MissionUnit = ''): MissionDef {
  return { id, kind, group, title, text, reward, unit, target: fixed(target), measure: stat(key) };
}
function custom(kind: MissionKind, group: string, id: string, title: string, text: string, reward: number, target: MissionDef['target'], measure: MissionDef['measure']): MissionDef {
  return { id, kind, group, title, text, reward, unit: '', target, measure };
}
const career = (...args: [string, string, string, string, number, string, number, MissionUnit?]): MissionDef => def('career', ...args);
const daily = (...args: [string, string, string, string, number, string, number, MissionUnit?]): MissionDef => def('daily', ...args);
const weekly = (...args: [string, string, string, string, number, string, number, MissionUnit?]): MissionDef => def('weekly', ...args);

/* ------------------------------------------------------------------ career (once, ever) */

export const CAREER: readonly MissionDef[] = Object.freeze([
  career('Events', 'first-finish', 'First finish', 'Finish your first event.', 50, 'runs', 1),
  career('Events', 'five-events', 'Regular', 'Finish 5 events.', 75, 'runs', 5),
  career('Events', 'twenty-five-events', 'Seasoned', 'Finish 25 events.', 150, 'runs', 25),
  career('Events', 'fifty-events', 'Fifty events', 'Finish 50 events.', 250, 'runs', 50),
  career('Events', 'time-trials-3', 'Against the clock', 'Finish 3 time trials.', 50, 'runs.tt', 3),
  career('Events', 'drift-attacks-3', 'Sideways', 'Finish 3 drift attacks.', 50, 'runs.da', 3),
  when(career('Events', 'ghost-race', 'Chase the ghost', 'Finish a rival ghost race.', 75, 'runs.rg', 1), needsRival),

  career('Drift', 'chain-500', 'First chain', 'Build a 50 point drift chain in an event.', 50, 'chain.max', 50, 'pts'),
  career('Drift', 'chain-1500', 'Linked up', 'Build a 150 point drift chain in an event.', 75, 'chain.max', 150, 'pts'),
  career('Drift', 'chain-3000', 'Long chain', 'Build a 300 point drift chain in an event.', 100, 'chain.max', 300, 'pts'),
  career('Drift', 'chain-6000', 'Chain gang', 'Build a 600 point drift chain in an event.', 150, 'chain.max', 600, 'pts'),
  career('Drift', 'chain-12000', 'Unbroken', 'Build an 800 point drift chain in an event.', 250, 'chain.max', 800, 'pts'),
  career('Drift', 'drift-3s', 'Hold it', 'Hold one drift for 3 seconds in an event.', 50, 'drift.ds', 30, 'ds'),
  career('Drift', 'drift-6s', 'Steady slide', 'Hold one drift for 6 seconds in an event.', 100, 'drift.ds', 60, 'ds'),
  career('Drift', 'drift-10s', 'Ten second drift', 'Hold one drift for 10 seconds without a break.', 150, 'drift.ds', 100, 'ds'),
  career('Drift', 'drift-15s', 'Endless corner', 'Hold one drift for 15 seconds without a break.', 250, 'drift.ds', 150, 'ds'),
  career('Score', 'score-2500', 'On the board', 'Bank 100 points in one event.', 75, 'score.max', 100, 'pts'),
  career('Score', 'score-8000', 'Big night', 'Bank 400 points in one event.', 125, 'score.max', 400, 'pts'),
  career('Score', 'score-20000', 'After hours legend', 'Bank 1,000 points in one event.', 200, 'score.max', 1000, 'pts'),

  career('Distance', 'distance-5km', 'Warm up', 'Drive 5 km in total.', 50, 'dist.m', 5000, 'm'),
  career('Distance', 'distance-25km', 'Night shift', 'Drive 25 km in total.', 100, 'dist.m', 25000, 'm'),
  career('Distance', 'distance-50km', 'Fifty kilometres', 'Drive 50 km in total.', 150, 'dist.m', 50000, 'm'),
  career('Distance', 'distance-100km', 'Long way round', 'Drive 100 km in total.', 200, 'dist.m', 100000, 'm'),
  career('Distance', 'distance-250km', 'Cross country', 'Drive 250 km in total.', 250, 'dist.m', 250000, 'm'),
  career('Speed', 'speed-150', 'Quick', 'Reach 150 km/h.', 50, 'speed.kmh', 150, 'kmh'),
  career('Speed', 'speed-200', 'Flat out', 'Reach 200 km/h.', 100, 'speed.kmh', 200, 'kmh'),

  when(custom('career', 'Routes', 'routes-3', 'Three roads', 'Finish an event on 3 different routes.', 75, fixed(3), routesWith('rc', 1)), needsRoutes(3)),
  when(custom('career', 'Routes', 'routes-all', 'Every road', 'Finish an event on every route.', 200, routeCount(), routesWith('rc', 1)), needsRoutes(2)),
  when(custom('career', 'Routes', 'region-harbor', 'Harbor Works', 'Finish an event on every Harbor Works route.', 75, routeCount('HW-'), routesWith('rc', 1, 'HW-')), needsRoutes(2, 'HW-')),
  when(custom('career', 'Routes', 'region-ridge', 'Ridge Pass', 'Finish an event on every Ridge Pass route.', 100, routeCount('RP-'), routesWith('rc', 1, 'RP-')), needsRoutes(2, 'RP-')),
  when(custom('career', 'Routes', 'region-coast', 'Coastline', 'Finish an event on every Coastline route.', 100, routeCount('CL-'), routesWith('rc', 1, 'CL-')), needsRoutes(2, 'CL-')),
  when(custom('career', 'Routes', 'bronze-everywhere', 'Bronze everywhere', 'Earn a bronze grade or better on every route.', 150, routeCount(), routesWith('rg', 1)), needsRoutes(2)),
  when(custom('career', 'Routes', 'silver-everywhere', 'Silver everywhere', 'Earn a silver grade or better on every route.', 200, routeCount(), routesWith('rg', 2)), needsRoutes(2)),
  when(custom('career', 'Routes', 'gold-three', 'Golden hour', 'Earn a gold grade on 3 different routes.', 250, fixed(3), routesWith('rg', 3)), needsRoutes(3)),

  career('Skill', 'recover-1', 'Back in the fight', 'Crash, recover and still finish the event.', 75, 'recov.fin', 1),
  career('Skill', 'recover-3', 'Never stay down', 'Crash, recover and still finish 3 events.', 100, 'recov.fin', 3),
  career('Skill', 'recover-grade', 'Dust off', 'Recover from a crash and still earn a bronze grade or better.', 100, 'recov.grade', 1),
  career('Skill', 'clean-run', 'Clean line', 'Finish an event of 45 seconds or more without a crash recovery.', 50, 'clean', 1),
  career('Skill', 'unassisted-1', 'No hands', 'Finish an event with driving assists off.', 100, 'runs.off', 1),
  career('Skill', 'unassisted-10', 'Pure driver', 'Finish 10 events with driving assists off.', 200, 'runs.off', 10),

  when(career('Online', 'online-first', 'Out with others', 'Finish an online race.', 100, 'net.races', 1), needsOnline),
  when(career('Online', 'online-win', 'First place', 'Win an online race.', 150, 'net.wins', 1), needsOnline),
  when(career('Online', 'online-5', 'Regular at the quay', 'Finish 5 online races.', 150, 'net.races', 5), needsOnline),
  when(career('Online', 'online-wins-3', 'Hard to catch', 'Win 3 online races.', 250, 'net.wins', 3), needsOnline),

  career('Garage', 'buy-1', 'First purchase', 'Buy something in the shop.', 50, 'buy.items', 1),
  career('Garage', 'buy-5', 'Collector', 'Own 5 shop items.', 100, 'buy.items', 5),
  when(career('Garage', 'buy-car', 'New wheels', 'Buy a car.', 150, 'buy.car', 1), needsCars),
  career('Garage', 'buy-10', 'Full garage', 'Own 10 shop items.', 200, 'buy.items', 10),
]);

/* ------------------------------------------------------------------ daily and weekly pools */

export const DAILY_POOL: readonly MissionDef[] = Object.freeze([
  daily('Events', 'd-warm-up', 'Warm up', 'Finish an event today.', 25, 'runs', 1),
  daily('Events', 'd-hat-trick', 'Hat trick', 'Finish 3 events today.', 50, 'runs', 3),
  daily('Distance', 'd-mile', 'Short haul', 'Drive 3 km today.', 25, 'dist.m', 3000, 'm'),
  daily('Distance', 'd-long-haul', 'Long haul', 'Drive 8 km today.', 50, 'dist.m', 8000, 'm'),
  daily('Drift', 'd-slide', 'Slide show', 'Hold one drift for 4 seconds in an event today.', 25, 'drift.ds', 40, 'ds'),
  daily('Drift', 'd-chain', 'Big chain', 'Build a 150 point drift chain in an event today.', 50, 'chain.max', 150, 'pts'),
  daily('Score', 'd-score', 'Points night', 'Bank 250 points in one event today.', 75, 'score.max', 250, 'pts'),
  when(custom('daily', 'Routes', 'd-two-roads', 'Two roads', 'Finish events on 2 different routes today.', 50, fixed(2), routesWith('rc', 1)), needsRoutes(2)),
  when(custom('daily', 'Routes', 'd-three-roads', 'Three roads', 'Finish events on 3 different routes today.', 100, fixed(3), routesWith('rc', 1)), needsRoutes(3)),
  when(daily('Online', 'd-online', 'Out tonight', 'Finish an online race today.', 75, 'net.races', 1), needsOnline),
  when(daily('Online', 'd-online-win', 'Take the win', 'Win an online race today.', 100, 'net.wins', 1), needsOnline),
  daily('Skill', 'd-clean', 'Clean sheet', 'Finish an event of 45 seconds or more without a crash recovery today.', 50, 'clean', 1),
  daily('Speed', 'd-speed', 'Quick one', 'Reach 160 km/h today.', 25, 'speed.kmh', 160, 'kmh'),
  daily('Skill', 'd-assists-off', 'Hands off', 'Finish an event with driving assists off today.', 75, 'runs.off', 1),
  daily('Skill', 'd-recover', 'Carry on', 'Crash, recover and still finish an event today.', 50, 'recov.fin', 1),
]);

export const WEEKLY_POOL: readonly MissionDef[] = Object.freeze([
  weekly('Distance', 'w-marathon', 'Marathon week', 'Drive 40 km this week.', 200, 'dist.m', 40000, 'm'),
  weekly('Events', 'w-regular', 'On the rota', 'Finish 15 events this week.', 150, 'runs', 15),
  weekly('Drift', 'w-chain', 'Chain master', 'Build a 500 point drift chain in an event this week.', 250, 'chain.max', 500, 'pts'),
  when(custom('weekly', 'Routes', 'w-grand-tour', 'Grand tour', 'Finish an event on every route this week.', 250, routeCount(), routesWith('rc', 1)), needsRoutes(3)),
  weekly('Score', 'w-score', 'Score hunter', 'Bank 800 points in one event this week.', 200, 'score.max', 800, 'pts'),
  weekly('Drift', 'w-long-drift', 'Long slide', 'Hold one drift for 12 seconds in an event this week.', 200, 'drift.ds', 120, 'ds'),
  when(weekly('Online', 'w-online', 'Quay regular', 'Finish 5 online races this week.', 200, 'net.races', 5), needsOnline),
  when(weekly('Online', 'w-online-wins', 'Winning week', 'Win 2 online races this week.', 250, 'net.wins', 2), needsOnline),
  weekly('Skill', 'w-assists-off', 'Unassisted', 'Finish 5 events with driving assists off this week.', 150, 'runs.off', 5),
  weekly('Speed', 'w-speed', 'Top end', 'Reach 180 km/h this week.', 150, 'speed.kmh', 180, 'kmh'),
]);

export const ALL_MISSIONS: readonly MissionDef[] = Object.freeze([...CAREER, ...DAILY_POOL, ...WEEKLY_POOL]);
const BY_ID = new Map(ALL_MISSIONS.map(mission => [mission.id, mission]));
export const missionById = (id: string): MissionDef | undefined => BY_ID.get(id);

/* ------------------------------------------------------------------ ceilings (anti-cheat budget) */

const sum = (list: readonly MissionDef[]): number => list.reduce((total, mission) => total + mission.reward, 0);
const topSum = (list: readonly MissionDef[], n: number): number =>
  [...list].sort((a, b) => b.reward - a.reward).slice(0, n).reduce((total, mission) => total + mission.reward, 0);

/** Every career mission, once. */
export const CAREER_TOTAL = sum(CAREER);
/** The most any one UTC day can pay: the three best daily rewards. */
export const DAILY_MAX = topSum(DAILY_POOL, DAILY_SLOTS);
/** The most any one UTC week can pay: the two best weekly rewards. */
export const WEEKLY_MAX = topSum(WEEKLY_POOL, WEEKLY_SLOTS);

/** UTC weeks touched from `createdAt` to `now`, inclusive. Unknown or future creation counts as one week. */
export function allowanceWeeks(createdAt: number | null | undefined, now: number): number {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now) return 1;
  return weekIdOf(now) - weekIdOf(createdAt) + 1;
}

/**
 * The most Marks missions can have paid a wallet created at `createdAt`, as of `now`:
 * every career mission once, the daily maximum for each UTC day, the weekly maximum for each UTC week.
 * Stored mission earnings above this are ignored (wallet.plausibleAccrued) and remote players are verified against it.
 */
export function missionCeiling(createdAt: number | null | undefined, now: number): number {
  return CAREER_TOTAL + DAILY_MAX * allowanceDays(createdAt, now) + WEEKLY_MAX * allowanceWeeks(createdAt, now);
}

/* ------------------------------------------------------------------ rotation (seeded by UTC date) */

function seeder(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
  return () => { // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks `n` missions from a pool, deterministically from the seed, preferring different groups. */
export function pickRotation(pool: readonly MissionDef[], seed: string, n: number): MissionDef[] {
  const random = seeder(seed);
  const order = pool.map((mission, index) => ({ mission, index, key: random() })).sort((a, b) => a.key - b.key || a.index - b.index).map(entry => entry.mission);
  const chosen: MissionDef[] = [], groups = new Set<string>();
  for (const mission of order) { if (chosen.length < n && !groups.has(mission.group)) { chosen.push(mission); groups.add(mission.group); } }
  for (const mission of order) { if (chosen.length < n && !chosen.includes(mission)) chosen.push(mission); }
  return chosen;
}

/** Can this mission be completed with the content in `ctx`? Impossible ones are never offered. */
export function isAvailable(mission: MissionDef, ctx: MissionContext = ALL_AVAILABLE): boolean {
  try { return (mission.needs ? mission.needs(ctx) : true) && mission.target(ctx) > 0; } catch { return false; }
}
/**
 * The daily set for a UTC day: picked from the missions that are possible right now. The pick is deterministic for the
 * same date and the same content, so every device agrees; when content changes (a new map) the set may re-roll.
 */
export const dailyFor = (dayId: string, ctx: MissionContext = ALL_AVAILABLE): MissionDef[] =>
  pickRotation(DAILY_POOL.filter(mission => isAvailable(mission, ctx)), `lateral-daily:${dayId}`, DAILY_SLOTS);
export const weeklyFor = (weekId: number, ctx: MissionContext = ALL_AVAILABLE): MissionDef[] =>
  pickRotation(WEEKLY_POOL.filter(mission => isAvailable(mission, ctx)), `lateral-weekly:${weekId}`, WEEKLY_SLOTS);

/* ------------------------------------------------------------------ views and claim keys */

export interface MissionView {
  /** Unique for this mission in this period; the wallet idempotency key is `m:${key}`. */
  readonly key: string;
  readonly def: MissionDef;
  readonly kind: MissionKind;
  readonly value: number;
  readonly target: number;
  /** 0..1 */
  readonly fraction: number;
  readonly complete: boolean;
  readonly claimed: boolean;
  /** When a daily or weekly mission expires (ms); null for career. */
  readonly endsAt: number | null;
}

/** The claim key of a mission in the period containing `now`. */
export function claimKeyOf(def: MissionDef, now: number): string {
  return def.kind === 'career' ? `c:${def.id}` : def.kind === 'daily' ? `d:${dayIdOf(now)}:${def.id}` : `w:${weekIdOf(now)}:${def.id}`;
}

export function viewOf(def: MissionDef, progress: MissionProgress, ctx: MissionContext, claimed: (key: string) => boolean, now: number): MissionView {
  const scope = def.kind === 'career' ? progress.life : def.kind === 'daily' ? (progress.day.id === dayIdOf(now) ? progress.day.c : {}) : (progress.week.id === weekIdOf(now) ? progress.week.c : {});
  const target = Math.max(1, def.target(ctx));
  const value = Math.max(0, def.measure(scope, ctx));
  const key = claimKeyOf(def, now);
  return {
    key, def, kind: def.kind, value: Math.min(value, target), target, fraction: Math.min(1, value / target), complete: value >= target,
    claimed: claimed(key), endsAt: def.kind === 'career' ? null : def.kind === 'daily' ? dayEndsAt(now) : weekEndsAt(now),
  };
}

/** Every mission the player can see right now: today's daily set, this week's weekly set, then the career list. */
export function missionViews(progress: MissionProgress, ctx: MissionContext, claimed: (key: string) => boolean, now: number): MissionView[] {
  const make = (def: MissionDef): MissionView => viewOf(def, progress, ctx, claimed, now);
  return [...dailyFor(dayIdOf(now), ctx).map(make), ...weeklyFor(weekIdOf(now), ctx).map(make), ...CAREER.filter(mission => isAvailable(mission, ctx)).map(make)];
}

/** Looks up an active mission by claim key (career `c:id`, daily `d:day:id`, weekly `w:week:id`), or null when it is not active now. */
export function activeByKey(key: string, now: number, ctx: MissionContext = ALL_AVAILABLE): MissionDef | null {
  const parts = key.split(':');
  if (parts[0] === 'c' && parts.length === 2) { const found = missionById(parts[1]!); return found?.kind === 'career' && isAvailable(found, ctx) ? found : null; }
  if (parts[0] === 'd' && parts.length === 3 && parts[1] === dayIdOf(now)) return dailyFor(parts[1], ctx).find(mission => mission.id === parts[2]) ?? null;
  if (parts[0] === 'w' && parts.length === 3 && Number(parts[1]) === weekIdOf(now)) return weeklyFor(weekIdOf(now), ctx).find(mission => mission.id === parts[2]) ?? null;
  return null;
}

/** Short progress text such as "3 / 5", "12.4 / 50 km" or "6 / 10 s". */
export function progressText(view: Pick<MissionView, 'def' | 'value' | 'target'>): string {
  const { unit } = view.def;
  const n = (v: number, digits = 0): string => v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  if (unit === 'm') return `${n(view.value / 1000, 1)} / ${n(view.target / 1000, 1)} km`;
  if (unit === 'ds') return `${n(view.value / 10, 1)} / ${n(view.target / 10, 1)} s`;
  if (unit === 'kmh') return `${n(view.value)} / ${n(view.target)} km/h`;
  return `${n(view.value)} / ${n(view.target)}`;
}

/* ------------------------------------------------------------------ events to counters */

export const MAX_RUN_SECONDS = 3600;
export const MAX_RUN_SCORE = 2_000_000;
export const MAX_CHAIN = 500_000;
/** Faster than this is not a car (net.quantize allows 200 m/s for packets; real cars stay far below). */
export const MAX_SPEED_MS = 120;
const ROUTE = /^[A-Z]{2}-\d{2}$/;
const RANK: Readonly<Record<string, number>> = { none: 0, bronze: 1, silver: 2, gold: 3 };

/** What the tracker saw during one event run (the result itself has no chain or crash data). */
export interface RunTelemetry {
  /** Highest unbanked drift chain, points. */
  readonly maxChain: number;
  /** Longest unbroken valid drift, seconds. */
  readonly driftSeconds: number;
  /** Crash recoveries during the run. */
  readonly recoveries: number;
  /** The route had medal targets for this mode (so the result's medal is authoritative). Default true. */
  readonly hasTargets?: boolean;
}

/**
 * 0..3. The real medal when the route has medal targets (`hasTargets`): no medal then means grade 0. On a route
 * without targets a drift attack is graded from its score (FALLBACK_GRADE_SCORE) and other modes get no grade.
 */
export function gradeOf(result: Pick<RunResult, 'medal' | 'bankedScore' | 'mode'>, hasTargets = true): number {
  const medal = RANK[result.medal] ?? 0;
  if (hasTargets || medal > 0 || result.mode !== 'drift-attack') return medal;
  const score = Number.isFinite(result.bankedScore) ? result.bankedScore : 0;
  return score >= FALLBACK_GRADE_SCORE[2] ? 3 : score >= FALLBACK_GRADE_SCORE[1] ? 2 : score >= FALLBACK_GRADE_SCORE[0] ? 1 : 0;
}

/** Sanity gate: only a believable, valid, current-physics event run with a recorded assist level counts at all. */
export function qualifyingRun(result: RunResult | null | undefined): result is RunResult {
  if (!result || typeof result !== 'object') return false;
  if (result.valid !== true || typeof result.runId !== 'string' || !result.runId || result.runId.length > 70) return false;
  if (!Number.isFinite(result.elapsedActiveSeconds) || result.elapsedActiveSeconds < MIN_RUN_SECONDS || result.elapsedActiveSeconds > MAX_RUN_SECONDS) return false;
  if (result.physicsVersion !== VEHICLE_PHYSICS_VERSION) return false;
  if (result.assist !== 'off' && result.assist !== 'medium' && result.assist !== 'high') return false;
  if (!Number.isFinite(result.bankedScore) || result.bankedScore < 0 || result.bankedScore > MAX_RUN_SCORE) return false;
  if (typeof result.routeId !== 'string' || !ROUTE.test(result.routeId)) return false;
  return result.mode === 'time-trial' || result.mode === 'drift-attack' || result.mode === 'rival-ghost';
}

/** Counter changes for a finished run, or null when the run does not qualify. Impossible values are clamped, not paid. */
export function runChanges(result: RunResult | null | undefined, telemetry: RunTelemetry | null): StatChange[] | null {
  if (!qualifyingRun(result)) return null;
  const grade = gradeOf(result, telemetry?.hasTargets ?? true);
  const changes: StatChange[] = [
    { key: 'runs', add: 1 },
    { key: result.mode === 'time-trial' ? 'runs.tt' : result.mode === 'drift-attack' ? 'runs.da' : 'runs.rg', add: 1 },
    { key: 'score.max', max: Math.floor(result.bankedScore) },
    { key: `rc:${result.routeId}`, max: 1 },
    { key: `rg:${result.routeId}`, max: grade },
  ];
  if (result.assist === 'off') changes.push({ key: 'runs.off', add: 1 });
  if (telemetry) {
    const chain = Number.isFinite(telemetry.maxChain) ? Math.max(0, Math.min(MAX_CHAIN, telemetry.maxChain)) : 0;
    const drift = Number.isFinite(telemetry.driftSeconds) ? Math.max(0, Math.min(result.elapsedActiveSeconds, telemetry.driftSeconds)) : 0;
    const recoveries = Number.isFinite(telemetry.recoveries) ? Math.max(0, Math.floor(telemetry.recoveries)) : 0;
    if (chain > 0) changes.push({ key: 'chain.max', max: Math.floor(chain) });
    if (drift > 0) changes.push({ key: 'drift.ds', max: Math.floor(drift * 10) });
    if (recoveries > 0) { changes.push({ key: 'recov.fin', add: 1 }); if (grade >= 1) changes.push({ key: 'recov.grade', add: 1 }); }
    else if (result.elapsedActiveSeconds >= 45) changes.push({ key: 'clean', add: 1 });
  }
  return changes;
}

/** Live driving: whole metres driven and the best speed (km/h). Values above the physical limit are dropped. */
export function driveChanges(metres: number, topSpeedMS: number): StatChange[] {
  const changes: StatChange[] = [];
  const m = Number.isFinite(metres) ? Math.floor(Math.max(0, Math.min(5000, metres))) : 0;
  if (m > 0) changes.push({ key: 'dist.m', add: m });
  if (Number.isFinite(topSpeedMS) && topSpeedMS > 0 && topSpeedMS <= MAX_SPEED_MS) changes.push({ key: 'speed.kmh', max: Math.floor(topSpeedMS * 3.6) });
  return changes;
}

/** An online race result as the tracker reports it (see onlineOutcome). */
export interface OnlineOutcome {
  /** Unique per lobby race, e.g. `${lobbyId}:${race}`. */
  readonly id: string;
  readonly participants: number;
  readonly position: number;
  /** The race is decided (everyone else finished, was invalid or the lobby closed it) and you were first. */
  readonly won: boolean;
}

/** Counters for an online race: a finish needs at least one other racer; a win needs the race to be decided with you first. */
export function onlineChanges(kind: 'finish' | 'win', outcome: OnlineOutcome): StatChange[] {
  if (outcome.participants < 2 || outcome.position < 1) return [];
  if (kind === 'finish') return [{ key: 'net.races', add: 1 }];
  return outcome.won && outcome.position === 1 ? [{ key: 'net.wins', add: 1 }] : [];
}

/** Shop ownership as counters: how many items (and cars) the verified wallet holds. */
export function purchaseChanges(owned: readonly string[], carIds: ReadonlySet<string>): StatChange[] {
  const items = new Set(owned).size, cars = [...new Set(owned)].filter(id => carIds.has(id)).length;
  const changes: StatChange[] = [];
  if (items > 0) changes.push({ key: 'buy.items', max: items });
  if (cars > 0) changes.push({ key: 'buy.car', max: cars });
  return changes;
}

/** Applies a list of changes to progress (convenience for tests and the source). */
export const advance = (progress: MissionProgress, now: number, changes: readonly StatChange[]): MissionProgress =>
  changes.length ? applyStats(progress, now, changes) : progress;
