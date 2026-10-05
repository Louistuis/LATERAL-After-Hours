/**
 * Mission progress: the small, bounded record of what the player has done, stored inside the wallet record
 * (WalletRecord.missions) so it syncs with the wallet. Pure functions only; no I/O and no wallet imports.
 *
 * Every counter is monotonic inside its period (it only grows, or keeps a maximum), so merging two copies of the same
 * player's progress (two tabs, local cache vs remote) is a per-key max, and an old copy can never take progress back.
 *
 *   life  : lifetime counters (career missions)
 *   day   : counters for one UTC day (daily missions); a new day starts from zero
 *   week  : counters for one UTC week, Monday to Sunday (weekly challenges)
 *   seen  : the last few run and race ids that were counted, so the same result is never counted twice
 *
 * Anything read from storage is untrusted: normalizeProgress bounds the number of keys, key length and values.
 */

const DAY_MS = 86_400_000;
export const MAX_COUNTERS = 80;
export const MAX_SEEN = 24;
const MAX_VALUE = 1e9;
const KEY = /^[A-Za-z][A-Za-z0-9.:_-]{0,23}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type Counters = Readonly<Record<string, number>>;

export interface MissionProgress {
  readonly v: 1;
  readonly life: Counters;
  readonly day: { readonly id: string; readonly c: Counters };
  readonly week: { readonly id: number; readonly c: Counters };
  readonly seen: readonly string[];
}

/** A change to apply to every scope: add to a running total, or keep the best (maximum) value. */
export type StatChange = Readonly<{ key: string; add: number } | { key: string; max: number }>;

/** UTC calendar day id, YYYY-MM-DD. */
export function dayIdOf(nowMs: number): string {
  return new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().slice(0, 10);
}
/** Week index since the epoch. Weeks start on Monday 00:00 UTC (the epoch day was a Thursday). */
export function weekIdOf(nowMs: number): number {
  return Math.floor((Math.floor((Number.isFinite(nowMs) ? nowMs : 0) / DAY_MS) + 3) / 7);
}
/** Next UTC midnight after `nowMs`. */
export function dayEndsAt(nowMs: number): number {
  return (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
}
/** The Monday 00:00 UTC that ends the week containing `nowMs`. */
export function weekEndsAt(nowMs: number): number {
  return (weekIdOf(nowMs) * 7 + 7 - 3) * DAY_MS;
}

const int = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(MAX_VALUE, Math.floor(value))) : 0;

function counters(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_COUNTERS) break;
    if (!KEY.test(key)) continue;
    const amount = int(value);
    if (amount > 0) { out[key] = amount; count++; }
  }
  return out;
}

export function emptyProgress(nowMs = 0): MissionProgress {
  return { v: 1, life: {}, day: { id: dayIdOf(nowMs), c: {} }, week: { id: weekIdOf(nowMs), c: {} }, seen: [] };
}

/** Validates untrusted progress (from storage or a remote record). Never throws. */
export function normalizeProgress(raw: unknown): MissionProgress {
  if (!raw || typeof raw !== 'object') return emptyProgress();
  const value = raw as Record<string, unknown>;
  const day = value.day as { id?: unknown; c?: unknown } | undefined;
  const week = value.week as { id?: unknown; c?: unknown } | undefined;
  const seen = Array.isArray(value.seen)
    ? value.seen.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80).slice(-MAX_SEEN)
    : [];
  return {
    v: 1,
    life: counters(value.life),
    day: { id: typeof day?.id === 'string' && DAY.test(day.id) ? day.id : '1970-01-01', c: counters(day?.c) },
    week: { id: int(week?.id), c: counters(week?.c) },
    seen,
  };
}

/** Starts a fresh day or week when the stored period is not the current one (past or future alike). */
export function rollProgress(progress: MissionProgress, nowMs: number): MissionProgress {
  const day = dayIdOf(nowMs), week = weekIdOf(nowMs);
  if (progress.day.id === day && progress.week.id === week) return progress;
  return {
    ...progress,
    day: progress.day.id === day ? progress.day : { id: day, c: {} },
    week: progress.week.id === week ? progress.week : { id: week, c: {} },
  };
}

function maxMerge(a: Counters, b: Counters): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, amount] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, amount);
  return counters(out);
}

/** Conflict free merge of two copies: per key maximum, and the newer period wins. */
export function mergeProgress(a: MissionProgress, b: MissionProgress): MissionProgress {
  const day = a.day.id === b.day.id ? { id: a.day.id, c: maxMerge(a.day.c, b.day.c) } : a.day.id > b.day.id ? a.day : b.day;
  const week = a.week.id === b.week.id ? { id: a.week.id, c: maxMerge(a.week.c, b.week.c) } : a.week.id > b.week.id ? a.week : b.week;
  return { v: 1, life: maxMerge(a.life, b.life), day, week, seen: [...new Set([...a.seen, ...b.seen])].slice(-MAX_SEEN) };
}

function bump(scope: Counters, change: StatChange): Record<string, number> {
  const out: Record<string, number> = { ...scope };
  if (!KEY.test(change.key)) return out;
  if (!(change.key in out) && Object.keys(out).length >= MAX_COUNTERS) return out;
  const before = out[change.key] ?? 0;
  if ('add' in change) out[change.key] = Math.min(MAX_VALUE, before + int(change.add));
  else out[change.key] = Math.max(before, int(change.max));
  return out;
}

/** Applies stat changes to the lifetime, day and week counters (rolling the periods first). */
export function applyStats(progress: MissionProgress, nowMs: number, changes: readonly StatChange[]): MissionProgress {
  let next = rollProgress(progress, nowMs);
  let life = next.life, day = next.day.c, week = next.week.c;
  for (const change of changes) { life = bump(life, change); day = bump(day, change); week = bump(week, change); }
  next = { ...next, life, day: { id: next.day.id, c: day }, week: { id: next.week.id, c: week } };
  return next;
}

/** Records that a run or race id was counted. Returns the progress and whether the id was new. */
export function markSeen(progress: MissionProgress, id: string): { progress: MissionProgress; fresh: boolean } {
  if (progress.seen.includes(id)) return { progress, fresh: false };
  return { progress: { ...progress, seen: [...progress.seen, id].slice(-MAX_SEEN) }, fresh: true };
}

export function sameProgress(a: MissionProgress, b: MissionProgress): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
