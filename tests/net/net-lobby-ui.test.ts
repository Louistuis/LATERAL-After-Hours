import { describe, expect, it } from 'vitest';
import { fairGridSlot, newLobby, optionsPatch, parseMember, pickLobby, rebasePatch, type LobbyRecord } from '../../src/net/lobby';
import { NetSession } from '../../src/net/session';
import { podiumOrder } from '../../src/ui/online-panel';
import { fakeRemote, fakeRoom, localView } from './helpers';

describe('lobby rules for the online UI', () => {
  it('lets the host pick mode and route only between races, resetting ready flags', () => {
    const lobby = { ...newLobby('time-trial', 'HW-01', 0), race: 4 };
    expect(optionsPatch(lobby, 'drift-attack', 'RP-01')).toEqual({ mode: 'drift-attack', route: 'RP-01', race: 5, rt: 0 });
    expect(optionsPatch(lobby, 'time-trial', 'HW-01')).toBeNull();
    expect(optionsPatch({ ...lobby, ph: 's' }, 'drift-attack', 'HW-01')).toBeNull();
    expect(optionsPatch(lobby, 'time-trial', '../x')).toBeNull();
    expect(optionsPatch(lobby, 'rival' as never, 'HW-01')).toBeNull();
  });

  it('rebases a scheduled start into the new host clock', () => {
    const starting: LobbyRecord = { ...newLobby('time-trial', 'HW-01', 0), ph: 's', at: 100_000 };
    expect(rebasePatch(starting, 7_000)).toEqual({ at: 93_000 });
    expect(rebasePatch({ ...starting, ph: 'r', ff: 120_000 }, -500)).toEqual({ at: 100_500, ff: 120_500 });
    expect(rebasePatch(starting, 2)).toBeNull();
    expect(rebasePatch({ ...starting, ph: 'w' }, 7_000)).toBeNull();
    expect(rebasePatch(starting, Number.NaN)).toBeNull();
  });

  it('keeps back-row grid starts off the leaderboard', () => {
    expect([0, 1, 2, 3].every(fairGridSlot)).toBe(true);
    expect([4, 5, 6, 7].some(fairGridSlot)).toBe(false);
  });

  it('finds a quick match across modes and routes', () => {
    const lobbies = { a: { ...newLobby('drift-attack', 'RP-01', 0) }, b: { ...newLobby('time-trial', 'HW-01', 0), ph: 'r' as const, at: 1 } };
    const presence = { p1: { lb: 'a' }, p2: { lb: 'b' }, p3: { lb: 'b' } };
    expect(pickLobby(lobbies, presence, undefined, 10)).toBe('a');
    expect(pickLobby(lobbies, presence, 'time-trial', 10)).toBe('b');
  });

  it('reads a bounded ping from presence', () => {
    expect(parseMember('x', { pg: 87.6 }).pg).toBe(87);
    expect(parseMember('x', { pg: 1e9 }).pg).toBe(9999);
    expect(parseMember('x', { pg: -5 }).pg).toBe(0);
    expect(parseMember('x', { pg: 'fast' }).pg).toBeUndefined();
  });

  it('orders the podium second, first, third', () => {
    expect(podiumOrder([1, 2, 3, 4])).toEqual([2, 1, 3]);
    expect(podiumOrder([1, 2])).toEqual([2, 1]);
    expect(podiumOrder([1])).toEqual([1]);
  });
});

describe('online session for the lobby UI', () => {
  const setup = (offsets: Record<string, number> = {}) => {
    const room = fakeRoom();
    const clock = { now: 10_000 };
    const starts: string[] = [], startedAt: Record<string, number> = {};
    const make = (id: string) => new NetSession(room.connect(id), { beginRace: async () => { starts.push(id); startedAt[id] = clock.now; }, paint: () => '', selectedRoute: () => 'HW-01' },
      fakeRemote(), { now: () => clock.now, wall: () => 5_000_000 + clock.now + (offsets[id] ?? 0) });
    const step = (sessions: NetSession[], ms: number, times = 1) => { for (let i = 0; i < times; i++) { clock.now += ms; for (const s of sessions) s.tick(localView(), clock.now); } };
    return { room, clock, starts, startedAt, make, step };
  };

  it('quick match joins an open lobby and readies up in one call', () => {
    const { make, step } = setup();
    const a = make('a'), b = make('b');
    for (const s of [a, b]) s.goOnline('CAR-01');
    const id = a.quickRace('drift-attack');
    const joined = b.quickMatch();
    expect(joined).toBe(id);
    step([a, b], 300, 2);
    expect(b.view().ready).toBe(true);
    expect(b.view().members.map(m => m.id)).toEqual(['a', 'b']);
    // Cars come from presence (the local view drives CAR-02 in these fixtures).
    expect(b.view().members.map(m => m.car)).toEqual(['CAR-02', 'CAR-02']);
  });

  it('only the host changes mode and route', () => {
    const { make, step } = setup();
    const a = make('a'), b = make('b');
    for (const s of [a, b]) s.goOnline('CAR-01');
    a.quickRace('time-trial'); b.quickRace('time-trial');
    step([a, b], 300, 2);
    expect(a.view().isHost).toBe(true);
    expect(b.setLobbyOptions('drift-attack', 'HW-01')).toBe(false);
    b.setReady(true);
    expect(a.setLobbyOptions('drift-attack', 'HW-01')).toBe(true);
    step([a, b], 300, 2);
    expect(b.view().lobby?.mode).toBe('drift-attack');
    expect(b.view().ready).toBe(false);
  });

  it('measures ping for the player list, host included', () => {
    const { make, step } = setup();
    const a = make('a'), b = make('b');
    for (const s of [a, b]) s.goOnline('CAR-01');
    a.quickRace('time-trial'); b.quickRace('time-trial');
    step([a, b], 300, 30);
    // The fake room delivers instantly, so the round trip is 0 ms: present, not null.
    expect(b.view().pingMs).toBe(0);
    expect(a.view().pingMs).toBe(0);
    expect(a.view().members.find(m => m.id === 'b')?.pingMs).toBe(0);
  });

  it('keeps the countdown on time when the host leaves mid-countdown', () => {
    const skewB = 4_000, skewC = -3_000;
    const { room, starts, startedAt, make, step } = setup({ b: -skewB, c: -skewC });
    const a = make('a'), b = make('b'), c = make('c');
    for (const s of [a, b, c]) s.goOnline('CAR-01');
    a.quickRace('time-trial'); b.quickRace('time-trial'); c.quickRace('time-trial');
    step([a, b, c], 400, 10);
    for (const s of [a, b, c]) s.setReady(true);
    step([a, b, c], 300, 1);
    const at = a.view().lobby!.at;
    expect(a.view().lobby!.ph).toBe('s');
    // Host a drops out two seconds into the six second grid countdown.
    step([a, b, c], 250, 4);
    a.dispose(); room.disconnect('a');
    step([b, c], 250, 4);
    expect(b.view().isHost).toBe(true);
    // b rebased the start into its own clock: same moment in real time.
    const rebased = b.view().lobby!.at;
    expect(rebased).toBe(at - skewB);
    // Both remaining drivers start their 3 s countdown when a's schedule said, in real time.
    const due = at - 5_000_000 - 3_000;
    step([b, c], 50, 120);
    expect(starts.sort()).toEqual(['b', 'c']);
    expect(Math.abs(startedAt.b! - due)).toBeLessThanOrEqual(300);
    expect(Math.abs(startedAt.c! - due)).toBeLessThanOrEqual(300);
  });

  it('quick match opens a lobby without readying when nobody is there, so no solo race starts', () => {
    const { make, step, starts } = setup();
    const a = make('a');
    a.goOnline('CAR-01');
    expect(a.quickMatch()).not.toBeNull();
    step([a], 300, 40);
    expect(a.view().ready).toBe(false);
    expect(a.view().joining).toBe(false);
    expect(a.view().lobby?.ph).toBe('w');
    expect(starts).toEqual([]);
    // A second driver quick matching joins that lobby and readies up.
    const b = make('b');
    b.goOnline('CAR-01');
    expect(b.quickMatch()).toBe(a.view().lobbyId);
    step([a, b], 300, 2);
    expect(b.view().ready).toBe(true);
  });

  it('does not report a lost connection after the page itself stalled', () => {
    const { make, step, clock } = setup();
    const a = make('a'), b = make('b');
    for (const s of [a, b]) s.goOnline('CAR-01');
    step([a, b], 250, 8);
    // A 15 s stall (shader compile, hidden tab): nothing ticked, nothing was read.
    clock.now += 15_000;
    step([a, b], 250, 1);
    expect(a.view().toasts).toEqual([]);
    // Real silence is still reported: b stops sending while a keeps running.
    step([a], 250, 60);
    expect(a.view().toasts.map(t => t.text)).toContain('Connection lost. Trying to reconnect.');
  });
});
