import { describe, expect, it } from 'vitest';
import { ApiError } from '../../server/util';
import { normalizeCode } from '../../server/gifts';
import { maskEmail, validEmail } from '../../server/mailer';
import { makeApp, newAccount } from './helpers';

const err = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return e instanceof ApiError ? `${e.status}:${e.code}` : String(e); } };
const aerr = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? `${e.status}:${e.code}` : String(e); } };

describe('direct gifts', () => {
  it('lands in the inbox, claims once, credits Marks and items, writes ledger rows', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Gift_Target');
    const g = app.gifts.createDirect('louis', 'gift_target', { marks: 500, items: ['oxide-copper', 'horn-twotone'], message: 'Enjoy' });
    expect(app.gifts.inbox(a.id)).toHaveLength(1);
    const out = app.gifts.claimDirect(a.account, g.id);
    expect(out).toMatchObject({ already: false, marks: 500, gained: ['oxide-copper', 'horn-twotone'], skipped: [] });
    const rec = app.wallets.get(a.id).record!;
    expect(rec.owned).toEqual(['oxide-copper', 'horn-twotone']);
    expect(rec.earned.gift).toBe(500 + 190 + 190);
    expect(rec.spent).toBe(380);
    expect(app.gifts.inbox(a.id)).toHaveLength(0);
    const kinds = app.wallets.ledger(a.id).map(l => l.kind);
    expect(kinds.filter(k => k === `gift:${g.id}`)).toHaveLength(3);
  });
  it('is idempotent: a second claim credits nothing and says so', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Idem_Target');
    const g = app.gifts.createDirect('louis', 'idem_target', { marks: 300 });
    app.gifts.claimDirect(a.account, g.id);
    const again = app.gifts.claimDirect(a.account, g.id);
    expect(again).toMatchObject({ already: true, marks: 0 });
    expect(app.wallets.get(a.id).record!.earned.gift).toBe(300);
    expect(app.wallets.get(a.id).version).toBe(1);
  });
  it('converts items already owned into nothing', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Owner_One');
    app.gifts.claimDirect(a.account, app.gifts.createDirect('louis', 'owner_one', { items: ['oxide-copper'] }).id);
    const g2 = app.gifts.createDirect('louis', 'owner_one', { marks: 10, items: ['oxide-copper'] });
    expect(app.gifts.claimDirect(a.account, g2.id)).toMatchObject({ gained: [], skipped: ['oxide-copper'], marks: 10 });
    expect(app.wallets.get(a.id).record!.owned).toEqual(['oxide-copper']);
  });
  it('only the addressee can claim, and unknown ids are 404', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Right_One'), b = await newAccount(app, 'Wrong_One');
    const g = app.gifts.createDirect('louis', 'right_one', { marks: 5 });
    expect(err(() => app.gifts.claimDirect(b.account, g.id))).toBe('404:no-such-gift');
    expect(err(() => app.gifts.claimDirect(a.account, 'nope'))).toBe('404:no-such-gift');
    expect(err(() => app.gifts.claimDirect(a.account, 42))).toBe('404:no-such-gift');
  });
  it('revoked and expired gifts can not be claimed', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Late_One');
    const g1 = app.gifts.createDirect('louis', 'late_one', { marks: 5 });
    const g2 = app.gifts.createDirect('louis', 'late_one', { marks: 5, expiresInDays: 1 });
    app.gifts.revoke(g1.id);
    expect(err(() => app.gifts.claimDirect(a.account, g1.id))).toBe('410:revoked');
    app.clock.t += 2 * 86_400_000;
    expect(err(() => app.gifts.claimDirect(a.account, g2.id))).toBe('410:expired');
    expect(app.gifts.inbox(a.id)).toHaveLength(0);
  });
  it('an opened gift stays opened after revoke (revoke never takes Marks back)', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Keep_One');
    const g = app.gifts.createDirect('louis', 'keep_one', { marks: 50 });
    app.gifts.claimDirect(a.account, g.id);
    const row = app.gifts.revoke(g.id);
    expect(row.state).toBe('revoked');
    expect(app.wallets.get(a.id).record!.earned.gift).toBe(50);
    expect(app.gifts.claimDirect(a.account, g.id).already).toBe(true);
  });
  it('enforces limits: 100000 Marks, 20 items, catalog ids, 140 chars, not empty', async () => {
    const app = makeApp();
    await newAccount(app, 'Limit_One');
    const make = (b: unknown): string => err(() => app.gifts.createDirect('louis', 'limit_one', b));
    expect(make({ marks: 100001 })).toBe('400:bad-marks');
    expect(make({ marks: -1 })).toBe('400:bad-marks');
    expect(make({ marks: 1.5 })).toBe('400:bad-marks');
    expect(make({ marks: '5' })).toBe('400:bad-marks');
    expect(make({ marks: 100000 })).toBe('ok');
    expect(make({})).toBe('400:empty-gift');
    expect(make({ items: ['nope'] })).toBe('400:bad-items');
    expect(make({ items: ['harbor-slate'] })).toBe('400:bad-items');
    expect(make({ items: Array.from({ length: 21 }, () => 'oxide-copper') })).toBe('400:bad-items');
    expect(make({ marks: 1, message: 'x'.repeat(141) })).toBe('400:bad-message');
    expect(make({ marks: 1, message: 'x'.repeat(140) })).toBe('ok');
    expect(make({ marks: 1, message: 5 })).toBe('400:bad-message');
    expect(make({ marks: 1, expiresInDays: -2 })).toBe('400:bad-expiry');
    expect(err(() => app.gifts.createDirect('louis', 'nobody_x', { marks: 1 }))).toBe('404:no-such-account');
    app.accounts.setBanned('limit_one', true);
    expect(make({ marks: 1 })).toBe('409:banned');
  });
  it('strips control characters from the message', async () => {
    const app = makeApp();
    await newAccount(app, 'Clean_One');
    const g = app.gifts.createDirect('louis', 'clean_one', { marks: 1, message: 'hi\u0000 there‮!\n\n ok' });
    expect(g.message).toBe('hi there ! ok');
  });
  it('can gift every recently active account', async () => {
    const app = makeApp();
    await newAccount(app, 'Active_A'); await newAccount(app, 'Active_B');
    const out = app.gifts.createForActive('louis', 7, { marks: 25 });
    expect(out.count).toBe(2);
    expect(err(() => app.gifts.createForActive('louis', 0, { marks: 1 }))).toBe('400:bad-days');
  });
});

describe('code gifts', () => {
  it('normalises codes and builds the deep link', () => {
    const app = makeApp();
    const g = app.gifts.createCode('louis', { marks: 100, maxClaims: 3 });
    expect(g.code).toMatch(/^LATERAL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(g.link).toBe(`https://lateral.example.test/?gift=${g.code}`);
    expect(normalizeCode(g.code!.toLowerCase().replace(/-/g, ' '))).toBe(g.code);
    for (const bad of ['', 'LATERAL', 'LATERAL-AAAA', 'LATERAL-AAAA-AAA0', 5, null]) expect(normalizeCode(bad as never)).toBeNull();
  });
  it('is redeemable once per account up to max_claims in total', async () => {
    const app = makeApp();
    const [a, b, c] = [await newAccount(app, 'Redeem_A'), await newAccount(app, 'Redeem_B'), await newAccount(app, 'Redeem_C')];
    const g = app.gifts.createCode('louis', { marks: 100, maxClaims: 2 });
    expect(app.gifts.redeem(a.account, g.code!)).toMatchObject({ already: false, marks: 100 });
    expect(app.gifts.redeem(a.account, g.code!)).toMatchObject({ already: true, marks: 0 });
    expect(app.gifts.redeem(b.account, g.code!.toLowerCase())).toMatchObject({ already: false, marks: 100 });
    expect(err(() => app.gifts.redeem(c.account, g.code!))).toBe('410:already-opened');
    expect(app.wallets.get(a.id).record!.earned.gift).toBe(100);
    expect(app.gifts.list()[0]).toMatchObject({ state: 'claimed', claims: 2 });
  });
  it('respects expiry and revoke', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Expiry_A');
    const g = app.gifts.createCode('louis', { marks: 5, expiresInDays: 1 });
    const r = app.gifts.createCode('louis', { marks: 5 });
    app.gifts.revoke(r.id);
    expect(err(() => app.gifts.redeem(a.account, r.code))).toBe('410:revoked');
    app.clock.t += 2 * 86_400_000;
    expect(err(() => app.gifts.redeem(a.account, g.code!))).toBe('410:expired');
  });
  it('locks redeeming for 15 minutes after 5 wrong codes in 10 minutes', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Lockout_A');
    const g = app.gifts.createCode('louis', { marks: 5 });
    for (let i = 0; i < 5; i++) { app.clock.t += 11_000; expect(err(() => app.gifts.redeem(a.account, 'LATERAL-AAAA-AAAA'))).toBe('404:bad-code'); }
    app.clock.t += 11_000;
    expect(err(() => app.gifts.redeem(a.account, g.code!))).toBe('429:locked');
    app.clock.t += 15 * 60_000;
    expect(err(() => app.gifts.redeem(a.account, g.code!))).toBe('ok');
  });
  it('rate limits to 10 redeems a minute', async () => {
    const app = makeApp();
    const a = await newAccount(app, 'Rate_A');
    const g = app.gifts.createCode('louis', { marks: 5, maxClaims: 100 });
    app.gifts.redeem(a.account, g.code!);
    for (let i = 0; i < 9; i++) app.gifts.redeem(a.account, g.code!);
    expect(err(() => app.gifts.redeem(a.account, g.code!))).toBe('429:rate-limited');
  });
  it('previews what a visitor may learn without signing in', () => {
    const app = makeApp();
    const g = app.gifts.createCode('louis', { marks: 5 });
    expect(app.gifts.preview(g.code)).toEqual({ state: 'open', from: 'Louis' });
    expect(app.gifts.preview('LATERAL-AAAA-AAAA')).toEqual({ state: 'invalid' });
    app.gifts.revoke(g.id);
    expect(app.gifts.preview(g.code).state).toBe('revoked');
  });
});

describe('email gifts', () => {
  it('validates and masks addresses', () => {
    expect(validEmail('a.b+c@example.com')).toBe(true);
    for (const bad of ['a@b', '@x.com', 'a b@x.com', 'x@y..com', 5, 'a'.repeat(300) + '@x.com', '<a@x.com>']) expect(validEmail(bad)).toBe(false);
    expect(maskEmail('Jane.Doe@Gmail.com')).toBe('j***@gmail.com');
  });
  it('with email off: makes the one-claim link and message, sends nothing, keeps no address', async () => {
    const app = makeApp();
    const out = await app.gifts.createForEmail('louis', 'Friend@Example.com', { marks: 500, message: 'Welcome' });
    expect(out.emailSent).toBe(false);
    expect(out.emailStatus).toBe('disabled');
    expect(out.link).toMatch(/\/\?gift=LATERAL-/);
    expect(out.message.text).toContain(out.link);
    expect(out.gift.maxClaims).toBe(1);
    expect(out.gift.emailMasked).toBe('f***@example.com');
    expect(app.transport.sent).toHaveLength(0);
    const dump = JSON.stringify([app.db.prepare('SELECT * FROM gifts').all(), app.db.prepare('SELECT * FROM email_log').all()]);
    expect(dump.toLowerCase()).not.toContain('friend@example.com');
  });
  it('with email on: sends one message through the transport, stores only a hash', async () => {
    const app = makeApp({ EMAIL_ENABLED: '1', MAIL_FROM: 'LATERAL <gifts@example.test>' });
    const out = await app.gifts.createForEmail('louis', 'friend@example.com', { marks: 500, items: ['oxide-copper'], message: 'Thanks' });
    expect(out).toMatchObject({ emailSent: true, emailStatus: 'sent' });
    expect(app.transport.sent).toHaveLength(1);
    const mail = app.transport.sent[0]!;
    expect(mail.to).toBe('friend@example.com');
    expect(mail.from).toBe('LATERAL <gifts@example.test>');
    expect(mail.text).toContain(out.link);
    expect(mail.html).toContain(out.link);
    expect(mail.text).toContain('500 Marks');
    expect(mail.text).not.toMatch(/—/);
    expect(mail.html).not.toMatch(/—/);
    expect((mail.html.match(/href="/g) ?? []).length).toBe(1);
    expect(mail.html).not.toMatch(/<img/i);
    const log = JSON.stringify(app.db.prepare('SELECT * FROM email_log').all());
    expect(log).not.toContain('friend');
  });
  it('limits to 3 per address and 30 per day, and reports transport failures without losing the link', async () => {
    const app = makeApp({ EMAIL_ENABLED: '1', EMAIL_DAILY_MAX: '5', MAIL_FROM: 'a@example.test' });
    for (let i = 0; i < 3; i++) await app.gifts.createForEmail('louis', 'same@example.com', { marks: 1 });
    expect(await aerr(app.gifts.createForEmail('louis', 'SAME@example.com', { marks: 1 }))).toBe('429:email-address-limit');
    await app.gifts.createForEmail('louis', 'b@example.com', { marks: 1 });
    await app.gifts.createForEmail('louis', 'c@example.com', { marks: 1 });
    expect(await aerr(app.gifts.createForEmail('louis', 'd@example.com', { marks: 1 }))).toBe('429:email-daily-limit');
    app.clock.t += 86_400_000;
    app.transport.failWith = 'smtp 550';
    const out = await app.gifts.createForEmail('louis', 'e@example.com', { marks: 1 });
    expect(out).toMatchObject({ emailSent: false, emailStatus: 'failed' });
    expect(out.link).toContain('?gift=');
    expect(await aerr(app.gifts.createForEmail('louis', 'not-an-email', { marks: 1 }))).toBe('400:bad-email');
  });
  it('a second visitor sees the gift as already opened', async () => {
    const app = makeApp();
    const [a, b] = [await newAccount(app, 'Mail_A'), await newAccount(app, 'Mail_B')];
    const out = await app.gifts.createForEmail('louis', 'x@example.com', { marks: 10 });
    app.gifts.redeem(a.account, out.gift.code);
    expect(err(() => app.gifts.redeem(b.account, out.gift.code))).toBe('410:already-opened');
    expect(app.gifts.preview(out.gift.code).state).toBe('opened');
  });
});

describe('test grant', () => {
  it('pays exactly TEST_GRANT_MARKS once and is idempotent', async () => {
    const app = makeApp({ TEST_GRANT_MARKS: '20000' });
    const a = await newAccount(app, 'Grant_A');
    expect(app.wallets.claimTestGrant(a.id).granted).toBe(20000);
    expect(app.wallets.claimTestGrant(a.id).granted).toBe(0);
    const rec = app.wallets.get(a.id).record!;
    expect(rec.earned.testgrant).toBe(20000);
    expect(app.wallets.ledger(a.id).filter(l => l.kind === 'earn:testgrant')).toHaveLength(1);
    expect(app.wallets.testGrantClaimed(a.id)).toBe(true);
  });
  it('closes when the marks are 0 or the date has passed', async () => {
    const off = makeApp({ TEST_GRANT_MARKS: '0' });
    const a = await newAccount(off, 'Grant_B');
    expect(err(() => off.wallets.claimTestGrant(a.id))).toBe('410:closed');
    expect(off.wallets.testGrantOpen()).toBe(false);
    const dated = makeApp({ TEST_GRANT_UNTIL: '2026-10-06T00:00:00Z' });
    const b = await newAccount(dated, 'Grant_C');
    expect(dated.wallets.testGrantOpen()).toBe(true);
    dated.clock.t = Date.UTC(2026, 9, 7);
    expect(err(() => dated.wallets.claimTestGrant(b.id))).toBe('410:closed');
  });
});
