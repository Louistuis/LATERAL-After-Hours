/**
 * Platform-neutral economy facade: wallet record + earn sources + store. Knows nothing about websim or portals.
 *
 * Safety model (see SECURITY.md):
 *   - balance = verified budget - spent, where spent is recomputed from the purchase list, never stored-and-trusted;
 *   - owned items the verified budget can not pay for are locked (unusable, not in view.owned or view.equipped);
 *   - purchase() is serialized (one at a time), idempotent per item, refuses while the wallet or tip ledger is
 *     loading or incomplete, and re-reads the store first so a stale second tab can not double-spend.
 */
import type { CarId } from '../../contracts/runtime-contracts';
import { carItem, catalogEntry, ITEMS } from './catalog';
import { CUSTOM_PLATE_ID } from './plate';
import { starterGiftItems, WELCOME_CLAIM, WELCOME_MARKS, type WelcomeSource } from './welcome';
import { mergeProgress, normalizeProgress, sameProgress } from './mission-progress';
import type {
  CosmeticSlot, Economy, EconomyGameEvents, EconomyView, EarnSource, GiftView, GrantRequest, GrantResult, ItemKind, ItemState, Loadout,
  PlateResult, PurchaseResult, WalletGrantPort, WalletRecord, WalletStore,
} from './types';
import {
  applyEquip, applyGrant, applyPlateText, applyPurchase, emptyWallet, grantedToday, mergeWallets, normalizeWallet, plausibleAccrued, sameWallet, sumValues, verifyOwned,
} from './wallet';

export interface EconomyOptions {
  readonly store: WalletStore;
  readonly sources: readonly EarnSource[];
  readonly game: EconomyGameEvents;
  readonly now?: () => number;
}

const STORE_TIMEOUT_MS = 8000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function createEconomy(options: EconomyOptions): Economy {
  const now = options.now ?? (() => Date.now());
  const sources = options.sources;
  const giftSource = (sources.find(source => source.id === 'welcome') as WelcomeSource | undefined) ?? null;
  const derivedIds = new Set(sources.filter(source => source.kind === 'derived').map(source => source.id));
  const caps: Record<string, number> = {};
  for (const source of sources) if (source.kind === 'accrued' && typeof source.dailyCap === 'number') caps[source.id] = source.dailyCap;
  const listeners = new Set<(view: EconomyView) => void>();
  let record: WalletRecord = emptyWallet();
  let anchor: number | null = null;
  let ready = false, disposed = false, error: string | null = null;
  let lastCredit: EconomyView['lastCredit'] = null, seq = 0;
  let derivedSeen: Record<string, number> = {};
  let cached: EconomyView | null = null;
  let writes: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<PurchaseResult>>();
  const detachers: (() => void)[] = [];

  const derived = (): Record<string, number> => {
    const totals: Record<string, number> = {};
    for (const source of sources) if (source.kind === 'derived' && (source.available() || source.silent)) totals[source.id] = Math.max(0, Math.floor(source.total?.() ?? 0));
    return totals;
  };
  /** Every derived source has read its source of truth completely (sources that can not say are assumed settled). */
  const settled = (): boolean => sources.every(source => source.kind !== 'derived' || !source.settled || source.settled());
  const ledgerStates = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const source of sources) if (source.kind === 'derived') out[source.id] = source.status?.() ?? (source.settled && !source.settled() ? 'loading' : 'ready');
    return out;
  };
  const adopt = (loaded: WalletRecord): void => {
    record = mergeWallets(record, loaded);
    const server = options.store.serverCreatedAt?.();
    if (typeof server === 'number' && Number.isFinite(server) && server > 0) anchor = server;
    if (!record.createdAt) record = { ...record, createdAt: anchor ?? now() };
  };

  interface Computed {
    readonly totals: Record<string, number>; readonly accrued: Record<string, number>; readonly budget: number;
    readonly valid: ReadonlySet<string>; readonly locked: ReadonlySet<string>; readonly spent: number; readonly balance: number; readonly verified: boolean;
  }
  const compute = (): Computed => {
    const totals = derived();
    const stored: Record<string, number> = {};
    for (const [id, amount] of Object.entries(record.earned)) if (!derivedIds.has(id)) stored[id] = amount;
    // Client-claimed earnings are capped to what the daily caps allow since the wallet was created
    // (missions: to the most they could ever have paid a wallet of this age).
    const created = anchor ?? record.createdAt ?? null;
    const ceilings: Record<string, number> = {};
    for (const source of sources) if (source.kind === 'accrued' && source.ceiling) ceilings[source.id] = source.ceiling(created, now());
    const accrued = plausibleAccrued(stored, caps, created, now(), ceilings);
    const budget = Math.floor(sumValues(totals) + sumValues(accrued));
    const verified = settled();
    // While tips are loading or failed the budget is a lower bound: do not lock yet (display only; purchases stay refused).
    const { valid, locked } = verified ? verifyOwned(record.owned, budget) : { valid: [...record.owned], locked: [] as string[] };
    const spent = valid.reduce((sum, id) => sum + (catalogEntry(id)?.price ?? 0), 0);
    return { totals, accrued, budget, valid: new Set(valid), locked: new Set(locked), spent, balance: Math.max(0, budget - spent), verified };
  };
  const usable = (id: string, state = compute()): boolean => {
    const entry = catalogEntry(id);
    return Boolean(entry && !entry.hidden && (entry.price === 0 || state.valid.has(id)));
  };

  const changed = (): void => {
    cached = null;
    if (disposed) return;
    for (const source of sources) { try { source.walletChanged?.(); } catch (failure) { console.warn('LATERAL source failed', failure); } }
    cached = null;
    const view = api.view();
    for (const listener of listeners) listener(view);
  };
  const credit = (amount: number, source: string, reason: string): void => {
    if (amount > 0) lastCredit = { seq: ++seq, amount, source, reason };
  };
  const persist = (next: WalletRecord): Promise<void> => {
    record = next;
    changed();
    const write = writes.then(() => options.store.save(record)).then(() => {
      if (error) { error = null; changed(); }
    }, failure => {
      // A store whose server judges every change (the self-hosted wallet) answers a refused change with its own record: take it over, do not retry.
      const adopted = (failure as { adopt?: unknown } | null)?.adopt;
      if (adopted && typeof adopted === 'object') {
        const server = normalizeWallet(adopted);
        const missions = record.missions && server.missions ? mergeProgress(server.missions, record.missions) : record.missions ?? server.missions;
        record = { ...server, ...(missions ? { missions } : {}) };
        error = 'The server refreshed part of your wallet.';
        changed();
        return;
      }
      console.warn('LATERAL wallet save failed', failure);
      error = options.store.durable ? 'Wallet sync failed. Your purchases are kept on this device and will sync again shortly.' : 'Your wallet could not be saved.';
      changed();
      if (!retryTimer && !disposed) retryTimer = setTimeout(() => { retryTimer = null; void persist(record); }, 15000);
    });
    writes = write;
    return write;
  };
  const watchDerived = (): void => {
    const totals = derived();
    for (const [id, total] of Object.entries(totals)) {
      const before = derivedSeen[id];
      if (ready && before !== undefined && total > before) {
        const source = sources.find(entry => entry.id === id);
        credit(total - before, id, source?.id === 'tips' ? 'Thanks for the tip' : source?.label ?? 'Marks received');
      }
    }
    derivedSeen = totals;
    changed();
  };

  const port: WalletGrantPort = {
    async grant(request: GrantRequest): Promise<GrantResult> {
      const source = sources.find(entry => entry.id === request.source && entry.kind === 'accrued');
      if (!source || disposed) return { granted: 0, capped: false, duplicate: false };
      await initial;
      const created = anchor ?? record.createdAt ?? null;
      const ceiling = source.ceiling ? source.ceiling(created, now()) : undefined;
      const { record: next, result } = applyGrant(record, request, source.dailyCap, now(), { maxGrant: source.maxGrant, ceiling });
      if (next !== record) {
        credit(result.granted, request.source, request.reason);
        await persist(next);
      }
      return result;
    },
    progress: () => record.missions ?? null,
    async saveProgress(next) {
      await initial;
      const incoming = normalizeProgress(next);
      const merged = record.missions ? mergeProgress(record.missions, incoming) : incoming;
      if (record.missions && sameProgress(merged, record.missions)) return;
      await persist({ ...record, missions: merged, updatedAt: now() });
    },
    claimed: key => Boolean(record.claims?.includes(key)) || record.receipts.includes(key),
    owned: () => { const state = compute(); return state.verified ? [...state.valid] : []; },
    remainingToday(sourceId: string): number {
      const source = sources.find(entry => entry.id === sourceId);
      if (!source?.dailyCap) return Infinity;
      return Math.max(0, source.dailyCap - grantedToday(record, sourceId, now()));
    },
  };

  for (const source of sources) {
    detachers.push(source.subscribe(watchDerived));
  }
  const initial: Promise<void> = (async () => {
    try {
      const loaded = await options.store.load();
      if (loaded) adopt(loaded); else adopt(emptyWallet());
    } catch (failure) {
      console.warn('LATERAL wallet load failed', failure);
      error = 'Wallet sync is offline. Purchases are paused until it reconnects.';
    }
    await Promise.all(sources.map(source => source.kind === 'derived' && source.refresh ? source.refresh().catch(() => {}) : undefined));
    derivedSeen = derived();
    ready = error === null;
    changed();
  })();
  void initial.then(() => {
    if (disposed) return;
    for (const source of sources) if (source.attach) detachers.push(source.attach({ wallet: port, game: options.game, now }));
    const offRemote = options.store.subscribe?.(remote => {
      const merged = mergeWallets(record, remote);
      if (!sameWallet(merged, record)) { record = merged; changed(); }
    });
    if (offRemote) detachers.push(offRemote);
  });

  const purchaseNow = async (itemId: string): Promise<PurchaseResult> => {
    await initial;
    const entry = catalogEntry(itemId);
    if (!entry) return { ok: false, reason: 'unknown-item', message: 'That item is not in the shop.' };
    if (!ready) return { ok: false, reason: 'not-ready', message: error ?? 'The wallet is still loading.' };
    // The tip ledger must be a complete read: a lower bound could lock what the player already paid for.
    if (!settled()) {
      await Promise.all(sources.map(source => source.kind === 'derived' ? source.refresh?.().catch(() => {}) : undefined));
      if (!settled()) return { ok: false, reason: 'not-ready', message: 'Your tips could not be checked yet. Purchases open as soon as they are.' };
    }
    // Re-read the store right before spending, so a second tab's purchase (or a refreshed remote) is seen first.
    try {
      const fresh = await withDeadline(options.store.loadFresh ? options.store.loadFresh() : options.store.load(), STORE_TIMEOUT_MS);
      if (fresh) adopt(fresh);
    } catch {
      return { ok: false, reason: 'store-failed', message: 'The wallet store is not reachable right now, so nothing was spent. Try again in a moment.' };
    }
    const state = compute();
    if (!state.verified) return { ok: false, reason: 'not-ready', message: 'Your tips could not be checked yet.' };
    const checked = applyPurchase(record, itemId, state.balance, now());
    if (!checked.ok) return checked;
    // The new item must fit the verified budget (guards a tampered record whose locked items are ahead of it in the list).
    const after = verifyOwned(checked.record.owned, state.budget);
    if (!after.valid.includes(entry.id)) return { ok: false, reason: 'insufficient', message: 'Your verified Marks do not cover that yet.' };
    await persist(checked.record);
    // A server that judges the change can refuse it and hand back its own record (see persist): then nothing was bought.
    if (!record.owned.includes(entry.id)) return { ok: false, reason: 'store-failed', message: 'The server did not accept that purchase, so nothing was spent. Your wallet was refreshed.' };
    // The purchase stands locally even if the remote write failed; persist() keeps retrying.
    return { ok: true, balance: compute().balance };
  };

  const itemState = (id: string, state = compute()): ItemState | null => {
    const entry = catalogEntry(id);
    if (!entry) return null;
    const kind: ItemKind = entry.kind === 'car' ? 'car' : 'cosmetic';
    const base = { id: entry.id, kind, slot: entry.slot, ...(entry.kind === 'car' ? { carId: entry.carId } : {}), price: entry.price };
    if (entry.hidden) return { ...base, status: 'unavailable', usable: false, shortfall: 0, reason: 'This item is not for sale.' };
    if (entry.price === 0) return { ...base, status: 'stock', usable: true, shortfall: 0, reason: null };
    if (state.valid.has(entry.id)) return { ...base, status: 'owned', usable: true, shortfall: 0, reason: null };
    if (state.locked.has(entry.id)) return { ...base, status: 'locked', usable: false, shortfall: 0, reason: 'Your verified Marks do not cover this item yet. It unlocks when they do.' };
    if (!ready || !settled()) return { ...base, status: 'unavailable', usable: false, shortfall: 0, reason: error ?? 'Checking your wallet and tips. One moment.' };
    const shortfall = Math.max(0, entry.price - state.balance);
    return { ...base, status: shortfall > 0 ? 'unaffordable' : 'buyable', usable: false, shortfall, reason: null };
  };

  /**
   * The starter gift as the UI sees it. 'opened' is read from the wallet record itself (the claim is the opened flag), never from the
   * source's own attach state: the view that says `ready` is emitted before sources attach, and a returning player must not see a closed gift
   * in that frame. Seeing the claim also writes the device flag, so the gift stays opened if the wallet later fails or is lost.
   */
  const giftView = (gift: WelcomeSource): GiftView => {
    const claimed = port.claimed?.(WELCOME_CLAIM) ?? false;
    if (claimed) gift.markOpened();
    return { state: claimed ? 'opened' : gift.state(), marks: WELCOME_MARKS, items: starterGiftItems(), pending: !claimed && gift.pending() };
  };

  const api: Economy = {
    view(): EconomyView {
      if (cached) return cached;
      const state = compute();
      const earnedBySource: Record<string, number> = { ...state.accrued, ...state.totals };
      const equipped: Loadout = {};
      for (const [slot, id] of Object.entries(record.equipped) as [CosmeticSlot, string][]) if ((slot as string) !== 'plateText' && usable(id, state)) equipped[slot] = id;
      // The custom plate text is only shown while the (verified) custom plate is the fitted one.
      if (equipped.plate === CUSTOM_PLATE_ID && record.equipped.plateText) equipped.plateText = record.equipped.plateText;
      cached = {
        ready, error, lastCredit,
        balance: state.balance,
        earnedBySource, spent: state.spent,
        owned: new Set(state.valid), equipped,
        canEarn: sources.some(source => source.available()),
        storeDurable: options.store.durable,
        verified: state.verified, ledger: ledgerStates(), locked: new Set(state.locked), budget: state.budget,
        purchasesOpen: ready && state.verified,
        gift: giftSource ? giftView(giftSource) : null,
      };
      return cached;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sources: () => sources,
    async refresh() {
      await initial;
      await Promise.all(sources.map(source => source.refresh?.().catch(() => {})));
      if (!ready) {
        try {
          const loaded = await options.store.load();
          if (loaded) adopt(loaded);
          error = null; ready = true;
        } catch { /* Still offline. */ }
      }
      watchDerived();
    },
    purchase(itemId: string): Promise<PurchaseResult> {
      if (typeof itemId !== 'string') return Promise.resolve({ ok: false, reason: 'invalid', message: 'That is not a valid item.' });
      // Idempotent: a double click (or a second caller) for the same item shares one purchase and one result.
      const existing = inflight.get(itemId);
      if (existing) return existing;
      const run = queue.then(() => purchaseNow(itemId), () => purchaseNow(itemId)).catch(failure => {
        console.warn('LATERAL purchase failed', failure);
        return { ok: false, reason: 'store-failed', message: 'The purchase did not go through. Nothing was spent.' } as PurchaseResult;
      });
      queue = run;
      const tracked = run.finally(() => { if (inflight.get(itemId) === tracked) inflight.delete(itemId); });
      inflight.set(itemId, tracked);
      return tracked;
    },
    async equip(slot: CosmeticSlot, itemId: string | null) {
      await initial;
      const state = compute();
      const next = applyEquip(record, slot, itemId, now(), id => usable(id, state));
      if (next !== record) await persist(next);
    },
    async setPlateText(text: string): Promise<PlateResult> {
      await initial;
      if (!ready) return { ok: false, reason: 'not-ready', message: error ?? 'The wallet is still loading.' };
      const next = applyPlateText(record, text, now(), id => usable(id));
      if (!next.ok) return next;
      await persist(next.record);
      return { ok: true, text: next.text };
    },
    openGift: () => (giftSource ? giftSource.open() : Promise.resolve({ ok: false, message: 'There is no gift here.' } as const)),
    owns: (itemId: string) => usable(itemId),
    itemState: id => itemState(id),
    items(kind?: ItemKind) {
      const state = compute();
      return ITEMS.filter(entry => !entry.hidden && (!kind || (entry.kind === 'car' ? 'car' : 'cosmetic') === kind)).map(entry => itemState(entry.id, state)!);
    },
    carAllowed(carId: CarId): boolean {
      const entry = carItem(carId);
      if (!entry || entry.hidden) return false;
      return usable(entry.id);
    },
    whenSettled(timeoutMs = 4000): Promise<boolean> {
      const ok = (): boolean => ready && settled();
      if (ok()) return Promise.resolve(true);
      return new Promise(resolve => {
        let off: (() => void) | null = null;
        const timer = setTimeout(() => { off?.(); resolve(false); }, timeoutMs);
        off = api.subscribe(() => { if (ok()) { clearTimeout(timer); off?.(); resolve(true); } });
      });
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const detach of detachers.splice(0)) detach();
      for (const source of sources) source.dispose();
      options.store.dispose?.();
      listeners.clear();
    },
  };
  return api;
}
