/**
 * The realtime hub. Socket-agnostic (a `Sock` is anything with send/close/bufferedAmount) so tests and the load tester
 * can drive it without a network. One global room `hub`; lobbies are named groups inside it.
 *
 * Wire protocol (JSON text frames, short keys), see notes/SELFHOST-SERVER.md for the full description:
 *   client -> server  {t:'h',token,v} {t:'p',d} {t:'r',d} {t:'m',d} {t:'c',n,op,...} {t:'pong'}
 *   server -> client  {t:'w',...} {t:'P',d} {t:'R',d} {t:'M',f,d} {t:'M',b:[[f,d]...]} {t:'C',n,...} {t:'wallet',version} {t:'ping',ts} {t:'err',code,msg}
 */
import { carItem, encodeLoadout, sanitizeLoadout } from '../src/economy/catalog';
import { parseLobbies, RACE_LIMIT_MS, MAX_LOBBY_PLAYERS, STALE_LOBBY_MS, type LobbyRecord } from '../src/net/lobby';
import { NET_CARS } from '../src/net/quantize';
import { clampInt, isPeerId } from '../src/net/sanitize';
import { PLAYABLE_ROUTE_IDS } from '../src/world/route-registry';
import type { WalletRecord } from '../src/economy/types';
import type { Accounts, Account } from './accounts';
import type { Collections, CollChange, CollRow } from './collections';
import { kindOf } from './collections';
import type { Config } from './config';
import type { WalletService } from './wallet';
import { Bucket, isRecord, randomToken, type Logger } from './util';

export const PROTOCOL = 1;
export const MAX_FRAME = 2048;
export const HELLO_MS = 5000;
export const PING_MS = 20_000;
export const DROP_MS = 45_000;
export const BACKPRESSURE_BYTES = 64 * 1024;
export const BACKED_UP_CLOSE_MS = 5000;
export const MAX_SUBS = 4;
export const LOW_MS = 250, LOBBY_MS = 100, ROOM_MS = 250, COLL_MS = 1000;
export const CLOSE = { badFrame: 4400, auth: 4401, banned: 4403, timeout: 4408, replaced: 4409, rate: 4429, full: 4503, backedUp: 4504 } as const;

export interface Sock {
  send(data: string): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
}

const LOW_FIELDS = new Set(['u', 'on', 'car', 'pt', 'lb', 'rd', 'ab']);
const LOBBY_FIELDS = new Set(['rp', 'pg']);
const LOBBY_KEYS = new Set(['ph', 'race', 'mode', 'route', 'at', 't', 'rt', 'ff', 'g']);
const MSG_TYPES = new Set(['s', 'h', 'p', 'q']);
const HANDSHAKE = new Set(['p', 'q', 'h']);

export class Conn {
  id = '';
  authed = false;
  accountId = '';
  name = '';
  account: Account | null = null;
  lastRx: number;
  readonly connectedAt: number;
  presence: Record<string, unknown> = {};
  lb = '';
  lowDirty: Record<string, unknown> | null = null;
  lastLow = 0;
  forceLow = false;
  lobDirty: { lb: string; patch: Record<string, unknown> } | null = null;
  lastLob = 0;
  readonly bState: Bucket; readonly bPres: Bucket; readonly bRoom: Bucket; readonly bColl: Bucket; readonly bMsg: Bucket;
  drops = 0;
  dropFrom = 0;
  subs = new Set<string>();
  backedSince = 0;
  lastPing = 0;
  owned: ReadonlySet<string> = new Set();
  pt = '';
  constructor(readonly sock: Sock, readonly ip: string, now: number) {
    this.lastRx = now; this.connectedAt = now; this.lastPing = now;
    this.bState = new Bucket(20, 30, now); this.bPres = new Bucket(10, 15, now); this.bRoom = new Bucket(4, 8, now);
    this.bColl = new Bucket(5, 8, now); this.bMsg = new Bucket(10, 20, now);
  }
}

interface LobbyState { rec: LobbyRecord; members: Set<Conn>; touched: number }

export interface HubStats {
  online: number; connected: number; lobbies: number; inPerSec: number; outPerSec: number; tickAvgMs: number; tickMaxMs: number;
  rssMb: number; heapMb: number; uptimeS: number; droppedFrames: number;
}

export class Hub {
  private readonly conns = new Map<string, Conn>();
  private readonly byIp = new Map<string, number>();
  private readonly byAccount = new Map<string, Set<Conn>>();
  private readonly lobbies = new Map<string, LobbyState>();
  private readonly stateQ = new Map<string, Map<string, string>>();
  private readonly lowSet = new Set<Conn>();
  private readonly lobSet = new Set<Conn>();
  private lowGone: string[] = [];
  private roomDirty: Record<string, Record<string, unknown> | null> = {};
  private collPending = new Map<string, { up: Map<string, CollRow>; del: Set<string> }>();
  private collSubs = new Map<string, Set<Conn>>();
  private lastRoom = 0; private lastColl = 0; private lastSweep = 0; private lastLowFlush = 0;
  private inCount = 0; private outCount = 0; private rateAt = 0; private inRate = 0; private outRate = 0;
  private tickSum = 0; private tickN = 0; private tickMax = 0; private tickAvg = 0;
  droppedFrames = 0;
  private readonly started: number;

  constructor(
    private readonly cfg: Config, private readonly accounts: Accounts, private readonly wallets: WalletService, private readonly colls: Collections,
    private readonly log: Logger, private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    this.rateAt = now();
    colls.onChange = change => this.onCollChange(change);
  }

  /* ------------------------------------------------------------ connections */

  /** Registers a socket. Returns null when a limit is hit (the caller closes the socket with CLOSE.full). */
  connect(sock: Sock, ip: string): Conn | null {
    if (this.conns.size >= this.cfg.maxConnTotal) return null;
    const perIp = this.byIp.get(ip) ?? 0;
    if (perIp >= this.cfg.maxConnPerIp) return null;
    const conn = new Conn(sock, ip, this.now());
    do { conn.id = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toLowerCase(); } while (this.conns.has(conn.id));
    this.conns.set(conn.id, conn);
    this.byIp.set(ip, perIp + 1);
    return conn;
  }

  disconnect(conn: Conn): void {
    if (this.conns.get(conn.id) !== conn) return;
    this.conns.delete(conn.id);
    const n = (this.byIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) this.byIp.delete(conn.ip); else this.byIp.set(conn.ip, n);
    this.lowSet.delete(conn); this.lobSet.delete(conn);
    for (const set of this.collSubs.values()) set.delete(conn);
    if (conn.authed) {
      const set = this.byAccount.get(conn.accountId);
      if (set) { set.delete(conn); if (!set.size) this.byAccount.delete(conn.accountId); }
      this.leaveLobby(conn);
      this.lowGone.push(conn.id);
    }
    conn.authed = false;
  }

  private safeSend(conn: Conn, text: string): void {
    try { conn.sock.send(text); this.outCount++; } catch { /* a dead socket is cleaned up by its close event */ }
  }
  private sendObj(conn: Conn, obj: unknown): void { this.safeSend(conn, JSON.stringify(obj)); }
  private err(conn: Conn, code: string, msg: string): void { this.sendObj(conn, { t: 'err', code, msg }); }
  private closeConn(conn: Conn, code: number, reason: string): void {
    try { conn.sock.close(code, reason); } catch { /* already closed */ }
    this.disconnect(conn);
  }

  /* ------------------------------------------------------------ incoming frames */

  receive(conn: Conn, text: string): void {
    if (this.conns.get(conn.id) !== conn) return; // a closed socket is ignored
    const now = this.now();
    conn.lastRx = now;
    this.inCount++;
    if (typeof text !== 'string' || text.length > MAX_FRAME) return this.closeConn(conn, CLOSE.badFrame, 'frame');
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { return this.closeConn(conn, CLOSE.badFrame, 'json'); }
    if (!isRecord(msg) || typeof msg.t !== 'string') return this.closeConn(conn, CLOSE.badFrame, 'frame');
    if (!conn.authed) {
      if (msg.t !== 'h') return this.closeConn(conn, CLOSE.auth, 'hello first');
      return this.hello(conn, msg);
    }
    switch (msg.t) {
      case 'pong': return;
      case 'p': return this.onPresence(conn, msg.d, now);
      case 'r': return this.onRoom(conn, msg.d, now);
      case 'm': return this.onMessage(conn, msg.d, now);
      case 'c': return this.onColl(conn, msg, now);
      case 'h': return; // a second hello is ignored
      default: this.drop(conn, now);
    }
  }

  /** Counts a refused frame; a client that keeps flooding is closed. */
  private drop(conn: Conn, now: number): void {
    this.droppedFrames++;
    if (now - conn.dropFrom > 10_000) { conn.dropFrom = now; conn.drops = 0; }
    if (++conn.drops > 300) this.closeConn(conn, CLOSE.rate, 'rate');
  }

  private hello(conn: Conn, msg: Record<string, unknown>): void {
    const token = msg.token;
    if (typeof token !== 'string' || typeof msg.v !== 'number') { this.err(conn, 'auth', 'Sign in again.'); return this.closeConn(conn, CLOSE.auth, 'auth'); }
    const account = this.accounts.byToken(token);
    if (!account) { this.err(conn, 'auth', 'Sign in again.'); return this.closeConn(conn, CLOSE.auth, 'auth'); }
    if (account.banned) { this.err(conn, 'banned', 'This account is not available.'); return this.closeConn(conn, CLOSE.banned, 'banned'); }
    // At most N sockets per account: the oldest one makes room.
    const mine = this.byAccount.get(account.id) ?? new Set<Conn>();
    while (mine.size >= this.cfg.maxConnPerAccount) {
      const oldest = [...mine].sort((a, b) => a.connectedAt - b.connectedAt)[0]!;
      mine.delete(oldest);
      this.err(oldest, 'replaced', 'Signed in somewhere else.');
      this.closeConn(oldest, CLOSE.replaced, 'replaced');
    }
    conn.authed = true; conn.account = account; conn.accountId = account.id; conn.name = account.name;
    mine.add(conn);
    this.byAccount.set(account.id, mine);
    this.loadStamp(conn);
    conn.presence = { u: conn.name, on: 0, car: 0, pt: conn.pt, lb: '', rd: -1 };
    conn.lowDirty = { ...conn.presence }; conn.forceLow = true;
    this.lowSet.add(conn);
    const presence: Record<string, unknown> = {};
    for (const c of this.conns.values()) if (c.authed && c !== conn) presence[c.id] = this.publicPresence(c);
    presence[conn.id] = { ...conn.presence };
    const lobbies: Record<string, LobbyRecord> = {};
    for (const [id, l] of this.lobbies) lobbies[id] = l.rec;
    this.accounts.touch(account.id);
    this.sendObj(conn, { t: 'w', v: PROTOCOL, id: conn.id, name: conn.name, serverTime: this.now(), presence, room: { lobbies }, limits: { frame: MAX_FRAME, state: 20, presence: 10 } });
  }

  private publicPresence(c: Conn): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of LOW_FIELDS) if (c.presence[k] !== undefined) out[k] = c.presence[k];
    return out;
  }

  /** The verified look: loadout string and owned items come from the wallet, never from the client. */
  private loadStamp(conn: Conn, record?: WalletRecord | null): void {
    const rec = record === undefined ? this.wallets.get(conn.accountId).record : record;
    conn.owned = new Set(rec?.owned ?? []);
    const loadout = sanitizeLoadout(rec?.equipped ?? {});
    conn.pt = Object.keys(loadout).length ? encodeLoadout(loadout) : '';
  }
  private verifiedCar(conn: Conn, idx: number): number {
    const id = NET_CARS[idx];
    const item = id ? carItem(id) : undefined;
    return item && (item.price === 0 || conn.owned.has(item.id)) ? idx : 0;
  }

  /* ------------------------------------------------------------ presence */

  private onPresence(conn: Conn, d: unknown, now: number): void {
    if (!conn.bPres.take(now)) return this.drop(conn, now);
    if (!isRecord(d)) return;
    const low: Record<string, unknown> = {}, lob: Record<string, unknown> = {};
    let leavingFrom = '';
    for (const key of Object.keys(d)) {
      const v = d[key];
      switch (key) {
        case 'on': if (v === 0 || v === 1) low.on = v; break;
        case 'car': if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64) low.car = this.verifiedCar(conn, v); break;
        case 'rd': if (typeof v === 'number' && Number.isFinite(v)) low.rd = clampInt(v, -1, 1e6); break;
        case 'ab': if (typeof v === 'number' && Number.isFinite(v)) low.ab = clampInt(v, 0, 0x7fffffff); break;
        case 'lb': {
          if (typeof v !== 'string' || v.length > 80 || (v !== '' && !isPeerId(v))) break;
          if (v === conn.lb) break;
          if (v !== '') {
            const lobby = this.lobbies.get(v);
            if (!lobby) { this.err(conn, 'no-lobby', 'That lobby is gone.'); this.fixSelf(conn, { lb: conn.lb }); break; }
            if (lobby.members.size >= MAX_LOBBY_PLAYERS) { this.err(conn, 'lobby-full', 'That lobby is full.'); this.fixSelf(conn, { lb: conn.lb }); break; }
          }
          low.lb = v;
          if (v === '') leavingFrom = conn.lb;
          break;
        }
        case 'rp': { const p = cleanProgress(v); if (p !== undefined) lob.rp = p; break; }
        case 'pg': if (typeof v === 'number' && Number.isFinite(v)) lob.pg = clampInt(v, 0, 9999); break;
        default: break; // u, pt and anything unknown: dropped (identity is server stamped)
      }
    }
    if ('lb' in low) this.moveLobby(conn, low.lb as string);
    if (Object.keys(low).length) {
      for (const k of Object.keys(low)) conn.presence[k] = low[k];
      conn.lowDirty = { ...(conn.lowDirty ?? {}), ...low };
      this.lowSet.add(conn);
    }
    if (Object.keys(lob).length) {
      for (const k of Object.keys(lob)) conn.presence[k] = lob[k];
      const target = leavingFrom || conn.lb;
      if (conn.lobDirty && conn.lobDirty.lb !== target) this.flushLobby(conn, now, true);
      if (target) {
        conn.lobDirty = { lb: target, patch: { ...(conn.lobDirty?.patch ?? {}), ...lob } };
        this.lobSet.add(conn);
      }
    }
  }

  /** Tells just this client the true value of a field it tried to set wrongly. */
  private fixSelf(conn: Conn, patch: Record<string, unknown>): void { this.sendObj(conn, { t: 'P', d: { [conn.id]: patch } }); }

  private moveLobby(conn: Conn, to: string): void {
    this.leaveLobby(conn);
    conn.lb = to;
    if (!to) return;
    const lobby = this.lobbies.get(to)!;
    lobby.members.add(conn); lobby.touched = this.now();
    // The newcomer needs the race fields of the people already there.
    const snap: Record<string, unknown> = {};
    for (const m of lobby.members) if (m !== conn) {
      const f: Record<string, unknown> = {};
      for (const k of LOBBY_FIELDS) if (m.presence[k] !== undefined) f[k] = m.presence[k];
      if (Object.keys(f).length) snap[m.id] = f;
    }
    if (Object.keys(snap).length) this.sendObj(conn, { t: 'P', d: snap });
  }
  private leaveLobby(conn: Conn): void {
    if (!conn.lb) return;
    if (conn.lobDirty) this.flushLobby(conn, this.now(), true);
    const lobby = this.lobbies.get(conn.lb);
    if (lobby) { lobby.members.delete(conn); lobby.touched = this.now(); }
    this.stateQ.get(conn.lb)?.delete(conn.id);
    conn.lb = '';
    conn.presence.rp = null; conn.presence.pg = undefined;
  }

  /* ------------------------------------------------------------ room state (lobbies) */

  private onRoom(conn: Conn, d: unknown, now: number): void {
    if (!conn.bRoom.take(now)) return this.drop(conn, now);
    if (!isRecord(d)) return;
    const keys = Object.keys(d);
    if (keys.length !== 1 || keys[0] !== 'lobbies' || !isRecord(d.lobbies)) return this.drop(conn, now);
    const entries = Object.entries(d.lobbies);
    if (entries.length > 4) return this.drop(conn, now);
    for (const [id, patch] of entries) {
      if (!isPeerId(id) || id.length > 80) continue;
      const lobby = this.lobbies.get(id);
      if (patch === null) {
        // Only an empty lobby can be deleted (stale sweep); a member may not delete a live one.
        if (lobby && lobby.members.size === 0) this.deleteLobby(id);
        continue;
      }
      if (!isRecord(patch)) continue;
      let ok = true;
      for (const k of Object.keys(patch)) if (!LOBBY_KEYS.has(k)) ok = false;
      if (!ok) { this.drop(conn, now); continue; }
      if (patch.route !== undefined && !(PLAYABLE_ROUTE_IDS as readonly string[]).includes(patch.route as string)) continue;
      if (lobby && lobby.members.size > 0 && !lobby.members.has(conn)) continue; // only members edit a live lobby
      if (!lobby && this.lobbies.size >= this.cfg.maxLobbies) { this.err(conn, 'lobbies-full', 'Too many lobbies right now.'); continue; }
      const merged = { ...(lobby?.rec ?? {}), ...patch };
      const parsed = parseLobbies({ lobbies: { [id]: merged } })[id];
      if (!parsed) continue;
      const before = lobby?.rec as unknown as Record<string, unknown> | undefined;
      const diff: Record<string, unknown> = {};
      for (const k of Object.keys(parsed) as Array<keyof LobbyRecord>) if (!before || before[k] !== parsed[k]) diff[k] = parsed[k];
      if (lobby) { lobby.rec = parsed; lobby.touched = now; } else this.lobbies.set(id, { rec: parsed, members: new Set(), touched: now });
      if (Object.keys(diff).length) {
        const pending = this.roomDirty[id];
        this.roomDirty[id] = pending === null || (pending === undefined && !before) ? { ...parsed } : { ...(pending ?? {}), ...diff };
      }
    }
  }
  private deleteLobby(id: string): void {
    this.lobbies.delete(id);
    this.stateQ.delete(id);
    this.roomDirty[id] = null;
  }

  /* ------------------------------------------------------------ messages */

  private onMessage(conn: Conn, d: unknown, now: number): void {
    if (!isRecord(d)) return;
    const type = d.type;
    if (typeof type !== 'string' || !MSG_TYPES.has(type)) return;
    const bucket = type === 's' ? conn.bState : conn.bMsg;
    if (!bucket.take(now)) return this.drop(conn, now);
    let clean: Record<string, unknown>;
    if (type === 's') {
      const packed = d.d;
      if (!Array.isArray(packed) || packed.length < 13 || packed.length > 32) return;
      for (let i = 0; i < packed.length; i++) if (typeof packed[i] !== 'number' || !Number.isFinite(packed[i])) return;
      clean = { type: 's', d: packed };
    } else if (type === 'h') {
      clean = { type: 'h' };
    } else {
      const n = d.n;
      if (typeof n !== 'number' || !Number.isFinite(n)) return;
      clean = { type, n };
      if (type === 'q') {
        if (typeof d.th !== 'number' || !Number.isFinite(d.th)) return;
        clean.th = d.th;
      }
    }
    const to = d.to;
    if (to !== undefined) {
      if (typeof to !== 'string') return;
      const target = this.conns.get(to);
      if (!target || !target.authed || target === conn) return;
      if (!HANDSHAKE.has(type) && !(conn.lb && conn.lb === target.lb)) return;
      if (!HANDSHAKE.has(type) && type === 's') return;
      clean.to = to;
      this.sendObj(target, { t: 'M', f: conn.id, d: clean });
      return;
    }
    if (!conn.lb) return; // no lobby and no recipient: dropped
    const lobby = this.lobbies.get(conn.lb);
    if (!lobby) return;
    if (type === 's') {
      let q = this.stateQ.get(conn.lb);
      if (!q) { q = new Map(); this.stateQ.set(conn.lb, q); }
      q.set(conn.id, JSON.stringify([conn.id, clean]));
      return;
    }
    const frame = JSON.stringify({ t: 'M', f: conn.id, d: clean });
    for (const m of lobby.members) if (m !== conn) this.safeSend(m, frame);
  }

  /* ------------------------------------------------------------ collections */

  private onColl(conn: Conn, msg: Record<string, unknown>, now: number): void {
    if (!conn.bColl.take(now)) return this.drop(conn, now);
    const n = msg.n, op = msg.op, r = msg.r;
    const rid = typeof r === 'number' || typeof r === 'string' ? r : undefined;
    if (typeof n !== 'string' || typeof op !== 'string' || n.length > 40) return;
    const reply = (extra: Record<string, unknown>): void => this.sendObj(conn, { t: 'C', n, ...(rid !== undefined ? { r: rid } : {}), ...extra });
    if (!kindOf(n)) return reply({ ok: false, reason: 'no-such-collection' });
    try {
      switch (op) {
        case 'sub': {
          if (!conn.subs.has(n) && conn.subs.size >= MAX_SUBS) return reply({ ok: false, reason: 'too-many-subscriptions' });
          conn.subs.add(n);
          let set = this.collSubs.get(n);
          if (!set) { set = new Set(); this.collSubs.set(n, set); }
          set.add(conn);
          return reply({ ok: true, full: true, rows: this.colls.list(n) });
        }
        case 'unsub': conn.subs.delete(n); this.collSubs.get(n)?.delete(conn); return reply({ ok: true });
        case 'list': return reply({ ok: true, rows: this.colls.list(n, isRecord(msg.q) ? { route: typeof msg.q.route === 'string' ? msg.q.route : undefined, mode: typeof msg.q.mode === 'string' ? msg.q.mode : undefined } : undefined) });
        case 'get': { const row = typeof msg.id === 'string' ? this.colls.get(n, msg.id) : null; return reply(row ? { ok: true, row } : { ok: false, reason: 'not-found' }); }
        case 'create': return reply(this.colls.write(conn.account!, n, msg.data));
        case 'update': return reply(typeof msg.id === 'string' ? this.colls.write(conn.account!, n, msg.data, msg.id) : { ok: false, reason: 'bad-row' });
        default: return reply({ ok: false, reason: 'bad-op' });
      }
    } catch (error) {
      this.log('coll.error', { n, err: String((error as Error)?.message ?? error).slice(0, 100) });
      reply({ ok: false, reason: 'server-error' });
    }
  }

  private onCollChange(change: CollChange): void {
    let p = this.collPending.get(change.coll);
    if (!p) { p = { up: new Map(), del: new Set() }; this.collPending.set(change.coll, p); }
    for (const row of change.up) { p.up.set(row.id, row); p.del.delete(row.id); }
    for (const id of change.del) { p.del.add(id); p.up.delete(id); }
  }

  /* ------------------------------------------------------------ wallet pushes */

  /** A wallet changed (client write or server credit): refresh the verified look and tell the account's sockets. */
  walletChanged(accountId: string, version: number, inbox = false): void {
    const set = this.byAccount.get(accountId);
    if (!set) return;
    for (const conn of set) {
      if (!inbox) {
        const before = conn.pt, car = conn.presence.car as number;
        this.loadStamp(conn);
        const patch: Record<string, unknown> = {};
        if (conn.pt !== before) { conn.presence.pt = conn.pt; patch.pt = conn.pt; }
        const fixed = this.verifiedCar(conn, car ?? 0);
        if (fixed !== car) { conn.presence.car = fixed; patch.car = fixed; }
        if (Object.keys(patch).length) { conn.lowDirty = { ...(conn.lowDirty ?? {}), ...patch }; this.lowSet.add(conn); }
      }
      this.sendObj(conn, { t: 'wallet', version, ...(inbox ? { inbox: true } : {}) });
    }
  }

  kick(accountId: string, code: string, close: number = CLOSE.banned): void {
    for (const conn of [...(this.byAccount.get(accountId) ?? [])]) { this.err(conn, code, 'Disconnected.'); this.closeConn(conn, close, code); }
  }

  /* ------------------------------------------------------------ the tick */

  /** One tick (50 ms in production). Flushes batched state, coalesced presence, room diffs, collection diffs and sweeps. */
  tick(now: number = this.now()): void {
    const t0 = performance.now();
    // 1. car state, one frame per recipient
    for (const [lb, q] of this.stateQ) {
      if (!q.size) continue;
      const lobby = this.lobbies.get(lb);
      if (lobby) {
        const entries = [...q];
        for (const m of lobby.members) {
          if (m.sock.bufferedAmount > BACKPRESSURE_BYTES) { this.droppedFrames++; this.noteBackedUp(m, now); continue; }
          m.backedSince = 0;
          let out = '';
          for (const [id, s] of entries) if (id !== m.id) out += (out ? ',' : '') + s;
          if (out) this.safeSend(m, `{"t":"M","b":[${out}]}`);
        }
      }
      q.clear();
    }
    // 2. race fields to lobby members (<= 10 Hz per sender)
    if (this.lobSet.size) {
      const byLobby = new Map<string, Record<string, unknown>>();
      for (const c of [...this.lobSet]) {
        if (!c.authed) { this.lobSet.delete(c); continue; }
        if (now - c.lastLob < LOBBY_MS || !c.lobDirty) continue;
        const d = c.lobDirty;
        c.lobDirty = null; c.lastLob = now; this.lobSet.delete(c);
        let g = byLobby.get(d.lb);
        if (!g) { g = {}; byLobby.set(d.lb, g); }
        g[c.id] = d.patch;
      }
      for (const [lb, group] of byLobby) {
        const lobby = this.lobbies.get(lb);
        if (!lobby) continue;
        const frame = JSON.stringify({ t: 'P', d: group });
        for (const m of lobby.members) this.safeSend(m, frame);
      }
    }
    // 3. hub presence (<= 4 Hz per sender), joins and departures
    if ((this.lowSet.size || this.lowGone.length) && now - this.lastLowFlush >= LOW_MS) {
      this.lastLowFlush = now;
      const group: Record<string, unknown> = {};
      let any = false;
      for (const c of [...this.lowSet]) {
        if (!c.authed) { this.lowSet.delete(c); continue; }
        if (!c.lowDirty || (!c.forceLow && now - c.lastLow < LOW_MS)) continue;
        group[c.id] = c.lowDirty; any = true;
        c.lowDirty = null; c.lastLow = now; c.forceLow = false; this.lowSet.delete(c);
      }
      for (const id of this.lowGone) { group[id] = null; any = true; }
      this.lowGone = [];
      if (any) this.broadcast(JSON.stringify({ t: 'P', d: group }));
    }
    // 4. lobby records (<= 4 Hz)
    if (now - this.lastRoom >= ROOM_MS && Object.keys(this.roomDirty).length) {
      this.lastRoom = now;
      const d = this.roomDirty; this.roomDirty = {};
      this.broadcast(JSON.stringify({ t: 'R', d: { lobbies: d } }));
    }
    // 5. collection diffs (<= 1 Hz)
    if (now - this.lastColl >= COLL_MS && this.collPending.size) {
      this.lastColl = now;
      for (const [name, p] of this.collPending) {
        const subs = this.collSubs.get(name);
        if (subs && subs.size && (p.up.size || p.del.size)) {
          const frame = JSON.stringify({ t: 'C', n: name, up: [...p.up.values()], del: [...p.del] });
          for (const c of subs) this.safeSend(c, frame);
        }
      }
      this.collPending.clear();
    }
    // 6. sweeps (1 Hz): hello deadline, pings, silence, backed-up sockets, stale lobbies, rate counters
    if (now - this.lastSweep >= 1000) {
      this.lastSweep = now;
      this.sweep(now);
    }
    const dt = performance.now() - t0;
    this.tickSum += dt; this.tickN++; if (dt > this.tickMax) this.tickMax = dt;
  }

  private noteBackedUp(conn: Conn, now: number): void {
    if (!conn.backedSince) conn.backedSince = now;
    else if (now - conn.backedSince > BACKED_UP_CLOSE_MS) this.closeConn(conn, CLOSE.backedUp, 'backed up');
  }

  private broadcast(frame: string): void {
    for (const c of this.conns.values()) if (c.authed) {
      if (c.sock.bufferedAmount > BACKPRESSURE_BYTES * 4) { this.noteBackedUp(c, this.now()); continue; }
      this.safeSend(c, frame);
    }
  }

  private sweep(now: number): void {
    for (const c of [...this.conns.values()]) {
      if (!c.authed) { if (now - c.connectedAt > HELLO_MS) this.closeConn(c, CLOSE.timeout, 'hello'); continue; }
      if (now - c.lastRx > DROP_MS) { this.closeConn(c, CLOSE.timeout, 'silent'); continue; }
      if (now - c.lastPing >= PING_MS) { c.lastPing = now; this.sendObj(c, { t: 'ping', ts: now }); }
      if (c.backedSince && c.sock.bufferedAmount <= BACKPRESSURE_BYTES) c.backedSince = 0;
      else if (c.backedSince && now - c.backedSince > BACKED_UP_CLOSE_MS) this.closeConn(c, CLOSE.backedUp, 'backed up');
    }
    for (const [id, l] of [...this.lobbies]) if (l.members.size === 0 && now - l.touched > STALE_LOBBY_MS) this.deleteLobby(id);
    const span = (now - this.rateAt) / 1000;
    if (span >= 4) {
      this.inRate = this.inCount / span; this.outRate = this.outCount / span; this.inCount = 0; this.outCount = 0; this.rateAt = now;
      this.tickAvg = this.tickN ? this.tickSum / this.tickN : 0; this.tickSum = 0; this.tickN = 0;
    }
  }

  private flushLobby(conn: Conn, now: number, force: boolean): void {
    const d = conn.lobDirty;
    if (!d) return;
    if (!force && now - conn.lastLob < LOBBY_MS) return;
    conn.lobDirty = null; conn.lastLob = now; this.lobSet.delete(conn);
    const lobby = this.lobbies.get(d.lb);
    if (!lobby) return;
    const frame = JSON.stringify({ t: 'P', d: { [conn.id]: d.patch } });
    for (const m of lobby.members) this.safeSend(m, frame);
  }

  /* ------------------------------------------------------------ introspection */

  onlineCount(): number { let n = 0; for (const c of this.conns.values()) if (c.authed) n++; return n; }
  lobbyCount(): number { return this.lobbies.size; }
  stats(): HubStats {
    const mem = process.memoryUsage();
    return {
      online: this.onlineCount(), connected: this.conns.size, lobbies: this.lobbies.size, inPerSec: Math.round(this.inRate), outPerSec: Math.round(this.outRate),
      tickAvgMs: Math.round((this.tickAvg || (this.tickN ? this.tickSum / this.tickN : 0)) * 1000) / 1000, tickMaxMs: Math.round(this.tickMax * 1000) / 1000,
      rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), uptimeS: Math.floor((this.now() - this.started) / 1000), droppedFrames: this.droppedFrames,
    };
  }
  resetTickMax(): void { this.tickMax = 0; }
  /** Test helper: the server's view of a connection's presence. */
  presenceOf(conn: Conn): Record<string, unknown> { return conn.presence; }
  lobbyMembers(id: string): string[] { return [...(this.lobbies.get(id)?.members ?? [])].map(c => c.id); }
}

/** Race progress as the client parser accepts it: [race, checkpoint, progressM, finishMs, score, assist?]. null clears it. */
export function cleanProgress(raw: unknown): unknown[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length < 5 || raw.length > 16) return undefined;
  for (let i = 0; i < 5; i++) if (typeof raw[i] !== 'number' || !Number.isFinite(raw[i])) return undefined;
  const base = [clampInt(raw[0], -1, 1e6), clampInt(raw[1], 0, 1000), clampInt(raw[2], -1e6, 1e6), clampInt(raw[3], -1, RACE_LIMIT_MS * 4), clampInt(raw[4], 0, 1e9)];
  return raw[5] === 0 || raw[5] === 1 || raw[5] === 2 ? [...base, raw[5]] : base;
}
