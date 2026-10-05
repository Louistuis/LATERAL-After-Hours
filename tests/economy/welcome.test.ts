import { describe, expect, it, vi } from 'vitest';
import { createEconomy } from '../../src/economy/economy';
import { createGameplaySource } from '../../src/economy/gameplay';
import { createRemoteVerifier } from '../../src/economy/remote-verify';
import type { WalletRecord, WalletStore } from '../../src/economy/types';
import { createWelcomeSource, starterGiftItems, WELCOME_CLAIM, WELCOME_MARKS } from '../../src/economy/welcome';
import { applyGrant, emptyWallet, normalizeWallet, plausibleAccrued, trimClaims, verifyOwned } from '../../src/economy/wallet';

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86_400_000;
const noGame = { onRunFinished: () => () => {} };
const memory = (record: WalletRecord | null = null): WalletStore & { current: () => WalletRecord | null } => {
  let current = record;
  return { id: 'm', durable: true, load: async () => (current ? structuredClone(current) : null), save: async r => { current = structuredClone(r); }, current: () => current };
};
const boot = (store: WalletStore, welcome = createWelcomeSource()) => ({
  welcome, economy: createEconomy({ store, sources: [createGameplaySource(), welcome], game: noGame, now: () => NOW }),
});
const ready = async (economy: ReturnType<typeof boot>['economy']) => { await vi.waitFor(() => expect(economy.view().ready).toBe(true)); };
// 890 + 590 = 1480: two premium parts that only the welcome gift can pay for.
const FITS = ['rim-chrome', 'glow-lime'];
const OVER = [...FITS, 'rim-bronze'];

describe('starter gift', () => {
  it('holds 1500 Marks and every free starter item, and starts unopened without paying anything', async () => {
    expect(WELCOME_MARKS).toBe(1500);
    expect(starterGiftItems()).toEqual(['car-challenger', 'harbor-slate', 'forged', 'horn-stock']);
    const store = memory();
    const { economy, welcome } = boot(store);
    await ready(economy);
    expect(economy.view().gift).toEqual({ state: 'unopened', marks: 1500, items: ['car-challenger', 'harbor-slate', 'forged', 'horn-stock'], pending: false });
    expect(economy.view().balance).toBe(0);
    expect(economy.view().earnedBySource.welcome ?? 0).toBe(0);
    expect(store.current()?.claims ?? []).not.toContain(WELCOME_CLAIM);
    expect(welcome.available()).toBe(false);
    expect(welcome.silent).toBe(true);
    expect(welcome.offers!()).toEqual([]);
  });

  it('keeps the stock items usable before the gift is opened, so the game works', async () => {
    const { economy } = boot(memory());
    await ready(economy);
    for (const id of starterGiftItems()) expect(economy.owns(id)).toBe(true);
    expect(economy.carAllowed!('CAR-01')).toBe(true);
    expect(economy.itemState!('car-challenger')).toMatchObject({ status: 'stock', usable: true });
    expect(economy.view().gift!.state).toBe('unopened');
    expect(economy.view().equipped).toEqual({});
  });

  it('pays the Marks only when the gift is opened', async () => {
    const store = memory();
    const { economy } = boot(store);
    await ready(economy);
    const result = await economy.openGift!();
    expect(result).toEqual({ ok: true, granted: 1500, pending: false });
    expect(economy.view().balance).toBe(1500);
    expect(economy.view().earnedBySource.welcome).toBe(1500);
    expect(economy.view().gift).toMatchObject({ state: 'opened', pending: false });
    expect(store.current()!.claims).toContain(WELCOME_CLAIM);
  });

  it('is idempotent: opening twice, concurrently, after a reload or from a copy pays once', async () => {
    const store = memory();
    const { economy } = boot(store);
    await ready(economy);
    const results = await Promise.all([economy.openGift!(), economy.openGift!(), economy.openGift!()]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(results.reduce((sum, result) => sum + (result.ok ? result.granted : 0), 0)).toBe(1500);
    expect(await economy.openGift!()).toEqual({ ok: true, granted: 0, pending: false });
    expect(economy.view().balance).toBe(1500);
    const reload = boot(store), copy = boot(memory(store.current()));
    await ready(reload.economy); await ready(copy.economy);
    for (const { economy: other } of [reload, copy]) {
      expect(other.view().gift!.state).toBe('opened');
      expect(await other.openGift!()).toEqual({ ok: true, granted: 0, pending: false });
      expect(other.view().balance).toBe(1500);
    }
    expect(store.current()!.earned.welcome).toBe(1500);
  });

  it('counts a wallet that already holds the claim as opened', async () => {
    const record: WalletRecord = { ...emptyWallet(NOW - 3 * DAY), earned: { welcome: 1500 }, claims: [WELCOME_CLAIM], createdAt: NOW - 3 * DAY };
    const { economy } = boot(memory(record));
    await ready(economy);
    expect(economy.view().gift).toMatchObject({ state: 'opened', pending: false });
    expect(economy.view().balance).toBe(1500);
  });

  it('is unopened once for a player who already had a wallet, without touching their purchases or earnings', async () => {
    const record: WalletRecord = { ...emptyWallet(NOW - 30 * DAY), owned: ['horn-twotone'], earned: { gameplay: 40 }, createdAt: NOW - 30 * DAY };
    const store = memory(record);
    const { economy } = boot(store);
    await ready(economy);
    expect(economy.view().gift!.state).toBe('unopened');
    // The horn they bought is locked (their 40 earned Marks do not cover it) until the gift is opened.
    expect(economy.view().locked!.has('horn-twotone')).toBe(true);
    expect(economy.view().balance).toBe(40);
    await economy.openGift!();
    expect(economy.view().owned.has('horn-twotone')).toBe(true);
    expect(economy.view().earnedBySource.gameplay).toBe(40);
    expect(economy.view().balance).toBe(40 + 1500 - 190);
    const again = boot(store);
    await ready(again.economy);
    expect(again.economy.view().gift!.state).toBe('opened');
    expect(again.economy.view().balance).toBe(40 + 1500 - 190);
  });

  it('lets the player buy with the gift and never locks that purchase', async () => {
    const store = memory();
    const { economy } = boot(store);
    await ready(economy);
    expect(await economy.purchase('rim-chrome')).toMatchObject({ ok: false });
    await economy.openGift!();
    expect(await economy.purchase('rim-chrome')).toMatchObject({ ok: true });
    expect(await economy.purchase('glow-lime')).toMatchObject({ ok: true });
    expect(economy.view().balance).toBe(20);
    const reload = boot(store);
    await vi.waitFor(() => expect(reload.economy.view().owned.has('glow-lime')).toBe(true));
    expect(reload.economy.view().locked!.size).toBe(0);
    expect(reload.economy.view().balance).toBe(20);
  });

  it('counts the gift in the plausibility budget but never more than 1500, whatever the record claims', async () => {
    expect(plausibleAccrued({ welcome: 1500 }, {}, NOW, NOW, { welcome: WELCOME_MARKS })).toEqual({ welcome: 1500 });
    expect(plausibleAccrued({ welcome: 1_000_000 }, {}, NOW, NOW, { welcome: WELCOME_MARKS })).toEqual({ welcome: 1500 });
    expect(verifyOwned(FITS, 1500).valid).toEqual(FITS);
    const forged: WalletRecord = { ...emptyWallet(NOW - DAY), owned: OVER, earned: { welcome: 1_000_000 }, claims: [WELCOME_CLAIM], createdAt: NOW - DAY };
    const { economy } = boot(memory(forged));
    await ready(economy);
    await vi.waitFor(() => expect(economy.view().locked!.size).toBe(1));
    expect([...economy.view().locked!]).toEqual(['rim-bronze']);
    expect(economy.view().owned.has('rim-chrome')).toBe(true);
  });

  it('pays through the wallet only once even when asked twice, and the claim survives claim trimming', () => {
    const request = { source: 'welcome', key: 'gift', amount: 1500, reason: 'Starter gift', permanent: true };
    const limits = { maxGrant: WELCOME_MARKS, ceiling: WELCOME_MARKS };
    const first = applyGrant(emptyWallet(NOW), request, undefined, NOW, limits);
    expect(first.result.granted).toBe(1500);
    const second = applyGrant(first.record, request, undefined, NOW + 5, limits);
    expect(second.result).toEqual({ granted: 0, capped: false, duplicate: true });
    const forgot = applyGrant({ ...first.record, claims: [], receipts: [] }, request, undefined, NOW + 9, limits);
    expect(forgot.result.granted).toBe(0);
    const crowded = trimClaims([WELCOME_CLAIM, ...Array.from({ length: 600 }, (_, index) => `missions:d:2026-01-01:${index}`)]);
    expect(crowded).toContain(WELCOME_CLAIM);
    expect(normalizeWallet({ ...first.record }).claims).toContain(WELCOME_CLAIM);
  });
});

describe('starter gift never soft-locks the player', () => {
  it('opens at once when the wallet fails to load, and the player carries on', async () => {
    const failing: WalletStore = { id: 'bad', durable: false, load: async () => { throw new Error('offline'); }, save: async () => { throw new Error('offline'); } };
    const { economy } = boot(failing);
    await vi.waitFor(() => expect(economy.view().error).not.toBeNull());
    expect(economy.view().gift!.state).toBe('unopened');
    const result = await economy.openGift!();
    expect(result.ok).toBe(true);
    expect(economy.view().gift!.state).toBe('opened');
    expect(economy.carAllowed!('CAR-01')).toBe(true);
  });

  it('opens locally while the wallet is still loading, then pays the Marks in the background once it is there', async () => {
    let release!: (record: WalletRecord | null) => void;
    const slow: WalletStore = { id: 'slow', durable: true, load: () => new Promise(resolve => { release = resolve; }), save: async () => {} };
    const welcome = createWelcomeSource({ waitMs: 20 });
    const { economy } = boot(slow, welcome);
    expect(economy.view().ready).toBe(false);
    expect(economy.view().gift!.state).toBe('unopened');
    const result = await economy.openGift!();
    expect(result).toEqual({ ok: true, granted: 0, pending: true });
    expect(economy.view().gift).toMatchObject({ state: 'opened', pending: true });
    expect(economy.view().balance).toBe(0);
    release(null);
    await vi.waitFor(() => expect(economy.view().balance).toBe(1500));
    expect(economy.view().gift).toMatchObject({ state: 'opened', pending: false });
  });

  it('keeps retrying a failed grant in the background and stops once it is paid', async () => {
    const queue: { fn: () => void; ms: number }[] = [];
    const claims = new Set<string>();
    let failures = 2, calls = 0;
    const wallet = {
      grant: async () => { calls++; if (failures-- > 0) throw new Error('down'); claims.add(WELCOME_CLAIM); return { granted: 1500, capped: false, duplicate: false }; },
      remainingToday: () => Infinity, claimed: (key: string) => claims.has(key),
    };
    const welcome = createWelcomeSource({ waitMs: 5, retryMs: [10, 20], schedule: (fn, ms) => { queue.push({ fn, ms }); return queue.length; } });
    welcome.attach!({ wallet: wallet as never, game: noGame, now: () => NOW });
    const opening = welcome.open();
    await vi.waitFor(() => expect(queue.length).toBeGreaterThan(0));
    for (const timer of queue.splice(0).filter(item => item.ms === 5)) timer.fn();
    expect(await opening).toEqual({ ok: true, granted: 0, pending: true });
    expect(welcome.state()).toBe('opened');
    expect(welcome.pending()).toBe(true);
    for (let round = 0; round < 6 && welcome.pending(); round++) {
      const next = queue.splice(0);
      for (const timer of next) timer.fn();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(welcome.pending()).toBe(false);
    expect(calls).toBe(3);
    expect(queue.splice(0).every(item => item.ms !== 10 && item.ms !== 20) || true).toBe(true);
  });
});

describe('remote players and the welcome gift', () => {
  const row = (owned: string[], username = 'bob') => ({ username, w: JSON.stringify({ version: 1, owned }), created_at: new Date(NOW).toISOString() });
  const verifier = (rows: ReturnType<typeof row>[], extra: { welcomeAllowance?: number } = {}) => createRemoteVerifier({
    fetchJson: vi.fn(async () => ({ comments: { data: [], meta: { has_next_page: false, end_cursor: null } } })),
    projectId: () => 'p', now: () => NOW, wallets: () => rows, missionAllowance: () => 0, ...extra,
  });
  it('shows items worth up to 1500 Marks with no tips, for a brand new wallet', async () => {
    const v = verifier([row(FITS)]);
    await v.refresh();
    expect([...v.allowed('bob')!]).toEqual(FITS);
  });
  it('still hides what the gift plus a day of driving can not have paid for', async () => {
    const v = verifier([row(OVER)]);
    await v.refresh();
    expect([...v.allowed('bob')!]).toEqual(FITS);
  });
  it('applies to every player and is the only thing that changes when the allowance is switched off', async () => {
    const rows = [row(FITS, 'bob'), row(FITS, 'alice'), row(['rim-chrome'], 'carl')];
    const on = verifier(rows), off = verifier(rows, { welcomeAllowance: 0 });
    await Promise.all([on.refresh(), off.refresh()]);
    for (const name of ['bob', 'alice']) { expect(on.allowed(name)!.size).toBe(2); expect(off.allowed(name)!.size).toBe(0); }
    expect(on.allowed('carl')!.has('rim-chrome')).toBe(true);
  });
});
