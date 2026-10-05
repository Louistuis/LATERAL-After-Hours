/**
 * Race lobby rules, kept pure so they can be tested with a fake socket.
 *
 * Shared lobby fields live in roomState.lobbies[id] and are written only by the
 * lobby host. Membership, ready flags and race progress live in each client's
 * own presence, so no two clients ever write the same key. The host is the
 * lowest client id among the members, which makes migration automatic: when the
 * host leaves, the next lowest member starts writing.
 */
import { MAX_PRESENCE_ENTRIES, boundedEntries, clampInt, clampNumber, isPeerId } from './sanitize';

export type RaceMode = 'time-trial' | 'drift-attack';
export type LobbyPhase = 'w' | 's' | 'r';
export interface LobbyRecord {
  /** w = waiting, s = starting (countdown scheduled), r = racing. */
  readonly ph: LobbyPhase;
  /** Race number; a ready flag only counts for the current race. */
  readonly race: number;
  readonly mode: RaceMode;
  readonly route: string;
  /** Wall-clock ms of the green light (host clock). */
  readonly at: number;
  /** Creation time. */
  readonly t: number;
  /** Ready timer start, 0 when not running. */
  readonly rt: number;
  /** First finish time, 0 when nobody has finished. */
  readonly ff: number;
  /** Starting grid for the scheduled race: member ids in slot order, comma separated. */
  readonly g: string;
}
/** [race, checkpointIndex, progressM, finish (ms, 0 running, -1 not valid), score] */
/** [race, checkpoint, progressM, finishMs (0 racing, -1 invalid), score, assist code (optional, finish only)]. */
export type RaceProgress = readonly [number, number, number, number, number, number?];
export interface MemberState {
  readonly id: string;
  readonly lb?: string;
  readonly rd?: number;
  readonly rp?: RaceProgress;
  /** Round trip to the lobby host (or, for the host, to another member), ms. Display only. */
  readonly pg?: number;
}

export const MAX_LOBBY_PLAYERS = 8;
export const START_DELAY_MS = 6000;
export const COUNTDOWN_MS = 3000;
export const READY_TIMER_MS = 20000;
export const FINISH_GRACE_MS = 60000;
export const RACE_LIMIT_MS = 8 * 60000;
export const STALE_LOBBY_MS = 30000;

export function newLobby(mode: RaceMode, route: string, now: number): LobbyRecord {
  return { ph: 'w', race: 1, mode, route, at: 0, t: now, rt: 0, ff: 0, g: '' };
}

export const MAX_LOBBIES = 32;
const ROUTE_ID = /^[A-Z]{2}-\d{2}$/;
const BIG = 1e15;

export function parseLobbies(roomState: Readonly<Record<string, unknown>>): Record<string, LobbyRecord> {
  const out: Record<string, LobbyRecord> = {};
  for (const [id, value] of boundedEntries<unknown>(roomState?.lobbies, MAX_LOBBIES)) {
    if (!isPeerId(id) || id.length > 80 || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if ((v.ph !== 'w' && v.ph !== 's' && v.ph !== 'r') || typeof v.race !== 'number' || !Number.isFinite(v.race)) continue;
    out[id] = {
      ph: v.ph, race: clampInt(v.race, 0, 1e6), mode: v.mode === 'drift-attack' ? 'drift-attack' : 'time-trial',
      route: typeof v.route === 'string' && ROUTE_ID.test(v.route) ? v.route : 'HW-01',
      at: num(v.at), t: num(v.t), rt: num(v.rt), ff: num(v.ff), g: gridString(v.g),
    };
  }
  return out;
}

/** Grid order: at most MAX_LOBBY_PLAYERS plain ids, comma separated. */
function gridString(value: unknown): string {
  if (typeof value !== 'string' || value.length > 800) return '';
  return value.split(',').slice(0, MAX_LOBBY_PLAYERS).filter(isPeerId).join(',');
}

/** [race, checkpointIndex, progressM, finish (ms, 0 running, -1 not valid), score] with every number finite and bounded. */
function parseProgress(raw: unknown): RaceProgress | undefined {
  if (!Array.isArray(raw) || raw.length < 5 || raw.length > 16) return undefined;
  for (let i = 0; i < 5; i++) if (typeof raw[i] !== 'number' || !Number.isFinite(raw[i])) return undefined;
  const base = [
    clampInt(raw[0], -1, 1e6), clampInt(raw[1], 0, 1000), clampInt(raw[2], -1e6, 1e6),
    clampInt(raw[3], -1, RACE_LIMIT_MS * 4), clampInt(raw[4], 0, 1e9),
  ] as const;
  // Optional assist code from the finish update: 0 off, 1 medium, 2 high. Anything else is dropped.
  return raw[5] === 0 || raw[5] === 1 || raw[5] === 2 ? [...base, raw[5]] : base;
}

export function parseMember(id: string, presence: Readonly<Record<string, unknown>> | undefined): MemberState {
  const p = presence ?? {};
  return {
    id,
    lb: typeof p.lb === 'string' && p.lb.length <= 80 ? p.lb : undefined,
    rd: typeof p.rd === 'number' && Number.isFinite(p.rd) ? clampInt(p.rd, -1, 1e6) : undefined,
    rp: parseProgress(p.rp),
    pg: typeof p.pg === 'number' && Number.isFinite(p.pg) ? clampInt(p.pg, 0, 9999) : undefined,
  };
}

export function membersOf(lobbyId: string, presence: Readonly<Record<string, Readonly<Record<string, unknown>>>>): MemberState[] {
  const members: MemberState[] = [];
  for (const [id, entry] of boundedEntries<Readonly<Record<string, unknown>>>(presence, MAX_PRESENCE_ENTRIES)) {
    if (isPeerId(id) && entry && typeof entry === 'object' && entry.lb === lobbyId) members.push(parseMember(id, entry));
  }
  return members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function hostOf(members: readonly MemberState[]): string | null {
  let best: string | null = null;
  for (const m of members) if (best === null || m.id < best) best = m.id;
  return best;
}

export function isParticipant(member: MemberState, lobby: LobbyRecord): boolean {
  return member.rp?.[0] === lobby.race;
}

/** The host's patch for this tick, or null when nothing changes. */
export function hostStep(lobby: LobbyRecord, members: readonly MemberState[], now: number): Partial<LobbyRecord> | null {
  const n = members.length;
  if (!n) return null;
  if (lobby.ph === 'w') {
    const ready = members.filter(m => m.rd === lobby.race).length;
    if (ready === n) return { ph: 's', at: now + START_DELAY_MS, rt: 0, ff: 0, g: gridOrder(members, lobby.race) };
    if (ready > 0 && n >= 2) {
      if (!lobby.rt) return { rt: now };
      if (now - lobby.rt >= READY_TIMER_MS) return { ph: 's', at: now + START_DELAY_MS, rt: 0, ff: 0, g: gridOrder(members, lobby.race) };
      return null;
    }
    return lobby.rt ? { rt: 0 } : null;
  }
  if (lobby.ph === 's') return now >= lobby.at ? { ph: 'r' } : null;
  const racers = members.filter(m => isParticipant(m, lobby));
  const done = racers.filter(m => m.rp![3] !== 0).length;
  // Only a real finish starts the grace period: a driver who quits or goes invalid must not cut everyone else short.
  const finished = racers.filter(m => m.rp![3] > 0).length;
  const end: Partial<LobbyRecord> = { ph: 'w', race: lobby.race + 1, at: 0, rt: 0, ff: 0 };
  if (now - lobby.at > RACE_LIMIT_MS) return end;
  if (!racers.length) return now - lobby.at > 15000 ? end : null;
  if (done === racers.length) return end;
  if (finished && !lobby.ff) return { ff: now };
  if (lobby.ff && now - lobby.ff > FINISH_GRACE_MS) return end;
  return null;
}

/** Grid order written by the host at the start: ready drivers first, each group in lobby (id) order. */
export function gridOrder(members: readonly MemberState[], race: number): string {
  const ready = members.filter(m => m.rd === race), rest = members.filter(m => m.rd !== race);
  return ready.concat(rest).slice(0, MAX_LOBBY_PLAYERS).map(m => m.id).join(',');
}

/** This driver's grid slot (0 = pole). Drivers missing from the grid take the slots after it. */
export function gridSlotOf(lobby: LobbyRecord, id: string, members: readonly MemberState[]): number {
  const grid = lobby.g ? lobby.g.split(',') : [];
  const slot = grid.indexOf(id);
  if (slot >= 0) return slot;
  const late = members.filter(m => !grid.includes(m.id)).findIndex(m => m.id === id);
  return Math.min(MAX_LOBBY_PLAYERS - 1, grid.length + Math.max(0, late));
}

/**
 * Staggered two-row grid behind the start line, as metres to the right of and
 * behind the route spawn. HW-01's finish gate sits 8.3 m behind the spawn, so
 * the back row stops at 7.2 m: no car starts on the wrong side of a gate.
 */
const GRID_LANES = [-1.7, 1.7, -5, 5] as const;
export function gridOffset(slot: number): { readonly rightM: number; readonly backM: number } {
  const s = Math.max(0, Math.min(MAX_LOBBY_PLAYERS - 1, Math.floor(slot) || 0));
  const row = s >> 2, lane = s & 3;
  return { rightM: GRID_LANES[lane]!, backM: row * 5.4 + lane * 0.6 };
}

/** Quick race: best open lobby for this mode, or null to create one. */
export function pickLobby(
  lobbies: Readonly<Record<string, LobbyRecord>>,
  presence: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  mode: RaceMode | undefined, now: number, route?: string,
): string | null {
  let best: string | null = null, bestScore = -1;
  for (const [id, lobby] of Object.entries(lobbies)) {
    if ((mode !== undefined && lobby.mode !== mode) || (route !== undefined && lobby.route !== route)) continue;
    const count = membersOf(id, presence).length;
    if (count < 1 || count >= MAX_LOBBY_PLAYERS) continue;
    // Waiting lobbies first, then ones still before their countdown, then running races (wait for the next one).
    const phaseScore = lobby.ph === 'w' ? 300 : lobby.ph === 's' && now < lobby.at - COUNTDOWN_MS - 500 ? 200 : 100;
    const score = phaseScore + count;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

export function staleLobbies(
  lobbies: Readonly<Record<string, LobbyRecord>>,
  presence: Readonly<Record<string, Readonly<Record<string, unknown>>>>, now: number,
): string[] {
  return Object.keys(lobbies).filter(id => now - lobbies[id]!.t > STALE_LOBBY_MS && membersOf(id, presence).length === 0);
}

export interface Standing { readonly id: string; readonly position: number; readonly finished: boolean; readonly invalid: boolean; readonly timeMs: number; readonly score: number; readonly checkpoint: number; readonly progressM: number; readonly assist?: 'off' | 'medium' | 'high' }

/** Live order: finished by time (or score in drift mode), then by distance; invalid runs last. */
export function standings(lobby: LobbyRecord, members: readonly MemberState[]): Standing[] {
  const racers = members.filter(m => isParticipant(m, lobby)).map(m => {
    const [, cp, prog, fin, score, assistCode] = m.rp!;
    const assist = assistCode === 0 ? 'off' as const : assistCode === 1 ? 'medium' as const : assistCode === 2 ? 'high' as const : undefined;
    return { id: m.id, finished: fin > 0, invalid: fin < 0, timeMs: fin > 0 ? fin : 0, score, checkpoint: cp, progressM: prog, ...(assist ? { assist } : {}) };
  });
  const drift = lobby.mode === 'drift-attack';
  racers.sort((a, b) => {
    if (a.invalid !== b.invalid) return a.invalid ? 1 : -1;
    if (drift) {
      if (a.score !== b.score) return b.score - a.score;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
    } else {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    }
    if (a.checkpoint !== b.checkpoint) return b.checkpoint - a.checkpoint;
    if (a.progressM !== b.progressM) return b.progressM - a.progressM;
    return a.id < b.id ? -1 : 1;
  });
  return racers.map((r, index) => ({ ...r, position: index + 1 }));
}

function num(value: unknown): number { return clampNumber(value, -BIG, BIG, 0); }

/**
 * Host pick of mode and route between races. Bumps the race number so every ready flag resets
 * (nobody is committed to a race they did not choose). Null when not allowed or nothing changes.
 */
export function optionsPatch(lobby: LobbyRecord, mode: RaceMode, route: string): Partial<LobbyRecord> | null {
  if (lobby.ph !== 'w' || (mode !== 'time-trial' && mode !== 'drift-attack') || !ROUTE_ID.test(route)) return null;
  if (lobby.mode === mode && lobby.route === route) return null;
  return { mode, route, race: lobby.race + 1, rt: 0 };
}

/**
 * A new host re-expresses a scheduled start in its own clock so the countdown does not jump.
 * `offsetMs` is the old host's clock minus the new host's clock, as the new host measured it.
 */
export function rebasePatch(lobby: LobbyRecord, offsetMs: number): Partial<LobbyRecord> | null {
  if ((lobby.ph !== 's' && lobby.ph !== 'r') || !lobby.at || !Number.isFinite(offsetMs) || Math.abs(offsetMs) < 5) return null;
  return { at: Math.round(lobby.at - offsetMs), ...(lobby.ff ? { ff: Math.round(lobby.ff - offsetMs) } : {}) };
}

/** Front row slots (up to 2 m back) count for the leaderboard; back row starts are 5 m or more behind and do not. */
export const FAIR_GRID_BACK_M = 2;
export function fairGridSlot(slot: number): boolean { return gridOffset(slot).backM <= FAIR_GRID_BACK_M; }
