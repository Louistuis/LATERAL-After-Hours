/**
 * The wallet on the game server. The server is the judge: it checks every change against the same catalog and
 * mission rules the client uses, and keeps the record per account (GET and POST /api/v1/wallet, optimistic
 * concurrency by `version`). The client keeps playing when the server is away:
 *
 *   - every save goes to the local cache first (per account, so two accounts on one device never mix);
 *   - the server write follows, at most one per ~2 s (the server allows 30 a minute) and always with the newest
 *     record, so a burst of changes is one request;
 *   - a version conflict (another tab or device wrote first) is merged once and retried; a change the rules refuse
 *     is not retried: the server's own record is adopted (the economy takes it over, see persist() there).
 *
 * The same object runs the server-only actions that return a new record: the testing bonus, gift claims and gift
 * codes. Their records go through the same listeners, so the balance moves like any other change.
 */
import type { WalletRecord, WalletStore } from '../economy/types';
import { emptyWallet, mergeWallets, normalizeWallet, sameWallet } from '../economy/wallet';
import type { Api, ApiResult } from './api';

export interface ServerGift {
  readonly id: string;
  readonly kind: 'direct' | 'code';
  readonly from: string;
  readonly message: string;
  readonly marks: number;
  readonly items: readonly string[];
  readonly createdAt: number | null;
}

export function parseGift(raw: unknown): ServerGift | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id).slice(0, 80) : '';
  if (!id) return null;
  const marks = typeof value.marks === 'number' && Number.isFinite(value.marks) ? Math.max(0, Math.min(1_000_000, Math.floor(value.marks))) : 0;
  const items = Array.isArray(value.items) ? value.items.filter((item): item is string => typeof item === 'string' && item.length <= 80).slice(0, 20) : [];
  const created = typeof value.created_at === 'number' ? value.created_at : typeof value.createdAt === 'number' ? value.createdAt : typeof value.created_at === 'string' ? Date.parse(value.created_at) : NaN;
  const from = typeof value.from_label === 'string' ? value.from_label : typeof value.from === 'string' ? value.from : '';
  return {
    id, kind: value.kind === 'code' ? 'code' : 'direct', marks, items,
    from: from.slice(0, 40) || 'Louis',
    message: typeof value.message === 'string' ? value.message.slice(0, 140) : '',
    createdAt: Number.isFinite(created) ? created : null,
  };
}

export interface TestGrantConfig { readonly marks: number; readonly open: boolean }

export type ActionResult =
  | { readonly ok: true; readonly marks: number; readonly items: readonly string[]; /** Items the player already had (they turned into nothing). */ readonly skipped: readonly string[]; readonly gift: ServerGift | null }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly retry: boolean };

export interface ServerWallet {
  readonly store: WalletStore;
  /** Unopened gifts (direct gifts addressed to this account). */
  gifts(): readonly ServerGift[];
  onGifts(listener: () => void): () => void;
  config(): TestGrantConfig | null;
  onConfig(listener: () => void): () => void;
  loadConfig(): Promise<TestGrantConfig | null>;
  claimTestGrant(): Promise<ActionResult>;
  claimGift(id: string): Promise<ActionResult>;
  redeemCode(code: string): Promise<ActionResult>;
  /** The socket said the wallet changed on the server (a gift landed): read it again. */
  pushed(version: number): void;
  /** Refreshes the inbox and the record from the server. */
  refresh(): Promise<boolean>;
  version(): number | null;
  dispose(): void;
}

export interface ServerWalletOptions {
  readonly api: Api;
  /** Per account cache (a local wallet store). A function so it can follow the signed in account. */
  readonly cache: WalletStore | (() => WalletStore);
  /** The wallet this device used before there was an account. Offered once to a brand new server wallet. */
  readonly guest?: WalletStore | null;
  /** Reports what happened to the offered guest wallet. */
  readonly onGuestOutcome?: (outcome: 'moved' | 'fresh') => void;
  /** Least ms between two writes. Default 2100 (the server allows 30 writes a minute). */
  readonly minWriteGapMs?: number;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
}

const CONFLICT = /version|conflict|stale|concurrent/i;

/** Error a failed save carries when the server answered with its own record: the economy adopts it. */
export class WalletRejected extends Error {
  constructor(readonly adopt: WalletRecord, readonly reason: string) { super(`The server did not accept the change (${reason})`); }
}

function recordOf(body: Record<string, unknown> | null): WalletRecord | null {
  const raw = body?.record;
  return raw && typeof raw === 'object' ? normalizeWallet(raw) : null;
}
const versionOf = (body: Record<string, unknown> | null): number | null => (typeof body?.version === 'number' && Number.isFinite(body.version) ? body.version : null);

const REASONS: Readonly<Record<string, string>> = {
  already_claimed: 'This gift was already opened.',
  already_opened: 'This gift was already opened.',
  bad_code: 'That code does not look right. Check it and try again.',
  claimed: 'This gift was already opened.',
  exhausted: 'This gift was already opened.',
  invalid_code: 'That code does not look right. Check it and try again.',
  not_found: 'That code does not look right. Check it and try again.',
  expired: 'This gift has expired.',
  revoked: 'This gift is no longer available.',
  locked: 'Too many wrong codes. Wait a few minutes and try again.',
  closed: 'The testing bonus is closed.',
};

export function explainAction(result: Pick<ApiResult, 'status' | 'code' | 'message' | 'network'>, fallback: string): string {
  if (result.network) return 'Cannot reach the game server right now. Try again in a moment.';
  const code = result.code.toLowerCase().replace(/[\s-]+/g, '_');
  if (REASONS[code]) return REASONS[code]!;
  if (/already|claimed|used|exhaust/.test(code)) return 'This gift was already opened.';
  if (/expire/.test(code)) return REASONS.expired!;
  if (/revoke/.test(code)) return REASONS.revoked!;
  if (code === 'rate_limited') return 'Slow down a little, then try again.';
  if (/lock|rate/.test(code) || result.status === 429) return REASONS.locked!;
  if (/invalid|not_found|unknown|code/.test(code) || result.status === 404) return REASONS.invalid_code!;
  if (result.status === 401) return 'You are signed out on this device.';
  return result.message || fallback;
}

export function createServerWallet(options: ServerWalletOptions): ServerWallet {
  const { api } = options;
  const cacheOption = options.cache;
  const cacheNow = (): WalletStore => (typeof cacheOption === 'function' ? cacheOption() : cacheOption);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const gap = options.minWriteGapMs ?? 2100;
  const listeners = new Set<(record: WalletRecord) => void>();
  const giftListeners = new Set<() => void>();
  const configListeners = new Set<() => void>();
  let version: number | null = null;
  let serverCreated: number | null = null;
  let inbox: ServerGift[] = [];
  let config: TestGrantConfig | null = null;
  let disposed = false;
  let lastSend = -Infinity;
  let pending: WalletRecord | null = null;
  let waiters: { resolve(): void; reject(error: unknown): void }[] = [];
  let flushing = false;
  let guestOutcome = false;

  const setInbox = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    const next = list.map(parseGift).filter((gift): gift is ServerGift => gift !== null).slice(0, 50);
    if (JSON.stringify(next) === JSON.stringify(inbox)) return;
    inbox = next;
    for (const listener of [...giftListeners]) listener();
  };
  const absorb = (body: Record<string, unknown> | null): WalletRecord | null => {
    const next = versionOf(body);
    if (next !== null) version = next;
    const created = body?.serverCreatedAt ?? body?.server_created_at;
    const ms = typeof created === 'number' ? created : typeof created === 'string' ? Date.parse(created) : NaN;
    if (Number.isFinite(ms) && ms > 0) serverCreated = ms;
    if (body && 'gifts' in body) setInbox(body.gifts);
    return recordOf(body);
  };
  const emit = (record: WalletRecord): void => { for (const listener of [...listeners]) listener(record); };

  const send = (record: WalletRecord, expect: number): Promise<ApiResult<Record<string, unknown>>> => {
    lastSend = now();
    return api.post<Record<string, unknown>>('/api/v1/wallet', { record, expectVersion: expect });
  };

  /** One write attempt (plus one merge and retry on a version conflict). Resolves true when the server holds `record`. */
  const write = async (record: WalletRecord, expect: number): Promise<{ ok: true; record: WalletRecord } | { ok: false; error: unknown }> => {
    let attempt = 0;
    let current = record, expectVersion = expect;
    for (;;) {
      const result = await send(current, expectVersion);
      const body = result.body;
      if (result.network || (!body && !result.ok)) return { ok: false, error: new Error('Wallet sync is offline') };
      if (result.ok && body?.ok !== false) { absorb(body); return { ok: true, record: current }; }
      // A rule rejection carries `reason` and the server's own copy of the record (null for an account with none yet).
      // Anything else (a rate limit, a 5xx) is a plain failure and must never make the economy adopt a record.
      if (body && body.ok === false && typeof body.reason === 'string' && 'record' in body) {
        const reason = body.reason;
        const theirs = absorb(body);
        if (theirs && attempt === 0 && CONFLICT.test(reason)) {
          attempt++;
          const merged = mergeWallets(theirs, current);
          if (sameWallet(merged, theirs)) return { ok: true, record: theirs };
          current = merged; expectVersion = version ?? expectVersion;
          continue;
        }
        // A brand new account has no record yet: refusing the first write then means "start from nothing".
        return { ok: false, error: new WalletRejected(theirs ?? emptyWallet(0), reason) };
      }
      return { ok: false, error: new Error(explainAction(result, 'Wallet sync failed')) };
    }
  };

  const pull = async (): Promise<ApiResult<Record<string, unknown>>> => {
    const result = await api.get<Record<string, unknown>>('/api/v1/wallet');
    return result;
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      while (pending && !disposed) {
        const wait = lastSend + gap - now();
        if (wait > 0) await new Promise<void>(resolve => { schedule(resolve, wait); });
        const record = pending, batch = waiters;
        pending = null; waiters = [];
        let outcome: Awaited<ReturnType<typeof write>>;
        if (version === null) {
          const got = await pull();
          if (!got.ok || got.network) outcome = { ok: false, error: new Error('Wallet sync is offline') };
          else {
            const theirs = absorb(got.body);
            const merged = theirs ? mergeWallets(theirs, record) : record;
            outcome = await write(merged, version ?? 0);
          }
        } else outcome = await write(record, version);
        if (outcome.ok) { for (const waiter of batch) waiter.resolve(); }
        else {
          if (outcome.error instanceof WalletRejected) { void cacheNow().save(outcome.error.adopt).catch(() => {}); emit(outcome.error.adopt); }
          for (const waiter of batch) waiter.reject(outcome.error);
        }
      }
    } finally { flushing = false; if (pending && !disposed) void flush(); }
  };

  const store: WalletStore = {
    id: 'server', durable: true,
    async load() {
      const result = await pull();
      if (!result.ok || result.network || !result.body) {
        // The server is away: play from the cache. The next save syncs.
        return cacheNow().load();
      }
      const theirs = absorb(result.body);
      const mine = await cacheNow().load().catch(() => null);
      const guest = !theirs && !mine && options.guest ? await options.guest.load().catch(() => null) : null;
      const candidate = theirs ? (mine ? mergeWallets(theirs, mine) : theirs) : (mine ?? guest);
      if (candidate && (!theirs || !sameWallet(candidate, theirs))) {
        const outcome = await write(candidate, version ?? 0);
        if (outcome.ok) { await cacheNow().save(candidate).catch(() => {}); if (guest && !guestOutcome) { guestOutcome = true; options.onGuestOutcome?.('moved'); } return candidate; }
        if (outcome.error instanceof WalletRejected) {
          if (guest && !guestOutcome) { guestOutcome = true; options.onGuestOutcome?.('fresh'); }
          await cacheNow().save(outcome.error.adopt).catch(() => {});
          return outcome.error.adopt;
        }
        return theirs ?? candidate;
      }
      if (theirs) await cacheNow().save(theirs).catch(() => {});
      return theirs;
    },
    async loadFresh() {
      const result = await pull();
      if (!result.ok || result.network || !result.body) throw new Error('Wallet sync is offline');
      return absorb(result.body);
    },
    serverCreatedAt: () => serverCreated,
    async save(record) {
      await cacheNow().save(record);
      pending = record;
      const done = new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }); });
      void flush();
      return done;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; listeners.clear(); },
  };

  const action = async (path: string, payload: unknown, fallback: string): Promise<ActionResult> => {
    const result = await api.post<Record<string, unknown>>(path, payload);
    const body = result.body;
    if (!result.ok || body?.ok === false) {
      return { ok: false, code: (typeof body?.reason === 'string' ? body.reason : result.code) || (result.network ? 'offline' : 'error'), message: explainAction({ ...result, code: typeof body?.reason === 'string' ? body.reason : result.code }, fallback), retry: result.network };
    }
    const record = absorb(body);
    if (record) { void cacheNow().save(record).catch(() => {}); emit(record); }
    // The account had opened this one before: nothing new was credited, so say so instead of replaying a reveal.
    if (body?.already === true) return { ok: false, code: 'already-opened', message: REASONS.already_claimed!, retry: false };
    const gift = parseGift(body?.gift);
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 40) : []);
    const given = typeof body?.marks === 'number' ? body.marks : typeof body?.granted === 'number' ? body.granted : null;
    const marks = given !== null && Number.isFinite(given) ? Math.max(0, Math.floor(given)) : gift?.marks ?? 0;
    return { ok: true, marks, items: strings(body?.gained).length ? strings(body?.gained) : strings(body?.items).length ? strings(body?.items) : [...(gift?.items ?? [])], skipped: strings(body?.skipped ?? body?.alreadyOwned ?? body?.already_owned), gift };
  };

  return {
    store,
    gifts: () => inbox,
    onGifts(listener) { giftListeners.add(listener); return () => { giftListeners.delete(listener); }; },
    config: () => config,
    onConfig(listener) { configListeners.add(listener); return () => { configListeners.delete(listener); }; },
    async loadConfig() {
      const result = await api.get<Record<string, unknown>>('/api/v1/config');
      const raw = (result.body?.testGrant ?? null) as Record<string, unknown> | null;
      if (result.ok && raw && typeof raw === 'object') {
        const marks = typeof raw.marks === 'number' && Number.isFinite(raw.marks) ? Math.max(0, Math.floor(raw.marks)) : 0;
        const next = { marks, open: raw.open === true && marks > 0 };
        if (!config || config.marks !== next.marks || config.open !== next.open) { config = next; for (const listener of [...configListeners]) listener(); }
      }
      return config;
    },
    claimTestGrant: () => action('/api/v1/wallet/testgrant', {}, 'The testing bonus could not be claimed. Try again.'),
    claimGift: id => action(`/api/v1/gifts/${encodeURIComponent(id)}/claim`, {}, 'This gift could not be opened. Try again.'),
    redeemCode: code => action('/api/v1/gifts/redeem', { code: code.trim().toUpperCase() }, 'That code could not be redeemed. Try again.'),
    pushed(next) { if (version === null || next > version) void this.refresh(); },
    async refresh() {
      const result = await pull();
      if (!result.ok || result.network) return false;
      const theirs = absorb(result.body);
      if (theirs) { void cacheNow().save(theirs).catch(() => {}); emit(theirs); }
      return true;
    },
    version: () => version,
    dispose() { disposed = true; listeners.clear(); giftListeners.clear(); configListeners.clear(); },
  };
}
