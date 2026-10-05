import type { DataStore, StoreRead, StoreWrite, PlatformTarget } from '../../contracts/runtime-contracts';
import { MAX_SAVE_BYTES, utf8Bytes } from '../save/envelope';

const STORE_PREFIX = 'lateral:save:v1';

/** Guarded local storage adapter for owner-review/standalone. It never performs network I/O. */
export function createGuardedBrowserDataStore(target: Exclude<PlatformTarget, 'crazygames-full'>): DataStore {
  let storage: Storage | null = null;
  let unavailableReason: string | null = null;
  return {
    async initialize() {
      try {
        if (typeof window === 'undefined') throw new Error('Browser storage is unavailable outside a browser');
        storage = window.localStorage;
        // Force a read to detect disabled or denied storage without mutating user data.
        void storage.length;
        unavailableReason = null;
      } catch (error) {
        storage = null;
        unavailableReason = safeReason(error);
      }
    },
    async read(key): Promise<StoreRead> {
      if (!storage) return { status: 'unavailable', reason: unavailableReason ?? 'Storage is not initialized' };
      try {
        const value = storage.getItem(storageKey(target, key));
        return value === null ? { status: 'missing' } : { status: 'found', serialized: value };
      } catch (error) { return { status: 'unavailable', reason: safeReason(error) }; }
    },
    async write(key, serialized): Promise<StoreWrite> {
      if (!storage) return { status: 'unavailable', reason: unavailableReason ?? 'Storage is not initialized' };
      if (utf8Bytes(serialized) > MAX_SAVE_BYTES) return { status: 'unavailable', reason: 'Save exceeds the 512 KiB limit' };
      try {
        storage.setItem(storageKey(target, key), serialized);
        return { status: 'written' };
      } catch (error) { return { status: 'unavailable', reason: safeReason(error) }; }
    },
    async flushPending() { /* Browser localStorage writes are synchronous and local. */ },
  };
}

function storageKey(target: PlatformTarget, key: string): string {
  if (!/^[a-z0-9:._-]{1,160}$/i.test(key)) throw new Error('Invalid save key');
  return `${STORE_PREFIX}:${target}:${key}`;
}

function safeReason(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Browser storage quota is full';
  if (error instanceof Error) return error.message.slice(0, 160);
  return 'Browser storage is unavailable';
}
