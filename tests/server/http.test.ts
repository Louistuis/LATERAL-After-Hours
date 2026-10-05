import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config';
import { FakeTransport } from '../../server/mailer';
import { startServer, type Running } from '../../server/server';
import { WebSocket } from '../../server/ws-client';
import { silentLog } from '../../server/util';
import { applyGrant, emptyWallet } from '../../src/economy/wallet';

const running: Running[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

async function boot(env: Record<string, string> = {}, transport?: FakeTransport): Promise<{ base: string; ws: string; srv: Running }> {
  const cfg = loadConfig({
    DB_PATH: ':memory:', HOSTS: '127.0.0.1', PORT: '0', PUBLIC_URL: 'https://lateral.example.test', PROXY_KEY: 'proxy-key-for-tests', ADMIN_KEY: 'cli-key-for-tests',
    ADMIN_PROXY_IPS: '127.0.0.1', ADMIN_EMAILS: 'louis@example.test', ADMIN_ORIGIN: 'https://files.example.test', ...env,
  });
  const srv = await startServer(cfg, { log: silentLog, transport: transport ?? null });
  running.push(srv);
  const port = srv.ports[0]!;
  return { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, srv };
}
interface Res { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(base: string, method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers };
  const res = await fetch(base + path, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await res.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const proxy = (over: Record<string, string> = {}): Record<string, string> => ({ 'x-lateral-proxy-key': 'proxy-key-for-tests', 'x-lateral-admin-email': 'louis@example.test', 'x-lateral-admin': '1', origin: 'https://files.example.test', ...over });
let seq = 0;
const ip = (): Record<string, string> => ({ 'x-real-ip': `10.20.${Math.floor(++seq / 200)}.${seq % 200 + 1}` });
async function signup(base: string, name: string): Promise<{ token: string; id: string; recoveryCode: string }> {
  const r = await call(base, 'POST', '/api/v1/account', { body: { name }, headers: ip() });
  expect(r.status).toBe(201);
  return { token: r.body.token, id: r.body.accountId, recoveryCode: r.body.recoveryCode };
}

describe('http: public', () => {
  it('serves health and config without auth and with safe headers', async () => {
    const { base } = await boot();
    const h = await call(base, 'GET', '/api/v1/health');
    expect(h.status).toBe(200); expect(h.body).toMatchObject({ ok: true, version: '1.0.0' });
    expect(h.headers.get('cache-control')).toBe('no-store');
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    expect(h.headers.get('access-control-allow-origin')).toBeNull();
    expect((await call(base, 'GET', '/api/v1/config')).body).toEqual({ testGrant: { marks: 20000, open: true }, emailGifts: false, version: '1.0.0', protocol: 1 });
    expect((await call(base, 'GET', '/nope')).status).toBe(404);
    expect((await call(base, 'GET', '/api/v1/nope')).status).toBe(401); // unknown routes need a sign in first
    expect((await call(base, 'GET', '/api/v1/me')).status).toBe(401);
  });
  it('creates an account, recovers it, regenerates the code and signs out', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Http_One');
    expect((await call(base, 'GET', '/api/v1/me', { token: a.token })).body).toMatchObject({ name: 'Http_One', admin: false });
    expect((await call(base, 'POST', '/api/v1/account', { body: { name: 'http_one' }, headers: ip() })).body.error).toBe('name-taken');
    const rec = await call(base, 'POST', '/api/v1/recover', { body: { name: 'HTTP_ONE', recoveryCode: a.recoveryCode }, headers: ip() });
    expect(rec.status).toBe(200);
    const bad = await call(base, 'POST', '/api/v1/recover', { body: { name: 'http_one', recoveryCode: 'AAAA-AAAA-AAAA-AAAA' }, headers: ip() });
    expect(bad.status).toBe(401);
    const regen = await call(base, 'POST', '/api/v1/recovery/regenerate', { body: {}, token: rec.body.token });
    expect(regen.body.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect((await call(base, 'POST', '/api/v1/logout', { body: {}, token: rec.body.token })).status).toBe(200);
    expect((await call(base, 'GET', '/api/v1/me', { token: rec.body.token })).status).toBe(401);
  });
  it('validates bodies: type, size, json, and strange tokens', async () => {
    const { base } = await boot();
    expect((await call(base, 'POST', '/api/v1/account', { raw: 'not json', headers: ip() })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/account`, { method: 'POST', headers: { 'content-type': 'text/plain', ...ip() }, body: '{"name":"abc"}' })).status).toBe(415);
    expect((await call(base, 'POST', '/api/v1/account', { raw: JSON.stringify({ name: 'x'.repeat(200_000) }), headers: ip() })).status).toBe(413);
    expect((await call(base, 'GET', '/api/v1/me', { headers: { authorization: 'Bearer short' } })).status).toBe(401);
    expect((await call(base, 'GET', '/api/v1/me', { headers: { authorization: 'Basic abcdefghijklmnopqrstuvwxyz' } })).status).toBe(401);
    expect((await call(base, 'POST', '/api/v1/account', { body: [1, 2], headers: ip() })).status).toBe(400);
  });
  it('trusts X-Real-IP only from a trusted proxy socket', async () => {
    const trusting = await boot({ ACCOUNTS_PER_IP_HOUR: '2' });
    for (let i = 0; i < 3; i++) expect((await call(trusting.base, 'POST', '/api/v1/account', { body: { name: `Real_${i}` }, headers: { 'x-real-ip': `10.7.7.${i}` } })).status).toBe(201);
    const strict = await boot({ ACCOUNTS_PER_IP_HOUR: '2', TRUSTED_PROXIES: '203.0.113.7' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await call(strict.base, 'POST', '/api/v1/account', { body: { name: `Spoof_${i}` }, headers: { 'x-real-ip': `10.8.8.${i}` } })).status);
    expect(codes).toEqual([201, 201, 429]);
  });
});

describe('http: wallet, test grant and gifts', () => {
  it('runs the whole wallet loop: starter gift, stale version, testgrant, purchase, rejection', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Wallet_One');
    const first = await call(base, 'GET', '/api/v1/wallet', { token: a.token });
    expect(first.body).toMatchObject({ record: null, version: 0, serverCreatedAt: null, gifts: [], testGrant: { marks: 20000, open: true, claimed: false } });
    const now = Date.now();
    let rec = emptyWallet(now);
    rec = applyGrant(rec, { source: 'welcome', key: 'gift', amount: 1500, reason: 'x', permanent: true }, undefined, now, { maxGrant: 1500 }).record;
    const posted = await call(base, 'POST', '/api/v1/wallet', { token: a.token, body: { record: rec, expectVersion: 0 } });
    expect(posted.body).toMatchObject({ ok: true, version: 1 });
    const stale = await call(base, 'POST', '/api/v1/wallet', { token: a.token, body: { record: rec, expectVersion: 0 } });
    expect(stale.body).toMatchObject({ ok: false, reason: 'version', version: 1 });
    expect(stale.body.record.earned.welcome).toBe(1500);
    const grant = await call(base, 'POST', '/api/v1/wallet/testgrant', { token: a.token, body: {} });
    expect(grant.body).toMatchObject({ ok: true, granted: 20000, version: 2 });
    expect((await call(base, 'POST', '/api/v1/wallet/testgrant', { token: a.token, body: {} })).body.granted).toBe(0);
    const cheat = { ...grant.body.record, earned: { ...grant.body.record.earned, testgrant: 99999 } };
    expect((await call(base, 'POST', '/api/v1/wallet', { token: a.token, body: { record: cheat, expectVersion: 2 } })).body).toMatchObject({ ok: false, reason: 'server-only-source', version: 2 });
    expect((await call(base, 'POST', '/api/v1/wallet', { token: a.token, body: { record: grant.body.record, expectVersion: 'x' } })).status).toBe(400);
    expect((await call(base, 'GET', '/api/v1/wallet', { token: a.token })).body.testGrant.claimed).toBe(true);
  });
  it('limits wallet writes to 30 a minute', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Wallet_Two');
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await call(base, 'POST', '/api/v1/wallet', { token: a.token, body: { record: emptyWallet(Date.now()), expectVersion: 0 } })).status;
    expect(last).toBe(429);
  });
  it('closes the test grant from the environment', async () => {
    const { base } = await boot({ TEST_GRANT_MARKS: '0' });
    expect((await call(base, 'GET', '/api/v1/config')).body.testGrant).toEqual({ marks: 0, open: false });
    const a = await signup(base, 'Grant_Off');
    expect((await call(base, 'POST', '/api/v1/wallet/testgrant', { token: a.token, body: {} })).status).toBe(410);
  });
  it('delivers a direct gift, a code gift and an email gift end to end through the admin API', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Gift_Http');
    const sent = await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { to: 'gift_http', marks: 250, items: ['oxide-copper'], message: 'Hi' } });
    expect(sent.status).toBe(201);
    const inbox = (await call(base, 'GET', '/api/v1/wallet', { token: a.token })).body.gifts;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ marks: 250, items: ['oxide-copper'], message: 'Hi', from: 'Louis' });
    const claim = await call(base, 'POST', `/api/v1/gifts/${inbox[0].id}/claim`, { token: a.token, body: {} });
    expect(claim.body).toMatchObject({ ok: true, already: false, marks: 250, gained: ['oxide-copper'] });
    expect(claim.body.record.owned).toEqual(['oxide-copper']);
    expect((await call(base, 'POST', `/api/v1/gifts/${inbox[0].id}/claim`, { token: a.token, body: {} })).body.already).toBe(true);

    const code = await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { code: true, marks: 100, maxClaims: 2 } });
    expect(code.body.link).toMatch(/^https:\/\/lateral\.example\.test\/\?gift=LATERAL-/);
    expect((await call(base, 'GET', `/api/v1/gifts/preview?code=${code.body.gift.code}`)).body).toEqual({ state: 'open', from: 'Louis' });
    const red = await call(base, 'POST', '/api/v1/gifts/redeem', { token: a.token, body: { code: code.body.gift.code } });
    expect(red.body).toMatchObject({ ok: true, marks: 100 });
    expect((await call(base, 'POST', '/api/v1/gifts/redeem', { token: a.token, body: { code: 'LATERAL-AAAA-AAAA' } })).status).toBe(404);

    const mail = await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { email: 'friend@example.com', marks: 500, message: 'Welcome' } });
    expect(mail.body).toMatchObject({ ok: true, kind: 'email', emailSent: false, emailStatus: 'disabled' });
    expect(mail.body.message.text).toContain(mail.body.link);
    const list = await call(base, 'GET', '/api/v1/admin/gifts', { headers: proxy() });
    expect(list.body.gifts).toHaveLength(3);
    expect(JSON.stringify(list.body)).not.toContain('friend@example.com');
    const revoked = await call(base, 'POST', `/api/v1/admin/gift/${mail.body.gift.id}/revoke`, { headers: proxy(), body: {} });
    expect(revoked.body.gift.state).toBe('revoked');
    expect((await call(base, 'GET', `/api/v1/gifts/preview?code=${mail.body.gift.code}`)).body.state).toBe('revoked');
  });
  it('sends the email through the transport when enabled', async () => {
    const t = new FakeTransport();
    const { base } = await boot({ EMAIL_ENABLED: '1', MAIL_FROM: 'LATERAL <gifts@example.test>' }, t);
    const r = await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { email: 'friend@example.com', marks: 5 } });
    expect(r.body).toMatchObject({ emailSent: true, emailStatus: 'sent' });
    expect(t.sent).toHaveLength(1);
  });
});

describe('http: collections', () => {
  it('reads the leaderboard without auth and writes with a token', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Board_One');
    expect((await call(base, 'GET', '/api/v1/collections/lateral_best_v1')).body).toEqual({ rows: [] });
    const w = await call(base, 'POST', '/api/v1/collections/lateral_best_v1', { token: a.token, body: { data: { route: 'HW-01', mode: 'time-trial', value: 45_000, car: 'CAR-01', pv: (await import('../../src/vehicle/tune-identity')).VEHICLE_PHYSICS_VERSION } } });
    expect(w.body).toMatchObject({ ok: true });
    const rows = (await call(base, 'GET', '/api/v1/collections/lateral_best_v1?route=HW-01&mode=time-trial')).body.rows;
    expect(rows[0]).toMatchObject({ username: 'Board_One', value: 45_000 });
    expect((await call(base, 'GET', `/api/v1/collections/lateral_ghost_v1/${rows[0].id}`)).status).toBe(404);
    expect((await call(base, 'GET', '/api/v1/collections/other')).status).toBe(404);
    const bad = await call(base, 'POST', '/api/v1/collections/lateral_best_v1', { token: a.token, body: { data: { route: 'HW-01', mode: 'time-trial', value: 1, car: 'CAR-01', pv: 'x' } } });
    expect(bad.status).toBe(422);
  });
});

describe('http: admin', () => {
  it('serves the admin API to the proxy path with the key, mesh ip and email, and nobody else', async () => {
    const { base } = await boot();
    const ok = await call(base, 'GET', '/api/v1/admin/whoami', { headers: proxy() });
    expect(ok.body).toMatchObject({ who: 'louis@example.test', via: 'proxy', emailEnabled: false });
    for (const h of [{} as Record<string, string>, { 'x-lateral-proxy-key': 'wrong', 'x-lateral-admin-email': 'louis@example.test' }, { 'x-lateral-proxy-key': 'proxy-key-for-tests', 'x-lateral-admin-email': 'eve@example.test' }]) {
      expect([401, 403]).toContain((await call(base, 'GET', '/api/v1/admin/stats', { headers: h })).status);
    }
    const wrongIp = await boot({ ADMIN_PROXY_IPS: '192.168.100.1' });
    expect((await call(wrongIp.base, 'GET', '/api/v1/admin/stats', { headers: proxy() })).status).toBe(403);
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } })).status).toBe(401);
  });
  it('enforces the CSRF guard on writes and never changes state on GET', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Csrf_One');
    const attempt = (headers: Record<string, string>, extra: Record<string, string> = {}): Promise<Res> => call(base, 'POST', '/api/v1/admin/account/csrf_one/ban', { body: {}, headers: { ...proxy(), ...headers }, ...extra });
    expect((await attempt({ origin: 'https://evil.example.test' })).status).toBe(403);
    expect((await attempt({ 'x-lateral-admin': '' })).status).toBe(403);
    expect((await attempt({ 'content-type': 'text/plain' })).status).toBe(403);
    expect((await call(base, 'GET', '/api/v1/admin/account/csrf_one/ban', { headers: proxy() })).status).toBe(404);
    expect((await call(base, 'GET', '/api/v1/me', { token: a.token })).status).toBe(200);
    expect((await attempt({})).status).toBe(200);
    expect((await call(base, 'GET', '/api/v1/me', { token: a.token })).status).toBe(401); // banned: token dropped
  });
  it('accepts the CLI key only on loopback without proxy headers', async () => {
    const { base } = await boot();
    const key = { 'x-admin-key': 'cli-key-for-tests' };
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: key })).status).toBe(200);
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: { ...key, 'x-real-ip': '1.2.3.4' } })).status).toBe(403);
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: { ...key, 'x-forwarded-for': '1.2.3.4' } })).status).toBe(403);
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: { 'x-admin-key': 'nope' } })).status).toBe(401);
    const post = await call(base, 'POST', '/api/v1/admin/gift', { headers: key, body: { code: true, marks: 5 } });
    expect(post.status).toBe(201);
  });
  it('locks out an address after ten failed attempts', async () => {
    const { base } = await boot();
    for (let i = 0; i < 10; i++) await call(base, 'GET', '/api/v1/admin/stats', { headers: { 'x-admin-key': `bad${i}` } });
    expect((await call(base, 'GET', '/api/v1/admin/stats', { headers: { 'x-admin-key': 'cli-key-for-tests' } })).status).toBe(429);
  });
  it('lists accounts, shows the ledger, bans, renames, promotes and lists the catalog', async () => {
    const { base } = await boot();
    const a = await signup(base, 'Ledger_One');
    await call(base, 'POST', '/api/v1/wallet/testgrant', { token: a.token, body: {} });
    expect((await call(base, 'GET', '/api/v1/admin/accounts?q=ledger', { headers: proxy() })).body.accounts[0]).toMatchObject({ name: 'Ledger_One', banned: false });
    const led = await call(base, 'GET', '/api/v1/admin/ledger?name=ledger_one', { headers: proxy() });
    expect(led.body.balance).toBe(20000);
    expect(led.body.ledger[0]).toMatchObject({ kind: 'earn:testgrant', amount: 20000 });
    expect((await call(base, 'GET', '/api/v1/admin/ledger?name=nobody_x', { headers: proxy() })).status).toBe(404);
    expect((await call(base, 'POST', '/api/v1/admin/account/ledger_one/promote', { headers: proxy(), body: {} })).body.account.admin).toBe(true);
    expect((await call(base, 'GET', '/api/v1/me', { token: a.token })).body.admin).toBe(true);
    expect((await call(base, 'POST', '/api/v1/admin/account/ledger_one/ban', { headers: proxy(), body: {} })).status).toBe(409);
    await call(base, 'POST', '/api/v1/admin/account/ledger_one/demote', { headers: proxy(), body: {} });
    expect((await call(base, 'POST', '/api/v1/admin/account/ledger_one/rename', { headers: proxy(), body: { newName: 'Renamed_One' } })).body.account.name).toBe('Renamed_One');
    const cat = await call(base, 'GET', '/api/v1/admin/catalog', { headers: proxy() });
    expect(cat.body.items.length).toBeGreaterThan(40);
    expect(cat.body.items.every((i: { price: number }) => i.price > 0)).toBe(true);
    const stats = await call(base, 'GET', '/api/v1/admin/stats', { headers: proxy() });
    expect(stats.body).toMatchObject({ accounts: 1, online: 0 });
    expect((await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { marks: 5 } })).status).toBe(400);
    expect((await call(base, 'POST', '/api/v1/admin/gift', { headers: proxy(), body: { to: 'all-active-days:7', marks: 5 } })).body).toMatchObject({ kind: 'all', count: 1 });
  });
});

describe('websocket', () => {
  const open = (url: string, origin: string | null): Promise<{ ws: InstanceType<typeof WebSocket>; frames: any[]; closed: Promise<number> }> => new Promise((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(url, origin === null ? {} : { origin });
    const frames: unknown[] = [];
    const closed = new Promise<number>(r => ws.on('close', c => r(c)));
    ws.on('message', m => frames.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, frames, closed }));
    ws.on('error', reject);
  });
  const until = async (fn: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

  it('checks the Origin header', async () => {
    const { ws: url } = await boot();
    await expect(open(url, 'https://evil.example.test')).rejects.toThrow();
    await expect(open(url, null)).rejects.toThrow();
    await expect(open(url, 'http://localhost:3000')).rejects.toThrow();
    const c = await open(url, 'https://lateral.example.test');
    c.ws.close();
    const dev = await boot({ ALLOW_LOCAL_ORIGINS: '1' });
    const d = await open(dev.ws, 'http://localhost:5173');
    d.ws.close();
    await expect(open(dev.ws, 'http://localhost.evil.test')).rejects.toThrow();
  });
  it('rejects other paths on upgrade', async () => {
    const { ws: url } = await boot();
    await expect(open(url.replace('/ws', '/other'), 'https://lateral.example.test')).rejects.toThrow();
  });
  it('says hello, relays between two real sockets in a lobby and drops when text-only is violated', async () => {
    const { base, ws: url, srv } = await boot({ MAX_CONN_PER_IP: '10' });
    const a = await signup(base, 'Sock_One'), b = await signup(base, 'Sock_Two');
    const ca = await open(url, 'https://lateral.example.test'), cb = await open(url, 'https://lateral.example.test');
    ca.ws.send(JSON.stringify({ t: 'h', token: a.token, v: 1 })); cb.ws.send(JSON.stringify({ t: 'h', token: b.token, v: 1 }));
    await until(() => ca.frames.some(f => f.t === 'w') && cb.frames.some(f => f.t === 'w'));
    const ida = ca.frames.find(f => f.t === 'w').id as string;
    ca.ws.send(JSON.stringify({ t: 'r', d: { lobbies: { room1: { ph: 'w', race: 1, mode: 'time-trial', route: 'HW-01', at: 0, t: Date.now(), rt: 0, ff: 0, g: '' } } } }));
    ca.ws.send(JSON.stringify({ t: 'p', d: { on: 1, lb: 'room1' } }));
    await new Promise(r => setTimeout(r, 120));
    cb.ws.send(JSON.stringify({ t: 'p', d: { on: 1, lb: 'room1' } }));
    await new Promise(r => setTimeout(r, 120));
    ca.ws.send(JSON.stringify({ t: 'm', d: { type: 's', d: Array.from({ length: 13 }, (_, i) => i) } }));
    await until(() => cb.frames.some(f => f.t === 'M' && f.b));
    expect(cb.frames.find(f => f.t === 'M' && f.b).b[0][0]).toBe(ida);
    expect(srv.hub.onlineCount()).toBe(2);
    cb.ws.send(Buffer.from([1, 2, 3]));
    expect(await cb.closed).toBe(4400);
    ca.ws.send('x'.repeat(5000));
    expect(await ca.closed).toBe(1009);
    await until(() => srv.hub.onlineCount() === 0);
  });
  it('closes a bad token with 4401 and sends an error first', async () => {
    const { ws: url } = await boot();
    const c = await open(url, 'https://lateral.example.test');
    c.ws.send(JSON.stringify({ t: 'h', token: 'z'.repeat(43), v: 1 }));
    expect(await c.closed).toBe(4401);
    expect(c.frames[0]).toMatchObject({ t: 'err', code: 'auth' });
  });
});

