/**
 * The player's account on the game server: a driver name, a token kept in localStorage and a recovery code that is
 * shown once. No email, no password, no third party. See SELFHOST-CONTRACT.md "Identity".
 *
 * The token is the only secret the browser keeps. It travels as `Authorization: Bearer` over HTTP and as the first
 * frame over the socket, never in a URL.
 */
import { createApi, type Api, type ApiResult } from './api';

export const ACCOUNT_KEY = 'lateral:account:v1';
/** Set once the player chose to play without an account, so the first-run step does not come back every visit. */
export const GUEST_KEY = 'lateral:account:guest:v1';
/** Set when the server stopped accepting the stored token (the player is told once). */
export const EXPIRED_KEY = 'lateral:account:expired:v1';

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const NAME_RULES = `${NAME_MIN} to ${NAME_MAX} letters, numbers, _ or -`;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface Account {
  readonly accountId: string;
  readonly name: string;
  readonly token: string;
  readonly admin?: boolean;
}

/** Checks a name the way the server will, so most mistakes show up before any request. Null = fine. */
export function validateDriverName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Pick a driver name.';
  if (name.length < NAME_MIN) return `A driver name needs at least ${NAME_MIN} characters.`;
  if (name.length > NAME_MAX) return `A driver name has at most ${NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(name)) return 'Use letters, numbers, _ or - only. No spaces.';
  return null;
}

export type Failure = { readonly ok: false; readonly code: string; readonly message: string; readonly retry: boolean };
export type CreateResult = { readonly ok: true; readonly account: Account; readonly recoveryCode: string } | Failure;
export type RecoverResult = { readonly ok: true; readonly account: Account } | Failure;
export type RegenerateResult = { readonly ok: true; readonly recoveryCode: string } | Failure;

const NETWORK: Failure = { ok: false, code: 'offline', message: 'Cannot reach the game server. Check your connection and try again.', retry: true };

/** Player facing text for a failed account call. No em dashes. */
export function explainFailure(result: Pick<ApiResult, 'status' | 'code' | 'message' | 'network'>, kind: 'create' | 'recover' | 'other'): string {
  const code = result.code.toLowerCase();
  if (result.network) return NETWORK.message;
  if (result.status === 429 || code.includes('rate') || code.includes('locked') || code.includes('too_many')) {
    return kind === 'recover' ? 'Too many tries. Wait a few minutes, then try again.' : 'Too many new drivers from this connection. Try again in a while.';
  }
  if (kind === 'create') {
    if (result.status === 409 || code.includes('taken') || code.includes('exists') || code.includes('unavailable')) return 'That name is taken. Try another.';
    if (code.includes('reserved') || code.includes('blocked') || code.includes('profan') || code.includes('forbidden') || code.includes('not_allowed')) return 'That name is not available. Try another.';
    if (code.includes('invalid') || code.includes('name') || result.status === 400 || result.status === 422) return `Names are ${NAME_RULES}.`;
  }
  if (kind === 'recover') {
    if (result.status === 401 || result.status === 403 || result.status === 404 || code.includes('invalid') || code.includes('wrong') || code.includes('not_found')) return 'That name and recovery code do not match. Check both and try again.';
  }
  if (result.status === 401) return 'You are signed out on this device.';
  return result.message || 'Something went wrong. Try again in a moment.';
}

export interface AccountStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export interface AccountService {
  /** The signed in account, or null (a guest, or nobody yet). */
  current(): Account | null;
  /** True when the player chose to play without an account on this device. */
  isGuest(): boolean;
  /** First run: neither an account nor a guest choice yet. */
  needsChoice(): boolean;
  /** Remember the "play without an account" choice (or take it back). */
  setGuest(guest: boolean): void;
  create(name: string): Promise<CreateResult>;
  recover(name: string, recoveryCode: string): Promise<RecoverResult>;
  regenerate(): Promise<RegenerateResult>;
  /** Asks the server who this token is. 'signed-out' means the token no longer works and was removed. */
  refresh(): Promise<'ok' | 'signed-out' | 'offline' | 'none'>;
  signOut(): void;
  token(): string | null;
  /** True once if the stored token was rejected since the last call (shown to the player a single time). */
  takeExpiredNotice(): boolean;
  subscribe(listener: (account: Account | null) => void): () => void;
  readonly api: Api;
}

function pickStorage(): AccountStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function parseAccount(raw: string | null): Account | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { accountId, name, token } = value;
    if (typeof accountId !== 'string' || typeof name !== 'string' || typeof token !== 'string' || !accountId || !name || token.length < 16) return null;
    return { accountId: accountId.slice(0, 80), name: name.slice(0, 40), token: token.slice(0, 200), ...(value.admin === true ? { admin: true } : {}) };
  } catch { return null; }
}

export interface AccountOptions {
  readonly storage?: AccountStorage | null;
  readonly api?: Api;
  readonly fetch?: typeof fetch;
  readonly base?: string;
}

export function createAccountService(options: AccountOptions = {}): AccountService {
  const storage = options.storage === undefined ? pickStorage() : options.storage;
  const read = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key: string, value: string | null): void => {
    try { if (value === null) storage?.removeItem(key); else storage?.setItem(key, value); } catch { /* Blocked storage: this session still works. */ }
  };
  let account = parseAccount(read(ACCOUNT_KEY));
  let memory: Account | null = account;
  const listeners = new Set<(account: Account | null) => void>();
  const api = options.api ?? createApi({ fetch: options.fetch, base: options.base, token: () => memory?.token ?? null });
  const emit = (): void => { for (const listener of [...listeners]) { try { listener(memory); } catch { /* A listener must not break the account. */ } } };
  const store = (next: Account | null): void => {
    account = next; memory = next;
    write(ACCOUNT_KEY, next ? JSON.stringify(next) : null);
    if (next) { write(GUEST_KEY, null); write(EXPIRED_KEY, null); }
    emit();
  };
  const tokenOf = (body: Record<string, unknown> | null): string => (typeof body?.token === 'string' ? body.token : '');

  return {
    api,
    current: () => memory,
    isGuest: () => !memory && read(GUEST_KEY) === '1',
    needsChoice: () => !memory && read(GUEST_KEY) !== '1',
    setGuest(guest) { write(GUEST_KEY, guest ? '1' : null); },
    token: () => memory?.token ?? null,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async create(raw) {
      const problem = validateDriverName(raw);
      const name = raw.trim();
      if (problem) return { ok: false, code: 'invalid_name', message: problem, retry: false };
      const result = await api.post('/api/v1/account', { name });
      const body = result.body as Record<string, unknown> | null;
      const token = tokenOf(body);
      if (!result.ok || !token || typeof body?.accountId !== 'string' || typeof body?.recoveryCode !== 'string') {
        if (result.ok) return { ok: false, code: 'bad_response', message: 'The server answered in a way this game does not understand. Try again.', retry: true };
        return { ok: false, code: result.code || (result.network ? 'offline' : 'error'), message: explainFailure(result, 'create'), retry: result.network || result.status === 429 };
      }
      const created: Account = { accountId: body.accountId, name: typeof body.name === 'string' && body.name ? body.name : name, token };
      store(created);
      return { ok: true, account: created, recoveryCode: body.recoveryCode };
    },
    async recover(rawName, rawCode) {
      const name = rawName.trim(), recoveryCode = rawCode.trim().toUpperCase();
      if (!name || !recoveryCode) return { ok: false, code: 'missing', message: 'Enter your driver name and recovery code.', retry: false };
      const result = await api.post('/api/v1/recover', { name, recoveryCode });
      const body = result.body as Record<string, unknown> | null;
      const token = tokenOf(body);
      if (!result.ok || !token) return { ok: false, code: result.code || 'error', message: explainFailure(result, 'recover'), retry: result.network };
      // The reply carries the new token; the account details come from the server so the name has its stored spelling.
      let accountId = typeof body?.accountId === 'string' ? body.accountId : '';
      let canonical = typeof body?.name === 'string' ? body.name : '';
      let admin = body?.admin === true;
      if (!accountId || !canonical) {
        const me = await api.withToken(token).get<Record<string, unknown>>('/api/v1/me');
        if (me.ok && typeof me.body?.accountId === 'string' && typeof me.body?.name === 'string') { accountId = me.body.accountId; canonical = me.body.name; admin = me.body.admin === true; }
      }
      if (!accountId) return { ok: false, code: 'bad_response', message: 'Signed in, but the server did not say who you are. Try again.', retry: true };
      const next: Account = { accountId, name: canonical || name, token, ...(admin ? { admin: true } : {}) };
      store(next);
      return { ok: true, account: next };
    },
    async regenerate() {
      if (!memory) return { ok: false, code: 'signed_out', message: 'Sign in first.', retry: false };
      const result = await api.post('/api/v1/recovery/regenerate');
      const code = (result.body as Record<string, unknown> | null)?.recoveryCode;
      if (!result.ok || typeof code !== 'string') return { ok: false, code: result.code || 'error', message: explainFailure(result, 'other'), retry: result.network };
      return { ok: true, recoveryCode: code };
    },
    async refresh() {
      if (!memory) return 'none';
      const sent = memory.token;
      const result = await api.get<Record<string, unknown>>('/api/v1/me');
      if (memory?.token !== sent) return 'ok';
      if (result.status === 401 || result.status === 403) {
        // The server dropped this token (more than five devices signed in, or the account was banned).
        write(EXPIRED_KEY, '1');
        store(null);
        write(GUEST_KEY, null);
        return 'signed-out';
      }
      if (!result.ok) return 'offline';
      const body = result.body;
      if (body && typeof body.name === 'string' && body.name && (body.name !== memory.name || (body.admin === true) !== Boolean(memory.admin))) {
        store({ ...memory, name: body.name, ...(body.admin === true ? { admin: true } : {}) });
      }
      return 'ok';
    },
    signOut() {
      // Tell the server to forget this token (best effort: signing out here never waits for it). The request reads the
      // token synchronously, so it is built before the account is cleared.
      if (memory) void api.post('/api/v1/logout').catch(() => {});
      write(GUEST_KEY, null); store(null);
    },
    takeExpiredNotice() { const flag = read(EXPIRED_KEY) === '1'; if (flag) write(EXPIRED_KEY, null); return flag; },
  };
}
