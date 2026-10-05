import { describe, expect, it } from 'vitest';
import { checkName, foldName, normalizeRecoveryCode, newRecoveryCode } from '../../server/accounts';
import { ApiError } from '../../server/util';
import { makeApp, newAccount } from './helpers';

const status = async (p: Promise<unknown>): Promise<number | string> => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? `${e.status}:${e.code}` : String(e); } };

describe('names', () => {
  it('accepts normal names and rejects bad characters and lengths', () => {
    for (const n of ['drift_king', 'Anna-2', 'abc', 'A'.repeat(16), 'nord_fan']) expect(checkName(n).ok).toBe(true);
    for (const n of ['ab', 'A'.repeat(17), 'has space', 'bad!', 'emoji\u{1F600}x', '', 'tab\tname', 12, null, undefined]) expect(checkName(n as never)).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('reserves staff and impersonation names, with digits, separators and leetspeak', () => {
    for (const n of ['louis', 'Louis', 'LOUIS_', 'louis99', 'l0uis', 'admin', 'Admin1', 'a_d_m_i_n', 'moderator', 'lateral', 'system', 'staff', 'nordcore', 'lou15', 'xlou15x', 'the_nordbo', 'nordcore-dev']) expect(checkName(n)).toMatchObject({ ok: false, reason: 'reserved' });
  });
  it('blocks slurs and obvious profanity, including leetspeak, but not honest names', () => {
    for (const n of ['fuck_you', 'sh1t', 'xXfuckXx', 'n1gg3r', 'k_k_k', 'hitler_fan']) expect(checkName(n).ok).toBe(false);
    for (const n of ['grape', 'Dickson', 'cockpit', 'badminton', 'torpedo', 'assassin', 'class1', 'smoke4242', 'drift_king']) expect(checkName(n).ok).toBe(true);
    expect(foldName('l33t__x')).toBe('letx');
  });
});

describe('recovery codes', () => {
  it('has the XXXX-XXXX-XXXX-XXXX shape from an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(newRecoveryCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  });
  it('normalises case, spaces and dashes and rejects junk', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jklm-npqr')).toBe('ABCDEFGHJKLMNPQR');
    expect(normalizeRecoveryCode(' ABCD EFGH JKLM NPQR ')).toBe('ABCDEFGHJKLMNPQR');
    for (const bad of ['', 'ABCD', 'ABCD-EFGH-JKLM-NPQ0', 'IIII-OOOO-0000-1111', 5, null, 'A'.repeat(50)]) expect(normalizeRecoveryCode(bad as never)).toBeNull();
  });
});

describe('accounts', () => {
  it('creates an account, stores only hashes, and resolves the token', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Driver_One');
    expect(app.accounts.byToken(a.token)?.name).toBe('Driver_One');
    const row = app.db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id) as Record<string, string>;
    expect(row.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(a.recoveryCode);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM tokens').all())).not.toContain(a.token);
  });
  it('keeps names unique case-insensitively', async () => {
    const app = makeApp();
    await newAccount(app, 'Driver_One');
    expect(await status(app.accounts.create('driver_one', '1.1.1.1'))).toBe('409:name-taken');
    expect(await status(app.accounts.create('louis', '1.1.1.2'))).toBe('422:name-reserved');
    expect(await status(app.accounts.create('x', '1.1.1.2'))).toBe('400:name-invalid');
  });
  it('limits creations to 5 per hour per IP and 200 globally', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await app.accounts.create(`same_ip_${i}`, '9.9.9.9');
    expect(await status(app.accounts.create('same_ip_5', '9.9.9.9'))).toBe('429:rate-limited');
    app.clock.t += 3_600_001;
    expect(await status(app.accounts.create('same_ip_5', '9.9.9.9'))).toBe('ok');
    const busy = makeApp({ ACCOUNTS_GLOBAL_HOUR: '4' });
    for (let i = 0; i < 4; i++) await busy.accounts.create(`other_${i}`, `8.8.8.${i}`);
    expect(await status(busy.accounts.create('other_9', '8.8.8.9'))).toBe('429:rate-limited');
  });
  it('recovers with the code, issues a new token and keeps at most 5', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Recover_Me');
    const tokens: string[] = [a.token];
    for (let i = 0; i < 6; i++) { app.clock.t += 1000; tokens.push((await app.accounts.recover('recover_me', a.recoveryCode.toLowerCase(), '2.2.2.2')).token); }
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE account_id = ?').get(a.id)).toEqual({ n: 5 });
    expect(app.accounts.byToken(tokens[0]!)).toBeNull();
    expect(app.accounts.byToken(tokens[tokens.length - 1]!)?.id).toBe(a.id);
  });
  it('locks (name, ip) after 5 wrong codes for 15 minutes, even for the right code', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Lock_Me');
    for (let i = 0; i < 5; i++) expect(await status(app.accounts.recover('lock_me', 'AAAA-AAAA-AAAA-AAAA', '3.3.3.3'))).toBe('401:bad-recovery');
    expect(await status(app.accounts.recover('lock_me', a.recoveryCode, '3.3.3.3'))).toBe('429:locked');
    expect(await status(app.accounts.recover('lock_me', a.recoveryCode, '4.4.4.4'))).toBe('ok'); // another network is not locked
    app.clock.t += 15 * 60_000 + 1;
    expect(await status(app.accounts.recover('lock_me', a.recoveryCode, '3.3.3.3'))).toBe('ok');
  });
  it('answers the same for unknown names and wrong codes', async () => {
    const app = makeApp();
    expect(await status(app.accounts.recover('nobody_here', 'AAAA-AAAA-AAAA-AAAA', '5.5.5.5'))).toBe('401:bad-recovery');
    expect(await status(app.accounts.recover('???', 'x', '5.5.5.5'))).toBe('401:bad-recovery');
  });
  it('regenerating invalidates the old code', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Regen_Me');
    const fresh = await app.accounts.regenerate(a.id);
    expect(await status(app.accounts.recover('regen_me', a.recoveryCode, '6.6.6.6'))).toBe('401:bad-recovery');
    expect(await status(app.accounts.recover('regen_me', fresh, '6.6.6.7'))).toBe('ok');
  });
  it('bans drop tokens and block recovery; unban restores; admins can not be banned; rename and promote work', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Ban_Me');
    app.accounts.setBanned('Ban_Me', true, 'testing');
    expect(app.accounts.byToken(a.token)).toBeNull();
    expect(await status(app.accounts.recover('ban_me', a.recoveryCode, '7.7.7.7'))).toBe('403:banned');
    app.accounts.setBanned('ban_me', false);
    expect(await status(app.accounts.recover('ban_me', a.recoveryCode, '7.7.7.8'))).toBe('ok');
    app.accounts.setAdmin('Ban_Me', true);
    expect(() => app.accounts.setBanned('Ban_Me', true)).toThrow(/Demote/);
    expect(app.accounts.rename('Ban_Me', 'louis').name).toBe('louis'); // admins may take reserved names
    expect(() => app.accounts.rename('louis', 'bad name')).toThrow();
    expect(() => app.accounts.setAdmin('ghost_user', true)).toThrow(/No account/);
  });
  it('searches by fragment and lists active accounts', async () => {
    const app = makeApp();
    await newAccount(app, 'alpha_one'); await newAccount(app, 'alpha_two'); await newAccount(app, 'beta_one');
    expect(app.accounts.search('alpha').map(a => a.name).sort()).toEqual(['alpha_one', 'alpha_two']);
    expect(app.accounts.search('%').length).toBe(0);
    expect(app.accounts.activeSince(7, 10).length).toBe(3);
  });
});
