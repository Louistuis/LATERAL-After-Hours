/**
 * Shared leaderboard ghosts on a websim collection. A player whose time trial lands in a route's top table uploads the
 * run's compact ghost (the same "g2:" format as the saved personal best, src/ghosts/recording.ts) into ONE row per
 * player and route, updated in place. Anyone can then race the #1 ghost, or the ghost of any driver on the board.
 *
 * Everything downloaded is untrusted:
 *   - the row must pass the route leaderboard checks (plausibleEntry: route, mode, physics version, value bounds,
 *     sanitized server-set username, whitelisted car and assist),
 *   - identity strings are short and charset limited, the payload is capped (MAX_REMOTE_GHOST_CHARS) before decoding,
 *   - the decoded ghost must validate (format, CRC, monotonic time, finite values, duration equal to the header and
 *     close to the row's time) and stay inside the world bounds,
 *   - rows are only decoded on demand (the one ghost the player picked).
 * The ghost is a visual rival only. It never touches physics, scoring or validity.
 */
import type { CarId, RouteId, RunResult, SavedGhost } from '../../contracts/runtime-contracts';
import type { NetCollection, NetRecord } from '../net/transport';
import { plausibleEntry, topEntries, type LeaderboardEntry } from '../net/leaderboard';
import { GHOST_HZ, MAX_GHOST_DURATION_SECONDS, validateSavedGhost, type GhostTransform } from './recording';

export const GHOST_COLLECTION = 'lateral_ghost_v1';
/** Payload cap in characters (about 54 KB of samples, a lap of roughly 170 s at 15 Hz). */
export const MAX_REMOTE_GHOST_CHARS = 72_000;
/** Only times that would sit in this many places of the route's time trial board upload a ghost. */
export const GHOST_TABLE_SIZE = 20;
/** Rows looked at when listing (each row is small to inspect; payloads are not decoded here). */
export const MAX_GHOST_ROWS = 2000;
/** World bounds a ghost sample must stay inside (metres). */
const WORLD_XZ = 20_000, WORLD_Y = 2_000;
const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface RemoteGhostRef extends LeaderboardEntry {
  readonly id: string;
  readonly routeVersion: string;
  readonly rulesVersion: string;
  readonly tuneHash: string;
}
export interface RemoteGhost extends RemoteGhostRef { readonly samples: readonly GhostTransform[] }

/** The row a run uploads, or null when the run can not carry a ghost (mode, validity, size, identity). */
export function ghostRow(saved: SavedGhost | null | undefined, result: RunResult): Record<string, unknown> | null {
  if (!saved || !result || result.mode !== 'time-trial' || !result.valid) return null;
  const h = saved.header;
  if (!h || h.routeId !== result.routeId || h.carId !== result.carId || typeof saved.compressedSnapshots !== 'string') return null;
  if (!saved.compressedSnapshots.startsWith('g2:') || saved.compressedSnapshots.length > MAX_REMOTE_GHOST_CHARS) return null;
  if (![h.routeVersion, h.rulesVersion, h.physicsVersion, h.tuneHash].every(value => typeof value === 'string' && IDENT.test(value))) return null;
  const value = Math.round(result.elapsedActiveSeconds * 1000);
  if (!Number.isSafeInteger(value) || value <= 0 || Math.abs(h.durationSeconds - result.elapsedActiveSeconds) > 0.5) return null;
  return {
    route: h.routeId, mode: 'time-trial', value, car: h.carId, pv: h.physicsVersion,
    rv: h.routeVersion, rules: h.rulesVersion, tune: h.tuneHash, n: h.sampleCount, d: h.durationSeconds, g: saved.compressedSnapshots,
    ...(result.assist ? { assist: result.assist } : {}),
  };
}

/** Light checks of one row (no decoding). */
export function ghostRef(record: NetRecord, route: string, routeVersion: string): RemoteGhostRef | null {
  const entry = plausibleEntry(record, route, 'time-trial');
  if (!entry || !entry.car) return null;
  if (typeof record.id !== 'string' || !record.id || record.id.length > 128) return null;
  const rv = record.rv, rules = record.rules, tune = record.tune, g = record.g, n = record.n, d = record.d;
  if (rv !== routeVersion || typeof rules !== 'string' || !IDENT.test(rules) || typeof tune !== 'string' || !IDENT.test(tune)) return null;
  if (typeof g !== 'string' || g.length > MAX_REMOTE_GHOST_CHARS || !g.startsWith('g2:')) return null;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1) return null;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > MAX_GHOST_DURATION_SECONDS) return null;
  if (Math.abs(d - entry.value / 1000) > 0.5) return null;
  return { ...entry, id: record.id, routeVersion: rv, rulesVersion: rules, tuneHash: tune };
}

/** Each driver's fastest ghost on this route, fastest first. */
export function listGhosts(records: readonly NetRecord[], route: string, routeVersion: string): RemoteGhostRef[] {
  const best = new Map<string, RemoteGhostRef>();
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length && i < MAX_GHOST_ROWS; i++) {
    const ref = ghostRef(list[i]!, route, routeVersion);
    if (!ref) continue;
    const key = ref.username.toLowerCase();
    const previous = best.get(key);
    if (!previous || ref.value < previous.value) best.set(key, ref);
  }
  return [...best.values()].sort((a, b) => a.value - b.value || a.username.localeCompare(b.username));
}

/** Decodes and validates one ghost row picked by id. Null when anything about it is off. */
export function loadGhost(records: readonly NetRecord[], id: string, route: string, routeVersion: string): RemoteGhost | null {
  const list = Array.isArray(records) ? records : [];
  const record = list.slice(0, MAX_GHOST_ROWS).find(row => row && row.id === id);
  if (!record) return null;
  const ref = ghostRef(record, route, routeVersion);
  if (!ref) return null;
  const saved: SavedGhost = {
    header: {
      formatVersion: 1, routeId: route as RouteId, routeVersion: ref.routeVersion, rulesVersion: ref.rulesVersion,
      physicsVersion: String(record.pv), carId: ref.car as CarId, tuneHash: ref.tuneHash, sampleHz: GHOST_HZ,
      sampleCount: record.n as number, durationSeconds: record.d as number,
    },
    compressedSnapshots: record.g as string,
  };
  const h = saved.header;
  const check = validateSavedGhost(saved, { routeId: h.routeId, routeVersion: h.routeVersion, rulesVersion: h.rulesVersion, physicsVersion: h.physicsVersion, carId: h.carId, tuneHash: h.tuneHash });
  if (!check.compatible) return null;
  for (const sample of check.samples) {
    const p = sample.position;
    if (Math.abs(p.x) > WORLD_XZ || Math.abs(p.z) > WORLD_XZ || Math.abs(p.y) > WORLD_Y) return null;
  }
  return { ...ref, samples: check.samples };
}

/** Would this time sit in the route's top table (so it is worth sharing as a ghost)? */
export function qualifiesForTable(boardRecords: readonly NetRecord[], route: string, valueMs: number, size = GHOST_TABLE_SIZE): boolean {
  const top = topEntries(boardRecords, route, 'time-trial', size);
  return top.length < size || valueMs < top[top.length - 1]!.value;
}

/** This player's own ghost row on the route (to update in place). */
export function ownGhostRow(records: readonly NetRecord[], route: string, username: string): NetRecord | null {
  if (!username) return null;
  const lower = username.toLowerCase();
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length && i < MAX_GHOST_ROWS; i++) {
    const row = list[i];
    if (row && row.route === route && typeof row.username === 'string' && row.username.toLowerCase() === lower && typeof row.id === 'string') return row;
  }
  return null;
}

/**
 * Uploads a run's ghost when it beats the player's shared ghost on this route (or there is none). One row per player and
 * route: updated in place where the platform allows it.
 */
export async function shareGhost(collection: NetCollection, row: Record<string, unknown>, username: string): Promise<'saved' | 'kept' | 'failed'> {
  const records = collection.getList();
  const own = ownGhostRow(records, String(row.route), username);
  const ownValue = own && typeof own.value === 'number' && own.pv === row.pv && own.rv === row.rv ? own.value : Infinity;
  if (own && !((row.value as number) < ownValue)) return 'kept';
  try {
    if (own && collection.update) await collection.update(own.id, row);
    else await collection.create(row);
    return 'saved';
  } catch { return 'failed'; }
}
