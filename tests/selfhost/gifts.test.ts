import { describe, expect, it } from 'vitest';
import { PENDING_GIFT_KEY, captureGiftLink, clearPendingGift, createGiftsController, giftParam, normalizeCode, pendingGiftCode } from '../../src/selfhost/gifts';
import { createSelfhostServices } from '../../src/selfhost/boot';
import { FakeServer, memoryStorage } from './helpers';

const where = (search: string) => ({ search, pathname: '/', hash: '' });
const history = () => { const calls: string[] = []; return { calls, state: null, replaceState: (_: unknown, __: string, url?: string | URL | null) => { calls.push(String(url)); } }; };

describe('gift links', () => {
  it('reads a code from ?gift= and normalises it', () => {
    expect(giftParam('?gift=lateral-abcd-1234')).toBe('LATERAL-ABCD-1234');
    expect(giftParam('?gift=')).toBeNull();
    expect(giftParam('?other=1')).toBeNull();
    expect(giftParam('?gift=<script>')).toBeNull();
    expect(normalizeCode('  lateral abcd_1234 ')).toBe('LATERAL-ABCD-1234');
  });

  it('stores the code and cleans the address bar', () => {
    const storage = memoryStorage(), h = history();
    expect(captureGiftLink(storage, where('?gift=LATERAL-ABCD-1234&x=1'), h)).toBe('LATERAL-ABCD-1234');
    expect(storage.getItem(PENDING_GIFT_KEY)).toBe('LATERAL-ABCD-1234');
    expect(h.calls).toEqual(['/?x=1']);
    expect(captureGiftLink(storage, where(''), h)).toBe('LATERAL-ABCD-1234');
    clearPendingGift(storage);
    expect(pendingGiftCode(storage)).toBeNull();
  });

  it('keeps the code across the driver name step and opens it once the account exists', async () => {
    const server = new FakeServer();
    server.gifts.push({ id: 'cg1', kind: 'code', code: 'LATERAL-ABCD-1234', marks: 5000, items: ['rim-gold'], message: 'Welcome', from: 'Louis' });
    const storage = memoryStorage();
    captureGiftLink(storage, where('?gift=LATERAL-ABCD-1234'), history());
    // A new visit (the page reloaded in between, or the name step took a while).
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    expect(services.gifts.pendingCode()).toBe('LATERAL-ABCD-1234');
    expect(services.account.needsChoice()).toBe(true);
    // Nothing is redeemed before there is an account: no call to the redeem endpoint yet.
    expect(server.calls.some(call => call.url.includes('redeem'))).toBe(false);
    const made = await services.account.create('Newbie');
    expect(made.ok).toBe(true);
    expect(services.gifts.pendingCode()).toBe('LATERAL-ABCD-1234');
    await services.wallet.store.load();
    const outcome = await services.gifts.redeemPending();
    expect(outcome.status).toBe('opened');
    if (outcome.status === 'opened') { expect(outcome.result.marks).toBe(5000); expect(outcome.result.gift?.message).toBe('Welcome'); }
    expect(services.gifts.pendingCode()).toBeNull();
    expect(storage.getItem(PENDING_GIFT_KEY)).toBeNull();
  });

  it('says the gift was already opened, and forgets the code', async () => {
    const server = new FakeServer();
    server.gifts.push({ id: 'cg1', kind: 'code', code: 'LATERAL-ABCD-1234', marks: 100, items: [], message: '', from: 'Louis' });
    const storage = memoryStorage();
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    await services.account.create('Twice1');
    await services.gifts.redeem('LATERAL-ABCD-1234');
    storage.setItem(PENDING_GIFT_KEY, 'LATERAL-ABCD-1234');
    const outcome = await services.gifts.redeemPending();
    expect(outcome).toEqual({ status: 'already', message: 'This gift was already opened.' });
    expect(storage.getItem(PENDING_GIFT_KEY)).toBeNull();
  });

  it('reports a code the server does not know as invalid and clears it', async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    await services.account.create('Nobody1');
    storage.setItem(PENDING_GIFT_KEY, 'LATERAL-NOPE-0000');
    const outcome = await services.gifts.redeemPending();
    expect(outcome.status).toBe('invalid');
    expect(storage.getItem(PENDING_GIFT_KEY)).toBeNull();
  });

  it('keeps the code when the server is unreachable, so the next visit tries again', async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    await services.account.create('Away1');
    storage.setItem(PENDING_GIFT_KEY, 'LATERAL-ABCD-1234');
    server.down = true;
    const outcome = await services.gifts.redeemPending();
    expect(outcome.status).toBe('retry');
    expect(storage.getItem(PENDING_GIFT_KEY)).toBe('LATERAL-ABCD-1234');
  });

  it('does not send two requests when asked twice at once', async () => {
    const server = new FakeServer();
    server.gifts.push({ id: 'cg1', kind: 'code', code: 'LATERAL-ABCD-1234', marks: 100, items: [], message: '', from: 'Louis' });
    const storage = memoryStorage();
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    await services.account.create('Double1');
    storage.setItem(PENDING_GIFT_KEY, 'LATERAL-ABCD-1234');
    const [a, b] = await Promise.all([services.gifts.redeemPending(), services.gifts.redeemPending()]);
    expect(a.status).toBe('opened'); expect(b.status).toBe('opened');
    expect(server.calls.filter(call => call.url.endsWith('/gifts/redeem'))).toHaveLength(1);
  });

  it('rejects an obviously wrong typed code without a request', async () => {
    const server = new FakeServer();
    const services = createSelfhostServices({ storage: memoryStorage(), fetch: server.fetch });
    await services.account.create('Typo1');
    const before = server.calls.length;
    const result = await services.gifts.redeem('??');
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(server.calls.length).toBe(before);
  });

  it('lists inbox gifts from the wallet answer', async () => {
    const server = new FakeServer();
    server.gifts.push({ id: 'd1', kind: 'direct', marks: 2500, items: [], message: 'Thanks for testing', from: 'Louis' });
    const services = createSelfhostServices({ storage: memoryStorage(), fetch: server.fetch });
    await services.account.create('Inbox1');
    await services.wallet.store.load();
    const gifts = createGiftsController(services.wallet, memoryStorage());
    expect(gifts.count()).toBe(1);
    expect(gifts.inbox()[0]).toMatchObject({ id: 'd1', message: 'Thanks for testing', marks: 2500 });
    const opened = await gifts.claim('d1');
    expect(opened.ok).toBe(true);
    await services.wallet.refresh();
    expect(gifts.count()).toBe(0);
  });
});
