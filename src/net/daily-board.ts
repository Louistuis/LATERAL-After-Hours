/**
 * Global daily challenge leaderboard on a websim collection. Usernames come from the server (record.username), every
 * row goes through the same plausibility checks as the route leaderboard (plausibleEntry: route, mode, physics version,
 * whole numbers, time and score bounds, sanitized name, whitelisted car and assist), plus the daily's own identity:
 * the UTC day, the car and the condition. One row per player per day: the client updates its own row when the
 * platform allows it, so the collection grows by players, not by attempts.
 */
import type { NetCollection, NetRecord } from './transport';
import { formatValue, plausibleEntry, type LeaderboardEntry } from './leaderboard';
import { VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';
import type { DailySpec } from '../events/daily';

export const DAILY_COLLECTION_PREFIX = 'lateral_daily_v1_';
/**
 * One collection per UTC day ("lateral_daily_v1_20261003"): a client only ever syncs today's rows, so the board stays
 * small no matter how many days the game runs. Rows still carry their day and are checked against it.
 */
export function dailyCollection(day: string): string { return `${DAILY_COLLECTION_PREFIX}${/^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replace(/-/g, '') : '19700101'}`; }
/** Rows looked at per refresh. Generous: rows are filtered by day before anything else. */
export const MAX_DAILY_RECORDS = 20_000;

export interface DailyBoardEntry extends LeaderboardEntry { readonly rank: number }

function todaysRows(records: readonly NetRecord[], spec: DailySpec): NetRecord[] {
  const out: NetRecord[] = [];
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length && i < MAX_DAILY_RECORDS; i++) {
    const record = list[i];
    if (record && typeof record === 'object' && record.day === spec.day && record.car === spec.car && record.rule === spec.rule) out.push(record);
  }
  return out;
}

/** Every plausible player best for today's daily, ranked (lowest time or highest score first). */
export function dailyBoard(records: readonly NetRecord[], spec: DailySpec): DailyBoardEntry[] {
  const lower = spec.mode === 'time-trial';
  const best = new Map<string, LeaderboardEntry>();
  for (const record of todaysRows(records, spec)) {
    const entry = plausibleEntry(record, spec.route, spec.mode);
    if (!entry || entry.car !== spec.car) continue;
    const key = entry.username.toLowerCase();
    const previous = best.get(key);
    if (!previous || (lower ? entry.value < previous.value : entry.value > previous.value)) best.set(key, entry);
  }
  return [...best.values()]
    .sort((a, b) => (lower ? a.value - b.value : b.value - a.value) || a.username.localeCompare(b.username))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function dailyTop(records: readonly NetRecord[], spec: DailySpec, limit = 10): DailyBoardEntry[] { return dailyBoard(records, spec).slice(0, limit); }

/** This player's entry and rank today, or null. */
export function dailyMine(records: readonly NetRecord[], spec: DailySpec, username: string): DailyBoardEntry | null {
  if (!username) return null;
  const lower = username.toLowerCase();
  return dailyBoard(records, spec).find(entry => entry.username.toLowerCase() === lower) ?? null;
}

export function isDailyImprovement(records: readonly NetRecord[], spec: DailySpec, username: string, value: number): boolean {
  const mine = dailyMine(records, spec, username);
  if (!mine) return true;
  return spec.mode === 'time-trial' ? value < mine.value : value > mine.value;
}

/** The row a counted run writes. The username is never sent: the server sets it. */
export function dailyRow(spec: DailySpec, value: number, assist?: 'off' | 'medium' | 'high', physicsVersion = VEHICLE_PHYSICS_VERSION): Record<string, unknown> {
  return { day: spec.day, route: spec.route, mode: spec.mode, car: spec.car, rule: spec.rule, value, pv: physicsVersion, ...(assist ? { assist } : {}) };
}

/** This player's own row id for today (to update in place), when the collection lists it. */
export function ownDailyRowId(records: readonly NetRecord[], spec: DailySpec, username: string): string | null {
  if (!username) return null;
  const lower = username.toLowerCase();
  for (const record of todaysRows(records, spec)) {
    if (typeof record.username === 'string' && record.username.toLowerCase() === lower && typeof record.id === 'string' && record.id) return record.id;
  }
  return null;
}

/**
 * Writes a counted run when it beats this player's best today. Updates the player's own row when the platform supports
 * it, otherwise creates one. Resolves to 'saved', 'kept' (not an improvement) or 'failed'.
 */
export async function submitDaily(board: NetCollection, spec: DailySpec, username: string, value: number, assist?: 'off' | 'medium' | 'high'): Promise<'saved' | 'kept' | 'failed'> {
  const records = board.getList();
  if (username && !isDailyImprovement(records, spec, username, value)) return 'kept';
  const row = dailyRow(spec, value, assist);
  const own = ownDailyRowId(records, spec, username);
  try {
    if (own && board.update) await board.update(own, row);
    else await board.create(row);
    return 'saved';
  } catch {
    try { if (own) { await board.create(row); return 'saved'; } } catch { /* fall through */ }
    return 'failed';
  }
}

export function formatDailyValue(spec: Pick<DailySpec, 'mode'>, value: number): string { return formatValue(spec.mode, value); }
