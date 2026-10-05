import { describe, expect, it } from 'vitest';
import { applyPurchase, emptyWallet } from '../../src/economy/wallet';
import { encodeLoadout } from '../../src/economy/catalog';
import type { WalletRecord } from '../../src/economy/types';
import { CLOSE, MAX_FRAME, cleanProgress } from '../../server/hub';
import { advance, connectClient, makeApp, newAccount, T0, type App, type Client, FakeSock } from './helpers';

const STATE = Array.from({ length: 13 }, (_, i) => i);
let counter = 0;
async function join(app: App, name?: string, ip?: string): Promise<Client> {
  const n = name ?? `Pilot_${++counter}`;
  const acc = await newAccount(app, n);
  const c = connectClient(app, acc.token, n, ip ?? `10.1.${counter % 250}.${Math.floor(counter / 250) + 1}`);
  return c;
}
const lobbyRec = { ph: 'w', race: 1, mode: 'time-trial', route: 'HW-01', at: 0, t: T0, rt: 0, ff: 0, g: '' };
function openLobby(app: App, host: Client, id = 'lobby1'): void {
  host.send({ t: 'r', d: { lobbies: { [id]: lobbyRec } } });
  host.send({ t: 'p', d: { on: 1, lb: id, rd: -1 } });
  advance(app, 300);
}
const statesTo = (c: Client): Array<[string, any]> => c.sock.ofType('M').flatMap(f => (f.b ?? [[f.f, f.d]]) as Array<[string, any]>).filter(([, d]) => d.type === 's'); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('hub: hello and limits', () => {
  it('welcomes a good token with id, serverTime and the presence map', async () => {
    const app = makeApp();
    const a = await join(app, 'First_One');
    const w = a.sock.ofType('w')[0];
    expect(w).toMatchObject({ v: 1, id: a.id, name: 'First_One', serverTime: T0 });
    expect(w.presence[a.id]).toMatchObject({ u: 'First_One', on: 0 });
    const b = await join(app, 'Second_One');
    expect(b.sock.ofType('w')[0].presence[a.id].u).toBe('First_One');
    advance(app, 100);
    expect(a.sock.ofType('P').some(f => f.d[b.id]?.u === 'Second_One')).toBe(true);
  });
  it('closes a bad token, a banned account and a non-hello first frame', async () => {
    const app = makeApp();
    const bad = connectClient(app, 'x'.repeat(43), 'nobody');
    expect(bad.sock.closed?.code).toBe(CLOSE.auth);
    expect(bad.sock.ofType('err')[0].code).toBe('auth');
    const acc = await newAccount(app, 'Banned_One');
    app.accounts.setBanned('Banned_One', true);
    const sock = new FakeSock();
    const conn = app.hub.connect(sock, '1.2.3.4')!;
    app.hub.receive(conn, JSON.stringify({ t: 'h', token: acc.token, v: 1 }));
    expect(sock.closed?.code).toBe(CLOSE.auth); // the ban dropped the token
    const acc2 = await newAccount(app, 'Banned_Two');
    const sock2 = new FakeSock(); const conn2 = app.hub.connect(sock2, '1.2.3.5')!;
    app.db.prepare('UPDATE accounts SET banned = 1 WHERE id = ?').run(acc2.id);
    app.hub.receive(conn2, JSON.stringify({ t: 'h', token: acc2.token, v: 1 }));
    expect(sock2.closed?.code).toBe(CLOSE.banned);
    const early = new FakeSock(); const c3 = app.hub.connect(early, '1.2.3.6')!;
    app.hub.receive(c3, JSON.stringify({ t: 'p', d: { on: 1 } }));
    expect(early.closed?.code).toBe(CLOSE.auth);
  });
  it('drops a socket that never says hello within 5 s', () => {
    const app = makeApp();
    const sock = new FakeSock(); app.hub.connect(sock, '1.1.1.1');
    advance(app, 4000); expect(sock.closed).toBeNull();
    advance(app, 2500); expect(sock.closed?.code).toBe(CLOSE.timeout);
  });
  it('closes oversize frames, invalid json and non-object frames', async () => {
    const app = makeApp();
    const a = await join(app);
    app.hub.receive(a.conn, 'x'.repeat(MAX_FRAME + 1));
    expect(a.sock.closed?.code).toBe(CLOSE.badFrame);
    const b = await join(app);
    app.hub.receive(b.conn, '{not json');
    expect(b.sock.closed?.code).toBe(CLOSE.badFrame);
    const c = await join(app);
    app.hub.receive(c.conn, '[1,2]');
    expect(c.sock.closed?.code).toBe(CLOSE.badFrame);
  });
  it('allows 3 sockets per IP, 400 in total, and replaces the oldest of one account', async () => {
    const app = makeApp({ MAX_CONN_TOTAL: '5' });
    const socks = [1, 2, 3, 4].map(() => app.hub.connect(new FakeSock(), '5.5.5.5'));
    expect(socks.filter(Boolean)).toHaveLength(3);
    app.hub.connect(new FakeSock(), '6.6.6.6'); app.hub.connect(new FakeSock(), '6.6.6.7');
    expect(app.hub.connect(new FakeSock(), '6.6.6.8')).toBeNull();
    const app2 = makeApp();
    const acc = await newAccount(app2, 'Multi_Tab');
    const tabs = [1, 2, 3, 4].map(i => connectClient(app2, acc.token, 'Multi_Tab', `7.7.7.${i}`));
    expect(tabs[0]!.sock.closed?.code).toBe(CLOSE.replaced);
    expect(tabs[3]!.sock.closed).toBeNull();
    expect(app2.hub.onlineCount()).toBe(3);
  });
  it('pings every 20 s and drops after 45 s of silence', async () => {
    const app = makeApp();
    const a = await join(app);
    advance(app, 21_000);
    expect(a.sock.ofType('ping').length).toBeGreaterThanOrEqual(1);
    a.send({ t: 'pong' });
    advance(app, 30_000);
    expect(a.sock.closed).toBeNull();
    advance(app, 20_000);
    expect(a.sock.closed?.code).toBe(CLOSE.timeout);
    expect(app.hub.onlineCount()).toBe(0);
  });
});

describe('hub: presence is server stamped', () => {
  it('ignores client identity fields and takes the loadout from the wallet', async () => {
    const app = makeApp();
    const acc = await newAccount(app, 'Stamp_One');
    let rec: WalletRecord = { ...emptyWallet(T0 - 1000), earned: { welcome: 1500 }, claims: ['welcome:gift'], receipts: ['welcome:gift'] };
    const bought = applyPurchase(rec, 'oxide-copper', 1500, T0); if (!bought.ok) throw new Error('x');
    rec = { ...bought.record, equipped: { paint: 'oxide-copper' } };
    expect(app.wallets.write(acc.id, rec, 0).ok).toBe(true);
    const c = connectClient(app, acc.token, 'Stamp_One');
    expect(c.sock.ofType('w')[0].presence[c.id].pt).toBe(encodeLoadout({ paint: 'oxide-copper' }));
    c.send({ t: 'p', d: { on: 1, u: 'Louis', pt: '~gold-chrome', name: 'Louis', admin: true, car: 2 } });
    advance(app, 300);
    const mine = app.hub.presenceOf(c.conn);
    expect(mine).toMatchObject({ u: 'Stamp_One', on: 1, car: 0, pt: encodeLoadout({ paint: 'oxide-copper' }) });
    expect(Object.keys(mine).sort()).toEqual(['car', 'lb', 'on', 'pt', 'rd', 'u']);
  });
  it('allows an owned car and refreshes the look when the wallet changes', async () => {
    const app = makeApp();
    const acc = await newAccount(app, 'Garage_One');
    const c = connectClient(app, acc.token, 'Garage_One');
    c.send({ t: 'p', d: { car: 1 } });
    expect(app.hub.presenceOf(c.conn).car).toBe(0); // CAR-02 is not owned
    app.gifts.claimDirect(acc.account, app.gifts.createDirect('louis', 'Garage_One', { items: ['car-cybertruck'] }).id);
    expect(c.sock.ofType('wallet').length).toBeGreaterThan(0);
    c.send({ t: 'p', d: { car: 1 } });
    expect(app.hub.presenceOf(c.conn).car).toBe(1);
  });
  it('pushes a wallet notice for server credits and inbox gifts', async () => {
    const app = makeApp();
    const a = await join(app, 'Push_One');
    a.sock.clear();
    const acc = app.accounts.byName('Push_One')!;
    app.gifts.createDirect('louis', 'Push_One', { marks: 10 });
    expect(a.sock.ofType('wallet')[0]).toMatchObject({ inbox: true });
    a.sock.clear();
    app.wallets.claimTestGrant(acc.id);
    expect(a.sock.ofType('wallet')[0]).toMatchObject({ version: 1 });
    expect(a.sock.ofType('wallet')[0].inbox).toBeUndefined();
  });
  it('tells everyone when a peer leaves', async () => {
    const app = makeApp();
    const a = await join(app), b = await join(app);
    advance(app, 100); a.sock.clear();
    app.hub.disconnect(b.conn);
    advance(app, 300);
    expect(a.sock.ofType('P').some(f => f.d[b.id] === null)).toBe(true);
  });
  it('validates presence fields', async () => {
    const app = makeApp();
    const a = await join(app);
    a.send({ t: 'p', d: { on: 5, rd: 'x', car: -1, ab: -3, rp: [1, 2], pg: 'a', lb: 'bad id!' } });
    expect(app.hub.presenceOf(a.conn)).toMatchObject({ on: 0, rd: -1, car: 0 });
    expect(cleanProgress([1, 2, 3, 4, 5, 1])).toEqual([1, 2, 3, 4, 5, 1]);
    expect(cleanProgress([1, 2, 3, 4, 5, 9])).toEqual([1, 2, 3, 4, 5]);
    expect(cleanProgress([1, 2, NaN, 4, 5])).toBeUndefined();
    expect(cleanProgress('x')).toBeUndefined();
    expect(cleanProgress(null)).toBeNull();
    a.send({ t: 'p', d: { ab: 12, rd: 3 } });
    expect(app.hub.presenceOf(a.conn)).toMatchObject({ ab: 12, rd: 3 });
  });
});

describe('hub: interest management', () => {
  it('relays car state only inside the sender lobby, batched per tick', async () => {
    const app = makeApp();
    const [a, b, c] = [await join(app), await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } }); c.send({ t: 'p', d: { on: 1 } });
    advance(app, 300);
    [a, b, c].forEach(x => x.sock.clear());
    a.send({ t: 'm', d: { type: 's', d: STATE } });
    expect(b.sock.frames.filter(f => f.t === 'M')).toHaveLength(0); // not before the tick
    advance(app, 50);
    expect(statesTo(b)).toEqual([[a.id, { type: 's', d: STATE }]]);
    expect(statesTo(c)).toHaveLength(0);
    expect(statesTo(a)).toHaveLength(0); // no echo to the sender
    expect(b.sock.ofType('M')[0]).toHaveProperty('b');
  });
  it('keeps only the latest state per sender per tick and one frame per recipient', async () => {
    const app = makeApp();
    const [a, b, c] = [await join(app), await join(app), await join(app)];
    openLobby(app, a);
    for (const x of [b, c]) x.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    [a, b, c].forEach(x => x.sock.clear());
    a.send({ t: 'm', d: { type: 's', d: STATE } });
    a.send({ t: 'm', d: { type: 's', d: STATE.map(v => v + 100) } });
    b.send({ t: 'm', d: { type: 's', d: STATE.map(v => v + 200) } });
    advance(app, 50);
    expect(b.sock.ofType('M')).toHaveLength(1);
    expect(c.sock.ofType('M')).toHaveLength(1);
    expect(c.sock.ofType('M')[0].b).toHaveLength(2);
    expect(statesTo(b).map(([f]) => f)).toEqual([a.id]);
    expect(statesTo(b)[0]![1].d[0]).toBe(100);
  });
  it('drops messages with no lobby and no recipient, and unknown or malformed types', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    a.send({ t: 'm', d: { type: 's', d: STATE } });
    a.send({ t: 'm', d: { type: 'x', d: 1 } });
    a.send({ t: 'm', d: { type: 's', d: [1, 2, 3] } });
    a.send({ t: 'm', d: { type: 's', d: STATE.map(() => 'x') } });
    a.send({ t: 'm', d: 'str' });
    advance(app, 100);
    expect(b.sock.ofType('M')).toHaveLength(0);
  });
  it('routes a `to` message only to that peer, and only inside the lobby unless it is a handshake', async () => {
    const app = makeApp();
    const [a, b, c] = [await join(app), await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    [a, b, c].forEach(x => x.sock.clear());
    a.send({ t: 'm', d: { type: 'p', n: 7, to: c.id } });   // handshake crosses lobbies
    a.send({ t: 'm', d: { type: 'q', n: 7, th: 5, to: c.id } });
    a.send({ t: 'm', d: { type: 's', d: STATE, to: c.id } }); // car state does not
    a.send({ t: 'm', d: { type: 'h', to: c.id } });
    expect(c.sock.ofType('M').map(f => f.d.type)).toEqual(['p', 'q', 'h']);
    expect(c.sock.ofType('M')[0]).toMatchObject({ f: a.id, d: { type: 'p', n: 7, to: c.id } });
    expect(b.sock.ofType('M')).toHaveLength(0);
    a.send({ t: 'm', d: { type: 'p', n: 1, to: 'nobody' } });
    a.send({ t: 'm', d: { type: 'p', n: 'x', to: b.id } });
  });
  it('stamps the sender id and strips client supplied f and clientId', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300); b.sock.clear();
    a.send({ t: 'm', d: { type: 'h', f: 'spoof', clientId: 'spoof', extra: 'x'.repeat(50) } });
    expect(b.sock.ofType('M')[0]).toEqual({ t: 'M', f: a.id, d: { type: 'h' } });
  });
  it('sends hub presence to everyone and race fields only to the lobby, with a snapshot for joiners', async () => {
    const app = makeApp();
    const [a, b, c] = [await join(app), await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    [a, b, c].forEach(x => x.sock.clear());
    a.send({ t: 'p', d: { rp: [1, 0, 50, 0, 0], pg: 33, car: 0 } });
    advance(app, 300);
    const raceFor = (x: Client): unknown[] => x.sock.ofType('P').map(f => f.d[a.id]).filter(p => p && p.rp);
    expect(raceFor(b)).toHaveLength(1);
    expect(raceFor(c)).toHaveLength(0);
    const d = await join(app);
    d.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    expect(d.sock.ofType('P').some(f => f.d[a.id]?.rp)).toBe(true); // snapshot of members' race fields
    expect(app.hub.lobbyMembers('lobby1')).toHaveLength(3);
  });
  it('coalesces presence to 4 Hz per sender for the hub and 10 Hz for race fields', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 1000);
    b.sock.clear();
    for (let i = 0; i < 20; i++) { a.send({ t: 'p', d: { rd: i } }); advance(app, 50); }
    const lows = b.sock.ofType('P').filter(f => f.d[a.id]?.rd !== undefined);
    expect(lows.length).toBeGreaterThanOrEqual(3); expect(lows.length).toBeLessThanOrEqual(5);
    expect(lows[lows.length - 1]!.d[a.id].rd).toBeGreaterThanOrEqual(15);
    b.sock.clear();
    for (let i = 0; i < 20; i++) { a.send({ t: 'p', d: { rp: [1, 0, i, 0, 0] } }); advance(app, 50); app.clock.t += 0; }
    const race = b.sock.ofType('P').filter(f => f.d[a.id]?.rp);
    expect(race.length).toBeGreaterThanOrEqual(8); expect(race.length).toBeLessThanOrEqual(11);
  });
});

describe('hub: lobbies', () => {
  it('rejects joining a missing or full lobby with a corrective presence', async () => {
    const app = makeApp();
    const host = await join(app);
    openLobby(app, host);
    const members = [host];
    for (let i = 0; i < 7; i++) { const m = await join(app); m.send({ t: 'p', d: { on: 1, lb: 'lobby1' } }); members.push(m); }
    expect(app.hub.lobbyMembers('lobby1')).toHaveLength(8);
    const late = await join(app);
    late.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    expect(late.sock.ofType('err').some(f => f.code === 'lobby-full')).toBe(true);
    expect(app.hub.presenceOf(late.conn).lb).toBe('');
    late.send({ t: 'p', d: { lb: 'ghostlobby' } });
    expect(late.sock.ofType('err').some(f => f.code === 'no-lobby')).toBe(true);
  });
  it('caps the number of lobbies and validates records', async () => {
    const app = makeApp({ MAX_LOBBIES: '3' });
    const a = await join(app);
    for (let i = 0; i < 5; i++) { a.send({ t: 'r', d: { lobbies: { [`l${i}`]: lobbyRec } } }); advance(app, 300); }
    expect(app.hub.lobbyCount()).toBe(3);
    expect(a.sock.ofType('err').some(f => f.code === 'lobbies-full')).toBe(true);
    a.send({ t: 'r', d: { lobbies: { bad: { ...lobbyRec, route: 'ZZ-99' } } } });
    a.send({ t: 'r', d: { lobbies: { bad2: { ph: 'q', race: 1 } } } });
    a.send({ t: 'r', d: { lobbies: { 'bad id': lobbyRec } } });
    a.send({ t: 'r', d: { other: 1 } });
    advance(app, 300);
    expect(app.hub.lobbyCount()).toBe(3);
  });
  it('lets only members edit a live lobby, deletes only empty ones, reaps stale ones, and diffs to everyone', async () => {
    const app = makeApp();
    const [a, b, watcher] = [await join(app), await join(app), await join(app)];
    openLobby(app, a);
    watcher.sock.clear();
    b.send({ t: 'r', d: { lobbies: { lobby1: { ph: 'r' } } } });   // not a member
    b.send({ t: 'r', d: { lobbies: { lobby1: null } } });
    a.send({ t: 'r', d: { lobbies: { lobby1: null } } });          // a member may not delete a live lobby
    advance(app, 300);
    expect(app.hub.lobbyCount()).toBe(1);
    expect(watcher.sock.ofType('R')).toHaveLength(0);
    a.send({ t: 'r', d: { lobbies: { lobby1: { ph: 's', at: 123 } } } });
    advance(app, 300);
    expect(watcher.sock.ofType('R')[0].d.lobbies.lobby1).toEqual({ ph: 's', at: 123 });
    a.send({ t: 'p', d: { lb: '' } });
    advance(app, 40_000);
    expect(app.hub.lobbyCount()).toBe(0);
    expect(watcher.sock.ofType('R').some(f => f.d.lobbies.lobby1 === null)).toBe(true);
  });
  it('shows lobbies in the welcome of a later joiner', async () => {
    const app = makeApp();
    const a = await join(app);
    openLobby(app, a);
    const b = await join(app);
    expect(b.sock.ofType('w')[0].room.lobbies.lobby1).toMatchObject({ ph: 'w', race: 1, route: 'HW-01' });
  });
});

describe('hub: rate limits and backpressure', () => {
  it('limits car state to about 20 per second and closes a flooder', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    let delivered = 0;
    for (let i = 0; i < 5; i++) {
      b.sock.clear();
      for (let k = 0; k < 100; k++) a.send({ t: 'm', d: { type: 's', d: STATE } });
      advance(app, 50);
      delivered += statesTo(b).length;
    }
    expect(delivered).toBeLessThanOrEqual(5);
    expect(app.hub.droppedFrames).toBeGreaterThan(300);
    expect(a.sock.closed?.code).toBe(CLOSE.rate);
  });
  it('limits presence to 10 per second', async () => {
    const app = makeApp();
    const a = await join(app);
    for (let i = 0; i < 40; i++) a.send({ t: 'p', d: { rd: i } });
    expect(app.hub.presenceOf(a.conn).rd).toBeLessThan(20);
  });
  it('limits collection ops to about 5 per second', async () => {
    const app = makeApp();
    const a = await join(app);
    a.sock.clear();
    for (let i = 0; i < 30; i++) a.send({ t: 'c', n: 'lateral_best_v1', op: 'list', r: i });
    expect(a.sock.ofType('C').length).toBeLessThanOrEqual(9);
  });
  it('drops state frames to a backed up socket and closes it after 5 s', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    b.sock.bufferedAmount = 200_000; b.sock.clear();
    a.send({ t: 'm', d: { type: 's', d: STATE } });
    advance(app, 50);
    expect(statesTo(b)).toHaveLength(0);
    expect(app.hub.droppedFrames).toBeGreaterThan(0);
    for (let i = 0; i < 6000 / 50; i++) { a.send({ t: 'm', d: { type: 's', d: STATE } }); advance(app, 50); a.send({ t: 'pong' }); b.send({ t: 'pong' }); }
    expect(b.sock.closed?.code).toBe(CLOSE.backedUp);
    expect(a.sock.closed).toBeNull();
  });
  it('recovers when the socket drains in time', async () => {
    const app = makeApp();
    const [a, b] = [await join(app), await join(app)];
    openLobby(app, a);
    b.send({ t: 'p', d: { on: 1, lb: 'lobby1' } });
    advance(app, 300);
    b.sock.bufferedAmount = 200_000;
    a.send({ t: 'm', d: { type: 's', d: STATE } }); advance(app, 100);
    b.sock.bufferedAmount = 0; b.sock.clear();
    advance(app, 3000);
    a.send({ t: 'm', d: { type: 's', d: STATE } }); advance(app, 100);
    expect(statesTo(b)).toHaveLength(1);
    expect(b.sock.closed).toBeNull();
  });
});

describe('hub: collections over the socket', () => {
  it('subscribes with a full snapshot and answers unknown collections and ops', async () => {
    const app = makeApp();
    const a = await join(app);
    a.send({ t: 'c', n: 'lateral_best_v1', op: 'sub', r: 1 });
    expect(a.sock.ofType('C')[0]).toMatchObject({ n: 'lateral_best_v1', r: 1, ok: true, full: true, rows: [] });
    a.send({ t: 'c', n: 'nope', op: 'sub', r: 2 });
    expect(a.sock.ofType('C')[1]).toMatchObject({ ok: false, reason: 'no-such-collection' });
    app.clock.t += 1000;
    a.send({ t: 'c', n: 'lateral_best_v1', op: 'zzz', r: 3 });
    expect(a.sock.ofType('C')[2]).toMatchObject({ ok: false, reason: 'bad-op' });
  });
  it('limits subscriptions to 4 per socket', async () => {
    const app = makeApp();
    const a = await join(app);
    for (let i = 0; i < 6; i++) { app.clock.t += 250; a.send({ t: 'c', n: `lateral_daily_v1_2026100${i + 1}`, op: 'sub', r: i }); }
    const replies = a.sock.ofType('C');
    expect(replies.filter(r => r.ok).length).toBe(4);
    expect(replies[4]).toMatchObject({ ok: false, reason: 'too-many-subscriptions' });
  });
});
