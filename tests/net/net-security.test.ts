import { describe, expect, it, vi } from 'vitest';
import { MAX_LOBBIES, parseLobbies, parseMember, membersOf } from '../../src/net/lobby';
import { MAX_DRIFT_SCORE, MAX_TIME_MS, MIN_DRIFT_SCORE, MIN_TIME_MS, plausibleEntry, topEntries } from '../../src/net/leaderboard';
import { MAX_POSITION_M, MAX_SPEED_MS, emptyCarState, packCarState, unpackCarState } from '../../src/net/quantize';
import { MAX_NAME, MAX_PAINT, MAX_REMOTE_CARS, MAX_TOAST, boundedEntries, clampInt, isPeerId, ownEntry, safeAvatarUrl, sanitizeText } from '../../src/net/sanitize';
import { NetSession } from '../../src/net/session';
import type { NetTransport } from '../../src/net/transport';
import { VEHICLE_PHYSICS_VERSION } from '../../src/vehicle/tune-identity';
import { fakeRemote, localView } from './helpers';

const pv = VEHICLE_PHYSICS_VERSION;

describe('text and id sanitizing', () => {
  it('strips control and bidi characters, collapses spaces and caps by code points', () => {
    expect(sanitizeText('a\u0000b‮c​d  e\n f', 32)).toBe('abcd e f');
    expect(sanitizeText('x'.repeat(5000), 32)).toHaveLength(32);
    expect(Array.from(sanitizeText('\u{1F600}'.repeat(100), 10))).toHaveLength(10);
    for (const bad of [undefined, null, 5, {}, [], Symbol.iterator]) expect(sanitizeText(bad, 10, 'fb')).toBe('fb');
    expect(sanitizeText('   ', 10, 'fb')).toBe('fb');
  });
  it('accepts only plain client ids and https avatars, and never reads the prototype chain', () => {
    for (const good of ['abc-123', 'a'.repeat(64), '0a1b2c3d-1111-2222-3333-444455556666']) expect(isPeerId(good)).toBe(true);
    for (const bad of ['', 'a'.repeat(65), '__proto__', 'constructor', 'a b', '<x>', 5, null, undefined]) expect(isPeerId(bad)).toBe(false);
    expect(safeAvatarUrl('https://img.example/a.png')).toBe('https://img.example/a.png');
    for (const bad of ['javascript:alert(1)', 'http://x/a.png', 'data:image/png;base64,AA', 'https://x/"onerror=1', `https://x/${'a'.repeat(400)}`, 7]) expect(safeAvatarUrl(bad)).toBe('');
    expect(ownEntry({ a: 1 }, 'a')).toBe(1);
    expect(ownEntry({ a: 1 }, 'toString')).toBeUndefined();
    expect(boundedEntries(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i])), 10)).toHaveLength(10);
    expect(boundedEntries([1, 2], 10)).toEqual([]);
    expect(clampInt(Number.NaN, 0, 5, 3)).toBe(3);
    expect(clampInt(99.9, 0, 5)).toBe(5);
  });
});

describe('car state decoding', () => {
  it('rejects NaN, Infinity, non-numbers, short and oversized packets', () => {
    const out = emptyCarState();
    const good = packCarState({ ...emptyCarState(), t: 1000 });
    expect(unpackCarState(good, out)).toBe(true);
    for (const i of [0, 1, 4, 8, 11, 12]) for (const bad of [Number.NaN, Infinity, -Infinity, '5', null, undefined]) {
      const packet: unknown[] = [...good]; packet[i] = bad;
      expect(unpackCarState(packet, out)).toBe(false);
    }
    expect(unpackCarState(good.slice(0, 12), out)).toBe(false);
    expect(unpackCarState([...good, ...Array(1e5).fill(0)], out)).toBe(false);
    expect(unpackCarState('nope', out)).toBe(false);
    expect(unpackCarState({ length: 13 }, out)).toBe(false);
    const huge: number[] = [...good]; huge[0] = 1e15;
    expect(unpackCarState(huge, out)).toBe(false);
  });
  it('clamps positions and velocities to the bounds', () => {
    const out = emptyCarState();
    const packet = packCarState({ ...emptyCarState(), t: 5 });
    packet[1] = 9e12; packet[2] = -9e12; packet[3] = 9e9; packet[8] = 9e12; packet[9] = -9e12; packet[10] = 9e12; packet[11] = 9e9;
    expect(unpackCarState(packet, out)).toBe(true);
    expect(Math.abs(out.px)).toBe(MAX_POSITION_M);
    expect(Math.abs(out.py)).toBe(MAX_POSITION_M);
    expect(Math.abs(out.pz)).toBe(MAX_POSITION_M);
    expect(Math.abs(out.vx)).toBe(MAX_SPEED_MS);
    expect(Math.abs(out.vy)).toBe(MAX_SPEED_MS);
    expect(Math.abs(out.vz)).toBe(MAX_SPEED_MS);
    expect(Math.abs(out.steer)).toBeLessThanOrEqual(1.2);
    expect(Number.isFinite(Math.hypot(out.qx, out.qy, out.qz, out.qw))).toBe(true);
  });
});

describe('room state and presence parsing', () => {
  it('bounds lobbies, ids, routes and grids; rejects NaN', () => {
    const lobbies: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) lobbies[`lobby-${i}`] = { ph: 'w', race: 1, mode: 'time-trial', route: 'HW-01', at: 0, t: 0, rt: 0, ff: 0, g: '' };
    lobbies['bad id!'] = { ph: 'w', race: 1 };
    lobbies.nan = { ph: 'w', race: Number.NaN };
    expect(Object.keys(parseLobbies({ lobbies })).length).toBeLessThanOrEqual(MAX_LOBBIES);
    const parsed = parseLobbies({ lobbies: { x: { ph: 'r', race: 1e12, mode: 'x', route: '<script>', at: Infinity, t: -1e30, rt: 'a', ff: NaN, g: `${'a,'.repeat(500)}<b>` } } }).x!;
    expect(parsed.route).toBe('HW-01');
    expect(parsed.race).toBe(1e6);
    expect(parsed.at).toBe(0);
    expect(Math.abs(parsed.t)).toBeLessThanOrEqual(1e15);
    expect(parsed.g.split(',').length).toBeLessThanOrEqual(8);
    expect(parseLobbies({ lobbies: 'junk' })).toEqual({});
    expect(parseLobbies({ lobbies: [1, 2] })).toEqual({});
  });
  it('race progress from a peer is finite and bounded or dropped', () => {
    expect(parseMember('a', { rp: [1, 2, Number.NaN, 0, 0] }).rp).toBeUndefined();
    expect(parseMember('a', { rp: [1, 2, 3, 0, 0, ...Array(100).fill(1)] }).rp).toBeUndefined();
    expect(parseMember('a', { rp: [1e12, 1e9, 1e12, 1e12, 1e15] }).rp).toEqual([1e6, 1000, 1e6, 8 * 60000 * 4, 1e9]);
    expect(parseMember('a', { lb: 'x'.repeat(500), rd: Infinity }).lb).toBeUndefined();
    expect(parseMember('a', { rd: Infinity }).rd).toBeUndefined();
  });
  it('membership ignores junk presence entries and caps the scan', () => {
    const presence: Record<string, Record<string, unknown>> = { '__proto__x': { lb: 'L' }, 'bad id': { lb: 'L' }, ok: { lb: 'L' } };
    for (let i = 0; i < 2000; i++) presence[`p${i}`] = { lb: 'L' };
    const members = membersOf('L', presence);
    expect(members.length).toBeLessThanOrEqual(256);
    expect(members.some(m => m.id === 'bad id')).toBe(false);
  });
});

describe('leaderboard plausibility', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: '1', username: 'ann', route: 'HW-01', mode: 'time-trial', value: 61000, pv, car: 'CAR-01', ...over });
  it('rejects a physics version mismatch (and a missing one), NaN, fractions and out-of-range values', () => {
    expect(plausibleEntry(row(), 'HW-01', 'time-trial')).toEqual({ username: 'ann', value: 61000, car: 'CAR-01' });
    expect(plausibleEntry(row({ pv: 'lateral-force-60hz-v5' }), 'HW-01', 'time-trial')).toBeNull();
    expect(plausibleEntry(row({ pv: undefined }), 'HW-01', 'time-trial')).toBeNull();
    for (const value of [Number.NaN, Infinity, -1, 0, 61000.5, '61000', null, MIN_TIME_MS - 1, MAX_TIME_MS + 1]) expect(plausibleEntry(row({ value }), 'HW-01', 'time-trial')).toBeNull();
    for (const value of [MIN_DRIFT_SCORE - 1, MAX_DRIFT_SCORE + 1, Number.NaN, 5.5]) expect(plausibleEntry(row({ mode: 'drift-attack', value }), 'HW-01', 'drift-attack')).toBeNull();
    expect(plausibleEntry(row({ mode: 'drift-attack', value: MIN_DRIFT_SCORE }), 'HW-01', 'drift-attack')).not.toBeNull();
    expect(plausibleEntry(row({ username: '' }), 'HW-01', 'time-trial')).toBeNull();
    expect(plausibleEntry(row({ route: 'HW-02' }), 'HW-01', 'time-trial')).toBeNull();
  });
  it('sanitizes names and cars, keeps one best per player and bounds the scan', () => {
    const entries = topEntries([row({ username: 'a‮b'.repeat(40), car: 'CAR-99' }), row({ id: '2', username: 'bob', value: 59000 }), row({ id: '3', username: 'bob', value: 70000 })], 'HW-01', 'time-trial');
    expect(entries[0]).toMatchObject({ username: 'bob', value: 59000 });
    expect(entries[1]!.username.length).toBeLessThanOrEqual(MAX_NAME);
    expect(entries[1]!.car).toBe('');
    const flood = Array.from({ length: 50000 }, (_, i) => row({ id: String(i), username: `u${i}`, value: 30000 + i }));
    expect(topEntries(flood, 'HW-01', 'time-trial', 3)).toHaveLength(3);
    expect(topEntries('nope' as never, 'HW-01', 'time-trial')).toEqual([]);
  });
});

function stub(selfId = 'me') {
  const presence: Record<string, Record<string, unknown>> = {};
  const peers: Record<string, { username: string; avatarUrl: string }> = {};
  let onMsg: ((d: Record<string, unknown>) => void) | null = null, onPres: ((p: typeof presence) => void) | null = null;
  const updates: Record<string, unknown>[] = [];
  const transport: NetTransport = {
    available: true, selfId, peers: () => peers, presence: () => presence, roomState: () => ({}),
    updatePresence(patch) { updates.push(patch); presence[selfId] = { ...presence[selfId], ...patch }; },
    updateRoomState() {}, send() {},
    onMessage: cb => { onMsg = cb; return () => {}; }, onPresence: cb => { onPres = cb as never; return () => {}; }, onRoomState: () => () => {},
    collection: () => null, dispose() {},
  };
  return { transport, presence, peers, updates, message: (d: Record<string, unknown>) => onMsg?.(d), presenceChanged: () => onPres?.({ ...presence }) };
}
const makeRemote = () => {
  const upserts: { id: string; car: string; paint: string; name: string }[] = [], pushes: string[] = [];
  const cars = new Set<string>();
  return { upserts, pushes, cars, sink: { upsert: (id: string, car: string, paint: string, name: string) => { cars.add(id); upserts.push({ id, car, paint, name }); }, push: (id: string) => { pushes.push(id); }, remove: (id: string) => { cars.delete(id); }, ids: () => cars.values(), update() {}, dispose() {} } };
};

describe('net session against hostile peers', () => {
  it('shows at most MAX_REMOTE_CARS remote cars however many presences are announced', () => {
    const s = stub(), r = makeRemote();
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '' }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.goOnline('CAR-01');
    for (let i = 0; i < 400; i++) { s.presence[`peer-${i}`] = { on: 1, car: 0, pt: '' }; s.peers[`peer-${i}`] = { username: `p${i}`, avatarUrl: '' }; }
    s.presenceChanged();
    expect(r.cars.size).toBeLessThanOrEqual(MAX_REMOTE_CARS);
  });
  it('sanitizes names, paints, car indexes and avatars before anything is drawn', () => {
    const s = stub(), r = makeRemote();
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '' }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.goOnline('CAR-01');
    s.peers.evil = { username: `<b>${'x'.repeat(300)}‮`, avatarUrl: 'javascript:alert(1)' };
    s.presence.evil = { on: 1, car: 1e9, pt: `~${'a'.repeat(5000)}` };
    s.presence.weird = { on: 1, car: Number.NaN, pt: { toString: 1 } };
    s.presenceChanged();
    const evil = r.upserts.find(u => u.id === 'evil')!;
    expect(evil.name.length).toBeLessThanOrEqual(MAX_NAME);
    expect(evil.name).not.toMatch(/‮/);
    expect(evil.paint.length).toBeLessThanOrEqual(MAX_PAINT);
    expect(evil.car).toBe('CAR-01');
    expect(r.upserts.find(u => u.id === 'weird')!.paint).toBe('');
    expect(session.view().players.find(p => p.id === 'evil')!.avatarUrl).toBe('');
  });
  it('runs every other player through verifyLook and re-evaluates when verification changes', () => {
    const s = stub(), r = makeRemote();
    let verified = false;
    let notify: () => void = () => {};
    const session = new NetSession(s.transport, {
      beginRace: async () => {}, paint: () => '',
      verifyLook: (_name, car, paint) => (verified ? { car, paint } : { car: 'CAR-01', paint: '' }),
      onLooksChanged: cb => { notify = cb; return () => {}; },
    }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.goOnline('CAR-01');
    s.peers.rich = { username: 'rich', avatarUrl: '' };
    s.presence.rich = { on: 1, car: 1, pt: '~gold-chrome......' };
    s.presenceChanged();
    expect(r.upserts.at(-1)).toMatchObject({ id: 'rich', car: 'CAR-01', paint: '' });
    verified = true; notify();
    expect(r.upserts.at(-1)).toMatchObject({ id: 'rich', car: 'CAR-02', paint: '~gold-chrome......' });
  });
  it('announces the starter car instead of a locked one', () => {
    const s = stub(), r = makeRemote();
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '', carAllowed: car => car === 'CAR-01' }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.goOnline('CAR-02');
    expect(s.updates[0]!.car).toBe(0);
    session.tick({ ...localView(), carId: 'CAR-02' }, 5000);
    expect(s.presence.me!.car).toBe(0);
  });
  it('drops malformed, spoofed and flooding messages without throwing', () => {
    const s = stub(), r = makeRemote();
    let now = 1000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '' }, r.sink as never, { now: () => now, wall: () => now });
    session.goOnline('CAR-01');
    s.presence.peer = { on: 1, car: 0, pt: '' }; s.presence.other = { on: 1, car: 0, pt: '' };
    s.presenceChanged();
    const packet = packCarState({ ...emptyCarState(), t: 10 });
    const junk: unknown[] = [null, 5, 'x', [], { type: 's' }, { f: 5, type: 's', d: packet }, { f: '__proto__', type: 's', d: packet }, { f: 'peer', type: 's', d: 'x' },
      { f: 'peer', type: 's', d: [NaN, ...packet.slice(1)] }, { f: 'peer', type: 's', d: new Array(1e6).fill(0) }, { f: 'peer', to: 'me', type: 'q', n: NaN, th: Infinity },
      { f: 'peer', to: 'me', type: 'p', n: 'x' }, { f: 'x'.repeat(10000), type: 'h' }, { get f(): string { throw new Error('getter'); }, type: 's' }];
    for (const data of junk) expect(() => s.message(data as never)).not.toThrow();
    expect(r.pushes).toEqual([]);
    // The socket-attached clientId wins over a spoofed payload id.
    s.message({ clientId: 'other', f: 'peer', type: 's', d: packet });
    expect(r.pushes).toEqual(['other']);
    // Flood: many state messages in the same millisecond are reduced to one.
    r.pushes.length = 0;
    now += 100;
    for (let i = 0; i < 1000; i++) s.message({ f: 'peer', type: 's', d: packCarState({ ...emptyCarState(), t: 20 + i }) });
    expect(r.pushes.length).toBe(1);
    now += 100;
    s.message({ f: 'peer', type: 's', d: packCarState({ ...emptyCarState(), t: 5000 }) });
    expect(r.pushes.length).toBe(2);
    warn.mockRestore();
  });
  it('caps toast text', () => {
    const s = stub(), r = makeRemote();
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '' }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.toast(`${'long '.repeat(500)}‮`);
    session.toast('\u0000\u0001');
    const toasts = session.view().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.text.length).toBeLessThanOrEqual(MAX_TOAST);
  });
  it('tolerates a throwing verifier or sink without breaking the rest', () => {
    const s = stub(), r = makeRemote();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new NetSession(s.transport, { beginRace: async () => {}, paint: () => '', verifyLook: name => { if (name === 'bad') throw new Error('boom'); return { car: 'CAR-01', paint: '' }; } }, r.sink as never, { now: () => 1000, wall: () => 1000 });
    session.goOnline('CAR-01');
    s.peers.bad = { username: 'bad', avatarUrl: '' }; s.peers.good = { username: 'good', avatarUrl: '' };
    s.presence.bad = { on: 1, car: 0, pt: '' }; s.presence.good = { on: 1, car: 0, pt: '' };
    expect(() => s.presenceChanged()).not.toThrow();
    expect(r.cars.has('good')).toBe(true);
    warn.mockRestore();
    expect(fakeRemote).toBeDefined();
  });
});
