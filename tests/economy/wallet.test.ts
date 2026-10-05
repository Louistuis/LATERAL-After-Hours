import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../contracts/runtime-contracts';
import { CATALOG, decodeLoadout, encodeLoadout, sanitizeLoadout } from '../../src/economy/catalog';
import { createEconomy } from '../../src/economy/economy';
import { createGameplaySource, GAMEPLAY_DAILY_CAP, marksForRun } from '../../src/economy/gameplay';
import { createLayeredStore, createLocalWalletStore } from '../../src/economy/stores';
import type { EarnSource, WalletRecord, WalletStore } from '../../src/economy/types';
import { applyEquip, applyGrant, applyPurchase, balanceOf, emptyWallet, mergeWallets, normalizeWallet } from '../../src/economy/wallet';

const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 0, 5);

describe('purchase and spend', () => {
  it('deducts the price, records ownership and refuses repeats and overspend', () => {
    const wallet = emptyWallet();
    const poor = applyPurchase(wallet, 'salt-pearl', 100, DAY1);
    expect(poor).toMatchObject({ ok: false, reason: 'insufficient' });
    const bought = applyPurchase(wallet, 'salt-pearl', 5000, DAY1);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.record.spent).toBe(1190);
    expect(bought.record.owned).toEqual(['salt-pearl']);
    expect(balanceOf(bought.record, { tips: 5000 })).toBe(3810);
    expect(applyPurchase(bought.record, 'salt-pearl', 5000, DAY1)).toMatchObject({ ok: false, reason: 'owned' });
    expect(applyPurchase(wallet, 'harbor-slate', 0, DAY1)).toMatchObject({ ok: false, reason: 'owned' });
    expect(applyPurchase(wallet, 'not-a-thing', 1e6, DAY1)).toMatchObject({ ok: false, reason: 'unknown-item' });
  });
  it('equips only owned items in their own slot', () => {
    const wallet = emptyWallet();
    expect(applyEquip(wallet, 'paint', 'salt-pearl', DAY1)).toBe(wallet);
    expect(applyEquip(wallet, 'rim', 'salt-pearl', DAY1)).toBe(wallet);
    expect(applyEquip(wallet, 'paint', 'harbor-slate', DAY1).equipped.paint).toBe('harbor-slate');
    const owned = { ...wallet, owned: ['rim-gold'], spent: 950 };
    const equipped = applyEquip(owned, 'rim', 'rim-gold', DAY1);
    expect(equipped.equipped.rim).toBe('rim-gold');
    expect(applyEquip(equipped, 'rim', null, DAY1).equipped.rim).toBeUndefined();
  });
  it('normalizes tampered storage: unknown items dropped, spent never below owned value', () => {
    const record = normalizeWallet({ spent: 0, owned: ['gold-chrome', 'fake', 'harbor-slate'], earned: { gameplay: 1e12, tips: 'x' }, daily: { gameplay: { day: 'bad', amount: 5 } }, equipped: { paint: 'fake', rim: 'rim-gold' }, receipts: [1, 'ok'] });
    expect(record.owned).toEqual(['gold-chrome']);
    expect(record.spent).toBe(2490);
    expect(record.earned).toEqual({ gameplay: 1e9, tips: 0 });
    expect(record.daily).toEqual({});
    expect(record.equipped).toEqual({ rim: 'rim-gold' });
    expect(record.receipts).toEqual(['ok']);
    expect(normalizeWallet('garbage')).toEqual(emptyWallet());
  });
  it('merges two copies without losing purchases or earnings', () => {
    const a: WalletRecord = { ...emptyWallet(1), spent: 450, owned: ['tidewater-metallic'], earned: { gameplay: 50 }, receipts: ['gameplay:run:1'], equipped: { paint: 'tidewater-metallic' }, updatedAt: 10 };
    const b: WalletRecord = { ...emptyWallet(1), spent: 950, owned: ['rim-gold'], earned: { gameplay: 30 }, receipts: ['gameplay:run:2'], equipped: { rim: 'rim-gold' }, updatedAt: 20 };
    const merged = mergeWallets(a, b);
    expect([...merged.owned].sort()).toEqual(['rim-gold', 'tidewater-metallic']);
    expect(merged.spent).toBe(1400);
    expect(merged.earned.gameplay).toBe(50);
    expect([...merged.receipts].sort()).toEqual(['gameplay:run:1', 'gameplay:run:2']);
    expect(merged.equipped).toEqual({ rim: 'rim-gold' });
  });
});

describe('daily gameplay cap', () => {
  it('caps grants per UTC day, is idempotent by key and resets at midnight UTC', () => {
    let wallet = emptyWallet();
    const grant = (key: string, amount: number, now = DAY1) => {
      const out = applyGrant(wallet, { source: 'gameplay', key, amount, reason: 'run' }, 200, now);
      wallet = out.record;
      return out.result;
    };
    expect(grant('run:1', 150)).toEqual({ granted: 150, capped: false, duplicate: false });
    expect(grant('run:1', 150)).toEqual({ granted: 0, capped: false, duplicate: true });
    expect(grant('run:2', 150)).toEqual({ granted: 50, capped: true, duplicate: false });
    expect(grant('run:3', 10)).toEqual({ granted: 0, capped: true, duplicate: false });
    expect(wallet.earned.gameplay).toBe(200);
    expect(grant('run:3', 10, DAY2)).toEqual({ granted: 0, capped: false, duplicate: true });
    expect(grant('run:4', 40, DAY2)).toEqual({ granted: 40, capped: false, duplicate: false });
    expect(wallet.earned.gameplay).toBe(240);
    expect(wallet.daily.gameplay).toEqual({ day: '2026-10-02', amount: 40 });
    expect(grant('run:5', 1e9, DAY2).granted).toBe(160);
  });
  it('pays small amounts for real runs only', () => {
    expect(GAMEPLAY_DAILY_CAP).toBe(25);
    const run = (over: Partial<RunResult>): RunResult => ({ runId: 'r', routeId: 'harbor' as never, mode: 'drift-attack', rulesVersion: '1', carId: 'CAR-01' as never, elapsedActiveSeconds: 60, bankedScore: 40000, medal: 'gold', valid: true, ...over } as RunResult);
    expect(marksForRun(run({}))).toBe(2 + 3 + 3);
    expect(marksForRun(run({ valid: false }))).toBe(0);
    expect(marksForRun(run({ elapsedActiveSeconds: 5 }))).toBe(0);
    expect(marksForRun(run({ mode: 'time-trial' as never, medal: 'none' as never }))).toBe(3);
    expect(marksForRun(run({ bankedScore: Number.NaN, medal: 'none' as never }))).toBe(2);
  });
});

describe('loadout wire format', () => {
  it('round-trips through the presence paint string and rejects junk', () => {
    const loadout = { paint: 'northern-shift', rim: 'rim-gold', underglow: 'glow-cycle', smoke: 'smoke-violet', plate: 'plate-berth', horn: 'horn-bell', wheelStyle: 'mesh' };
    const wire = encodeLoadout(loadout);
    expect(wire.length).toBeLessThan(200);
    expect(decodeLoadout(wire)).toEqual(loadout);
    expect(decodeLoadout(encodeLoadout({ paint: 'carbon' }))).toEqual({ paint: 'carbon' });
    expect(decodeLoadout('harbor-slate')).toBeNull();
    expect(decodeLoadout('~rim-gold.harbor-slate.<script>')).toEqual({});
    expect(sanitizeLoadout({ paint: 'rim-gold' })).toEqual({});
  });
  it('has unique ids, sane prices and no em dashes in copy', () => {
    expect(new Set(CATALOG.map(item => item.id)).size).toBe(CATALOG.length);
    for (const item of CATALOG) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/);
      expect(item.price).toBeGreaterThanOrEqual(0);
      expect(item.price === 0).toBe(item.rarity === 'stock');
      expect(Number.isSafeInteger(item.price)).toBe(true);
      expect(`${item.name} ${item.blurb}`).not.toMatch(/—/);
    }
  });
});

function memoryStore(initial: WalletRecord | null = null, failSave = false): WalletStore & { saved: WalletRecord[] } {
  let current = initial;
  const saved: WalletRecord[] = [];
  return {
    id: 'memory', durable: true, saved,
    async load() { return current; },
    async save(record) { if (failSave) throw new Error('offline'); current = record; saved.push(record); },
  };
}
function derivedSource(total: number): EarnSource & { set(n: number): void } {
  const listeners = new Set<() => void>();
  return {
    id: 'tips', kind: 'derived', label: 'Tips',
    available: () => true, total: () => total, refresh: async () => {},
    set(n) { total = n; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); },
  };
}
const noGame = { onRunFinished: () => () => {} };

describe('economy facade', () => {
  it('balance = derived tips + accrued - spent, and stored tip numbers are ignored', async () => {
    const store = memoryStore({ ...emptyWallet(), earned: { gameplay: 120, tips: 999999 }, spent: 400, owned: ['tidewater-metallic'] });
    const economy = createEconomy({ store, sources: [derivedSource(1100)], game: noGame });
    await economy.refresh();
    expect(economy.view().ready).toBe(true);
    expect(economy.view().balance).toBe(1100 + 120 - 450);
    expect(economy.view().earnedBySource).toEqual({ gameplay: 120, tips: 1100 });
  });
  it('purchases persist, equip follows ownership, and insufficient balance is refused', async () => {
    const store = memoryStore();
    const tips = derivedSource(1000);
    const economy = createEconomy({ store, sources: [tips], game: noGame });
    await economy.refresh();
    expect(await economy.purchase('gold-chrome')).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(await economy.purchase('tidewater-metallic')).toEqual({ ok: true, balance: 550 });
    await economy.equip('paint', 'tidewater-metallic');
    await economy.equip('paint', 'salt-pearl');
    expect(economy.view().equipped).toEqual({ paint: 'tidewater-metallic' });
    expect(store.saved.at(-1)?.owned).toEqual(['tidewater-metallic']);
    const seen = vi.fn();
    economy.subscribe(seen);
    tips.set(1500);
    expect(economy.view().balance).toBe(1050);
    expect(economy.view().lastCredit).toMatchObject({ amount: 500, source: 'tips' });
    expect(seen).toHaveBeenCalled();
  });
  it('wires the gameplay source to finished runs with the daily cap', async () => {
    let finish: ((result: RunResult) => void) | null = null;
    const game = { onRunFinished: (listener: (result: RunResult) => void) => { finish = listener; return () => { finish = null; }; } };
    const store = memoryStore();
    const economy = createEconomy({ store, sources: [createGameplaySource(8)], game, now: () => DAY1 });
    await economy.refresh();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    const run = { runId: 'a', mode: 'drift-attack', elapsedActiveSeconds: 60, bankedScore: 0, medal: 'gold', valid: true } as unknown as RunResult;
    finish!(run);
    finish!(run);
    finish!({ ...run, runId: 'b' });
    await vi.waitFor(() => expect(economy.view().balance).toBe(8));
    expect(store.saved.at(-1)?.daily.gameplay).toEqual({ day: '2026-10-01', amount: 8 });
  });
  it('blocks purchases while the wallet store is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store: WalletStore = { id: 'down', durable: true, load: async () => { throw new Error('offline'); }, save: async () => {} };
    const economy = createEconomy({ store, sources: [derivedSource(5000)], game: noGame });
    expect(await economy.purchase('tidewater-metallic')).toMatchObject({ ok: false, reason: 'not-ready' });
    warn.mockRestore();
    economy.dispose();
  });
  it('layered store keeps the local copy when the remote fails and merges both on load', async () => {
    const local = createLocalWalletStore('k', null);
    const remote = memoryStore({ ...emptyWallet(), owned: ['rim-gold'], spent: 950, updatedAt: 5 });
    const layered = createLayeredStore(remote, local);
    await local.save({ ...emptyWallet(), owned: ['rim-bronze'], spent: 450, updatedAt: 9 });
    const loaded = await layered.load();
    expect([...(loaded?.owned ?? [])].sort()).toEqual(['rim-bronze', 'rim-gold']);
    expect(loaded?.spent).toBe(1400);
    const broken = createLayeredStore({ id: 'r', durable: true, load: async () => { throw new Error('x'); }, save: async () => { throw new Error('x'); } }, local);
    expect((await broken.load())?.owned).toEqual(['rim-bronze']);
    await expect(broken.save(emptyWallet())).rejects.toThrow();
    expect((await local.load())?.owned).toEqual([]);
  });
});
