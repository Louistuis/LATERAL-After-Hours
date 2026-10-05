import { describe, expect, it } from 'vitest';
import type { VehicleSnapshot } from '../../contracts/runtime-contracts';
import { dailySpec } from '../../src/events/daily';
import { createGhostRecorder } from '../../src/ghosts/recording';
import { VEHICLE_PHYSICS_VERSION } from '../../src/vehicle/tune-identity';
import { dailyCollection } from '../../src/net/daily-board';
import { GHOST_COLLECTION, KEEP_DAILY, KEEP_GHOSTS, KEEP_LEADERBOARD, LEADERBOARD_COLLECTION, maxScore, minTimeMs } from '../../server/collections';
import type { Account } from '../../server/accounts';
import { advance, connectClient, makeApp, newAccount, T0, type App } from './helpers';

const PV = VEHICLE_PHYSICS_VERSION;
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ route: 'HW-01', mode: 'time-trial', value: 45_000, car: 'CAR-01', pv: PV, ...over });
let n = 0;
/** Inserts an account directly (scrypt is too slow to do hundreds of times). */
function bulkAccount(app: App): Account {
  const id = `bulk${++n}`, name = `bulk_${n}`;
  app.db.prepare("INSERT INTO accounts (id, name, name_lower, created_at, recovery_salt, recovery_hash, last_seen) VALUES (?, ?, ?, ?, '', '', ?)").run(id, name, name, app.now(), app.now());
  return { id, name, admin: false, banned: false, createdAt: app.now() };
}
const snap = (tick: number, x: number): VehicleSnapshot => ({
  simulationTick: tick, carId: 'CAR-01', position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -10 }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
  engineRpm: 2000, gear: 1, driftAngleRad: 0,
  wheels: [0, 1, 2, 3].map(() => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0, normalLoadN: 1, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0, surfaceId: null })) as unknown as VehicleSnapshot['wheels'],
});
function ghostRow(seconds: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const rec = createGhostRecorder();
  for (let i = 0; i <= seconds * 60; i++) rec.update(snap(i, i / 60), i / 60);
  const meta = { routeId: 'HW-01' as const, routeVersion: 'r1', rulesVersion: 's1', physicsVersion: PV, carId: 'CAR-01' as const, tuneHash: 'h1' };
  const saved = rec.toSavedGhost(meta, 128 * 1024)!;
  return { route: 'HW-01', mode: 'time-trial', value: Math.round(saved.header.durationSeconds * 1000), car: 'CAR-01', pv: PV, rv: 'r1', rules: 's1', tune: 'h1', n: saved.header.sampleCount, d: saved.header.durationSeconds, g: saved.compressedSnapshots, ...over };
}

describe('leaderboard rows', () => {
  it('accepts a plausible time, stamps username and created_at, and lists it', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Racer_One');
    const out = app.colls.write(a.account, LEADERBOARD_COLLECTION, row({ username: 'Louis', created_at: 'x', admin: 1 }));
    expect(out).toMatchObject({ ok: true, kept: false });
    const rows = app.colls.list(LEADERBOARD_COLLECTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: 'Racer_One', route: 'HW-01', mode: 'time-trial', value: 45_000, car: 'CAR-01', pv: PV });
    expect(rows[0]!.created_at).toBe(new Date(T0).toISOString());
    expect(Object.keys(rows[0]!).sort()).toEqual(['car', 'created_at', 'id', 'mode', 'pv', 'route', 'username', 'value']);
  });
  it('rejects implausible, foreign and malformed rows', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Racer_Two');
    const w = (r: unknown): unknown => { app.clock.t += 6000; const o = app.colls.write(a.account, LEADERBOARD_COLLECTION, r); return o.ok ? 'ok' : o.reason; };
    expect(w(row({ value: 19_999 }))).toBe('implausible');
    expect(w(row({ value: minTimeMs('HW-01', 'CAR-01') - 1 }))).toBe('implausible');
    expect(w(row({ value: 3_600_001 }))).toBe('implausible');
    expect(w(row({ value: 45_000.5 }))).toBe('implausible');
    expect(w(row({ value: NaN }))).toBe('implausible');
    expect(w(row({ pv: 'old' }))).toBe('implausible');
    expect(w(row({ route: 'XX-01' }))).toBe('unknown-route');
    expect(w(row({ route: 'HW-02' }))).toBe('unknown-route');
    expect(w(row({ mode: 'nope' }))).toBe('bad-row');
    expect(w(row({ car: 'CAR-99' }))).toBe('bad-car');
    expect(w(row({ car: 'CAR-04' }))).toBe('car-not-owned');
    expect(w(row({ mode: 'drift-attack', value: 99 }))).toBe('implausible');
    expect(w(row({ mode: 'drift-attack', value: maxScore('HW-01') + 1 }))).toBe('implausible');
    expect(w('str')).toBe('bad-row');
    expect(w(null)).toBe('bad-row');
    expect(app.colls.list(LEADERBOARD_COLLECTION)).toHaveLength(0);
    expect(app.colls.write(a.account, 'lateral_other', row())).toEqual({ ok: false, reason: 'no-such-collection' });
  });
  it('lets an owned premium car post, and keeps only improvements per route and mode', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Racer_Three');
    app.gifts.claimDirect(a.account, app.gifts.createDirect('louis', 'Racer_Three', { items: ['car-f1'] }).id);
    const w = (r: unknown): ReturnType<typeof app.colls.write> => { app.clock.t += 6000; return app.colls.write(a.account, LEADERBOARD_COLLECTION, r); };
    expect(w(row({ car: 'CAR-04', value: 40_000 }))).toMatchObject({ ok: true, kept: false });
    expect(w(row({ car: 'CAR-04', value: 41_000 }))).toMatchObject({ ok: true, kept: true });
    expect(w(row({ car: 'CAR-04', value: 39_000 }))).toMatchObject({ ok: true, kept: false });
    expect(w(row({ route: 'RP-01', value: 80_000 }))).toMatchObject({ ok: true, kept: false });
    expect(w(row({ mode: 'drift-attack', value: 500 }))).toMatchObject({ ok: true, kept: false });
    expect(w(row({ mode: 'drift-attack', value: 400 }))).toMatchObject({ ok: true, kept: true });
    expect(w(row({ mode: 'drift-attack', value: 900 }))).toMatchObject({ ok: true, kept: false });
    const rows = app.colls.list(LEADERBOARD_COLLECTION, { route: 'HW-01', mode: 'time-trial' });
    expect(rows).toHaveLength(1); expect(rows[0]!.value).toBe(39_000);
    expect(app.colls.list(LEADERBOARD_COLLECTION)).toHaveLength(3);
  });
  it('sorts times ascending and scores descending, hides banned players', async () => {
    const app = makeApp();
    const accs = [bulkAccount(app), bulkAccount(app), bulkAccount(app)];
    [50_000, 42_000, 47_000].forEach((v, i) => app.colls.write(accs[i]!, LEADERBOARD_COLLECTION, row({ value: v })));
    [300, 900, 600].forEach((v, i) => app.colls.write(accs[i]!, LEADERBOARD_COLLECTION, row({ mode: 'drift-attack', value: v })));
    const tt = app.colls.list(LEADERBOARD_COLLECTION, { mode: 'time-trial' }).map(r => r.value);
    const da = app.colls.list(LEADERBOARD_COLLECTION, { mode: 'drift-attack' }).map(r => r.value);
    expect(tt).toEqual([42_000, 47_000, 50_000]); expect(da).toEqual([900, 600, 300]);
    app.db.prepare('UPDATE accounts SET banned = 1 WHERE id = ?').run(accs[1]!.id);
    app.colls.invalidate(LEADERBOARD_COLLECTION);
    expect(app.colls.list(LEADERBOARD_COLLECTION, { mode: 'time-trial' }).map(r => r.value)).toEqual([47_000, 50_000]);
  });
  it('keeps only the best 100 per board', () => {
    const app = makeApp();
    for (let i = 0; i < KEEP_LEADERBOARD + 8; i++) { app.clock.t += 6000; app.colls.write(bulkAccount(app), LEADERBOARD_COLLECTION, row({ value: 60_000 - i * 10 })); }
    const rows = app.colls.list(LEADERBOARD_COLLECTION, { route: 'HW-01', mode: 'time-trial' });
    expect(rows).toHaveLength(KEEP_LEADERBOARD);
    expect(rows[0]!.value).toBe(60_000 - (KEEP_LEADERBOARD + 7) * 10);
    expect(app.colls.rowCount()).toBe(KEEP_LEADERBOARD);
  });
  it('limits writes to 12 per minute per account and only the owner can update', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Racer_Four'), b = await newAccount(app, 'Racer_Five');
    const first = app.colls.write(a.account, LEADERBOARD_COLLECTION, row()) as { ok: true; id: string };
    for (let i = 0; i < 11; i++) app.colls.write(a.account, LEADERBOARD_COLLECTION, row({ value: 44_000 - i }));
    expect(app.colls.write(a.account, LEADERBOARD_COLLECTION, row({ value: 30_000 }))).toEqual({ ok: false, reason: 'rate-limited' });
    expect(app.colls.write(b.account, LEADERBOARD_COLLECTION, row({ value: 41_000 }), first.id)).toEqual({ ok: false, reason: 'not-owner' });
    app.clock.t += 61_000;
    expect(app.colls.write(a.account, LEADERBOARD_COLLECTION, row({ value: 30_500 }), first.id)).toMatchObject({ ok: true });
    expect(app.colls.write(a.account, LEADERBOARD_COLLECTION, row({ route: 'RP-01', value: 90_000 }), first.id)).toEqual({ ok: false, reason: 'bad-row' });
  });
});

describe('daily boards', () => {
  const today = '2026-10-05';
  const name = dailyCollection(today);
  const spec = dailySpec(today);
  const drow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    day: today, route: spec.route, mode: spec.mode, car: spec.car, rule: spec.rule, value: spec.mode === 'time-trial' ? 70_000 : 800, pv: PV, ...over,
  });
  it('accepts today\'s challenge for any account (the daily car is lent), one row per player', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Daily_One');
    expect(app.colls.write(a.account, name, drow())).toMatchObject({ ok: true, kept: false });
    expect(app.colls.write(a.account, name, drow({ value: spec.mode === 'time-trial' ? 80_000 : 700 }))).toMatchObject({ ok: true, kept: true });
    const rows = app.colls.list(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: 'Daily_One', day: today, rule: spec.rule });
  });
  it('rejects another challenge, another day, and bad values', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Daily_Two');
    const w = (r: unknown, coll = name): unknown => { app.clock.t += 6000; const o = app.colls.write(a.account, coll, r); return o.ok ? 'ok' : o.reason; };
    expect(w(drow({ route: spec.route === 'HW-01' ? 'RP-01' : 'HW-01' }))).toBe('wrong-challenge');
    expect(w(drow({ car: spec.car === 'CAR-01' ? 'CAR-02' : 'CAR-01' }))).toBe('wrong-challenge');
    expect(w(drow({ rule: spec.rule === 'none' ? 'no-reset' : 'none' }))).toBe('wrong-challenge');
    expect(w(drow({ day: '2026-10-04' }))).toBe('wrong-challenge');
    expect(w(drow({ value: 5 }))).toBe('implausible');
    expect(w(drow({ pv: 'x' }))).toBe('implausible');
    expect(w(drow(), dailyCollection('2026-10-03'))).toBe('day-closed');
    expect(w(drow(), dailyCollection('2026-10-09'))).toBe('day-closed');
    expect(app.colls.list(name)).toHaveLength(0);
  });
  it('accepts yesterday for ten minutes after midnight and keeps the best 200', () => {
    const app = makeApp();
    app.clock.t = Date.UTC(2026, 9, 6, 0, 5);
    const acc = bulkAccount(app);
    const out = app.colls.write(acc, name, drow());
    expect(out.ok).toBe(true);
    app.clock.t = T0;
    for (let i = 0; i < KEEP_DAILY + 5; i++) { app.clock.t += 6000; app.colls.write(bulkAccount(app), name, drow({ value: spec.mode === 'time-trial' ? 90_000 - i : 500 + i })); }
    expect(app.colls.list(name).length).toBeLessThanOrEqual(KEEP_DAILY);
  });
  it('prunes boards older than three days', () => {
    const app = makeApp();
    const acc = bulkAccount(app);
    app.db.prepare("INSERT INTO coll_rows (coll, id, account_id, username, rkey, value, created_at, data) VALUES ('lateral_daily_v1_20260930', 'x', ?, 'u', 'd', 1, 'z', '{}')").run(acc.id);
    app.db.prepare("INSERT INTO coll_rows (coll, id, account_id, username, rkey, value, created_at, data) VALUES ('lateral_daily_v1_20261004', 'y', ?, 'u', 'd', 1, 'z', '{}')").run(acc.id);
    expect(app.colls.prune(3)).toBe(1);
    expect(app.colls.rowCount()).toBe(1);
  });
});

describe('ghosts', () => {
  it('accepts a real ghost for a top time, lists it as a stub and serves the payload on demand', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Ghost_One');
    const g = ghostRow(40);
    const out = app.colls.write(a.account, GHOST_COLLECTION, g) as { ok: true; id: string };
    expect(out.ok).toBe(true);
    const listed = app.colls.list(GHOST_COLLECTION)[0]!;
    expect(listed.g).toBe('g2:');
    expect(listed).toMatchObject({ n: g.n, d: g.d, rv: 'r1', username: 'Ghost_One' });
    const full = app.colls.get(GHOST_COLLECTION, out.id)!;
    expect(full.g).toBe(g.g);
  });
  it('rejects corrupt, oversize, mismatched and too-fast ghosts', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Ghost_Two');
    const w = (r: unknown): unknown => { app.clock.t += 6000; const o = app.colls.write(a.account, GHOST_COLLECTION, r); return o.ok ? 'ok' : o.reason; };
    const g = ghostRow(40);
    expect(w({ ...g, g: (g.g as string).slice(0, -8) })).toBe('ghost-invalid');
    expect(w({ ...g, g: `g2:${'A'.repeat(72_100)}` })).toBe('ghost-size');
    expect(w({ ...g, g: 'plain' })).toBe('ghost-size');
    expect(w({ ...g, d: 90 })).toBe('bad-row');
    expect(w({ ...g, n: 5 })).toBe('ghost-invalid');
    expect(w({ ...g, rv: 'bad id' })).toBe('bad-row');
    expect(w({ ...g, mode: 'drift-attack' })).toBe('bad-row');
    expect(w({ ...g, value: 1000, d: 1 })).toBe('implausible');
    expect(w({ ...g, car: 'CAR-02' })).toBe('car-not-owned');
    expect(app.colls.rowCount()).toBe(0);
  });
  it('only a time inside the route\'s top 20 carries a ghost', () => {
    const app = makeApp();
    for (let i = 0; i < KEEP_GHOSTS; i++) { app.clock.t += 6000; app.colls.write(bulkAccount(app), LEADERBOARD_COLLECTION, row({ value: 36_000 + i * 100 })); }
    const a = bulkAccount(app);
    app.clock.t += 6000;
    expect(app.colls.write(a, GHOST_COLLECTION, ghostRow(40))).toEqual({ ok: false, reason: 'not-top' }); // 40.0 s is slower than the 20th time
    app.clock.t += 6000;
    expect(app.colls.write(a, GHOST_COLLECTION, ghostRow(34))).toMatchObject({ ok: true });
  });
});

describe('collections over the socket', () => {
  it('creates over the wire, replies with the request id and sends diffs to subscribers at most once a second', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Wire_One'), b = await newAccount(app, 'Wire_Two');
    const ca = connectClient(app, a.token, 'Wire_One', '10.4.0.1'), cb = connectClient(app, b.token, 'Wire_Two', '10.4.0.2');
    cb.send({ t: 'c', n: LEADERBOARD_COLLECTION, op: 'sub', r: 'sub' });
    ca.send({ t: 'c', n: LEADERBOARD_COLLECTION, op: 'create', r: 9, data: row() });
    expect(ca.sock.ofType('C').pop()).toMatchObject({ n: LEADERBOARD_COLLECTION, r: 9, ok: true, kept: false });
    cb.sock.clear();
    advance(app, 1100);
    const diff = cb.sock.ofType('C');
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ up: [{ username: 'Wire_One', value: 45_000 }], del: [] });
    app.clock.t += 6000;
    ca.send({ t: 'c', n: LEADERBOARD_COLLECTION, op: 'create', r: 10, data: row({ value: 44_000 }) });
    cb.send({ t: 'c', n: LEADERBOARD_COLLECTION, op: 'create', r: 11, data: row({ value: 43_000 }) });
    ca.send({ t: 'c', n: LEADERBOARD_COLLECTION, op: 'get', id: 'nope', r: 12 });
    expect(ca.sock.ofType('C').pop()).toMatchObject({ ok: false, reason: 'not-found' });
    cb.sock.clear();
    advance(app, 1100);
    const merged = cb.sock.ofType('C').filter(f => f.up);
    expect(merged).toHaveLength(1);
    expect(merged[0].up.map((r: { value: number }) => r.value).sort()).toEqual([43_000, 44_000]);
  });
});
