import { describe, expect, it, vi } from 'vitest';
import { createEconomy } from '../../src/economy/economy';
import { selectOwnedCar } from '../../src/economy/car-select';
import { createLayeredStore, createLocalWalletStore } from '../../src/economy/stores';
import type { EarnSource, WalletRecord, WalletStore } from '../../src/economy/types';
import { GAMEPLAY_DAILY_CAP, createGameplaySource } from '../../src/economy/gameplay';
import { MAX_WALLET_JSON, allowanceDays, applyEquip, applyPurchase, emptyWallet, mergeWallets, normalizeWallet, parseWalletJson, plausibleAccrued, spentOf, verifyOwned } from '../../src/economy/wallet';

const NOW = Date.UTC(2026, 9, 2, 12);
const noGame = { onRunFinished: () => () => {} };

function memoryStore(initial: WalletRecord | null = null, hooks: { failFresh?: () => boolean; created?: number | null } = {}): WalletStore & { saved: WalletRecord[]; current(): WalletRecord | null } {
  let current = initial;
  const saved: WalletRecord[] = [];
  return {
    id: 'memory', durable: true, saved, current: () => current,
    async load() { return current; },
    async loadFresh() { if (hooks.failFresh?.()) throw new Error('unreachable'); return current; },
    serverCreatedAt: () => hooks.created ?? null,
    async save(record) { current = record; saved.push(record); },
  };
}
function tips(total: number, state: { settled: boolean } = { settled: true }): EarnSource & { set(n: number): void; state: { settled: boolean } } {
  const listeners = new Set<() => void>();
  return {
    id: 'tips', kind: 'derived', label: 'Tips', state,
    available: () => true, total: () => total, refresh: async () => {}, settled: () => state.settled,
    set(n) { total = n; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); },
  };
}

describe('ownership is derived from the purchase list, never from a stored number', () => {
  it('recomputes spent from owned items and ignores a forged spent', () => {
    const record = normalizeWallet({ spent: 0, owned: ['gold-chrome', 'car-cybertruck'] });
    expect(record.spent).toBe(2490 + 4990);
    expect(spentOf(record)).toBe(7480);
    expect(normalizeWallet({ spent: 1e9, owned: [] }).spent).toBe(0);
  });
  it('drops unknown, free and non-string ids and bounds hostile lists', () => {
    const owned = ['harbor-slate', 'car-challenger', 'nope', 7, null, '__proto__', 'rim-gold', 'rim-gold', ...Array.from({ length: 5000 }, (_, i) => `x${i}`)];
    const record = normalizeWallet({ owned, earned: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`s${i}`, 5])), receipts: Array.from({ length: 9000 }, (_, i) => `r${i}`) });
    expect(record.owned).toEqual(['rim-gold']);
    expect(Object.keys(record.earned).length).toBeLessThanOrEqual(16);
    expect(record.receipts.length).toBeLessThanOrEqual(300);
  });
  it('ignores oversized or junk stored JSON without parsing it', () => {
    expect(parseWalletJson('x'.repeat(MAX_WALLET_JSON + 1))).toBeNull();
    expect(parseWalletJson('{not json')).toBeNull();
    expect(parseWalletJson(42)).toBeNull();
    expect(parseWalletJson(JSON.stringify({ owned: ['rim-gold'] }))?.owned).toEqual(['rim-gold']);
  });
  it('verifyOwned keeps the oldest purchases that fit the budget and locks the rest, in order', () => {
    expect(verifyOwned(['rim-gold', 'gold-chrome', 'horn-twotone'], 1500)).toEqual({ valid: ['rim-gold'], locked: ['gold-chrome', 'horn-twotone'] });
    expect(verifyOwned(['rim-gold'], 949).locked).toEqual(['rim-gold']);
    expect(verifyOwned(['rim-gold'], Number.NaN).locked).toEqual(['rim-gold']);
    expect(verifyOwned([], 0)).toEqual({ valid: [], locked: [] });
  });
  it('merging copies unions the lists and recomputes spent, so "owning" items never hides their cost', () => {
    const honest: WalletRecord = { ...emptyWallet(1), owned: ['horn-twotone'], spent: 190, updatedAt: 1 };
    const forged: WalletRecord = { ...emptyWallet(1), owned: ['car-cybertruck', 'gold-chrome'], spent: 0, updatedAt: 2 };
    const merged = mergeWallets(honest, forged);
    expect(merged.owned).toEqual(['horn-twotone', 'car-cybertruck', 'gold-chrome']);
    expect(merged.spent).toBe(190 + 4990 + 2490);
    expect(mergeWallets(forged, honest).spent).toBe(merged.spent);
  });
  it('caps client-claimed earnings to the daily cap times the wallet age', () => {
    expect(allowanceDays(NOW, NOW)).toBe(1);
    expect(allowanceDays(Date.UTC(2026, 9, 1, 23, 59), Date.UTC(2026, 9, 2, 0, 1))).toBe(2);
    expect(allowanceDays(undefined, NOW)).toBe(1);
    expect(allowanceDays(NOW + 1e9, NOW)).toBe(1);
    expect(plausibleAccrued({ gameplay: 1e9, other: 7 }, { gameplay: GAMEPLAY_DAILY_CAP }, Date.UTC(2026, 9, 1), NOW)).toEqual({ gameplay: 50, other: 7 });
    expect(plausibleAccrued({ gameplay: Number.NaN, b: -4 }, { gameplay: 25 }, NOW, NOW)).toEqual({});
  });
});

describe('purchase validation', () => {
  it('rejects bad ids, bad balances and repeats, and never lets the balance go below zero', () => {
    const wallet = emptyWallet(NOW);
    for (const bad of [undefined, null, 5, {}, '', 'x'.repeat(200)]) expect(applyPurchase(wallet, bad, 1e6, NOW)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(applyPurchase(wallet, 'not-a-thing', 1e6, NOW)).toMatchObject({ ok: false, reason: 'unknown-item' });
    expect(applyPurchase(wallet, 'horn-twotone', Number.NaN, NOW)).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(applyPurchase(wallet, 'horn-twotone', -50, NOW)).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(applyPurchase(wallet, 'horn-twotone', 189, NOW)).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(applyPurchase(wallet, 'car-challenger', 1e6, NOW)).toMatchObject({ ok: false, reason: 'owned' });
    const bought = applyPurchase(wallet, 'horn-twotone', 190, NOW);
    expect(bought.ok && bought.record.spent).toBe(190);
    if (bought.ok) expect(applyPurchase(bought.record, 'horn-twotone', 1e6, NOW)).toMatchObject({ ok: false, reason: 'owned' });
  });
  it('cars can not be equipped into a loadout slot', () => {
    const wallet = { ...emptyWallet(NOW), owned: ['car-cybertruck'] };
    expect(applyEquip(wallet, 'paint' as never, 'car-cybertruck', NOW)).toBe(wallet);
  });
});

describe('economy: tampering and locks', () => {
  it('locks owned items the verified budget can not pay for (edited storage)', async () => {
    const store = memoryStore({ ...emptyWallet(NOW), owned: ['gold-chrome', 'car-cybertruck'], spent: 0, equipped: { paint: 'gold-chrome' }, earned: { gameplay: 1e9 } });
    const economy = createEconomy({ store, sources: [tips(0), createGameplaySource()], game: noGame, now: () => NOW });
    await economy.refresh();
    const view = economy.view();
    expect(view.owned.has('gold-chrome')).toBe(false);
    expect([...view.locked!].sort()).toEqual(['car-cybertruck', 'gold-chrome']);
    expect(view.equipped.paint).toBeUndefined();
    expect(view.balance).toBe(GAMEPLAY_DAILY_CAP);
    expect(view.budget).toBe(GAMEPLAY_DAILY_CAP);
    expect(economy.carAllowed!('CAR-02')).toBe(false);
    expect(economy.carAllowed!('CAR-01')).toBe(true);
    expect(economy.itemState!('gold-chrome')).toMatchObject({ status: 'locked', usable: false });
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: false, reason: 'insufficient' });
  });
  it('locked items unlock again when real tips arrive', async () => {
    const source = tips(0);
    const store = memoryStore({ ...emptyWallet(NOW), owned: ['rim-gold'] });
    const economy = createEconomy({ store, sources: [source], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(economy.view().locked!.has('rim-gold')).toBe(true);
    source.set(1000);
    expect(economy.view().owned.has('rim-gold')).toBe(true);
    expect(economy.view().balance).toBe(50);
  });
  it('paid, verified purchases stay owned and usable', async () => {
    const economy = createEconomy({ store: memoryStore(), sources: [tips(1250)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(await economy.purchase('rim-gold')).toEqual({ ok: true, balance: 300 });
    await economy.equip('rim', 'rim-gold');
    expect(economy.view().equipped.rim).toBe('rim-gold');
    expect(economy.itemState!('rim-gold')).toMatchObject({ status: 'owned', usable: true });
  });
  it('backdated gameplay allowance does not help when the store reports a server creation time', async () => {
    const old = { ...emptyWallet(1), createdAt: 1, earned: { gameplay: 100000 }, owned: ['rim-gold'] };
    const economy = createEconomy({ store: memoryStore(old, { created: NOW }), sources: [createGameplaySource()], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(economy.view().budget).toBe(GAMEPLAY_DAILY_CAP);
    expect(economy.view().locked!.has('rim-gold')).toBe(true);
  });
});

describe('economy: purchases are atomic and idempotent', () => {
  it('rapid double clicks spend once and share one result', async () => {
    const store = memoryStore();
    const economy = createEconomy({ store, sources: [tips(500)], game: noGame, now: () => NOW });
    await economy.refresh();
    const results = await Promise.all([economy.purchase('horn-twotone'), economy.purchase('horn-twotone'), economy.purchase('horn-twotone')]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(economy.view().balance).toBe(310);
    expect(store.current()?.owned).toEqual(['horn-twotone']);
  });
  it('parallel purchases of different items can not overspend', async () => {
    const economy = createEconomy({ store: memoryStore(), sources: [tips(500)], game: noGame, now: () => NOW });
    await economy.refresh();
    const results = await Promise.all([economy.purchase('plate-afterhours'), economy.purchase('plate-lateral'), economy.purchase('horn-foghorn')]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(economy.view().balance).toBeGreaterThanOrEqual(0);
    expect(economy.view().balance).toBe(10);
  });
  it('two tabs on one store: the stale tab sees the other purchase first and is refused', async () => {
    const store = memoryStore();
    const a = createEconomy({ store, sources: [tips(500)], game: noGame, now: () => NOW });
    const b = createEconomy({ store, sources: [tips(500)], game: noGame, now: () => NOW });
    await Promise.all([a.refresh(), b.refresh()]);
    expect(await a.purchase('plate-afterhours')).toMatchObject({ ok: true });
    expect(await b.purchase('plate-lateral')).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(store.current()?.owned).toEqual(['plate-afterhours']);
  });
  it('refuses while the tip ledger is loading or incomplete, and after it completes the purchase works', async () => {
    const state = { settled: false };
    const economy = createEconomy({ store: memoryStore(), sources: [tips(5000, state)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(economy.view().purchasesOpen).toBe(false);
    expect(economy.itemState!('horn-twotone')).toMatchObject({ status: 'unavailable', usable: false });
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: false, reason: 'not-ready' });
    state.settled = true;
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: true });
  });
  it('refuses when the store is unreachable at purchase time and spends nothing', async () => {
    let down = false;
    const store = memoryStore(null, { failFresh: () => down });
    const economy = createEconomy({ store, sources: [tips(5000)], game: noGame, now: () => NOW });
    await economy.refresh();
    down = true;
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: false, reason: 'store-failed' });
    expect(economy.view().owned.has('horn-twotone')).toBe(false);
    expect(store.saved).toHaveLength(0);
    down = false;
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: true });
  });
  it('a layered store treats an unreachable primary as unreachable for purchases even when the cache answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = createLocalWalletStore('k', null);
    const remote: WalletStore = { id: 'r', durable: true, load: async () => emptyWallet(NOW), loadFresh: async () => { throw new Error('x'); }, save: async () => {} };
    const economy = createEconomy({ store: createLayeredStore(remote, local), sources: [tips(5000)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(await economy.purchase('horn-twotone')).toMatchObject({ ok: false, reason: 'store-failed' });
    warn.mockRestore();
  });
  it('rejects non-string and unknown ids through the facade', async () => {
    const economy = createEconomy({ store: memoryStore(), sources: [tips(5000)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(await economy.purchase(undefined as never)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await economy.purchase('__proto__')).toMatchObject({ ok: false, reason: 'unknown-item' });
    expect(await economy.purchase('car-challenger')).toMatchObject({ ok: false, reason: 'owned' });
  });
  it('item states and car permission across the ladder', async () => {
    const economy = createEconomy({ store: memoryStore(), sources: [tips(200)], game: noGame, now: () => NOW });
    expect(economy.carAllowed!('CAR-01')).toBe(true);
    expect(economy.carAllowed!('CAR-02')).toBe(false);
    await economy.refresh();
    expect(economy.itemState!('horn-twotone')).toMatchObject({ status: 'buyable', shortfall: 0, kind: 'cosmetic' });
    expect(economy.itemState!('car-cybertruck')).toMatchObject({ status: 'unaffordable', kind: 'car', carId: 'CAR-02', shortfall: 4990 - 200 });
    expect(economy.itemState!('car-challenger')).toMatchObject({ status: 'stock', usable: true });
    expect(economy.itemState!('nope')).toBeNull();
    expect(economy.items!('car').map(entry => entry.carId)).toEqual(expect.arrayContaining(['CAR-01', 'CAR-02']));
    expect(economy.carAllowed!('CAR-03' as never)).toBe(false);
    expect(economy.carAllowed!('CAR-99' as never)).toBe(false);
    expect(await economy.whenSettled!(50)).toBe(true);
  });
});

describe('car selection facade', () => {
  it('refuses locked and unknown cars before touching the garage, allows the starter and owned cars', async () => {
    const picked: string[] = [];
    const selector = { selectCar: async (car: string) => { picked.push(car); } };
    const economy = createEconomy({ store: memoryStore({ ...emptyWallet(NOW), owned: ['car-cybertruck'] }), sources: [tips(5000)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(await selectOwnedCar(economy, selector as never, 'CAR-01')).toEqual({ ok: true });
    expect(await selectOwnedCar(economy, selector as never, 'CAR-02')).toEqual({ ok: true });
    expect(await selectOwnedCar(economy, selector as never, 'CAR-03' as never)).toMatchObject({ ok: false, reason: 'unknown' });
    expect(picked).toEqual(['CAR-01', 'CAR-02']);
    const poor = createEconomy({ store: memoryStore(), sources: [tips(0)], game: noGame, now: () => NOW });
    await poor.refresh();
    const denied = await selectOwnedCar(poor, selector as never, 'CAR-02');
    expect(denied).toMatchObject({ ok: false, reason: 'locked' });
    expect(picked).toEqual(['CAR-01', 'CAR-02']);
    const failing = await selectOwnedCar(economy, { selectCar: async () => { throw new Error('boom'); } } as never, 'CAR-01');
    expect(failing).toMatchObject({ ok: false, reason: 'failed', message: 'boom' });
  });
});
