/**
 * Achievements and badges (pure, data driven). Stats are folded from game events (finished runs, daily runs, ghost wins,
 * photos, replays, online races); each achievement is one row in ACHIEVEMENTS with a progress function over the stats.
 *
 * Unlocks are client side and cosmetic: they never pay Marks. Other players see your top badges in the online lobby
 * through a small presence bit mask (badgeMask / decodeBadgeMask), which is clamped and whitelisted on the way in.
 */
import type { Medal, RunResult } from '../../contracts/runtime-contracts';

export type BadgeTier = 'bronze' | 'silver' | 'gold';
export interface FeatStats {
  readonly v: 1;
  readonly runs: number;
  readonly validRuns: number;
  readonly gold: number;
  readonly silver: number;
  readonly bronze: number;
  readonly goldRoutes: readonly string[];
  readonly routes: readonly string[];
  readonly cars: readonly string[];
  readonly bestDrift: number;
  readonly dailyDays: readonly string[];
  readonly bestStreak: number;
  readonly ghostWins: number;
  readonly photos: number;
  readonly replays: number;
  readonly onlineRaces: number;
  readonly onlineWins: number;
  /** Achievement id -> unlock time (ms). */
  readonly unlocked: Readonly<Record<string, number>>;
}
export interface Achievement {
  readonly id: string;
  /** Presence bit (0..29). Never reuse a bit for a different achievement. */
  readonly bit: number;
  readonly name: string;
  readonly line: string;
  /** Two characters on the badge. */
  readonly badge: string;
  readonly tier: BadgeTier;
  progress(stats: FeatStats): readonly [current: number, target: number];
}

const count = (n: number, target: number) => [Math.min(n, target), target] as const;
export const ACHIEVEMENTS: readonly Achievement[] = Object.freeze([
  { id: 'first-run', bit: 0, name: 'Off the line', line: 'Finish your first run.', badge: '01', tier: 'bronze', progress: s => count(s.runs, 1) },
  { id: 'clean-ten', bit: 1, name: 'Clean sheet', line: 'Finish 10 clean runs.', badge: '10', tier: 'bronze', progress: s => count(s.validRuns, 10) },
  { id: 'clean-fifty', bit: 2, name: 'Night owl', line: 'Finish 50 clean runs.', badge: '50', tier: 'silver', progress: s => count(s.validRuns, 50) },
  { id: 'medal', bit: 3, name: 'On the board', line: 'Win any medal.', badge: 'MD', tier: 'bronze', progress: s => count(s.gold + s.silver + s.bronze, 1) },
  { id: 'gold', bit: 4, name: 'Gold rush', line: 'Win a gold medal.', badge: 'AU', tier: 'silver', progress: s => count(s.gold, 1) },
  { id: 'triple-gold', bit: 5, name: 'Triple crown', line: 'Gold on three different routes.', badge: '3G', tier: 'gold', progress: s => count(s.goldRoutes.length, 3) },
  { id: 'drift-1k', bit: 6, name: 'Sideways', line: 'Bank 1,000 points in one drift attack.', badge: 'SW', tier: 'bronze', progress: s => count(s.bestDrift, 1000) },
  { id: 'drift-5k', bit: 7, name: 'Smoke show', line: 'Bank 5,000 points in one drift attack.', badge: 'SM', tier: 'gold', progress: s => count(s.bestDrift, 5000) },
  { id: 'tourist', bit: 8, name: 'Tourist', line: 'Finish a run on every route.', badge: 'TR', tier: 'bronze', progress: s => count(s.routes.length, 3) },
  { id: 'collector', bit: 9, name: 'Test driver', line: 'Finish runs in three different cars.', badge: 'TD', tier: 'silver', progress: s => count(s.cars.length, 3) },
  { id: 'daily', bit: 10, name: 'Daily driver', line: 'Finish a daily challenge.', badge: 'DD', tier: 'bronze', progress: s => count(s.dailyDays.length ? 1 : 0, 1) },
  { id: 'streak-3', bit: 11, name: 'Regular', line: 'Daily challenge three days in a row.', badge: 'R3', tier: 'silver', progress: s => count(s.bestStreak, 3) },
  { id: 'streak-7', bit: 12, name: 'Night shift', line: 'Daily challenge seven days in a row.', badge: 'N7', tier: 'gold', progress: s => count(s.bestStreak, 7) },
  { id: 'ghost', bit: 13, name: 'Ghost hunter', line: 'Beat a leaderboard ghost.', badge: 'GH', tier: 'silver', progress: s => count(s.ghostWins, 1) },
  { id: 'photo', bit: 14, name: 'Shutterbug', line: 'Save a photo in photo mode.', badge: 'PH', tier: 'bronze', progress: s => count(s.photos, 1) },
  { id: 'replay', bit: 15, name: 'Director\'s cut', line: 'Watch a replay of your run.', badge: 'DC', tier: 'bronze', progress: s => count(s.replays, 1) },
  { id: 'online', bit: 16, name: 'Grid regular', line: 'Finish 5 online races.', badge: 'OR', tier: 'bronze', progress: s => count(s.onlineRaces, 5) },
  { id: 'online-win', bit: 17, name: 'Harbor king', line: 'Win an online race.', badge: 'HK', tier: 'gold', progress: s => count(s.onlineWins, 1) },
]);

const MAX_LIST = 64, MAX_COUNT = 1e9;
const int = (value: unknown, max = MAX_COUNT): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
const strings = (value: unknown, pattern: RegExp, max = MAX_LIST): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && pattern.test(item)))].slice(-max) : [];
const ROUTE = /^[A-Z]{2}-\d{2}$/, CAR = /^CAR-\d{2}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;

export function emptyStats(): FeatStats {
  return { v: 1, runs: 0, validRuns: 0, gold: 0, silver: 0, bronze: 0, goldRoutes: [], routes: [], cars: [], bestDrift: 0, dailyDays: [], bestStreak: 0, ghostWins: 0, photos: 0, replays: 0, onlineRaces: 0, onlineWins: 0, unlocked: {} };
}

/** Validates untrusted storage: bounded lists, whole non-negative numbers, known achievement ids only. */
export function normalizeStats(raw: unknown): FeatStats {
  if (!raw || typeof raw !== 'object') return emptyStats();
  const value = raw as Record<string, unknown>;
  const unlocked: Record<string, number> = {};
  if (value.unlocked && typeof value.unlocked === 'object' && !Array.isArray(value.unlocked)) {
    for (const def of ACHIEVEMENTS) {
      const at = (value.unlocked as Record<string, unknown>)[def.id];
      if (Object.prototype.hasOwnProperty.call(value.unlocked, def.id) && typeof at === 'number' && Number.isFinite(at) && at > 0) unlocked[def.id] = Math.floor(at);
    }
  }
  return {
    v: 1, runs: int(value.runs), validRuns: int(value.validRuns), gold: int(value.gold), silver: int(value.silver), bronze: int(value.bronze),
    goldRoutes: strings(value.goldRoutes, ROUTE), routes: strings(value.routes, ROUTE), cars: strings(value.cars, CAR),
    bestDrift: int(value.bestDrift, 1e7), dailyDays: strings(value.dailyDays, DAY, 60), bestStreak: int(value.bestStreak, 3660),
    ghostWins: int(value.ghostWins), photos: int(value.photos), replays: int(value.replays), onlineRaces: int(value.onlineRaces), onlineWins: int(value.onlineWins),
    unlocked,
  };
}

const add = (list: readonly string[], item: string, max = MAX_LIST): readonly string[] => list.includes(item) ? list : [...list, item].slice(-max);

export type StatEvent =
  | { readonly type: 'run'; readonly result: Pick<RunResult, 'valid' | 'mode' | 'routeId' | 'carId' | 'bankedScore' | 'medal'> }
  | { readonly type: 'daily'; readonly day: string; readonly streak: number }
  | { readonly type: 'ghost-win' }
  | { readonly type: 'photo' }
  | { readonly type: 'replay' }
  /** One online race outcome: `race` counts a finish, `won` a win (the win can arrive later than the finish). */
  | { readonly type: 'online'; readonly race: boolean; readonly won: boolean };

/** Folds one event into the stats (pure). */
export function applyStat(stats: FeatStats, event: StatEvent): FeatStats {
  switch (event.type) {
    case 'run': {
      const r = event.result;
      const medal: Medal = r.valid ? r.medal : 'none';
      const valid = r.valid === true;
      return {
        ...stats,
        runs: stats.runs + 1,
        validRuns: stats.validRuns + (valid ? 1 : 0),
        gold: stats.gold + (medal === 'gold' ? 1 : 0), silver: stats.silver + (medal === 'silver' ? 1 : 0), bronze: stats.bronze + (medal === 'bronze' ? 1 : 0),
        goldRoutes: medal === 'gold' && ROUTE.test(r.routeId) ? add(stats.goldRoutes, r.routeId) : stats.goldRoutes,
        routes: valid && ROUTE.test(r.routeId) ? add(stats.routes, r.routeId) : stats.routes,
        cars: valid && CAR.test(r.carId) ? add(stats.cars, r.carId) : stats.cars,
        bestDrift: valid && r.mode === 'drift-attack' && Number.isFinite(r.bankedScore) ? Math.max(stats.bestDrift, Math.min(1e7, Math.floor(r.bankedScore))) : stats.bestDrift,
      };
    }
    case 'daily':
      if (!DAY.test(event.day)) return stats;
      return { ...stats, dailyDays: add(stats.dailyDays, event.day, 60), bestStreak: Math.max(stats.bestStreak, int(event.streak, 3660)) };
    case 'ghost-win': return { ...stats, ghostWins: stats.ghostWins + 1 };
    case 'photo': return { ...stats, photos: stats.photos + 1 };
    case 'replay': return { ...stats, replays: stats.replays + 1 };
    case 'online': return { ...stats, onlineRaces: stats.onlineRaces + (event.race ? 1 : 0), onlineWins: stats.onlineWins + (event.won ? 1 : 0) };
    default: return stats;
  }
}

export interface AchievementView extends Achievement { readonly current: number; readonly target: number; readonly unlocked: boolean; readonly unlockedAt: number | null }

export function achievementViews(stats: FeatStats): AchievementView[] {
  return ACHIEVEMENTS.map(def => {
    const [current, target] = def.progress(stats);
    const at = stats.unlocked[def.id] ?? null;
    return { ...def, current, target, unlocked: at !== null, unlockedAt: at };
  });
}

/** Marks newly reached achievements as unlocked. Returns the new stats and the ones just unlocked (in list order). */
export function unlockReached(stats: FeatStats, now: number): { stats: FeatStats; fresh: Achievement[] } {
  const fresh: Achievement[] = [];
  let unlocked: Record<string, number> | null = null;
  for (const def of ACHIEVEMENTS) {
    if (stats.unlocked[def.id]) continue;
    const [current, target] = def.progress(stats);
    if (current >= target) { (unlocked ??= { ...stats.unlocked })[def.id] = Math.max(1, Math.floor(now)); fresh.push(def); }
  }
  return unlocked ? { stats: { ...stats, unlocked }, fresh } : { stats, fresh };
}

const TIER_RANK: Readonly<Record<BadgeTier, number>> = { gold: 3, silver: 2, bronze: 1 };
const BIT_LIMIT = 30;
export const MAX_BADGE_MASK = 2 ** BIT_LIMIT - 1;

/** Presence bit mask of the unlocked achievements. */
export function badgeMask(stats: FeatStats): number {
  let mask = 0;
  for (const def of ACHIEVEMENTS) if (stats.unlocked[def.id] && def.bit >= 0 && def.bit < BIT_LIMIT) mask += 2 ** def.bit;
  return mask;
}

/** Badges from an untrusted presence value: whole number in range, unknown bits ignored, best tiers first. */
export function decodeBadgeMask(value: unknown, limit = 3): Achievement[] {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_BADGE_MASK) return [];
  return ACHIEVEMENTS.filter(def => Math.floor(value / 2 ** def.bit) % 2 === 1)
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.bit - a.bit)
    .slice(0, Math.max(0, limit));
}

/** Best badges of this player, for the profile header and the lobby. */
export function topBadges(stats: FeatStats, limit = 3): Achievement[] { return decodeBadgeMask(badgeMask(stats), limit); }
