import { describe, expect, it } from 'vitest';
import { bootSelfhostEconomy, createSelfhostServices, selfhostSources } from '../../src/selfhost/boot';
import { TEST_GRANT_CLAIM, createTestGrantSource, offerState } from '../../src/selfhost/testgrant';
import { createLocalWalletStore } from '../../src/economy/stores';
import { FakeServer, memoryStorage } from './helpers';

const noGame = { onRunFinished: () => () => {} };

async function boot(server: FakeServer, name = 'Louis') {
  const storage = memoryStorage();
  const services = createSelfhostServices({ storage, fetch: server.fetch });
  await services.account.create(name);
  services.decide();
  const { economy, platform } = bootSelfhostEconomy({ game: noGame, services });
  await economy.whenSettled?.(4000);
  return { services, economy, platform, storage };
}

describe('economy of the selfhost build', () => {
  it('has missions, welcome, daily challenge, gifts and the testing bonus, and nothing that pays for driving, tips or creators', async () => {
    const server = new FakeServer();
    const { economy, platform } = await boot(server);
    expect(platform).toBe('selfhost');
    expect(economy.sources().map(source => source.id)).toEqual(['missions', 'welcome', 'daily', 'gift', 'testgrant']);
    for (const banned of ['gameplay', 'tips', 'creator']) expect(economy.sources().some(source => source.id === banned)).toBe(false);
    economy.dispose();
  });

  it('sources are the same list the boot uses and none of them is derived (nothing is read from a third party)', () => {
    const server = new FakeServer();
    const services = createSelfhostServices({ storage: memoryStorage(), fetch: server.fetch });
    const sources = selfhostSources(services);
    expect(sources.every(source => source.kind === 'accrued')).toBe(true);
    expect(sources.find(source => source.id === 'gift')).toMatchObject({ maxGrant: 0 });
    expect(sources.find(source => source.id === 'testgrant')).toMatchObject({ maxGrant: 0 });
  });

  it('plays without an account on a local wallet and never calls the server wallet', async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const services = createSelfhostServices({ storage, fetch: server.fetch });
    services.account.setGuest(true);
    services.decide();
    const { economy } = bootSelfhostEconomy({ game: noGame, services });
    await economy.whenSettled?.(4000);
    expect(economy.view().ready).toBe(true);
    expect(server.calls.some(call => call.url === '/api/v1/wallet')).toBe(false);
    // The testing bonus is for accounts: it is not offered here.
    expect(economy.sources().find(source => source.id === 'testgrant')?.offers?.()).toEqual([]);
    economy.dispose();
  });
});

describe('testing bonus sheet states', () => {
  it('is hidden when the server closed it, claimable, then claimed', () => {
    expect(offerState(null, false)).toBe('hidden');
    expect(offerState({ marks: 20000, open: false }, false)).toBe('hidden');
    expect(offerState({ marks: 0, open: true }, false)).toBe('hidden');
    expect(offerState({ marks: 20000, open: true }, false)).toBe('claimable');
    expect(offerState({ marks: 20000, open: true }, true)).toBe('claimed');
  });

  it('shows one offer with the amount, claims it once and then reads Claimed', async () => {
    const server = new FakeServer();
    const { economy, services } = await boot(server);
    await services.wallet.loadConfig();
    const source = economy.sources().find(item => item.id === 'testgrant')!;
    const offer = source.offers!()[0]!;
    expect(offer.title).toBe('Testing bonus: claim 20,000 Marks');
    expect(offer.unavailable).toBeNull();
    const before = economy.view().balance;
    const result = await source.redeem!(offer.id);
    expect(result).toMatchObject({ status: 'granted', marks: 20000 });
    await economy.refresh();
    expect(economy.view().balance - before).toBe(20000);
    expect(source.offers!()[0]!.unavailable).toBe('Claimed');
    const again = await source.redeem!(offer.id);
    expect(again.status).toBe('failed');
    expect(economy.view().balance - before).toBe(20000);
    economy.dispose();
  });

  it('stays claimed after a reload because the claim key is in the wallet', async () => {
    const server = new FakeServer();
    const first = await boot(server);
    await first.services.wallet.loadConfig();
    await first.economy.sources().find(item => item.id === 'testgrant')!.redeem!('claim');
    first.economy.dispose();
    const services = createSelfhostServices({ storage: first.storage, fetch: server.fetch });
    services.decide();
    const { economy } = bootSelfhostEconomy({ game: noGame, services });
    await economy.whenSettled?.(4000);
    await services.wallet.loadConfig();
    expect(economy.sources().find(item => item.id === 'testgrant')!.offers!()[0]!.unavailable).toBe('Claimed');
    expect(server.byName('Louis').record?.claims).toContain(TEST_GRANT_CLAIM);
    economy.dispose();
  });

  it('vanishes when the server closes the bonus', async () => {
    const server = new FakeServer();
    server.testGrant = { marks: 0, open: false };
    const { economy, services } = await boot(server);
    await services.wallet.loadConfig();
    expect(economy.sources().find(item => item.id === 'testgrant')!.offers!()).toEqual([]);
    expect(economy.sources().find(item => item.id === 'testgrant')!.available()).toBe(false);
    economy.dispose();
  });

  it('does not offer anything when signed out', () => {
    const source = createTestGrantSource({ config: () => ({ marks: 20000, open: true }), onConfig: () => () => {}, loadConfig: async () => null, claimTestGrant: async () => ({ ok: false, code: 'x', message: 'x', retry: false }) }, () => false);
    expect(source.state()).toBe('hidden');
    expect(source.offers!()).toEqual([]);
  });

  it('a purchase after the bonus survives a reload', async () => {
    const server = new FakeServer();
    const { economy, services, storage } = await boot(server);
    await services.wallet.loadConfig();
    await economy.sources().find(item => item.id === 'testgrant')!.redeem!('claim');
    const bought = await economy.purchase('rim-gold');
    expect(bought.ok).toBe(true);
    const balance = economy.view().balance;
    economy.dispose();
    const again = createSelfhostServices({ storage, fetch: server.fetch });
    again.decide();
    const next = bootSelfhostEconomy({ game: noGame, services: again });
    await next.economy.whenSettled?.(4000);
    expect(next.economy.owns('rim-gold')).toBe(true);
    expect(next.economy.view().balance).toBe(balance);
    next.economy.dispose();
  });

  it('a purchase the server refuses is rolled back and the wallet is refreshed', async () => {
    const server = new FakeServer();
    const { economy, services } = await boot(server);
    await services.wallet.loadConfig();
    await economy.sources().find(item => item.id === 'testgrant')!.redeem!('claim');
    server.rejectNext = 'unknown-item';
    const bought = await economy.purchase('rim-gold');
    expect(bought.ok).toBe(false);
    expect(economy.owns('rim-gold')).toBe(false);
    economy.dispose();
  });
});

describe('local cache key', () => {
  it('keeps two accounts on one device apart', async () => {
    const storage = memoryStorage();
    const a = createLocalWalletStore('lateral:wallet:v1:selfhost:acc-1', storage);
    const b = createLocalWalletStore('lateral:wallet:v1:selfhost:acc-2', storage);
    await a.save({ version: 1, spent: 0, owned: [], equipped: {}, earned: { welcome: 1500 }, daily: {}, receipts: [], updatedAt: 1 });
    expect(await b.load()).toBeNull();
  });
});
