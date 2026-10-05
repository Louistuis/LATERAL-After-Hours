/**
 * Pluggable wallet persistence.
 *  - createLocalWalletStore: localStorage (portals, offline, and the fast cache on websim).
 *  - createWebsimCollectionStore: one record per websim user in a WebsimSocket collection. Records are
 *    owned by their author (only the author can update them), so a player can only write their own wallet.
 *  - createLayeredStore: primary + cache, merged with mergeWallets so neither copy ever loses a purchase.
 */
import type { DataStore } from '../../contracts/runtime-contracts';
import type { WalletRecord, WalletStore } from './types';
import { mergeWallets, parseWalletJson } from './wallet';
import { withTimeout } from './timeout';

export function createLocalWalletStore(key: string, storage: (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>) | null = safeLocalStorage()): WalletStore {
  let durable = false;
  try { if (storage) { storage.setItem(`${key}:probe`, '1'); storage.removeItem?.(`${key}:probe`); durable = true; } } catch { durable = false; }
  let memory: WalletRecord | null = null;
  return {
    id: 'local', durable,
    async load() {
      try {
        const raw = storage?.getItem(key);
        const parsed = raw ? parseWalletJson(raw) : null;
        if (parsed) return parsed;
      } catch { /* Corrupt or blocked storage reads as empty. */ }
      return memory;
    },
    /** Another tab wrote the wallet: surface it so this tab merges it before it spends. */
    subscribe(listener) {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
      const onStorage = (event: StorageEvent): void => {
        if (event.key !== key || typeof event.newValue !== 'string') return;
        const record = parseWalletJson(event.newValue);
        if (record) listener(record);
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
    async save(record) {
      memory = record;
      try { storage?.setItem(key, JSON.stringify(record)); } catch { /* Session-only: memory copy stands. */ }
    },
  };
}

/**
 * Adapter over the game's existing DataStore contract (src/platform: guarded localStorage, CrazyGames data
 * module, ...), so a portal build can keep the wallet wherever it keeps the profile save.
 */
export function createDataStoreWalletStore(store: DataStore, key: string, durable = true, id = 'data-store'): WalletStore {
  let initialized: Promise<void> | null = null;
  const ready = (): Promise<void> => (initialized ??= store.initialize().catch(() => {}));
  return {
    id, durable,
    async load() {
      await ready();
      const read = await store.read(key);
      if (read.status === 'missing') return null;
      if (read.status === 'unavailable') throw new Error(read.reason);
      return parseWalletJson(read.serialized);
    },
    async save(record) {
      await ready();
      const written = await store.write(key, JSON.stringify(record));
      if (written.status !== 'written') throw new Error(written.reason);
    },
  };
}

/** A store whose real backend is only known after an async step (e.g. resolving the websim user). */
export function createDeferredStore(id: string, durable: boolean, resolve: () => Promise<WalletStore>): WalletStore {
  let inner: Promise<WalletStore> | null = null;
  const get = (): Promise<WalletStore> => (inner ??= resolve());
  const listeners = new Set<(record: WalletRecord) => void>();
  let detach: (() => void) | null = null;
  let serverCreated: number | null = null;
  const poll = (store: WalletStore): void => { const value = store.serverCreatedAt?.(); if (typeof value === 'number') serverCreated = value; };
  void get().then(store => {
    poll(store);
    detach = store.subscribe?.(record => { for (const listener of listeners) listener(record); }) ?? null;
  }, () => {});
  return {
    id, durable,
    load: async () => { const store = await get(); const record = await store.load(); poll(store); return record; },
    loadFresh: async () => { const store = await get(); const record = await (store.loadFresh ? store.loadFresh() : store.load()); poll(store); return record; },
    serverCreatedAt: () => serverCreated,
    save: async record => (await get()).save(record),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { detach?.(); listeners.clear(); void inner?.then(store => store.dispose?.(), () => {}); },
  };
}

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The subset of the injected WebsimSocket collection API used here (verified on the live prototype). */
interface CollectionRecord { readonly id: string; readonly username?: string; readonly [key: string]: unknown }
interface WebsimCollection {
  getList(): CollectionRecord[];
  create(data: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  subscribe(callback: (records: CollectionRecord[]) => void): (() => void) | void;
  filter(query: Record<string, unknown>): WebsimCollection;
}
interface WebsimRoomLike { initialize(): Promise<void>; collection(name: string): WebsimCollection }

export const WALLET_COLLECTION = 'lateral_wallet_v1';

/** Returns null off websim. WebsimSocket is a platform singleton, so this shares the multiplayer connection. */
export function createWebsimCollectionStore(username: string, collectionName = WALLET_COLLECTION): WalletStore | null {
  const Ctor = (globalThis as { WebsimSocket?: new () => WebsimRoomLike }).WebsimSocket;
  if (typeof Ctor !== 'function' || !username) return null;
  let room: WebsimRoomLike | null = null;
  let mine: WebsimCollection | null = null;
  let recordId: string | null = null;
  let latest: CollectionRecord[] = [];
  let serverCreated: number | null = null;
  let detach: (() => void) | null = null;
  const listeners = new Set<(record: WalletRecord) => void>();

  const decode = (records: readonly CollectionRecord[]): WalletRecord | null => {
    const own = records.filter(entry => entry.username === username && typeof entry.w === 'string');
    if (!own.length) return null;
    // Oldest record is the canonical one; duplicates from a create race are merged in, never dropped.
    recordId ??= own[own.length - 1]!.id;
    let merged: WalletRecord | null = null;
    let earliest: number | null = null;
    for (const entry of own) {
      const parsed = parseWalletJson(entry.w);
      if (!parsed) continue; // Skip a corrupt or oversized row.
      merged = merged ? mergeWallets(merged, parsed) : parsed;
      const created = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
      if (Number.isFinite(created) && (earliest === null || created < earliest)) earliest = created;
    }
    // created_at is set by websim when the row is created, so a player can not backdate it.
    if (earliest !== null) serverCreated = earliest;
    return merged;
  };
  const connect = async (): Promise<WebsimCollection | null> => {
    if (mine) return mine;
    try {
      room = new Ctor();
      const ok = await withTimeout(room.initialize().then(() => true), 8000);
      if (!ok) return null;
      mine = room.collection(collectionName).filter({ username });
      const first = new Promise<void>(resolve => {
        let settled = false;
        const off = mine!.subscribe(records => {
          latest = records ?? [];
          if (!settled) { settled = true; resolve(); return; }
          const record = decode(latest);
          if (record) for (const listener of listeners) listener(record);
        });
        detach = typeof off === 'function' ? off : null;
        setTimeout(() => { if (!settled) { settled = true; latest = mine?.getList() ?? []; resolve(); } }, 6000);
      });
      await first;
      return mine;
    } catch (error) {
      console.warn('LATERAL wallet sync unavailable', error);
      return null;
    }
  };
  return {
    id: 'websim-collection', durable: true,
    async load() {
      const collection = await connect();
      if (!collection) throw new Error('Wallet sync is offline');
      return decode(latest.length ? latest : collection.getList());
    },
    /** Strict read: rejects when the store is unreachable (load() has the same behavior here). */
    async loadFresh() {
      const collection = await connect();
      if (!collection) throw new Error('Wallet sync is offline');
      return decode(collection.getList() ?? latest);
    },
    serverCreatedAt: () => serverCreated,
    async save(record) {
      const collection = await connect();
      if (!collection) throw new Error('Wallet sync is offline');
      // Never overwrite the remote row with fewer purchases than it already has (a stale tab, a second device).
      const current = decode(latest.length ? latest : collection.getList());
      const data = { v: 1, w: JSON.stringify(current ? mergeWallets(current, record) : record) };
      if (recordId) await collection.update(recordId, data);
      else {
        const created = await collection.create(data) as { id?: string } | undefined;
        if (created && typeof created.id === 'string') recordId = created.id;
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { detach?.(); listeners.clear(); },
  };
}

/**
 * Reads both stores and merges; writes go to the cache first (instant, survives reloads) and then the primary.
 * A primary failure is reported but the cache keeps the write, and the next successful save carries it over.
 */
export function createLayeredStore(primary: WalletStore, cache: WalletStore): WalletStore {
  return {
    id: `${primary.id}+${cache.id}`,
    durable: primary.durable || cache.durable,
    async load() {
      const [remote, local] = await Promise.allSettled([primary.load(), cache.load()]);
      const a = remote.status === 'fulfilled' ? remote.value : null;
      const b = local.status === 'fulfilled' ? local.value : null;
      if (remote.status === 'rejected' && !b) throw remote.reason;
      return a && b ? mergeWallets(a, b) : a ?? b;
    },
    /** Strict read: the primary must answer (a cache-only answer is not good enough to spend against). */
    async loadFresh() {
      const [remote, local] = await Promise.all([primary.loadFresh ? primary.loadFresh() : primary.load(), cache.load().catch(() => null)]);
      return remote && local ? mergeWallets(remote, local) : remote ?? local;
    },
    serverCreatedAt: () => primary.serverCreatedAt?.() ?? null,
    async save(record) {
      await cache.save(record);
      await primary.save(record);
    },
    subscribe: primary.subscribe ? listener => primary.subscribe!(listener) : undefined,
    dispose() { primary.dispose?.(); cache.dispose?.(); },
  };
}
