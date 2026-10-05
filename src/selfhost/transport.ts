/**
 * NetTransport over the game server's WebSocket (/ws), with the same semantics as the websim adapter in
 * src/net/transport.ts, so src/net/session.ts, lobby.ts and the rest run unchanged:
 *   - presence(): client id -> presence object; updatePresence() applies at once and then goes to the server;
 *   - roomState(): deep merged, null deletes; updateRoomState() is the same;
 *   - send(): a broadcast message, delivered to the others in the lobby (the server does not echo it);
 *   - collection(name): rows with create / update / getList / subscribe.
 *
 * Wire format (short keys, see notes/SELFHOST-SERVER.md): hello {t:'h',token,v} is the first frame (the token is never
 * in the URL); the server answers {t:'w',...} with this client's id, everybody's presence and the lobbies.
 *
 * Lost connections come back by themselves: exponential backoff with jitter, and once the new welcome arrives the
 * transport re-sends this client's presence and the lobby it hosts, and subscribes to its collections again.
 * `createSelfhostTransport` never gives up; `connectSelfhostTransport` returns the offline transport when the very
 * first connection does not come up, so the game stays playable.
 */
import { createOfflineTransport, type NetCollection, type NetPeer, type NetRecord, type NetTransport, type PresenceMap, type RoomState } from '../net/transport';
import type { Api } from './api';

export const PROTOCOL_VERSION = 1;
/** The server drops frames over this size. */
export const MAX_FRAME_BYTES = 2048;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000];
const PRESENCE_FLUSH_MS = 100;
const ROOM_FLUSH_MS = 250;
const ECHO_MS = 2000;
const SILENCE_MS = 55_000;
const WATCH_MS = 5000;
/** Fields of presence that only the server may write. */
const SERVER_FIELDS = new Set(['u', 'pt']);
const AUTH_CLOSE = new Set([4401, 4403, 4409]);

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
type WebSocketCtor = new (url: string) => WebSocketLike;
const OPEN = 1;

export type TransportState = 'connecting' | 'open' | 'closed' | 'stopped';
export type StopReason = 'auth' | 'banned' | 'replaced';

export interface SelfhostTransportOptions {
  /** ws(s) URL of the hub. Default: same host as the page, /ws. */
  readonly url?: string;
  /** The account token, sent in the hello frame. */
  token(): string | null;
  /** HTTP side (collection writes and reads). */
  readonly api: Api;
  readonly WebSocket?: WebSocketCtor;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  readonly random?: () => number;
  /** The server says the wallet changed (a gift landed). */
  onWallet?(version: number, inbox: boolean): void;
  /** The server will not take this connection again (sign in again, banned, signed in somewhere else). */
  onStopped?(reason: StopReason): void;
  /** Called on every state change. */
  onState?(state: TransportState): void;
}

export interface SelfhostTransport extends NetTransport {
  state(): TransportState;
  /** Starts a connection attempt now (the browser came back online). */
  reconnectNow(): void;
  /** Resolves with the first welcome, or null after `ms`. */
  whenWelcome(ms: number): Promise<boolean>;
  /** Server clock minus local clock, ms. */
  serverOffsetMs(): number;
  /** Read only list of a collection over HTTP (no socket needed). */
  readonly api: Api;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Deep merge in the room state sense: objects merge, null deletes the key, anything else replaces. */
export function mergeRoom(state: Json, patch: Json): Json {
  const out: Json = { ...state };
  for (const key of Object.keys(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const value = patch[key];
    if (value === null) delete out[key];
    else if (isObject(value) && isObject(out[key])) out[key] = mergeRoom(out[key] as Json, value);
    else if (isObject(value)) out[key] = mergeRoom({}, value);
    else out[key] = value;
  }
  return out;
}
/** Merges two outgoing patches (later wins). null stays null so a delete is not lost. */
function mergePatch(base: Json, next: Json): Json {
  const out: Json = { ...base };
  for (const key of Object.keys(next)) {
    const value = next[key];
    out[key] = isObject(value) && isObject(out[key]) ? mergePatch(out[key] as Json, value) : value;
  }
  return out;
}

interface CollState { rows: NetRecord[]; subscribers: Set<(records: readonly NetRecord[]) => void>; subscribed: boolean }

export function createSelfhostTransport(options: SelfhostTransportOptions): SelfhostTransport {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const Ctor = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  const url = options.url ?? (typeof location !== 'undefined' ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws` : 'ws://127.0.0.1/ws');

  let ws: WebSocketLike | null = null;
  let state: TransportState = 'closed';
  let selfId = '';
  let peers: Record<string, NetPeer> = {};
  let presence: Record<string, Record<string, unknown>> = {};
  let room: Json = {};
  let serverOffset = 0;
  let attempt = 0, lastRx = 0, welcomed = false, disposed = false, stableTimer: unknown = null, retryTimer: unknown = null, echoTimer: unknown = null, watchTimer: unknown = null;
  const messageListeners = new Set<(data: Record<string, unknown>) => void>();
  const presenceListeners = new Set<(p: PresenceMap) => void>();
  const roomListeners = new Set<(s: RoomState) => void>();
  const welcomeWaiters = new Set<(ok: boolean) => void>();
  const collections = new Map<string, CollState>();
  const pendingReplies = new Map<string, (reply: Json) => void>();
  let requestSeq = 0;
  let lastPresenceSend = -Infinity, lastRoomSend = -Infinity;

  // What this client told the server, kept so a new connection can say it again.
  let ownPresence: Json = {};
  const ownLobbies: Record<string, Json> = {};
  let outPresence: Json | null = null, outRoom: Json | null = null, presenceTimer: unknown = null, roomTimer: unknown = null;

  const setState = (next: TransportState): void => { if (state !== next) { state = next; try { options.onState?.(next); } catch { /* observers must not break the socket */ } } };
  const rawSend = (frame: Json): boolean => {
    if (!ws || ws.readyState !== OPEN || !welcomed) return false;
    try {
      const text = JSON.stringify(frame);
      if (text.length > MAX_FRAME_BYTES) return false;
      ws.send(text);
      return true;
    } catch { return false; }
  };
  const notifyPresence = (): void => { const snapshot = presence; for (const listener of [...presenceListeners]) { try { listener(snapshot); } catch (error) { console.warn('LATERAL presence listener failed', error); } } };
  const notifyRoom = (): void => { const snapshot = room; for (const listener of [...roomListeners]) { try { listener(snapshot); } catch (error) { console.warn('LATERAL room listener failed', error); } } };
  const rebuildPeers = (): void => {
    const next: Record<string, NetPeer> = {};
    for (const [id, entry] of Object.entries(presence)) next[id] = { username: typeof entry.u === 'string' ? entry.u : '', avatarUrl: '' };
    peers = next;
  };

  /* ---------------------------------------------------------------- outgoing, coalesced */
  const flushPresence = (): void => {
    presenceTimer = null;
    if (!outPresence) return;
    const patch = outPresence; outPresence = null;
    if (rawSend({ t: 'p', d: patch })) lastPresenceSend = now(); // not connected: ownPresence carries it to the next welcome
  };
  const queuePresence = (): void => {
    if (presenceTimer) return;
    const wait = Math.max(0, lastPresenceSend + PRESENCE_FLUSH_MS - now());
    presenceTimer = schedule(flushPresence, wait);
  };
  const flushRoom = (): void => {
    roomTimer = null;
    if (!outRoom) return;
    const patch = outRoom; outRoom = null;
    if (rawSend({ t: 'r', d: patch })) lastRoomSend = now();
  };
  const queueRoom = (): void => {
    if (roomTimer) return;
    roomTimer = schedule(flushRoom, Math.max(0, lastRoomSend + ROOM_FLUSH_MS - now()));
  };

  const resend = (): void => {
    // The lobby this client hosts may be gone (server restart): put it back before saying who is in it.
    const lobbies = (isObject(room.lobbies) ? room.lobbies : {}) as Json;
    const joined = typeof ownPresence.lb === 'string' ? ownPresence.lb : '';
    for (const [id, record] of Object.entries(ownLobbies)) if (id === joined && !lobbies[id]) rawSend({ t: 'r', d: { lobbies: { [id]: record } } });
    if (Object.keys(ownPresence).length) rawSend({ t: 'p', d: ownPresence });
    for (const [name, coll] of collections) if (coll.subscribers.size) { coll.subscribed = false; subscribeCollection(name); }
  };

  /* ---------------------------------------------------------------- incoming */
  const deliver = (from: string, d: unknown): void => {
    if (!isObject(d)) return;
    const data = { ...d, f: from, clientId: from };
    for (const listener of [...messageListeners]) { try { listener(data); } catch (error) { console.warn('LATERAL message listener failed', error); } }
  };
  const applyCollection = (name: string, frame: Json): void => {
    const coll = collections.get(name);
    if (!coll) return;
    if (Array.isArray(frame.rows)) coll.rows = frame.rows.filter(isObject).map(row => row as unknown as NetRecord);
    if (Array.isArray(frame.up) || Array.isArray(frame.del)) {
      const byId = new Map(coll.rows.map(row => [row.id, row] as const));
      for (const row of (Array.isArray(frame.up) ? frame.up : [])) if (isObject(row) && typeof row.id === 'string') byId.set(row.id, row as unknown as NetRecord);
      for (const id of (Array.isArray(frame.del) ? frame.del : [])) if (typeof id === 'string') byId.delete(id);
      coll.rows = [...byId.values()];
    }
    for (const listener of [...coll.subscribers]) { try { listener(coll.rows); } catch (error) { console.warn('LATERAL collection listener failed', error); } }
  };

  const onFrame = (text: string): void => {
    lastRx = now();
    let frame: Json;
    try { const parsed: unknown = JSON.parse(text); if (!isObject(parsed)) return; frame = parsed; } catch { return; }
    switch (frame.t) {
      case 'w': {
        selfId = typeof frame.id === 'string' ? frame.id : '';
        presence = isObject(frame.presence) ? Object.fromEntries(Object.entries(frame.presence).filter(([, v]) => isObject(v)).map(([k, v]) => [k, { ...(v as Json) }])) : {};
        room = isObject(frame.room) ? mergeRoom({}, frame.room) : {};
        if (typeof frame.serverTime === 'number') serverOffset = frame.serverTime - now();
        rebuildPeers();
        welcomed = true;
        setState('open');
        if (stableTimer) cancel(stableTimer);
        stableTimer = schedule(() => { attempt = 0; }, 10_000);
        resend();
        notifyPresence(); notifyRoom();
        for (const waiter of [...welcomeWaiters]) waiter(true);
        welcomeWaiters.clear();
        break;
      }
      case 'P': {
        if (!isObject(frame.d)) break;
        const next = { ...presence };
        for (const [id, patch] of Object.entries(frame.d)) {
          if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
          if (patch === null) { delete next[id]; continue; }
          if (isObject(patch)) next[id] = { ...(next[id] ?? {}), ...patch };
        }
        presence = next; rebuildPeers(); notifyPresence();
        break;
      }
      case 'R': {
        if (isObject(frame.d)) { room = mergeRoom(room, frame.d); notifyRoom(); }
        break;
      }
      case 'M': {
        if (Array.isArray(frame.b)) { for (const entry of frame.b) if (Array.isArray(entry) && typeof entry[0] === 'string') deliver(entry[0], entry[1]); }
        else if (typeof frame.f === 'string') deliver(frame.f, frame.d);
        break;
      }
      case 'C': {
        const name = typeof frame.n === 'string' ? frame.n : '';
        const key = frame.r !== undefined ? `${name}|${String(frame.r)}` : '';
        if (key && pendingReplies.has(key)) { const resolve = pendingReplies.get(key)!; pendingReplies.delete(key); resolve(frame); }
        if (name && (frame.ok !== false)) applyCollection(name, frame);
        break;
      }
      case 'wallet': options.onWallet?.(typeof frame.version === 'number' ? frame.version : 0, frame.inbox === true); break;
      case 'ping': rawSend({ t: 'pong' }); break;
      case 'err': {
        const code = typeof frame.code === 'string' ? frame.code : '';
        if (code === 'auth') stop('auth'); else if (code === 'banned') stop('banned'); else if (code === 'replaced') stop('replaced');
        break;
      }
      default: break;
    }
  };

  /* ---------------------------------------------------------------- connection */
  const stop = (reason: StopReason): void => {
    if (state === 'stopped') return;
    setState('stopped');
    try { ws?.close(1000, reason); } catch { /* already closed */ }
    options.onStopped?.(reason);
  };
  const clearTimers = (): void => { for (const timer of [retryTimer, presenceTimer, roomTimer]) if (timer) cancel(timer); retryTimer = presenceTimer = roomTimer = null; };

  const scheduleRetry = (): void => {
    if (disposed || state === 'stopped' || retryTimer) return;
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt++;
    // +-30 % jitter, so a restarted server is not hit by everyone in the same second.
    const wait = Math.round(base * (0.7 + random() * 0.6));
    retryTimer = schedule(() => { retryTimer = null; open(); }, wait);
  };

  function open(): void {
    if (disposed || state === 'stopped' || !Ctor) return;
    if (ws && (ws.readyState === 0 || ws.readyState === OPEN)) return;
    const token = options.token();
    if (!token) { setState('closed'); return; }
    welcomed = false;
    setState('connecting');
    let socket: WebSocketLike;
    try { socket = new Ctor(url); } catch { setState('closed'); scheduleRetry(); return; }
    ws = socket;
    socket.onopen = () => { try { socket.send(JSON.stringify({ t: 'h', token, v: PROTOCOL_VERSION })); } catch { /* the close handler retries */ } };
    socket.onmessage = event => { if (ws === socket && typeof event.data === 'string') onFrame(event.data); };
    socket.onerror = () => { /* followed by close */ };
    socket.onclose = event => {
      if (ws !== socket) return;
      ws = null; welcomed = false;
      if (stableTimer) { cancel(stableTimer); stableTimer = null; }
      if (state === 'stopped' || disposed) return;
      setState('closed');
      if (AUTH_CLOSE.has(event.code)) { stop(event.code === 4401 ? 'auth' : event.code === 4403 ? 'banned' : 'replaced'); return; }
      scheduleRetry();
    };
  }

  // The session treats a silent socket as a lost connection when it hears nothing, not even its own echo: the server
  // does not echo, so a heartbeat in the same shape keeps that watch honest while the connection is really alive.
  echoTimer = schedule(function echo() {
    if (disposed) return;
    if (state === 'open' && welcomed && selfId && now() - lastRx < SILENCE_MS / 2) deliver(selfId, { type: 'echo' });
    echoTimer = schedule(echo, ECHO_MS);
  }, ECHO_MS);
  watchTimer = schedule(function watch() {
    if (disposed) return;
    if (state === 'open' && now() - lastRx > SILENCE_MS) { try { ws?.close(4000, 'silent'); } catch { /* ignore */ } }
    watchTimer = schedule(watch, WATCH_MS);
  }, WATCH_MS);

  /* ---------------------------------------------------------------- collections */
  const collState = (name: string): CollState => {
    let coll = collections.get(name);
    if (!coll) { coll = { rows: [], subscribers: new Set(), subscribed: false }; collections.set(name, coll); }
    return coll;
  };
  const ask = (name: string, frame: Json): Promise<Json | null> => new Promise(resolve => {
    const r = ++requestSeq;
    const key = `${name}|${r}`;
    pendingReplies.set(key, reply => resolve(reply));
    if (!rawSend({ t: 'c', n: name, r, ...frame })) { pendingReplies.delete(key); resolve(null); return; }
    schedule(() => { if (pendingReplies.delete(key)) resolve(null); }, 8000);
  });
  function subscribeCollection(name: string): void {
    const coll = collState(name);
    if (coll.subscribed) return;
    coll.subscribed = true;
    void ask(name, { op: 'sub' }).then(reply => { if (!reply || reply.ok === false) coll.subscribed = false; });
  }
  const reason = (body: unknown, fallback: string): string => (isObject(body) && typeof body.reason === 'string' ? body.reason : isObject(body) && typeof body.error === 'string' ? body.error : fallback);

  const collection = (name: string): NetCollection | null => {
    if (!/^[A-Za-z0-9_]{3,40}$/.test(name)) return null;
    const coll = collState(name);
    const write = async (data: Record<string, unknown>, id?: string): Promise<unknown> => {
      // Rows can be large (a ghost lap), so writes go over HTTP, which has room for them. The server stamps the name.
      const result = await options.api.post<Json>(`/api/v1/collections/${encodeURIComponent(name)}`, { data, ...(id ? { id } : {}) });
      if (!result.ok || result.body?.ok === false) throw new Error(reason(result.body, result.network ? 'offline' : 'rejected'));
      return { id: result.body?.id };
    };
    return {
      create: data => write(data),
      update: (id, data) => write(data, id),
      getList: () => coll.rows,
      subscribe(callback) {
        coll.subscribers.add(callback);
        if (state === 'open') subscribeCollection(name);
        if (coll.subscribed && coll.rows.length) schedule(() => { if (coll.subscribers.has(callback)) callback(coll.rows); }, 0);
        return () => {
          coll.subscribers.delete(callback);
          if (!coll.subscribers.size && coll.subscribed) { coll.subscribed = false; rawSend({ t: 'c', n: name, r: ++requestSeq, op: 'unsub' }); }
        };
      },
      async fetchRow(id) {
        const result = await options.api.get<Json>(`/api/v1/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
        return result.ok && isObject(result.body?.row) ? result.body!.row as unknown as NetRecord : null;
      },
    };
  };

  /* ---------------------------------------------------------------- the NetTransport surface */
  const transport: SelfhostTransport = {
    available: true,
    get selfId() { return selfId; },
    api: options.api,
    peers: () => peers,
    presence: () => presence,
    roomState: () => room,
    state: () => state,
    serverOffsetMs: () => serverOffset,
    updatePresence(patch) {
      if (!isObject(patch)) return;
      // Optimistic local change first: the session reads it back at once (goOnline, setReady, joinLobby).
      presence = { ...presence, [selfId || 'self']: { ...(presence[selfId || 'self'] ?? {}), ...patch } };
      const sendable: Json = {};
      for (const key of Object.keys(patch)) {
        if (SERVER_FIELDS.has(key)) continue;
        const value = patch[key];
        // A value this client already said (and the server confirmed by silence) is not sent again.
        if (JSON.stringify(ownPresence[key]) === JSON.stringify(value) && key in ownPresence) continue;
        sendable[key] = value;
      }
      notifyPresence();
      if (!Object.keys(sendable).length) return;
      ownPresence = { ...ownPresence, ...sendable };
      outPresence = mergePatch(outPresence ?? {}, sendable);
      queuePresence();
    },
    updateRoomState(patch) {
      if (!isObject(patch)) return;
      room = mergeRoom(room, patch);
      const lobbies = isObject(patch.lobbies) ? patch.lobbies : null;
      if (lobbies) for (const [id, value] of Object.entries(lobbies)) { if (value === null) delete ownLobbies[id]; else if (isObject(value)) ownLobbies[id] = mergeRoom(ownLobbies[id] ?? {}, value); }
      notifyRoom();
      outRoom = mergePatch(outRoom ?? {}, patch);
      queueRoom();
    },
    send(message) { if (isObject(message)) rawSend({ t: 'm', d: message }); },
    onMessage(callback) { messageListeners.add(callback); return () => { messageListeners.delete(callback); }; },
    onPresence(callback) { presenceListeners.add(callback); return () => { presenceListeners.delete(callback); }; },
    onRoomState(callback) { roomListeners.add(callback); return () => { roomListeners.delete(callback); }; },
    collection,
    reconnectNow() {
      if (disposed || state === 'stopped') return;
      if (retryTimer) { cancel(retryTimer); retryTimer = null; }
      attempt = 0;
      open();
    },
    whenWelcome(ms) {
      if (welcomed) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = (ok: boolean): void => { welcomeWaiters.delete(done); resolve(ok); };
        welcomeWaiters.add(done);
        schedule(() => { if (welcomeWaiters.has(done)) done(false); }, ms);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      for (const timer of [stableTimer, echoTimer, watchTimer]) if (timer) cancel(timer);
      try { ws?.close(1000, 'bye'); } catch { /* already closed */ }
      ws = null;
      messageListeners.clear(); presenceListeners.clear(); roomListeners.clear();
      for (const waiter of [...welcomeWaiters]) waiter(false);
      welcomeWaiters.clear();
      for (const coll of collections.values()) coll.subscribers.clear();
    },
  };
  open();
  return transport;
}

/**
 * Connects and resolves once the server said welcome. When the first connection does not come up inside `timeoutMs`
 * (server down, no account) the answer is the offline transport: the game plays on without the online features.
 */
export async function connectSelfhostTransport(options: SelfhostTransportOptions, timeoutMs = 8000): Promise<NetTransport> {
  if (!options.token()) return createOfflineTransport();
  const transport = createSelfhostTransport(options);
  const ok = await transport.whenWelcome(timeoutMs);
  if (ok) return transport;
  transport.dispose();
  return createOfflineTransport();
}

/** A collection that only reads, over HTTP (guests, or a socket that is not up). It polls while someone listens. */
export function createReadOnlyCollection(api: Api, name: string, options: { pollMs?: number; schedule?: (fn: () => void, ms: number) => unknown; cancel?: (handle: unknown) => void } = {}): NetCollection {
  const pollMs = options.pollMs ?? 20_000;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let rows: NetRecord[] = [];
  const subscribers = new Set<(records: readonly NetRecord[]) => void>();
  let timer: unknown = null, inflight = false, loaded = false;
  const load = async (): Promise<void> => {
    if (inflight) return;
    inflight = true;
    try {
      const result = await api.get<Json>(`/api/v1/collections/${encodeURIComponent(name)}`);
      if (result.ok && Array.isArray(result.body?.rows)) { rows = result.body!.rows.filter(isObject).map(row => row as unknown as NetRecord); loaded = true; for (const listener of [...subscribers]) listener(rows); }
    } finally { inflight = false; }
    if (subscribers.size) timer = schedule(() => { timer = null; void load(); }, pollMs);
  };
  return {
    create: () => Promise.reject(new Error('Make an account to post times')),
    getList: () => rows,
    subscribe(callback) {
      subscribers.add(callback);
      if (loaded) schedule(() => { if (subscribers.has(callback)) callback(rows); }, 0);
      if (!timer && !inflight) void load();
      return () => { subscribers.delete(callback); if (!subscribers.size && timer) { cancel(timer); timer = null; } };
    },
    async fetchRow(id) {
      const result = await api.get<Json>(`/api/v1/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
      return result.ok && isObject(result.body?.row) ? result.body!.row as unknown as NetRecord : null;
    },
  };
}
