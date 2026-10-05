/**
 * Gifts from Louis: the inbox (direct gifts, from the wallet response and socket pushes), claiming, gift codes and the
 * `?gift=CODE` deep link.
 *
 * The deep link is the one thing that must never get lost: a visitor can arrive from a link, have no account yet and
 * go through the driver name step. The code is therefore written to localStorage the moment the page loads, stays
 * there across the account step (and across reloads) and is only removed once the server answered for it: opened,
 * already opened, or not a real code.
 */
import type { EarnSource } from '../economy/types';
import type { ActionResult, ServerGift, ServerWallet } from './wallet-store';

export const PENDING_GIFT_KEY = 'lateral:gift:pending:v1';
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/;

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_]+/g, '-');
}
export const looksLikeCode = (raw: string): boolean => CODE_PATTERN.test(normalizeCode(raw));

export interface GiftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
function pickStorage(): GiftStorage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }

/** The code in `?gift=` of a query string, or null. */
export function giftParam(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get('gift');
    if (!raw) return null;
    const code = normalizeCode(raw);
    return CODE_PATTERN.test(code) ? code : null;
  } catch { return null; }
}

/**
 * Reads `?gift=` from the page address, keeps the code in storage and removes it from the address bar (a reload or a
 * shared screenshot then does not carry it). Returns the code now waiting, if any.
 */
export function captureGiftLink(storage: GiftStorage | null = pickStorage(), location: Pick<Location, 'search' | 'pathname' | 'hash'> | null = typeof window === 'undefined' ? null : window.location, history: Pick<History, 'replaceState' | 'state'> | null = typeof window === 'undefined' ? null : window.history): string | null {
  if (location) {
    const code = giftParam(location.search);
    if (code) {
      try { storage?.setItem(PENDING_GIFT_KEY, code); } catch { /* Blocked storage: this visit still opens it. */ }
      try {
        const params = new URLSearchParams(location.search); params.delete('gift');
        const rest = params.toString();
        history?.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash ?? ''}`);
      } catch { /* Address cleanup is cosmetic. */ }
      if (!storage) memoryPending = code;
    }
  }
  return pendingGiftCode(storage);
}
let memoryPending: string | null = null;
export function pendingGiftCode(storage: GiftStorage | null = pickStorage()): string | null {
  try { const value = storage?.getItem(PENDING_GIFT_KEY); if (value && CODE_PATTERN.test(value)) return value; } catch { /* fall through */ }
  return memoryPending;
}
export function clearPendingGift(storage: GiftStorage | null = pickStorage()): void {
  memoryPending = null;
  try { storage?.removeItem(PENDING_GIFT_KEY); } catch { /* Nothing to clear. */ }
}

export type PendingOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'opened'; readonly result: Extract<ActionResult, { ok: true }> }
  | { readonly status: 'already'; readonly message: string }
  | { readonly status: 'invalid'; readonly message: string }
  /** The server could not be reached: the code stays stored and the next visit tries again. */
  | { readonly status: 'retry'; readonly message: string };

export interface GiftsController {
  /** Gifts waiting for this account. */
  inbox(): readonly ServerGift[];
  count(): number;
  claim(id: string): Promise<ActionResult>;
  redeem(code: string): Promise<ActionResult>;
  /** The code from a gift link that was not used yet, or null. */
  pendingCode(): string | null;
  /** Redeems the stored code (an account exists now). Removes it once the server has answered for it. */
  redeemPending(): Promise<PendingOutcome>;
  subscribe(listener: () => void): () => void;
}

export function createGiftsController(wallet: ServerWallet, storage: GiftStorage | null = pickStorage()): GiftsController {
  const settle = (code: string, result: ActionResult): PendingOutcome => {
    if (result.ok) { clearPendingGift(storage); return { status: 'opened', result }; }
    if (result.retry) return { status: 'retry', message: result.message };
    clearPendingGift(storage);
    return /already|opened/i.test(result.message) ? { status: 'already', message: 'This gift was already opened.' } : { status: 'invalid', message: result.message };
  };
  let busy: Promise<PendingOutcome> | null = null;
  return {
    inbox: () => wallet.gifts(),
    count: () => wallet.gifts().length,
    claim: id => wallet.claimGift(id),
    redeem(code) {
      const clean = normalizeCode(code);
      if (!looksLikeCode(clean)) return Promise.resolve({ ok: false, code: 'invalid_code', message: 'That code does not look right. Check it and try again.', retry: false });
      return wallet.redeemCode(clean).then(result => { if (result.ok && pendingGiftCode(storage) === clean) clearPendingGift(storage); return result; });
    },
    pendingCode: () => pendingGiftCode(storage),
    redeemPending() {
      const code = pendingGiftCode(storage);
      if (!code) return Promise.resolve({ status: 'none' });
      busy ??= wallet.redeemCode(code).then(result => settle(code, result)).finally(() => { busy = null; });
      return busy;
    },
    subscribe: listener => wallet.onGifts(listener),
  };
}

/** What the economy knows about gifts: a silent accrued source (the server writes `earned.gift`; the client never grants it). */
export interface GiftSource extends EarnSource { readonly gifts: GiftsController }

export function createServerGiftSource(gifts: GiftsController): GiftSource {
  const listeners = new Set<() => void>();
  const off = gifts.subscribe(() => { for (const listener of [...listeners]) listener(); });
  return {
    id: 'gift', kind: 'accrued', label: 'Gifts', silent: true, gifts,
    // The server is the only writer of this source: no grant from the client is ever made, and the largest gift is 100,000 Marks.
    maxGrant: 0,
    available: () => false,
    offers: () => [],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { off(); listeners.clear(); },
  };
}
