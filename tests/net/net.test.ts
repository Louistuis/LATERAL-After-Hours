import { describe, expect, it } from 'vitest';
import { emptyCarState, packCarState, unpackCarState, type NetCarState } from '../../src/net/quantize';
import { SnapshotBuffer, INTERP_DELAY_MS } from '../../src/net/interpolation';
import { hostOf, hostStep, newLobby, pickLobby, standings, START_DELAY_MS, READY_TIMER_MS, type LobbyRecord, type MemberState } from '../../src/net/lobby';
import { NetSession } from '../../src/net/session';
import { createOfflineTransport, type PresenceMap } from '../../src/net/transport';
import { topEntries } from '../../src/net/leaderboard';
import { fakeRemote, fakeRoom, localView } from './helpers';

function state(t: number, x: number, vx = 0): NetCarState {
  return { ...emptyCarState(), t, px: x, vx };
}

describe('quantization', () => {
  it('round-trips a car state within quantization error', () => {
    const s: NetCarState = { t: 12345.6, px: 123.456, py: -2.345, pz: -456.789, qx: 0.1, qy: -0.7, qz: 0.05, qw: -0.7, vx: 31.27, vy: -0.4, vz: -12.01, steer: 0.321, brake: true, reverse: false, handbrake: true };
    const out = emptyCarState();
    const packed = packCarState(s);
    expect(packed).toHaveLength(13);
    expect(packed.every(Number.isInteger)).toBe(true);
    expect(JSON.stringify(packed).length).toBeLessThan(90);
    expect(unpackCarState(JSON.parse(JSON.stringify(packed)), out)).toBe(true);
    expect(out.px).toBeCloseTo(123.46, 2);
    expect(out.pz).toBeCloseTo(-456.79, 2);
    expect(out.vx).toBeCloseTo(31.27, 2);
    expect(out.steer).toBeCloseTo(0.321, 3);
    // q and -q are the same rotation; the packer flips to the w >= 0 hemisphere.
    const len = Math.hypot(0.1, 0.7, 0.05, 0.7);
    expect(out.qw).toBeCloseTo(0.7 / len, 3);
    expect(out.qy).toBeCloseTo(0.7 / len, 3);
    expect([out.brake, out.reverse, out.handbrake]).toEqual([true, false, true]);
  });
  it('rejects malformed payloads', () => {
    const out = emptyCarState();
    expect(unpackCarState(null, out)).toBe(false);
    expect(unpackCarState([1, 2, 3], out)).toBe(false);
    expect(unpackCarState(Array(13).fill('x'), out)).toBe(false);
    expect(unpackCarState([...Array(12).fill(0), Infinity], out)).toBe(false);
  });
});

describe('snapshot interpolation', () => {
  it('renders a fixed delay behind the sender between samples', () => {
    const buffer = new SnapshotBuffer();
    // Sender clock is 5000 ms behind the receiver; latency 20 ms.
    for (let i = 0; i <= 5; i++) buffer.push(state(i * 80, i * 8, 100), 5020 + i * 80);
    const out = emptyCarState();
    // Receiver time 5020 + 200 maps to sender time 200 - delay 100 = 100 ms: x = 10 m at 100 m/s.
    expect(buffer.sample(5220, out)).toBe(true);
    expect(out.px).toBeCloseTo(10, 4);
    expect(INTERP_DELAY_MS).toBe(100);
  });
  it('follows a curve smoothly using sent velocities (Hermite)', () => {
    const buffer = new SnapshotBuffer(0);
    buffer.push(state(0, 0, 0), 0);
    buffer.push(state(1000, 1, 2), 1000);
    const out = emptyCarState();
    buffer.sample(500, out);
    // h00*0 + h10*0 + h01*1 + h11*2 at u=0.5: 0.5 - 0.25 = 0.25
    expect(out.px).toBeCloseTo(0.25, 5);
  });
  it('extrapolates with velocity for a bounded window, then holds', () => {
    const buffer = new SnapshotBuffer(0);
    buffer.push(state(0, 0, 10), 0);
    buffer.push(state(100, 1, 10), 100);
    const out = emptyCarState();
    buffer.sample(200, out);
    expect(out.px).toBeCloseTo(2, 5);
    buffer.sample(5000, out);
    expect(out.px).toBeCloseTo(1 + 10 * 0.25, 5);
  });
  it('drops out-of-order samples and resets on a restarted sender clock', () => {
    const buffer = new SnapshotBuffer(0);
    buffer.push(state(10000, 0), 0);
    buffer.push(state(10080, 1), 80);
    buffer.push(state(10040, 99), 90);
    expect(buffer.size).toBe(2);
    buffer.push(state(50, 7), 200);
    expect(buffer.size).toBe(1);
  });
});

const lobby = (patch: Partial<LobbyRecord> = {}): LobbyRecord => ({ ...newLobby('time-trial', 'HW-01', 0), ...patch });
const member = (id: string, patch: Partial<MemberState> = {}): MemberState => ({ id, lb: 'L', ...patch });

describe('lobby rules', () => {
  it('picks the lowest client id as host and migrates when it leaves', () => {
    const members = [member('b'), member('a'), member('c')];
    expect(hostOf(members)).toBe('a');
    expect(hostOf(members.filter(m => m.id !== 'a'))).toBe('b');
    expect(hostOf([])).toBeNull();
  });
  it('starts when everyone is ready', () => {
    expect(hostStep(lobby(), [member('a', { rd: 1 }), member('b', { rd: 1 })], 1000)).toEqual({ ph: 's', at: 1000 + START_DELAY_MS, rt: 0, ff: 0, g: 'a,b' });
    expect(hostStep(lobby(), [member('a', { rd: 1 })], 1000)?.ph).toBe('s');
  });
  it('a stale ready flag from the previous race does not count', () => {
    expect(hostStep(lobby({ race: 2 }), [member('a', { rd: 1 })], 1000)).toBeNull();
  });
  it('runs a ready timer once one of several drivers is ready', () => {
    const members = [member('a', { rd: 1 }), member('b')];
    expect(hostStep(lobby(), members, 1000)).toEqual({ rt: 1000 });
    expect(hostStep(lobby({ rt: 1000 }), members, 1000 + READY_TIMER_MS - 1)).toBeNull();
    expect(hostStep(lobby({ rt: 1000 }), members, 1000 + READY_TIMER_MS)?.ph).toBe('s');
    expect(hostStep(lobby({ rt: 1000 }), [member('a'), member('b')], 2000)).toEqual({ rt: 0 });
  });
  it('goes starting -> racing -> waiting with the next race number', () => {
    expect(hostStep(lobby({ ph: 's', at: 5000 }), [member('a')], 4999)).toBeNull();
    expect(hostStep(lobby({ ph: 's', at: 5000 }), [member('a')], 5000)).toEqual({ ph: 'r' });
    const racing = lobby({ ph: 'r', at: 5000 });
    const running = [member('a', { rp: [1, 3, 200, 0, 0] }), member('b', { rp: [1, 2, 150, 0, 0] })];
    expect(hostStep(racing, running, 9000)).toBeNull();
    const oneDone = [member('a', { rp: [1, 8, 0, 61000, 0] }), member('b', { rp: [1, 2, 150, 0, 0] })];
    expect(hostStep(racing, oneDone, 9000)).toEqual({ ff: 9000 });
    expect(hostStep({ ...racing, ff: 9000 }, oneDone, 9000 + 61000)).toEqual({ ph: 'w', race: 2, at: 0, rt: 0, ff: 0 });
    const allDone = [member('a', { rp: [1, 8, 0, 61000, 0] }), member('b', { rp: [1, 8, 0, -1, 0] })];
    expect(hostStep(racing, allDone, 9000)?.race).toBe(2);
  });
  it('does not start the finish grace when a driver only goes invalid', () => {
    const racing = lobby({ ph: 'r', at: 5000 });
    const quitter = [member('a', { rp: [1, 2, 150, -1, 0] }), member('b', { rp: [1, 2, 150, 0, 0] })];
    expect(hostStep(racing, quitter, 9000)).toBeNull();
    const thenFinish = [member('a', { rp: [1, 2, 150, -1, 0] }), member('b', { rp: [1, 8, 0, 70000, 0] })];
    expect(hostStep(racing, thenFinish, 75000)?.race).toBe(2);
  });
  it('quick race prefers waiting lobbies of the right mode with room', () => {
    const lobbies = { A: lobby({ ph: 'r', at: 0 }), B: lobby(), C: { ...lobby(), mode: 'drift-attack' as const } };
    const presence: PresenceMap = { x: { lb: 'A' }, y: { lb: 'B' }, z: { lb: 'C' } };
    expect(pickLobby(lobbies, presence, 'time-trial', 100)).toBe('B');
    expect(pickLobby(lobbies, presence, 'drift-attack', 100)).toBe('C');
    const full: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 8; i++) full[`p${i}`] = { lb: 'B' };
    expect(pickLobby({ B: lobby() }, full, 'time-trial', 100)).toBeNull();
  });
  it('orders standings by finish time, then distance, invalid last', () => {
    const l = lobby({ ph: 'r' });
    const list = standings(l, [
      member('a', { rp: [1, 4, 300, 0, 0] }), member('b', { rp: [1, 8, 0, 62000, 0] }),
      member('c', { rp: [1, 8, 0, 60000, 0] }), member('d', { rp: [1, 5, 10, 0, 0] }),
      member('e', { rp: [1, 8, 0, -1, 0] }), member('f', { rp: [0, 9, 0, 1, 0] }),
    ]);
    expect(list.map(s => s.id)).toEqual(['c', 'b', 'd', 'a', 'e']);
    expect(list[0]!.position).toBe(1);
  });
});

describe('net session with a fake socket', () => {
  it('stays inert on the offline adapter', () => {
    const session = new NetSession(createOfflineTransport(), { beginRace: async () => {}, paint: () => '' }, fakeRemote());
    session.goOnline('CAR-01');
    session.tick(localView(), 0);
    expect(session.available).toBe(false);
    expect(session.view().active).toBe(false);
  });

  it('shares car state, matches into one lobby, starts a synced race and migrates the host', async () => {
    const room = fakeRoom();
    let wall = 1_000_000;
    const clock = { now: () => wall, wall: () => wall };
    const starts: string[] = [];
    const make = (id: string) => {
      const remote = fakeRemote();
      const session = new NetSession(room.connect(id), { beginRace: async () => { starts.push(id); }, paint: () => 'harbor-teal' }, remote, clock);
      return { session, remote };
    };
    const a = make('a'), b = make('b'), c = make('c');
    for (const p of [a, b, c]) p.session.goOnline('CAR-02');
    expect([...b.remote.cars]).toEqual(['a', 'c']);
    a.session.tick(localView(), wall);
    expect(b.remote.pushes).toContain('a');
    expect(room.presence.a).toMatchObject({ on: 1, car: 1, pt: 'harbor-teal' });

    const lobbyId = a.session.quickRace('time-trial');
    expect(b.session.quickRace('time-trial')).toBe(lobbyId);
    expect(c.session.quickRace('time-trial')).toBe(lobbyId);
    expect(b.session.view().members.map(m => [m.id, m.host])).toEqual([['a', true], ['b', false], ['c', false]]);

    // Host a leaves before anyone readies: b takes over and drives the lobby.
    a.session.leaveLobby();
    room.disconnect('a');
    expect(c.session.view().members.find(m => m.host)?.id).toBe('b');
    b.session.setReady(true); c.session.setReady(true);
    wall += 300; b.session.tick(localView(), wall); c.session.tick(localView(), wall);
    const lobby = b.session.view().lobby!;
    expect(lobby.ph).toBe('s');
    expect(lobby.at).toBe(wall + START_DELAY_MS);

    // Clients join the grid when the 3 s run countdown is due.
    wall = lobby.at - 2900; b.session.tick(localView(), wall); c.session.tick(localView(), wall);
    await Promise.resolve(); await Promise.resolve();
    expect(starts.sort()).toEqual(['b', 'c']);
    expect(room.presence.b!.rp).toEqual([1, 0, 0, 0, 0]);

    // Progress and finish feed the shared standings.
    wall += 3500;
    b.session.tick(localView({ runId: 'rb', checkpointIndex: 2, routeProgressM: 120, }), wall);
    c.session.tick(localView({ runId: 'rc', checkpointIndex: 3, routeProgressM: 180 }), wall);
    wall += 300;
    b.session.tick(localView({ runId: 'rb', checkpointIndex: 2, routeProgressM: 120 }), wall);
    c.session.tick(localView({ runId: 'rc', checkpointIndex: 3, routeProgressM: 180 }), wall);
    expect(b.session.view().standings.map(s => s.id)).toEqual(['c', 'b']);
    const result = { runId: 'rb', routeId: 'HW-01' as const, mode: 'time-trial' as const, rulesVersion: 'x', carId: 'CAR-02' as const, elapsedActiveSeconds: 58.5, bankedScore: 0, medal: 'none' as const, valid: true };
    wall += 300; b.session.tick(localView({ runId: 'rb', checkpointIndex: 8, routeProgressM: 0 }, result), wall);
    expect(b.session.view().standings[0]).toMatchObject({ id: 'b', finished: true, timeMs: 58500 });
    expect(b.session.view().finished).toBe(true);
  });

  it('keeps hosting the lobby from the idle timer when frames stop', () => {
    const room = fakeRoom();
    let wall = 2_000_000;
    const clock = { now: () => wall, wall: () => wall };
    const make = (id: string) => new NetSession(room.connect(id), { beginRace: async () => {}, paint: () => '' }, fakeRemote(), clock);
    const a = make('a'), b = make('b');
    for (const s of [a, b]) s.goOnline('CAR-01');
    a.idle(wall); // no frame yet: nothing to act on
    a.tick(localView(), wall);
    const id = a.quickRace('drift-attack')!;
    b.quickRace('drift-attack');
    a.setReady(true); b.setReady(true);
    // a is the host and is now backgrounded: only the timer runs.
    wall += 1000; a.idle(wall);
    expect(a.view().lobby).toMatchObject({ ph: 's' });
    expect(b.transport.roomState()).toMatchObject({ lobbies: { [id]: { ph: 's' } } });
  });
});

describe('leaderboard', () => {
  it('keeps one best entry per player and sorts by mode', () => {
    const pv = 'lateral-force-60hz-v6';
    const records = [
      { id: '1', username: 'ann', route: 'HW-01', mode: 'time-trial', value: 61000, pv },
      { id: '2', username: 'ann', route: 'HW-01', mode: 'time-trial', value: 59000, pv },
      { id: '3', username: 'bob', route: 'HW-01', mode: 'time-trial', value: 60000, pv },
      { id: '4', username: 'cat', route: 'HW-01', mode: 'time-trial', value: 100, pv },
      { id: '5', username: 'bob', route: 'HW-01', mode: 'drift-attack', value: 9000, pv },
    ];
    expect(topEntries(records, 'HW-01', 'time-trial').map(e => [e.username, e.value])).toEqual([['ann', 59000], ['bob', 60000]]);
    expect(topEntries(records, 'HW-01', 'drift-attack')).toHaveLength(1);
  });
});
