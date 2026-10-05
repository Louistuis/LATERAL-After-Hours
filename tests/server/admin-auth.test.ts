import { describe, expect, it } from 'vitest';
import { AdminAuth } from '../../server/admin-auth';
import { loadConfig } from '../../server/config';
import { ApiError } from '../../server/util';
import { T0 } from './helpers';

const cfg = loadConfig({ PROXY_KEY: 'proxy-key-for-tests', ADMIN_KEY: 'cli-key-for-tests', ADMIN_EMAILS: 'louis@example.test,Second@Example.test', ADMIN_ORIGIN: 'https://files.example.test' });
const proxyHeaders = (over: Record<string, string> = {}): Record<string, string> => ({ 'x-lateral-proxy-key': 'proxy-key-for-tests', 'x-lateral-admin-email': 'louis@example.test', ...over });
const post = (over: Record<string, string> = {}): Record<string, string> => proxyHeaders({ 'content-type': 'application/json', 'x-lateral-admin': '1', origin: 'https://files.example.test', ...over });
const MESH = '192.168.100.1';

async function code(p: Promise<unknown>): Promise<number | 'ok'> {
  try { await p; return 'ok'; } catch (e) { if (e instanceof ApiError) return e.status; throw e; }
}
const auth = (): AdminAuth => new AdminAuth(cfg, null, () => T0);

describe('admin auth: proxy path', () => {
  it('accepts the mesh IP with the right key and an allowed email', async () => {
    const who = await auth().authenticate('GET', proxyHeaders(), MESH);
    expect(who).toEqual({ via: 'proxy', who: 'louis@example.test' });
    expect((await auth().authenticate('GET', proxyHeaders({ 'x-lateral-admin-email': 'SECOND@example.test' }), `::ffff:${MESH}`)).who).toBe('second@example.test');
  });
  it('rejects the LAN and any other source IP even with the right key', async () => {
    for (const ip of ['192.168.86.40', '192.168.100.100', '10.0.0.5', '127.0.0.1', '', undefined]) expect(await code(auth().authenticate('GET', proxyHeaders(), ip))).toBe(403);
  });
  it('rejects a wrong or missing key', async () => {
    expect(await code(auth().authenticate('GET', proxyHeaders({ 'x-lateral-proxy-key': 'nope' }), MESH))).toBe(401);
    expect(await code(auth().authenticate('GET', { 'x-lateral-admin-email': 'louis@example.test' }, MESH))).toBe(401);
    expect(await code(auth().authenticate('GET', {}, MESH))).toBe(401);
  });
  it('rejects an email that is not on the list', async () => {
    expect(await code(auth().authenticate('GET', proxyHeaders({ 'x-lateral-admin-email': 'eve@example.test' }), MESH))).toBe(403);
    expect(await code(auth().authenticate('GET', proxyHeaders({ 'x-lateral-admin-email': '' }), MESH))).toBe(403);
  });
  it('rejects forged headers without the key', async () => {
    expect(await code(auth().authenticate('GET', { 'x-lateral-admin-email': 'louis@example.test', 'x-lateral-admin': '1' }, MESH))).toBe(401);
    expect(await code(auth().authenticate('GET', { 'x-lateral-admin-email': 'louis@example.test' }, '192.168.86.9'))).toBe(403);
  });
  it('is disabled entirely when no proxy key is configured', async () => {
    const off = new AdminAuth(loadConfig({ ADMIN_KEY: 'x'.repeat(20) }), null, () => T0);
    expect(await code(off.authenticate('GET', proxyHeaders({ 'x-lateral-proxy-key': '' , 'x-lateral-admin-email': 'admin@example.com' }), MESH))).toBe(401);
    expect(await code(off.authenticate('GET', proxyHeaders({ 'x-lateral-proxy-key': 'anything' }), MESH))).toBe(401);
  });
});

describe('admin auth: CSRF guard', () => {
  it('accepts a complete POST', async () => { expect(await code(auth().authenticate('POST', post(), MESH))).toBe('ok'); });
  it('rejects a wrong or missing content type', async () => {
    expect(await code(auth().authenticate('POST', post({ 'content-type': 'text/plain' }), MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', post({ 'content-type': 'application/x-www-form-urlencoded' }), MESH))).toBe(403);
    const { 'content-type': _c, ...rest } = post(); void _c;
    expect(await code(auth().authenticate('POST', rest, MESH))).toBe(403);
  });
  it('rejects a missing or wrong custom header', async () => {
    const { 'x-lateral-admin': _x, ...rest } = post(); void _x;
    expect(await code(auth().authenticate('POST', rest, MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', post({ 'x-lateral-admin': '0' }), MESH))).toBe(403);
  });
  it('requires the exact origin, or a referer under it', async () => {
    expect(await code(auth().authenticate('POST', post({ origin: 'https://evil.example.test' }), MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', post({ origin: 'https://files.example.test.evil.test' }), MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', post({ origin: 'http://files.example.test' }), MESH))).toBe(403);
    const { origin: _o, ...noOrigin } = post(); void _o;
    expect(await code(auth().authenticate('POST', noOrigin, MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', { ...noOrigin, referer: 'https://files.example.test/lateral-admin/' }, MESH))).toBe('ok');
    expect(await code(auth().authenticate('POST', { ...noOrigin, referer: 'https://files.example.test.evil.test/' }, MESH))).toBe(403);
    expect(await code(auth().authenticate('POST', post({ origin: 'https://evil.example.test', referer: 'https://files.example.test/' }), MESH))).toBe(403);
  });
  it('applies to every non-GET method and never to GET', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) expect(await code(auth().authenticate(m, proxyHeaders(), MESH))).toBe(403);
    expect(await code(auth().authenticate('GET', proxyHeaders(), MESH))).toBe('ok');
  });
});

describe('admin auth: CLI key mode', () => {
  const cli = (over: Record<string, string> = {}): Record<string, string> => ({ 'x-admin-key': 'cli-key-for-tests', 'content-type': 'application/json', ...over });
  it('accepts loopback with the right key', async () => {
    expect(await auth().authenticate('POST', cli(), '127.0.0.1')).toEqual({ via: 'cli', who: 'cli' });
    expect(await code(auth().authenticate('GET', cli(), '::1'))).toBe('ok');
    expect(await code(auth().authenticate('GET', cli(), '::ffff:127.0.0.1'))).toBe('ok');
  });
  it('rejects the key over the mesh IP, the LAN and the public path', async () => {
    for (const ip of [MESH, '192.168.100.100', '192.168.86.10', '203.0.113.9']) expect(await code(auth().authenticate('GET', cli(), ip))).toBe(403);
  });
  it('rejects a wrong key and any request that carries proxy headers', async () => {
    expect(await code(auth().authenticate('GET', cli({ 'x-admin-key': 'wrong' }), '127.0.0.1'))).toBe(401);
    for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-lateral-proxy-key']) expect(await code(auth().authenticate('GET', cli({ [h]: '1.2.3.4' }), '127.0.0.1'))).toBe(403);
  });
  it('is off when no admin key is configured', async () => {
    const off = new AdminAuth(loadConfig({}), null, () => T0);
    expect(await code(off.authenticate('GET', { 'x-admin-key': '' }, '127.0.0.1'))).toBe(401);
    expect(await code(off.authenticate('GET', { 'x-admin-key': 'x' }, '127.0.0.1'))).toBe(401);
  });
  it('still needs a JSON body type on writes', async () => {
    expect(await code(auth().authenticate('POST', cli({ 'content-type': 'text/plain' }), '127.0.0.1'))).toBe(403);
  });
});

describe('admin auth: lockout and the dormant Access mode', () => {
  it('answers 429 after ten failures from one IP, and a good request is then also blocked', async () => {
    const a = auth();
    for (let i = 0; i < 10; i++) expect(await code(a.authenticate('GET', proxyHeaders({ 'x-lateral-proxy-key': `bad${i}` }), MESH))).toBe(401);
    expect(await code(a.authenticate('GET', proxyHeaders(), MESH))).toBe(429);
    expect(await code(auth().authenticate('GET', proxyHeaders(), MESH))).toBe('ok'); // a different limiter instance is unaffected
  });
  it('ignores Cf-Access-Jwt-Assertion when Access mode is not configured', async () => {
    expect(await code(auth().authenticate('GET', { 'cf-access-jwt-assertion': 'a.b.c' }, MESH))).toBe(401);
  });
});
