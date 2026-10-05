import { describe, expect, it } from 'vitest';
import { createAccountService } from '../../src/selfhost/account';
import { WalletRejected, createServerWallet, explainAction, parseGift } from '../../src/selfhost/wallet-store';
import { createLocalWalletStore } from '../../src/economy/stores';
import { emptyWallet, normalizeWallet } from '../../src/economy/wallet';
import type { WalletRecord } from '../../src/economy/types';
import { FakeServer, memoryStorage } from './helpers';

async function signedIn(server: FakeServer, name = 'Louis') {
  const storage = memoryStorage();
  const account = createAccountService({ storage, fetch: server.fetch });
  await account.create(name);
  const cache = createLocalWalletStore('cache', storage);
  const wallet = createServerWallet({ api: account.api, cache, minWriteGapMs: 0, schedule: fn => setTimeout(fn, 0) });
  return { account, cache, wallet, storage };
}
const withMissions = (record: WalletRecord, claim: string): WalletRecord => normalizeWallet({ ...record, claims: [...(record.claims ?? []), claim] });
const posts = (server: FakeServer): number => server.calls.filter(call => call.method === 'POST' && call.url === '/api/v1/wallet').length;

describe('server wallet store', () => {
  it('loads null for a brand new account and keeps what it saves, per version', async () => {
    const server = new FakeServer();
    const { wallet, account } = await signedIn(server);
    expect(await wallet.store.load()).toBeNull();
    const record = emptyWallet(5000);
    await wallet.store.save(record);
    expect(server.byName('Louis').record?.createdAt).toBe(5000);
    expect(wallet.version()).toBe(1);
    expect((await wallet.store.load())?.createdAt).toBe(5000);
    expect(account.current()?.name).toBe('Louis');
  });

  it('sends one request for a burst of saves, with the newest record', async () => {
    const server = new FakeServer();
    const { wallet } = await signedIn(server);
    await wallet.store.load();
    const first = emptyWallet(5000);
    const saves = [wallet.store.save(first), wallet.store.save(withMissions(first, 'missions:c:a')), wallet.store.save(withMissions(first, 'missions:c:b'))];
    await Promise.all(saves);
    expect(posts(server)).toBeLessThanOrEqual(2);
    expect(server.byName('Louis').record?.claims).toContain('missions:c:b');
  });

  it('merges and retries once when another device wrote first', async () => {
    const server = new FakeServer();
    const { wallet } = await signedIn(server);
    await wallet.store.load();
    await wallet.store.save(emptyWallet(5000));
    // Another device adds a claim between our load and our write.
    server.staleNext = account => { account.record = withMissions(account.record!, 'missions:c:other'); account.version += 1; };
    await wallet.store.save(withMissions(emptyWallet(5000), 'missions:c:mine'));
    const stored = server.byName('Louis').record!;
    expect(stored.claims).toEqual(expect.arrayContaining(['missions:c:other', 'missions:c:mine']));
  });

  it('adopts the server record when the rules refuse the change, and does not retry', async () => {
    const server = new FakeServer();
    const { wallet } = await signedIn(server);
    await wallet.store.load();
    await wallet.store.save(emptyWallet(5000));
    const before = posts(server);
    server.rejectNext = 'spent-mismatch';
    const seen: WalletRecord[] = [];
    wallet.store.subscribe?.(record => seen.push(record));
    const error = await wallet.store.save(normalizeWallet({ ...emptyWallet(5000), owned: ['rim-gold'] })).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(WalletRejected);
    expect((error as WalletRejected).reason).toBe('spent-mismatch');
    expect((error as WalletRejected).adopt.owned).toEqual([]);
    expect(posts(server)).toBe(before + 1);
    expect(seen.at(-1)?.owned).toEqual([]);
  });

  it('treats a rate limit as a plain failure: the economy must not adopt anything from it', async () => {
    const server = new FakeServer();
    const { wallet } = await signedIn(server);
    await wallet.store.load();
    await wallet.store.save(withMissions(emptyWallet(5000), 'missions:c:a'));
    server.rateLimitNext = true;
    const error = await wallet.store.save(withMissions(emptyWallet(5000), 'missions:c:b')).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WalletRejected);
  });

  it('plays from the cache while the server is away and syncs afterwards', async () => {
    const server = new FakeServer();
    const { wallet, cache } = await signedIn(server);
    await wallet.store.load();
    await wallet.store.save(emptyWallet(5000));
    server.down = true;
    const offline = await wallet.store.load();
    expect(offline?.createdAt).toBe(5000);
    const failed = await wallet.store.save(withMissions(emptyWallet(5000), 'missions:c:a')).then(() => 'ok', () => 'failed');
    expect(failed).toBe('failed');
    expect((await cache.load())?.claims).toContain('missions:c:a');
    server.down = false;
    await wallet.store.save(withMissions(emptyWallet(5000), 'missions:c:a'));
    expect(server.byName('Louis').record?.claims).toContain('missions:c:a');
  });

  it('offers the progress made before the account to the new account once', async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const account = createAccountService({ storage, fetch: server.fetch });
    await account.create('Late1');
    const guest = createLocalWalletStore('guest', storage);
    await guest.save(withMissions(emptyWallet(7000), 'missions:c:guest'));
    const outcomes: string[] = [];
    const wallet = createServerWallet({ api: account.api, cache: createLocalWalletStore('cache', storage), guest, onGuestOutcome: o => outcomes.push(o), minWriteGapMs: 0, schedule: fn => setTimeout(fn, 0) });
    const loaded = await wallet.store.load();
    expect(loaded?.claims).toContain('missions:c:guest');
    expect(outcomes).toEqual(['moved']);
  });

  it('says the server started fresh when it refuses the old progress', async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const account = createAccountService({ storage, fetch: server.fetch });
    await account.create('Late2');
    const guest = createLocalWalletStore('guest', storage);
    await guest.save(normalizeWallet({ ...emptyWallet(7000), earned: { missions: 999999 } }));
    server.rejectNext = 'mission-claim-invalid';
    const outcomes: string[] = [];
    const wallet = createServerWallet({ api: account.api, cache: createLocalWalletStore('cache', storage), guest, onGuestOutcome: o => outcomes.push(o), minWriteGapMs: 0, schedule: fn => setTimeout(fn, 0) });
    await wallet.store.load();
    expect(outcomes).toEqual(['fresh']);
  });

  it('claims the testing bonus and a gift through the same record stream', async () => {
    const server = new FakeServer();
    server.gifts.push({ id: 'g1', kind: 'direct', marks: 5000, items: ['rim-gold'], message: 'Enjoy', from: 'Louis' });
    const { wallet } = await signedIn(server);
    await wallet.store.load();
    // The wallet answer carries the inbox.
    expect(wallet.gifts().map(gift => gift.id)).toEqual(['g1']);
    const seen: WalletRecord[] = [];
    wallet.store.subscribe?.(record => seen.push(record));
    const gift = await wallet.claimGift('g1');
    expect(gift).toMatchObject({ ok: true, marks: 5000, items: ['rim-gold'] });
    await wallet.refresh();
    expect(wallet.gifts()).toEqual([]);
    const bonus = await wallet.claimTestGrant();
    expect(bonus).toMatchObject({ ok: true, marks: 20000 });
    expect(seen.at(-1)?.earned.testgrant).toBe(20000);
    const again = await wallet.claimTestGrant();
    expect(again).toMatchObject({ ok: true, marks: 0 });
    const reopened = await wallet.claimGift('g1');
    expect(reopened).toMatchObject({ ok: false, message: 'This gift was already opened.' });
  });

  it('reads the testing bonus switch from the server config', async () => {
    const server = new FakeServer();
    const { wallet } = await signedIn(server);
    expect(await wallet.loadConfig()).toEqual({ marks: 20000, open: true });
    server.testGrant = { marks: 0, open: false };
    expect(await wallet.loadConfig()).toEqual({ marks: 0, open: false });
  });
});

describe('gift parsing and error text', () => {
  it('parses the server gift view and bounds it', () => {
    expect(parseGift({ id: 'a', kind: 'direct', marks: 5, items: ['x', 3], message: 'hi', from: 'Louis', createdAt: 5 })).toMatchObject({ id: 'a', marks: 5, items: ['x'], from: 'Louis', createdAt: 5 });
    expect(parseGift({ id: 'a', marks: 1e12 })?.marks).toBe(1_000_000);
    expect(parseGift({ nope: 1 })).toBeNull();
    expect(parseGift(null)).toBeNull();
  });
  it('explains the codes plainly, without em dashes', () => {
    const cases: [string, number][] = [['already-opened', 410], ['bad-code', 404], ['rate-limited', 429], ['locked', 429], ['expired', 410], ['revoked', 410], ['closed', 410], ['weird', 500]];
    for (const [code, status] of cases) expect(explainAction({ status, code, message: '', network: false }, 'Try again.')).not.toMatch(/—|–/);
    expect(explainAction({ status: 410, code: 'already-opened', message: '', network: false }, 'x')).toBe('This gift was already opened.');
    expect(explainAction({ status: 404, code: 'bad-code', message: '', network: false }, 'x')).toMatch(/does not look right/);
    expect(explainAction({ status: 0, code: '', message: '', network: true }, 'x')).toMatch(/Cannot reach/);
  });
});
