import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessVerifier } from '../../server/access-jwt';

const TEAM = 'team.example.test', AUD = 'aud-tag-123', NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const pair = (): { priv: KeyObject; pub: KeyObject; jwk: Record<string, unknown> } => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { priv: privateKey, pub: publicKey, jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
};
const good = pair(), other = pair();
const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function sign(payload: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64(payload);
  const s = createSign('RSA-SHA256'); s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(opts.key ?? good.priv).toString('base64url')}`;
}
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: `https://${TEAM}`, aud: [AUD], email: 'louis@example.test', exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, ...over });
function make(keys = [{ ...good.jwk, kid: 'k1' }]): { v: AccessVerifier; fetches: string[]; now: { t: number } } {
  const fetches: string[] = []; const now = { t: NOW };
  const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, emails: ['louis@example.test'] }, async url => { fetches.push(url); return { keys }; }, () => now.t);
  return { v, fetches, now };
}

describe('Cloudflare Access JWT verifier (dormant mode)', () => {
  it('accepts a good token and fetches the certs from the team domain', async () => {
    const { v, fetches } = make();
    expect(await v.verify(sign(claims()))).toEqual({ ok: true, email: 'louis@example.test' });
    expect(fetches).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });
  it('accepts a string aud and mixed case email', async () => {
    const { v } = make();
    expect((await v.verify(sign(claims({ aud: AUD, email: 'Louis@Example.test' })))).ok).toBe(true);
  });
  it('rejects the wrong audience', async () => { expect(await make().v.verify(sign(claims({ aud: ['other'] })))).toEqual({ ok: false, reason: 'aud' }); });
  it('rejects an expired token (beyond the 60 s leeway)', async () => {
    const { v } = make();
    expect(await v.verify(sign(claims({ exp: NOW / 1000 - 120 })))).toEqual({ ok: false, reason: 'expired' });
    expect((await v.verify(sign(claims({ exp: NOW / 1000 - 30 })))).ok).toBe(true);
  });
  it('rejects a token that is not valid yet', async () => { expect(await make().v.verify(sign(claims({ nbf: NOW / 1000 + 600 })))).toEqual({ ok: false, reason: 'not-yet' }); });
  it('rejects an email that is not on the list', async () => { expect(await make().v.verify(sign(claims({ email: 'eve@example.test' })))).toEqual({ ok: false, reason: 'email' }); });
  it('rejects the wrong issuer', async () => { expect(await make().v.verify(sign(claims({ iss: 'https://evil.example.test' })))).toEqual({ ok: false, reason: 'iss' }); });
  it('rejects a bad signature (tampered payload and a foreign key)', async () => {
    const { v } = make();
    const t = sign(claims()); const [h, , s] = t.split('.');
    expect(await v.verify(`${h}.${b64(claims({ email: 'louis@example.test', aud: [AUD], exp: NOW / 1000 + 99999 }))}.${s}`)).toEqual({ ok: false, reason: 'signature' });
    expect(await v.verify(sign(claims(), { key: other.priv }))).toEqual({ ok: false, reason: 'signature' });
  });
  it('rejects an unknown kid after one refresh, and rate limits refreshes', async () => {
    const { v, fetches, now } = make();
    expect(await v.verify(sign(claims(), { kid: 'nope' }))).toEqual({ ok: false, reason: 'unknown-kid' });
    const first = fetches.length;
    await v.verify(sign(claims(), { kid: 'nope2' }));
    expect(fetches.length).toBe(first); // refresh at most once a minute
    now.t += 61_000;
    await v.verify(sign(claims(), { kid: 'nope3' }));
    expect(fetches.length).toBe(first + 1);
  });
  it('picks up a rotated key on an unknown kid', async () => {
    const keys = [{ ...good.jwk, kid: 'k1' }]; const now = { t: NOW };
    const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, emails: ['louis@example.test'] }, async () => ({ keys: [...keys] }), () => now.t);
    expect((await v.verify(sign(claims()))).ok).toBe(true);
    keys.push({ ...other.jwk, kid: 'k2' });
    now.t += 61_000;
    expect((await v.verify(sign(claims(), { key: other.priv, kid: 'k2' }))).ok).toBe(true);
  });
  it('rejects alg none', async () => {
    const t = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`;
    expect((await make().v.verify(t)).ok).toBe(false);
    expect(await make().v.verify(`${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.AAAA`)).toEqual({ ok: false, reason: 'alg' });
  });
  it('rejects HS256 signed with the public key as the secret', async () => {
    const pem = good.pub.export({ type: 'spki', format: 'pem' }) as string;
    const head = b64({ alg: 'HS256', kid: 'k1' }), body = b64(claims());
    const sig = createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
    expect(await make().v.verify(`${head}.${body}.${sig}`)).toEqual({ ok: false, reason: 'alg' });
  });
  it('rejects malformed input', async () => {
    const { v } = make();
    for (const t of [undefined, '', 'a.b', 'a.b.c.d', 'not a token', 'x'.repeat(9000), `${b64('[]')}.${b64('{}')}.AAAA`]) expect((await v.verify(t)).ok).toBe(false);
  });
});
