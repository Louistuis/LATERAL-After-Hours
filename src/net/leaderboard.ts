import type { NetRecord } from './transport';
import type { RaceMode } from './lobby';
import { NET_CARS } from './quantize';
import { MAX_NAME, sanitizeText } from './sanitize';
import { VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';
import { isAssistLevel, type AssistLevel } from '../physics/assists';

export const LEADERBOARD_COLLECTION = 'lateral_best_v1';
export interface LeaderboardEntry { readonly username: string; readonly value: number; readonly car: string; readonly assist?: AssistLevel }

/** Sanity bounds. A lap faster than this or a score outside this range was not driven. */
export const MIN_TIME_MS = 20000;
export const MAX_TIME_MS = 3_600_000;
export const MIN_DRIFT_SCORE = 100;
export const MAX_DRIFT_SCORE = 1e7;
/** At most this many collection rows are looked at per refresh, so a flooded collection can not stall the menu. */
export const MAX_RECORDS = 5000;
const ROUTE_ID = /^[A-Z]{2}-\d{2}$/;

/**
 * Returns the entry when the row is a plausible result for this route and mode, else null. Rejects: another route
 * or mode, a physics version that is not this build's (times from different physics are not comparable), NaN,
 * Infinity, fractions, impossible times (under 20 s or over an hour) and scores outside 100 to 10 million.
 */
export function plausibleEntry(record: NetRecord, route: string, mode: RaceMode): LeaderboardEntry | null {
  if (!record || typeof record !== 'object' || record.route !== route || record.mode !== mode || !ROUTE_ID.test(route)) return null;
  if (record.pv !== VEHICLE_PHYSICS_VERSION) return null;
  const value = record.value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  if (mode === 'time-trial' ? value < MIN_TIME_MS || value > MAX_TIME_MS : value < MIN_DRIFT_SCORE || value > MAX_DRIFT_SCORE) return null;
  const username = sanitizeText(record.username, MAX_NAME);
  if (!username) return null;
  const car = typeof record.car === 'string' && (NET_CARS as readonly string[]).includes(record.car) ? record.car : '';
  // Assist level is whitelisted to the three known values; legacy rows or anything else carry no badge.
  const assist = isAssistLevel(record.assist) ? record.assist : undefined;
  return assist ? { username, value, car, assist } : { username, value, car };
}

/** One best entry per player: lowest time for time trial, highest score for drift. */
export function topEntries(records: readonly NetRecord[], route: string, mode: RaceMode, limit = 10): LeaderboardEntry[] {
  const best = new Map<string, LeaderboardEntry>();
  const lower = mode === 'time-trial';
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length && i < MAX_RECORDS; i++) {
    const entry = plausibleEntry(list[i]!, route, mode);
    if (!entry) continue;
    const previous = best.get(entry.username);
    if (!previous || (lower ? entry.value < previous.value : entry.value > previous.value)) best.set(entry.username, entry);
  }
  return [...best.values()].sort((a, b) => (lower ? a.value - b.value : b.value - a.value)).slice(0, limit);
}

export function isImprovement(records: readonly NetRecord[], username: string, route: string, mode: RaceMode, value: number): boolean {
  const mine = topEntries(records.filter(r => r.username === username), route, mode, 1)[0];
  if (!mine) return true;
  return mode === 'time-trial' ? value < mine.value : value > mine.value;
}

export function formatValue(mode: RaceMode, value: number): string {
  if (mode === 'drift-attack') return Math.round(value).toLocaleString('en-US');
  const totalS = value / 1000, minutes = Math.floor(totalS / 60), seconds = totalS - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}
