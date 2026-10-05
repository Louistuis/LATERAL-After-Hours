/**
 * Collections: the leaderboard, the daily boards and shared ghosts. Rows are validated with the same plausibility code the
 * client uses (src/net/leaderboard.ts, src/ghosts/recording.ts, src/events/daily.ts), plus server-only checks
 * (owned car, per route time floors, top-N only). The server stamps `username` and `created_at`; only the owner can update.
 */
import { catalogEntry, carItem } from '../src/economy/catalog';
import { dailySpec, isDay } from '../src/events/daily';
import { MEDAL_TABLE, carMedalPace } from '../src/events/medal-targets';
import { GHOST_HZ, MAX_GHOST_DURATION_SECONDS, validateSavedGhost } from '../src/ghosts/recording';
import { GHOST_COLLECTION, MAX_REMOTE_GHOST_CHARS } from '../src/ghosts/remote-ghosts';
import { LEADERBOARD_COLLECTION, plausibleEntry } from '../src/net/leaderboard';
import { DAILY_COLLECTION_PREFIX } from '../src/net/daily-board';
import { NET_CARS } from '../src/net/quantize';
import { isAssistLevel } from '../src/physics/assists';
import { VEHICLE_PHYSICS_VERSION } from '../src/vehicle/tune-identity';
import { PLAYABLE_ROUTE_IDS } from '../src/world/route-registry';
import type { CarId, RouteId, SavedGhost } from '../contracts/runtime-contracts';
import type { Db } from './db';
import type { Config } from './config';
import type { Account } from './accounts';
import type { WalletService } from './wallet';
import { ApiError, WindowLimiter, dayOf, isRecord } from './util';

export { LEADERBOARD_COLLECTION, GHOST_COLLECTION, DAILY_COLLECTION_PREFIX };
export const KEEP_LEADERBOARD = 100, KEEP_DAILY = 200, KEEP_GHOSTS = 20;
const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
const WORLD_XZ = 20_000, WORLD_Y = 2_000;

export interface CollRow { readonly id: string; readonly username: string; readonly created_at: string; readonly [key: string]: unknown }
export type WriteOutcome = { ok: true; id: string; kept: boolean } | { ok: false; reason: string };
export interface CollChange { readonly coll: string; readonly up: readonly CollRow[]; readonly del: readonly string[] }

type Kind = 'leaderboard' | 'daily' | 'ghost';
export function kindOf(name: string): Kind | null {
  if (name === LEADERBOARD_COLLECTION) return 'leaderboard';
  if (name === GHOST_COLLECTION) return 'ghost';
  if (/^lateral_daily_v1_\d{8}$/.test(name)) return 'daily';
  return null;
}
const dayFromName = (name: string): string => `${name.slice(-8, -4)}-${name.slice(-4, -2)}-${name.slice(-2)}`;

/** The lowest believable time for a route and car: well under the gold target, which is already a very clean lap. */
export function minTimeMs(route: string, car: string): number {
  const gold = MEDAL_TABLE[route as RouteId]?.targets['time-trial'].gold;
  return gold ? Math.floor(gold * carMedalPace(car as CarId) * 0.6 * 1000) : 20_000;
}
export function maxScore(route: string): number {
  const gold = MEDAL_TABLE[route as RouteId]?.targets['drift-attack'].gold;
  return gold ? gold * 40 : 1e7;
}

interface DbRow { id: string; account_id: string; username: string; rkey: string; value: number; created_at: string; data: string }

export class Collections {
  readonly limiter: WindowLimiter;
  private readonly cache = new Map<string, CollRow[]>();
  private idSeq = 0;
  /** Called with every committed change; the hub batches these to subscribers at 1 Hz. */
  onChange: (change: CollChange) => void = () => {};

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly wallets: WalletService, private readonly now: () => number = Date.now) {
    this.limiter = new WindowLimiter(cfg.collectionWritesPerMin, 60_000);
  }

  private toRow(r: DbRow, stub: boolean): CollRow {
    const data = JSON.parse(r.data) as Record<string, unknown>;
    if (stub && typeof data.g === 'string') data.g = 'g2:';
    return { ...data, id: r.id, username: r.username, created_at: r.created_at };
  }

  /** Sorted snapshot (best first). Ghost payloads are replaced by the stub "g2:"; fetch a full row with get(). */
  list(name: string, filter?: { route?: string; mode?: string }): CollRow[] {
    const kind = kindOf(name);
    if (!kind) throw new ApiError(404, 'no-such-collection', 'No such collection.');
    let rows = this.cache.get(name);
    if (!rows) {
      const raw = this.db.prepare(`SELECT c.* FROM coll_rows c JOIN accounts a ON a.id = c.account_id WHERE c.coll = ? AND a.banned = 0 ORDER BY c.rkey, c.value`).all(name) as unknown as DbRow[];
      rows = raw.map(r => this.toRow(r, true));
      // Drift boards rank high to low; fix the order per group.
      rows.sort((a, b) => {
        const ka = String(a.route ?? ''), kb = String(b.route ?? '');
        if (ka !== kb) return ka < kb ? -1 : 1;
        const ma = String(a.mode ?? ''), mb = String(b.mode ?? '');
        if (ma !== mb) return ma < mb ? -1 : 1;
        const va = Number(a.value), vb = Number(b.value);
        return ma === 'drift-attack' ? vb - va : va - vb;
      });
      this.cache.set(name, rows);
    }
    if (filter?.route || filter?.mode) return rows.filter(r => (!filter.route || r.route === filter.route) && (!filter.mode || r.mode === filter.mode));
    return rows;
  }

  get(name: string, id: string): CollRow | null {
    if (!kindOf(name) || typeof id !== 'string' || id.length > 40) return null;
    const r = this.db.prepare('SELECT c.* FROM coll_rows c JOIN accounts a ON a.id = c.account_id WHERE c.coll = ? AND c.id = ? AND a.banned = 0').get(name, id) as DbRow | undefined;
    return r ? this.toRow(r, false) : null;
  }

  invalidate(name: string): void { this.cache.delete(name); }

  /* ---------------------------------------------------------------- writes */

  /** `create` (no id) or `update` (id of the caller's own row). Both validate the same way. */
  write(account: Account, name: string, data: unknown, updateId?: string): WriteOutcome {
    const kind = kindOf(name);
    if (!kind) return { ok: false, reason: 'no-such-collection' };
    const now = this.now();
    if (!this.limiter.hit(account.id, now)) return { ok: false, reason: 'rate-limited' };
    if (!isRecord(data)) return { ok: false, reason: 'bad-row' };
    let clean: Record<string, unknown> | string;
    if (kind === 'leaderboard') clean = this.checkLeaderboard(account, data);
    else if (kind === 'daily') clean = this.checkDaily(name, data, now);
    else clean = this.checkGhost(account, data);
    if (typeof clean === 'string') return { ok: false, reason: clean };
    const rkey = kind === 'daily' ? 'd' : kind === 'leaderboard' ? `${clean.route}:${clean.mode}` : String(clean.route);
    const value = clean.value as number;
    const lower = clean.mode === 'time-trial';
    const own = this.db.prepare('SELECT * FROM coll_rows WHERE coll = ? AND account_id = ? AND rkey = ?').get(name, account.id, rkey) as DbRow | undefined;
    if (updateId !== undefined) {
      const target = this.db.prepare('SELECT account_id, rkey FROM coll_rows WHERE coll = ? AND id = ?').get(name, updateId) as { account_id: string; rkey: string } | undefined;
      if (!target || target.account_id !== account.id) return { ok: false, reason: 'not-owner' };
      if (target.rkey !== rkey) return { ok: false, reason: 'bad-row' };
    }
    if (own) {
      const prev = JSON.parse(own.data) as Record<string, unknown>;
      const samePv = prev.pv === clean.pv;
      if (samePv && (lower ? value >= own.value : value <= own.value)) return { ok: true, id: own.id, kept: true };
    }
    const stamp = new Date(now).toISOString();
    const text = JSON.stringify(clean);
    let id: string;
    if (own) {
      id = own.id;
      this.db.prepare('UPDATE coll_rows SET value = ?, created_at = ?, data = ?, username = ? WHERE coll = ? AND id = ?').run(value, stamp, text, account.name, name, id);
    } else {
      id = `${now.toString(36)}${(this.idSeq++ % 1296).toString(36).padStart(2, '0')}${account.id.slice(1, 5)}`;
      this.db.prepare('INSERT INTO coll_rows (coll, id, account_id, username, rkey, value, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, id, account.id, account.name, rkey, value, stamp, text);
    }
    const dropped = this.trim(name, kind, rkey, lower);
    this.invalidate(name);
    const row = this.get(name, id);
    const stub = row && typeof row.g === 'string' ? { ...row, g: 'g2:' } : row;
    this.onChange({ coll: name, up: dropped.includes(id) || !stub ? [] : [stub], del: dropped });
    return { ok: true, id, kept: false };
  }

  /** Keeps only the best N of the group; returns the ids removed. */
  private trim(name: string, kind: Kind, rkey: string, lower: boolean): string[] {
    const keep = kind === 'leaderboard' ? KEEP_LEADERBOARD : kind === 'daily' ? KEEP_DAILY : KEEP_GHOSTS;
    const group = kind === 'daily' ? [rkey] : [rkey];
    const rows = this.db.prepare(`SELECT id FROM coll_rows WHERE coll = ? AND rkey = ? ORDER BY value ${lower ? 'ASC' : 'DESC'}, created_at ASC LIMIT -1 OFFSET ?`).all(name, group[0], keep) as Array<{ id: string }>;
    const ids = rows.map(r => r.id);
    const del = this.db.prepare('DELETE FROM coll_rows WHERE coll = ? AND id = ?');
    for (const id of ids) del.run(name, id);
    return ids;
  }

  private ownsCar(account: Account, car: string): boolean {
    const item = carItem(car as CarId);
    if (!item) return false;
    if (item.price === 0) return true;
    const record = this.wallets.get(account.id).record;
    return Boolean(record?.owned.includes(item.id));
  }

  private checkBase(account: Account | null, d: Record<string, unknown>, route: string, mode: 'time-trial' | 'drift-attack'): Record<string, unknown> | string {
    if (!(PLAYABLE_ROUTE_IDS as readonly string[]).includes(route)) return 'unknown-route';
    const entry = plausibleEntry({ ...d, id: 'x', username: account?.name ?? 'x' } as never, route, mode);
    if (!entry) return 'implausible';
    if (!entry.car || !(NET_CARS as readonly string[]).includes(entry.car)) return 'bad-car';
    if (mode === 'time-trial' && (d.value as number) < minTimeMs(route, entry.car)) return 'implausible';
    if (mode === 'drift-attack' && (d.value as number) > maxScore(route)) return 'implausible';
    if (d.pv !== VEHICLE_PHYSICS_VERSION) return 'implausible';
    return {
      route, mode, value: d.value, car: entry.car, pv: d.pv, ...(isAssistLevel(d.assist) ? { assist: d.assist } : {}),
    };
  }

  private checkLeaderboard(account: Account, d: Record<string, unknown>): Record<string, unknown> | string {
    const mode = d.mode === 'drift-attack' || d.mode === 'time-trial' ? d.mode : null;
    if (!mode || typeof d.route !== 'string') return 'bad-row';
    const base = this.checkBase(account, d, d.route, mode);
    if (typeof base === 'string') return base;
    if (!this.ownsCar(account, base.car as string)) return 'car-not-owned';
    return base;
  }

  private checkDaily(name: string, d: Record<string, unknown>, now: number): Record<string, unknown> | string {
    const day = dayFromName(name);
    if (!isDay(day)) return 'bad-row';
    const today = dayOf(now), yest = dayOf(now - 86_400_000);
    if (day !== today && !(day === yest && now % 86_400_000 < 10 * 60_000)) return 'day-closed';
    const spec = dailySpec(day);
    if (d.day !== day || d.route !== spec.route || d.mode !== spec.mode || d.car !== spec.car || d.rule !== spec.rule) return 'wrong-challenge';
    const base = this.checkBase(null, d, spec.route, spec.mode);
    if (typeof base === 'string') return base;
    return { day, rule: spec.rule, ...base };
  }

  private checkGhost(account: Account, d: Record<string, unknown>): Record<string, unknown> | string {
    if (d.mode !== 'time-trial' || typeof d.route !== 'string') return 'bad-row';
    const base = this.checkBase(account, d, d.route, 'time-trial');
    if (typeof base === 'string') return base;
    if (!this.ownsCar(account, base.car as string)) return 'car-not-owned';
    const { rv, rules, tune, n, d: dur, g } = d;
    if (![rv, rules, tune].every(v => typeof v === 'string' && IDENT.test(v))) return 'bad-row';
    if (typeof g !== 'string' || g.length > MAX_REMOTE_GHOST_CHARS || !g.startsWith('g2:')) return 'ghost-size';
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1) return 'bad-row';
    if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0 || dur > MAX_GHOST_DURATION_SECONDS) return 'bad-row';
    if (Math.abs(dur - (d.value as number) / 1000) > 0.5) return 'bad-row';
    // Only a time that sits in the route's top table carries a ghost.
    const board = this.list(LEADERBOARD_COLLECTION, { route: d.route, mode: 'time-trial' });
    const mine = board.find(r => r.username === account.name);
    const others = board.filter(r => r.username !== account.name);
    const worst = others.length >= KEEP_GHOSTS ? Number(others[KEEP_GHOSTS - 1]!.value) : Infinity;
    if (!(Number(d.value) < worst) && !mine) return 'not-top';
    if (!(Number(d.value) < worst)) return 'not-top';
    const saved: SavedGhost = {
      header: { formatVersion: 1, routeId: d.route as RouteId, routeVersion: rv as string, rulesVersion: rules as string, physicsVersion: String(d.pv), carId: base.car as CarId, tuneHash: tune as string, sampleHz: GHOST_HZ, sampleCount: n, durationSeconds: dur },
      compressedSnapshots: g,
    };
    const check = validateSavedGhost(saved, { routeId: d.route as RouteId, routeVersion: rv as string, rulesVersion: rules as string, physicsVersion: String(d.pv), carId: base.car as CarId, tuneHash: tune as string });
    if (!check.compatible) return 'ghost-invalid';
    for (const s of check.samples) {
      const p = s.position;
      if (Math.abs(p.x) > WORLD_XZ || Math.abs(p.z) > WORLD_XZ || Math.abs(p.y) > WORLD_Y) return 'ghost-invalid';
    }
    return { ...base, rv, rules, tune, n, d: dur, g };
  }

  /** Old daily boards are dropped after `days` days (a client only ever syncs today's). */
  prune(days = 3): number {
    const cut = `lateral_daily_v1_${dayOf(this.now() - days * 86_400_000).replace(/-/g, '')}`;
    const r = this.db.prepare("DELETE FROM coll_rows WHERE coll LIKE 'lateral_daily_v1_%' AND coll < ?").run(cut);
    for (const key of [...this.cache.keys()]) if (key < cut && key.startsWith(DAILY_COLLECTION_PREFIX)) this.cache.delete(key);
    return Number(r.changes);
  }

  rowCount(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM coll_rows').get() as { n: number }).n; }
  static knownCatalog = catalogEntry;
}
