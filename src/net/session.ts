import type { CarId, Quat, RunResult, Vec3 } from '../../contracts/runtime-contracts';
import {
  COUNTDOWN_MS, fairGridSlot, gridSlotOf, hostOf, hostStep, membersOf, newLobby, optionsPatch, parseLobbies, pickLobby, rebasePatch, staleLobbies, standings,
  type LobbyRecord, type RaceMode, type Standing,
} from './lobby';
import { isImprovement, LEADERBOARD_COLLECTION, topEntries, type LeaderboardEntry } from './leaderboard';
import { carFromIndex, carIndex, emptyCarState, packCarState, unpackCarState, type NetCarState } from './quantize';
import { MAX_NAME, MAX_PAINT, MAX_PRESENCE_ENTRIES, MAX_REMOTE_CARS, MAX_TOAST, boundedEntries, isPeerId, ownEntry, safeAvatarUrl, sanitizeText } from './sanitize';
import type { NetCollection, NetRecord, NetTransport, PresenceMap } from './transport';
import { STARTER_CAR } from '../vehicle/starter-car';
import { VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';

export const SEND_INTERVAL_MS = 80; // 12.5 Hz
const LOBBY_TICK_MS = 250;
const MAX_STEER_RAD = 0.6;
const CLOCK_SAMPLES = 5;
const HORN_COOLDOWN_MS = 700;
const TOAST_MS = 4000;
/** Without any socket traffic for this long while others are online, report the connection as lost. */
const SILENCE_MS = 6000;
/** A gap this long between lobby ticks means the page itself stalled (shader compile, hidden tab), not the socket. */
const STALL_MS = 1500;
/** A peer sending state faster than this is dropped (the real rate is 12.5 Hz). */
const MIN_STATE_INTERVAL_MS = 8;
/** Clock offsets beyond this are a lying host or a broken clock, not network delay. */
const MAX_CLOCK_OFFSET_MS = 10 * 60_000;
const MAX_TRACKED_PEERS = 128;

/** Median of a small sample list (clock offsets). */
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Steer yaw of a front wheel relative to the body, in the same convention the
 * local car presentation uses (wheel = body * yaw(steer) * roll(spin)).
 */
export function wheelSteerYaw(body: Quat, wheel: Quat): number {
  const ax = -body.x, ay = -body.y, az = -body.z, aw = body.w;
  const w = aw * wheel.w - ax * wheel.x - ay * wheel.y - az * wheel.z;
  const x = aw * wheel.x + wheel.w * ax + ay * wheel.z - az * wheel.y;
  const y = aw * wheel.y + wheel.w * ay + az * wheel.x - ax * wheel.z;
  const z = aw * wheel.z + wheel.w * az + ax * wheel.y - ay * wheel.x;
  const yaw = Math.abs(w) >= Math.abs(x) ? 2 * Math.atan(y / (w || 1e-9)) : 2 * Math.atan(-z / (x || 1e-9));
  return Number.isFinite(yaw) ? yaw : 0;
}

/** The slice of RuntimeView the net layer reads each frame. */
export interface NetLocalView {
  readonly carId: CarId;
  readonly frame: { readonly current: { readonly position: Vec3; readonly rotation: Quat; readonly linearVelocityMS: Vec3; readonly gear: number; readonly wheels?: readonly { readonly rotation: Quat }[] }; readonly score: { readonly banked: number } };
  readonly input: { readonly steering: number; readonly brake: number; readonly handbrake: number };
  readonly run: { readonly runId: string; readonly checkpointIndex: number; readonly routeProgressM: number } | null;
  readonly result: RunResult | null;
}
export interface NetGamePort {
  /** Puts the local car on grid slot `slot` (0 = pole) and starts the run's 3 s countdown. */
  beginRace(mode: RaceMode, route: string, slot: number): Promise<void>;
  /** The route picked in the garage: quick races open or join a lobby on it, and the board shows it. */
  selectedRoute?(): string;
  paint(): string;
  /** Plays a horn: null for this player's own car, otherwise the remote client id. */
  horn?(fromId: string | null): void;
  /**
   * Decides what another player's car and paint string (loadout) this client may draw. Returns the stock look until
   * the player's tips and wallet have been verified (src/economy/remote-verify.ts). Absent = whitelist only.
   */
  verifyLook?(username: string, car: CarId, paint: string): { car: CarId; paint: string };
  /** Fires when verification results changed, so remote cars are re-evaluated. */
  onLooksChanged?(listener: () => void): () => void;
  /** May the local player use this car? A locked car is announced as the starter car instead. */
  carAllowed?(car: CarId): boolean;
}
/** Visual port for remote cars; RemoteCars in the browser, a stub in tests. */
export interface RemoteCarSink {
  upsert(id: string, carId: CarId, paint: string, name: string): void;
  push(id: string, state: ReturnType<typeof emptyCarState>, nowMs: number): void;
  remove(id: string): void;
  ids(): Iterable<string>;
  update(nowMs: number, dtSeconds: number): void;
  dispose(): void;
}

export interface NetPlayer { readonly id: string; readonly name: string; readonly avatarUrl: string; readonly online: boolean; readonly self: boolean }
export interface NetMember { readonly id: string; readonly name: string; readonly ready: boolean; readonly host: boolean; readonly self: boolean; readonly car: CarId; readonly avatarUrl: string; readonly pingMs: number | null }
export interface NamedStanding extends Standing { readonly name: string; readonly self: boolean }
export interface OnlineView {
  readonly available: boolean;
  readonly active: boolean;
  readonly selfId: string;
  readonly selfName: string;
  readonly players: readonly NetPlayer[];
  readonly lobbyId: string | null;
  readonly lobby: LobbyRecord | null;
  readonly members: readonly NetMember[];
  readonly ready: boolean;
  /** Ms until the green light, or null when no start is scheduled. */
  readonly startInMs: number | null;
  /** Race number this client is racing or just raced, or 0. */
  readonly race: number;
  readonly raceMode: RaceMode;
  readonly racing: boolean;
  readonly finished: boolean;
  readonly standings: readonly NamedStanding[];
  readonly leaderboard: Readonly<Record<RaceMode, readonly LeaderboardEntry[]>>;
  readonly notice: string | null;
  /** Short-lived messages: connection lost or back, host changes, drivers leaving. */
  readonly toasts: readonly NetToast[];
  /** Estimated host clock minus local clock, ms (0 for the host itself). */
  readonly clockOffsetMs: number;
  /** This client hosts its lobby (picks mode and route). */
  readonly isHost: boolean;
  /** Round trip to the lobby host (or to another member, for the host), ms. */
  readonly pingMs: number | null;
  /** Quick match is joining and will ready up as soon as the lobby syncs. */
  readonly joining: boolean;
}
export interface NetToast { readonly id: number; readonly text: string; readonly until: number }

/** The local car as a network state (allocation free). */
export function fillCarState(view: NetLocalView, nowMs: number, s: NetCarState): NetCarState {
  const c = view.frame.current;
  s.t = nowMs;
  s.px = c.position.x; s.py = c.position.y; s.pz = c.position.z;
  s.qx = c.rotation.x; s.qy = c.rotation.y; s.qz = c.rotation.z; s.qw = c.rotation.w;
  s.vx = c.linearVelocityMS.x; s.vy = c.linearVelocityMS.y; s.vz = c.linearVelocityMS.z;
  const wheel = c.wheels?.[0];
  s.steer = wheel ? wheelSteerYaw(c.rotation, wheel.rotation) : -view.input.steering * MAX_STEER_RAD;
  s.reverse = c.gear < 0;
  s.brake = !s.reverse && view.input.brake > 0.05;
  s.handbrake = view.input.handbrake > 0.05;
  return s;
}

export class NetSession {
  private active = false;
  private lobbyId: string | null = null;
  private joinedWall = 0;
  private readyFor = -1;
  private race = 0;
  private raceMode: RaceMode = 'time-trial';
  private raceRunId: string | null = null;
  private raceStarting = false;
  private finishValue = 0;
  private lastSend = -Infinity;
  private lastLobbyTick = -Infinity;
  private lastFrameMs = 0;
  private lastView: NetLocalView | null = null;
  private lastProgress = '';
  private submittedRunIds = new Set<string>();
  private notice: string | null = null;
  private records: readonly NetRecord[] = [];
  private readonly packed: number[] = [];
  private readonly sendState = emptyCarState();
  private readonly recvState = emptyCarState();
  private readonly message: Record<string, unknown> = { type: 's', f: '', d: this.packed };
  private readonly listeners = new Set<(view: OnlineView) => void>();
  private readonly detach: (() => void)[] = [];
  private readonly board: NetCollection | null;
  private cachedView: OnlineView | null = null;
  private disposed = false;
  private pendingStart: LobbyRecord | null = null;
  // Clock sync against the lobby host (ping/pong over room.send, median of samples).
  private clockHost: string | null = null;
  private clockSamples: number[] = [];
  private clockOffset = 0;
  private lastPing = -Infinity;
  private pingSeq = 0;
  private readonly pings = new Map<number, number>();
  // Round trip for the ping column: to the host, or for the host to one other member.
  private rttPeer: string | null = null;
  private rtt: number | null = null;
  private lastRttPing = -Infinity;
  private publishedRtt = -1;
  private lastRttPublish = -Infinity;
  // Quick match: ready up once the lobby record has synced.
  private pendingReady = false;
  // Grid slot of the current race: back-row starts are not leaderboard times.
  private raceSlot = 0;
  // Last host seen with clock samples, to rebase a countdown when hosting passes to this client.
  private prevClockHost: string | null = null;
  private prevClockOffset = 0;
  private prevClockSamples = 0;
  // Horn, toasts and connection watch.
  private lastHorn = -Infinity;
  private readonly peerHorn = new Map<string, number>();
  private toasts: NetToast[] = [];
  private toastSeq = 0;
  private connected = true;
  private lastTraffic = 0;
  private lastSelfEcho = 0;
  private lastWatch = 0;
  private lastHost: string | null = null;
  private lastMembers: string[] = [];
  private readonly names = new Map<string, string>();
  private readonly lastState = new Map<string, number>();

  constructor(
    readonly transport: NetTransport,
    private readonly game: NetGamePort,
    private readonly remote: RemoteCarSink,
    private readonly clock: { now(): number; wall(): number } = { now: () => performance.now(), wall: () => Date.now() },
  ) {
    this.board = transport.available ? transport.collection(LEADERBOARD_COLLECTION) : null;
    if (!transport.available) return;
    this.detach.push(transport.onMessage(data => this.onMessage(data)));
    this.detach.push(transport.onPresence(presence => { this.syncRemotes(presence); this.changed(); }));
    this.detach.push(transport.onRoomState(() => this.changed()));
    const offLooks = game.onLooksChanged?.(() => { if (this.active) { this.syncRemotes(this.transport.presence()); this.changed(); } });
    if (offLooks) this.detach.push(offLooks);
    if (this.board) {
      this.records = this.board.getList();
      this.detach.push(this.board.subscribe(records => { this.records = records; this.changed(); }));
    }
  }

  get available(): boolean { return this.transport.available; }

  subscribe(listener: (view: OnlineView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shows this player in the shared harbor and shows the others to them. */
  goOnline(car: CarId): void {
    if (!this.available || this.active) return;
    this.active = true;
    this.transport.updatePresence({ on: 1, car: carIndex(this.localCar(car)), pt: sanitizeText(this.game.paint(), MAX_PAINT), lb: '', rd: -1, rp: null });
    this.syncRemotes(this.transport.presence());
    this.changed();
  }

  goOffline(): void {
    if (!this.active) return;
    this.leaveLobby();
    this.active = false;
    this.transport.updatePresence({ on: 0, lb: '', rd: -1, rp: null });
    for (const id of [...this.remote.ids()]) this.remote.remove(id);
    this.changed();
  }

  quickRace(mode: RaceMode, route = this.game.selectedRoute?.() ?? 'HW-01'): string | null {
    if (!this.active) return null;
    const wall = this.clock.wall();
    const presence = this.transport.presence();
    const lobbies = parseLobbies(this.transport.roomState());
    let id = pickLobby(lobbies, presence, mode, wall, route);
    if (!id) {
      id = `${this.transport.selfId.slice(0, 8)}-${wall.toString(36)}`;
      this.transport.updateRoomState({ lobbies: { [id]: newLobby(mode, route, wall) } });
    }
    this.joinLobby(id);
    return id;
  }

  /**
   * One click online: best open lobby of any mode on any route (and ready up), else a new time trial on the selected
   * route. A new lobby is not readied: a lone ready driver would start a solo race at once, before anyone can join.
   */
  quickMatch(): string | null {
    if (!this.active) return null;
    const wall = this.clock.wall();
    const id = pickLobby(parseLobbies(this.transport.roomState()), this.transport.presence(), undefined, wall);
    if (!id) return this.quickRace('time-trial');
    this.joinLobby(id);
    this.pendingReady = true; this.lobbyReadyCheck();
    return id;
  }

  /** Host only, between races: pick the next race's mode and route. Everyone's ready flag resets. */
  setLobbyOptions(mode: RaceMode, route: string): boolean {
    const lobby = this.lobby();
    if (!lobby || !this.lobbyId || !this.isHost()) return false;
    const patch = optionsPatch(lobby, mode, route);
    if (!patch) return false;
    this.transport.updateRoomState({ lobbies: { [this.lobbyId]: patch } });
    this.changed();
    return true;
  }

  joinLobby(id: string): void {
    this.lobbyId = id;
    this.joinedWall = this.clock.wall();
    this.readyFor = -1;
    this.lastHost = null;
    this.lastMembers = [];
    this.transport.updatePresence({ lb: id, rd: -1 });
    this.changed();
  }

  leaveLobby(): void {
    if (!this.lobbyId) return;
    this.lobbyId = null;
    this.pendingReady = false;
    this.readyFor = -1;
    this.race = 0;
    this.raceRunId = null;
    this.raceStarting = false;
    this.pendingStart = null;
    this.syncClock(null);
    this.transport.updatePresence({ lb: '', rd: -1, rp: null });
    this.changed();
  }

  setReady(ready: boolean): void {
    const lobby = this.lobby();
    if (!lobby) return;
    this.readyFor = ready ? lobby.race : -1;
    this.transport.updatePresence({ rd: this.readyFor });
    this.changed();
  }

  /** Clears the last race's standings card. */
  dismissResults(): void {
    if (this.racing()) return;
    this.race = 0;
    this.changed();
  }

  /** Sounds the horn for everyone nearby. Returns false while on cooldown or offline. */
  horn(): boolean {
    if (!this.active || this.disposed) return false;
    const now = this.clock.now();
    if (now - this.lastHorn < HORN_COOLDOWN_MS) return false;
    this.lastHorn = now;
    this.transport.send({ type: 'h', f: this.transport.selfId });
    this.game.horn?.(null);
    return true;
  }

  toast(text: string, ms = TOAST_MS): void {
    text = sanitizeText(text, MAX_TOAST);
    if (!text) return;
    const now = this.clock.now();
    this.toasts = this.toasts.filter(t => t.until > now && t.text !== text).concat({ id: ++this.toastSeq, text, until: now + ms }).slice(-3);
    this.changed();
  }

  /** Connection state from the socket watch or the browser's online and offline events. */
  setConnected(ok: boolean): void {
    if (ok === this.connected) return;
    this.connected = ok;
    if (!this.active) return;
    this.toast(ok ? 'Reconnected. You are back in the harbor.' : 'Connection lost. Trying to reconnect.', ok ? 3500 : 8000);
  }

  /** Lobby host's clock (local clock for the host itself). */
  hostNow(): number { return this.clock.wall() + this.clockOffset; }

  /** Call once per rendered frame. */
  tick(view: NetLocalView, nowMs = this.clock.now()): void {
    if (this.disposed || !this.available) return;
    const dt = this.lastFrameMs ? Math.min(Math.max((nowMs - this.lastFrameMs) / 1000, 0), 0.1) : 0;
    this.lastFrameMs = nowMs;
    this.lastView = view;
    const pending = this.pendingStart;
    if (pending && this.hostNow() >= pending.at - COUNTDOWN_MS) { this.pendingStart = null; if (!this.raceStarting && this.race !== pending.race) this.startRace(pending); }
    if (this.active) {
      if (nowMs - this.lastSend >= SEND_INTERVAL_MS) { this.lastSend = nowMs; this.sendCar(view, nowMs); }
      this.remote.update(nowMs, dt);
    }
    this.watchResult(view);
    if (nowMs - this.lastLobbyTick >= LOBBY_TICK_MS) { this.lastLobbyTick = nowMs; this.lobbyTick(view); }
  }

  /**
   * Timer driven fallback for when frames stop (background tab, minimised window).
   * Keeps lobby hosting, race start and presence alive at a slower rate so a
   * backgrounded host does not freeze the lobby for everyone else.
   */
  idle(nowMs = this.clock.now()): void {
    const view = this.lastView;
    if (this.disposed || !this.available || !view || nowMs - this.lastLobbyTick < LOBBY_TICK_MS * 2) return;
    this.lastLobbyTick = nowMs;
    if (this.active && nowMs - this.lastSend >= 1000) { this.lastSend = nowMs; this.sendCar(view, nowMs); }
    this.lobbyTick(view);
  }

  view(): OnlineView {
    if (this.cachedView) return this.cachedView;
    const t = this.transport, hostWall = this.hostNow();
    const peers = t.peers(), presence = t.presence(), selfId = t.selfId;
    const name = (id: string): string => this.nameOf(id, peers);
    const players: NetPlayer[] = boundedEntries(peers, MAX_PRESENCE_ENTRIES).map(([id]) => id).filter(isPeerId).map(id => ({
      id, name: name(id), avatarUrl: safeAvatarUrl(ownEntry(peers, id)?.avatarUrl), online: ownEntry(presence, id)?.on === 1, self: id === selfId,
    })).sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const lobby = this.lobby();
    const members = this.lobbyId ? membersOf(this.lobbyId, presence) : [];
    const host = hostOf(members);
    const raceLobby: LobbyRecord | null = this.race && lobby ? { ...lobby, race: this.race, mode: this.raceMode } : null;
    const live = raceLobby ? standings(raceLobby, members) : [];
    const route = lobby?.route ?? this.game.selectedRoute?.() ?? 'HW-01';
    this.cachedView = {
      available: t.available, active: this.active, selfId, selfName: name(selfId), players,
      lobbyId: this.lobbyId, lobby,
      members: members.map(m => ({
        id: m.id, name: name(m.id), ready: Boolean(lobby && m.rd === lobby.race), host: m.id === host, self: m.id === selfId,
        car: this.memberCar(m.id, presence, name(m.id)), avatarUrl: safeAvatarUrl(ownEntry(peers, m.id)?.avatarUrl), pingMs: m.id === selfId ? this.rtt : m.pg ?? null,
      })),
      ready: Boolean(lobby && this.readyFor === lobby.race),
      startInMs: lobby && (lobby.ph === 's' || lobby.ph === 'r') && lobby.at > hostWall ? lobby.at - hostWall : null,
      race: this.race, raceMode: this.raceMode, racing: this.racing(), finished: this.finishValue !== 0,
      standings: live.map(s => ({ ...s, name: name(s.id), self: s.id === selfId })),
      leaderboard: { 'time-trial': topEntries(this.records, route, 'time-trial'), 'drift-attack': topEntries(this.records, route, 'drift-attack') },
      notice: this.notice,
      toasts: this.toasts,
      clockOffsetMs: this.clockOffset,
      isHost: Boolean(this.lobbyId) && host === selfId,
      pingMs: this.rtt,
      joining: this.pendingReady,
    };
    return this.cachedView;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.active) this.transport.updatePresence({ on: 0, lb: '', rp: null });
    this.disposed = true;
    for (const off of this.detach.splice(0)) off();
    this.remote.dispose();
    this.listeners.clear();
  }

  private isHost(): boolean {
    return Boolean(this.lobbyId) && hostOf(membersOf(this.lobbyId!, this.transport.presence())) === this.transport.selfId;
  }

  /** The car a member shows: the verified look, so the list never advertises a car the race will not draw. */
  private memberCar(id: string, presence: PresenceMap, name: string): CarId {
    const entry = ownEntry(presence, id);
    if (id === this.transport.selfId) return this.localCar(this.lastView?.carId ?? carFromIndex(entry?.car));
    const car = carFromIndex(entry?.car);
    try { return this.game.verifyLook ? this.game.verifyLook(name, car, sanitizeText(typeof entry?.pt === 'string' ? entry.pt : '', MAX_PAINT)).car : car; } catch { return STARTER_CAR; }
  }

  private lobbyReadyCheck(): void {
    if (!this.pendingReady) return;
    const lobby = this.lobby();
    if (lobby && lobby.ph === 'w') { this.pendingReady = false; this.setReady(true); }
  }

  private lobby(): LobbyRecord | null {
    return this.lobbyId ? parseLobbies(this.transport.roomState())[this.lobbyId] ?? null : null;
  }

  private racing(): boolean { return this.race !== 0 && this.finishValue === 0 && this.lobby()?.race === this.race; }

  private changed(): void {
    this.cachedView = null;
    if (!this.listeners.size) return;
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }

  private sendCar(view: NetLocalView, nowMs: number): void {
    fillCarState(view, nowMs, this.sendState);
    packCarState(this.sendState, this.packed);
    this.message.f = this.transport.selfId;
    this.transport.send(this.message);
    const presence = this.transport.presence()[this.transport.selfId];
    const carIdx = carIndex(this.localCar(view.carId)), paint = sanitizeText(this.game.paint(), MAX_PAINT);
    if (presence && (presence.car !== carIdx || presence.pt !== paint)) this.transport.updatePresence({ car: carIdx, pt: paint });
  }

  /** The car this client announces: a locked car is never shown to others, the starter stands in. */
  private localCar(car: CarId): CarId {
    try { return this.game.carAllowed && !this.game.carAllowed(car) ? STARTER_CAR : car; } catch { return STARTER_CAR; }
  }

  private onMessage(data: Record<string, unknown>): void {
    // Anything a peer sends can be malformed: a decode problem must never reach the render loop or the socket handler.
    try { this.handleMessage(data); } catch (error) { console.warn('LATERAL dropped a bad network message', error); }
  }

  private handleMessage(data: Record<string, unknown>): void {
    // The sender id the socket attached beats the one inside the payload, which a peer can write freely.
    const claimed = isPeerId(data.clientId) ? data.clientId : isPeerId(data.f) ? data.f : '';
    const from = claimed;
    if (!from) return;
    const self = this.transport.selfId, now = this.clock.now();
    if (from === self) { this.lastSelfEcho = now; this.heard(now); return; }
    this.heard(now);
    if (data.to !== undefined) { if (data.to === self) this.onClockMessage(from, data); return; }
    if (!this.active || ownEntry(this.transport.presence(), from)?.on !== 1) return;
    if (data.type === 'h') {
      if (now - (this.peerHorn.get(from) ?? -Infinity) < HORN_COOLDOWN_MS * 0.8) return;
      this.trim(this.peerHorn);
      this.peerHorn.set(from, now);
      this.game.horn?.(from);
      return;
    }
    if (data.type !== 's') return;
    if (now - (this.lastState.get(from) ?? -Infinity) < MIN_STATE_INTERVAL_MS) return;
    this.trim(this.lastState);
    this.lastState.set(from, now);
    if (!unpackCarState(data.d, this.recvState)) return;
    this.remote.push(from, this.recvState, this.clock.now());
  }

  /** Keeps a per-peer map bounded: a peer id flood can not grow it forever. */
  private trim(map: Map<string, number>): void {
    if (map.size < MAX_TRACKED_PEERS) return;
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }

  private heard(now: number): void {
    this.lastTraffic = now;
    if (!this.connected) this.setConnected(true);
  }

  private onClockMessage(from: string, data: Record<string, unknown>): void {
    const n = typeof data.n === 'number' && Number.isFinite(data.n) ? data.n : NaN;
    if (data.type === 'p') {
      if (!Number.isFinite(n)) return;
      // Anyone may ask; only the lobby host's answer is used by the asker.
      this.transport.send({ type: 'q', f: this.transport.selfId, to: from, n, th: this.clock.wall() });
      return;
    }
    if (data.type !== 'q' || (from !== this.clockHost && from !== this.rttPeer) || typeof data.th !== 'number' || !Number.isFinite(data.th)) return;
    const sent = this.pings.get(n);
    if (sent === undefined) return;
    this.pings.delete(n);
    const received = this.clock.wall(), rtt = received - sent;
    if (rtt < 0 || rtt > 3000) return;
    this.rtt = this.rtt === null ? Math.round(rtt) : Math.round(this.rtt * 0.7 + rtt * 0.3);
    if (from !== this.clockHost) { this.changed(); return; }
    const sample = data.th + rtt / 2 - received;
    if (!Number.isFinite(sample) || Math.abs(sample) > MAX_CLOCK_OFFSET_MS) return;
    this.clockSamples.push(sample);
    if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
    this.clockOffset = Math.round(median(this.clockSamples));
    this.changed();
  }

  /** Pings the lobby host until there are enough samples, then refreshes slowly. */
  private syncClock(host: string | null): void {
    const self = this.transport.selfId;
    if (host !== this.clockHost) {
      // Keep the old estimate until the new host answers: a scheduled start stays on a sensible clock meanwhile.
      if (this.clockHost && this.clockSamples.length) { this.prevClockHost = this.clockHost; this.prevClockOffset = this.clockOffset; this.prevClockSamples = this.clockSamples.length; }
      this.clockHost = host; this.clockSamples = []; this.pings.clear(); this.lastPing = -Infinity;
      if (!host || host === self) this.clockOffset = 0;
    }
    if (!host || host === self) return;
    const now = this.clock.now();
    if (now - this.lastPing < (this.clockSamples.length < CLOCK_SAMPLES ? 300 : 4000)) return;
    this.lastPing = now;
    const n = ++this.pingSeq;
    this.pings.set(n, this.clock.wall());
    if (this.pings.size > CLOCK_SAMPLES * 2) this.pings.delete(this.pings.keys().next().value!);
    this.transport.send({ type: 'p', f: self, to: host, n });
  }

  /** Ping for the player list: the host has no host to ping, so it measures against another member. */
  private measureRtt(host: string | null, memberIds: readonly string[]): void {
    const self = this.transport.selfId;
    this.rttPeer = host === self ? memberIds.find(id => id !== self) ?? null : host;
    if (!this.rttPeer) { this.rtt = null; return; }
    const now = this.clock.now();
    if (this.rttPeer !== this.clockHost && now - this.lastRttPing >= 4000) {
      this.lastRttPing = now;
      const n = ++this.pingSeq;
      this.pings.set(n, this.clock.wall());
      if (this.pings.size > CLOCK_SAMPLES * 2) this.pings.delete(this.pings.keys().next().value!);
      this.transport.send({ type: 'p', f: self, to: this.rttPeer, n });
    }
    if (this.rtt !== null && (Math.abs(this.rtt - this.publishedRtt) >= 20 || now - this.lastRttPublish > 10000) && now - this.lastRttPublish > 2000) {
      this.publishedRtt = this.rtt; this.lastRttPublish = now;
      this.transport.updatePresence({ pg: this.rtt });
    }
  }

  /** Hosting passed to this client mid-countdown: move the start into this client's clock (once). */
  private rebaseIfNewHost(lobby: LobbyRecord, host: string | null): void {
    const self = this.transport.selfId;
    if (host !== self || !this.prevClockHost || this.prevClockHost === self || !this.lobbyId) return;
    const offset = this.prevClockSamples ? this.prevClockOffset : 0;
    this.prevClockHost = null; this.prevClockSamples = 0;
    const patch = rebasePatch(lobby, offset);
    if (patch) this.transport.updateRoomState({ lobbies: { [this.lobbyId]: patch } });
  }

  private nameOf(id: string, peers = this.transport.peers()): string {
    const known = sanitizeText(ownEntry(peers, id)?.username, MAX_NAME);
    if (known) {
      if (this.names.size >= MAX_TRACKED_PEERS && !this.names.has(id)) this.names.delete(this.names.keys().next().value!);
      this.names.set(id, known);
      return known;
    }
    return this.names.get(id) ?? `Driver ${sanitizeText(id, 4)}`;
  }

  /** Host changes and drivers leaving, as toasts. */
  private watchMembers(members: readonly { readonly id: string }[], host: string | null): void {
    const self = this.transport.selfId, ids = members.map(m => m.id);
    if (this.lastMembers.length) {
      const hostLeft = this.lastHost !== null && this.lastHost !== host && !ids.includes(this.lastHost);
      if (hostLeft && host) this.toast(`${this.nameOf(this.lastHost!)} left. ${host === self ? 'You are' : `${this.nameOf(host)} is`} now the host.`);
      for (const id of this.lastMembers) if (id !== this.lastHost && id !== self && !ids.includes(id)) this.toast(`${this.nameOf(id)} left the lobby.`);
      for (const id of ids) if (id !== self && !this.lastMembers.includes(id)) this.toast(`${this.nameOf(id)} joined the lobby.`, 2500);
    }
    this.lastMembers = ids; this.lastHost = host;
  }

  /** No socket traffic at all for a while, although others are online and sending: report it. */
  private watchConnection(presence: PresenceMap): void {
    const now = this.clock.now(), self = this.transport.selfId;
    const stalled = this.lastWatch > 0 && now - this.lastWatch > STALL_MS;
    this.lastWatch = now;
    if (!this.active || !this.connected) return;
    // After a stall the messages that arrived meanwhile are still queued: the silence says nothing about the socket yet.
    if (stalled) { if (this.lastSelfEcho) this.lastSelfEcho = now; if (this.lastTraffic) this.lastTraffic = now; return; }
    // When this client hears its own broadcasts, silence is a reliable signal on its own.
    if (this.lastSelfEcho) { if (now - this.lastSelfEcho > SILENCE_MS && now - this.lastSend < 1500) this.setConnected(false); return; }
    const others = boundedEntries<Record<string, unknown>>(presence, MAX_PRESENCE_ENTRIES).some(([id, p]) => id !== self && p?.on === 1);
    if (others && this.lastTraffic && now - this.lastTraffic > SILENCE_MS * 2) this.setConnected(false);
  }

  private syncRemotes(presence: PresenceMap): void {
    if (!this.active) return;
    const peers = this.transport.peers(), self = this.transport.selfId;
    const keep = new Set<string>();
    // At most MAX_REMOTE_CARS cars are ever loaded, in a stable order, so a flood of fake presences can not freeze this client.
    const ids = boundedEntries<Record<string, unknown>>(presence, MAX_PRESENCE_ENTRIES)
      .filter(([id, p]) => isPeerId(id) && id !== self && p && typeof p === 'object' && p.on === 1)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, MAX_REMOTE_CARS);
    for (const [id, p] of ids) {
      keep.add(id);
      try {
        const name = this.nameOf(id, peers);
        const car = carFromIndex(p.car), paint = sanitizeText(typeof p.pt === 'string' ? p.pt : '', MAX_PAINT);
        const look = this.game.verifyLook ? this.game.verifyLook(name, car, paint) : { car, paint };
        this.remote.upsert(id, look.car, look.paint, name);
      } catch (error) { console.warn('LATERAL could not show a remote car', error); }
    }
    for (const id of [...this.remote.ids()]) if (!keep.has(id)) this.remote.remove(id);
  }

  private lobbyTick(view: NetLocalView): void {
    const wall = this.clock.wall();
    const presence = this.transport.presence();
    const lobbies = parseLobbies(this.transport.roomState());
    const nowMs = this.clock.now();
    if (this.toasts.some(t => t.until <= nowMs)) { this.toasts = this.toasts.filter(t => t.until > nowMs); this.changed(); }
    this.watchConnection(presence);
    if (this.active) {
      // The lowest online client sweeps empty lobbies so roomState does not grow forever.
      const online = boundedEntries<Record<string, unknown>>(presence, MAX_PRESENCE_ENTRIES).filter(([, p]) => p?.on === 1).map(([id]) => id).sort();
      if (online[0] === this.transport.selfId) {
        const stale = staleLobbies(lobbies, presence, wall);
        if (stale.length) this.transport.updateRoomState({ lobbies: Object.fromEntries(stale.map(id => [id, null])) });
      }
    }
    if (!this.lobbyId) return;
    const lobby = lobbies[this.lobbyId];
    if (!lobby) {
      // The lobby record vanished (swept or never synced): fall back to the menu.
      if (wall - this.joinedWall > 5000) { this.notice = 'The race lobby closed.'; this.leaveLobby(); }
      return;
    }
    const members = membersOf(this.lobbyId, presence);
    const host = hostOf(members);
    this.watchMembers(members, host);
    this.syncClock(host);
    this.measureRtt(host, members.map(m => m.id));
    this.rebaseIfNewHost(lobby, host);
    this.lobbyReadyCheck();
    if (host === this.transport.selfId) {
      const patch = hostStep(lobby, members, wall);
      if (patch) this.transport.updateRoomState({ lobbies: { [this.lobbyId]: patch } });
    }
    // Join the scheduled race once the grid countdown is due, on the host's clock.
    // Inside the last second the frame tick takes over for a precise start.
    const hostWall = this.hostNow();
    if ((lobby.ph === 's' || lobby.ph === 'r') && this.race !== lobby.race && !this.raceStarting && hostWall < lobby.at + 1500) {
      if (hostWall >= lobby.at - COUNTDOWN_MS) { this.pendingStart = null; this.startRace(lobby); }
      else if (lobby.at - COUNTDOWN_MS - hostWall < 1000) this.pendingStart = lobby;
    }
    if (this.race && this.race === lobby.race && !this.raceStarting) this.publishProgress(view);
    if (lobby.ph === 'w' && this.readyFor !== -1 && this.readyFor !== lobby.race) this.readyFor = -1;
    this.changed();
  }

  private startRace(lobby: LobbyRecord): void {
    this.raceStarting = true;
    this.race = lobby.race;
    this.raceMode = lobby.mode;
    this.raceRunId = null;
    this.finishValue = 0;
    this.lastProgress = '';
    this.notice = null;
    this.transport.updatePresence({ rp: [lobby.race, 0, 0, 0, 0], rd: -1 });
    this.readyFor = -1;
    const slot = gridSlotOf(lobby, this.transport.selfId, membersOf(this.lobbyId ?? '', this.transport.presence()));
    this.raceSlot = slot;
    this.game.beginRace(lobby.mode, lobby.route, slot)
      .catch(error => { this.notice = sanitizeText(error instanceof Error ? error.message : '', MAX_TOAST, 'Could not start the race'); this.finishValue = -1; this.transport.updatePresence({ rp: [lobby.race, 0, 0, -1, 0] }); })
      .finally(() => { this.raceStarting = false; this.changed(); });
  }

  private publishProgress(view: NetLocalView): void {
    if (this.finishValue !== 0) return;
    const run = view.run;
    if (run && this.raceRunId === null) this.raceRunId = run.runId;
    // Left the race run (free drive, a different event): count it as not finished.
    if (this.raceRunId !== null && (!run || run.runId !== this.raceRunId) && !view.result) {
      this.finishValue = -1;
      this.transport.updatePresence({ rp: [this.race, 0, 0, -1, 0] });
      return;
    }
    if (!run) return;
    const progress: [number, number, number, number, number] = [this.race, run.checkpointIndex, Math.round(run.routeProgressM), 0, Math.round(view.frame.score.banked)];
    const key = progress.join(',');
    if (key !== this.lastProgress) { this.lastProgress = key; this.transport.updatePresence({ rp: progress }); }
  }

  private watchResult(view: NetLocalView): void {
    const result = view.result;
    if (!result || this.submittedRunIds.has(result.runId)) return;
    this.submittedRunIds.add(result.runId);
    if (this.race && this.finishValue === 0 && (this.raceRunId === null || this.raceRunId === result.runId)) {
      const ms = Math.max(1, Math.round(result.elapsedActiveSeconds * 1000));
      this.finishValue = result.valid ? ms : -1;
      const assistCode = result.assist === 'off' ? 0 : result.assist === 'medium' ? 1 : result.assist === 'high' ? 2 : null;
      this.transport.updatePresence({ rp: assistCode === null
        ? [this.race, 99, 0, this.finishValue, Math.round(result.bankedScore)]
        : [this.race, 99, 0, this.finishValue, Math.round(result.bankedScore), assistCode] });
      this.changed();
      // A back-row start covers extra metres before the line: race result yes, leaderboard time no.
      if (!fairGridSlot(this.raceSlot)) return;
    }
    this.submitBest(result);
  }

  private submitBest(result: RunResult): void {
    if (!this.board || !result.valid) return;
    if (result.mode !== 'time-trial' && result.mode !== 'drift-attack') return;
    const value = result.mode === 'time-trial' ? Math.round(result.elapsedActiveSeconds * 1000) : Math.round(result.bankedScore);
    if (value <= 0) return;
    const username = this.transport.peers()[this.transport.selfId]?.username ?? '';
    if (username && !isImprovement(this.records, username, result.routeId, result.mode, value)) return;
    this.board.create({ route: result.routeId, mode: result.mode, value, car: result.carId, pv: result.physicsVersion ?? VEHICLE_PHYSICS_VERSION, ...(result.assist ? { assist: result.assist } : {}) })
      .catch(error => console.warn('Leaderboard submit failed', error));
  }
}
