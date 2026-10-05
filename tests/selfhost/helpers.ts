import type { WalletRecord } from '../../src/economy/types';
import { emptyWallet, normalizeWallet } from '../../src/economy/wallet';

export function memoryStorage(initial: Record<string, string> = {}): Storage & { dump(): Record<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
    dump: () => Object.fromEntries(data),
  };
}

export interface FakeGift { id: string; kind: 'direct' | 'code'; marks: number; items: string[]; message: string; from: string; code?: string; opened?: boolean }

interface FakeAccount { accountId: string; name: string; recoveryCode: string; tokens: Set<string>; record: WalletRecord | null; version: number; testGrantClaimed: boolean; opened: Set<string> }

/** A small in-memory stand-in for the game server's HTTP API, enough to drive the client modules. */
export class FakeServer {
  readonly accounts = new Map<string, FakeAccount>();
  readonly gifts: FakeGift[] = [];
  readonly calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  down = false;
  testGrant = { marks: 20000, open: true };
  /** Rejection to answer the next wallet write with (reason code). */
  rejectNext: string | null = null;
  /** Answer the next wallet write with the server's 429. */
  rateLimitNext = false;
  /** Make the next wallet write look stale (another device wrote first). */
  staleNext: ((account: { record: WalletRecord | null; version: number }) => void) | null = null;
  private seq = 0;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? null;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    this.calls.push({ method, url, auth, body });
    if (this.down) throw new TypeError('network down');
    const reply = (status: number, data: unknown): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.split('?')[0]!;
    const token = auth?.replace(/^Bearer /, '') ?? '';
    const me = [...this.accounts.values()].find(account => account.tokens.has(token)) ?? null;

    if (method === 'GET' && path === '/api/v1/config') return reply(200, { testGrant: this.testGrant, emailGifts: false, version: '1', protocol: 1 });
    if (method === 'POST' && path === '/api/v1/account') {
      const name = String(body?.name ?? '');
      if (!/^[A-Za-z0-9_-]{3,16}$/.test(name)) return reply(400, { ok: false, error: 'name-invalid', message: 'bad' });
      if ([...this.accounts.values()].some(account => account.name.toLowerCase() === name.toLowerCase())) return reply(409, { ok: false, error: 'name-taken', message: 'taken' });
      const account = this.make(name);
      return reply(201, { accountId: account.accountId, name, token: [...account.tokens][0], recoveryCode: account.recoveryCode });
    }
    if (method === 'POST' && path === '/api/v1/recover') {
      const account = [...this.accounts.values()].find(item => item.name.toLowerCase() === String(body?.name ?? '').toLowerCase());
      if (!account || account.recoveryCode !== String(body?.recoveryCode ?? '').toUpperCase()) return reply(401, { ok: false, error: 'bad-recovery', message: 'no' });
      const next = `tok-${account.accountId}-${++this.seq}-xxxxxxxxxxxx`;
      account.tokens.add(next);
      return reply(200, { token: next, accountId: account.accountId, name: account.name });
    }
    if (!me) return reply(401, { ok: false, error: 'unauthorized', message: 'no' });
    if (method === 'POST' && path === '/api/v1/logout') { me.tokens.delete(token); return reply(200, { ok: true }); }
    if (method === 'GET' && path === '/api/v1/me') return reply(200, { accountId: me.accountId, name: me.name, admin: false, createdAt: 1 });
    if (method === 'POST' && path === '/api/v1/recovery/regenerate') { me.recoveryCode = this.code(); return reply(200, { recoveryCode: me.recoveryCode }); }
    if (method === 'GET' && path === '/api/v1/wallet') return reply(200, this.walletBody(me));
    if (method === 'POST' && path === '/api/v1/wallet') {
      if (this.rateLimitNext) { this.rateLimitNext = false; return reply(429, { ok: false, error: 'rate-limited', message: 'slow down' }); }
      this.staleNext?.(me); this.staleNext = null;
      if (this.rejectNext) { const reason = this.rejectNext; this.rejectNext = null; return reply(200, { ok: false, reason, record: me.record, version: me.version }); }
      if (body?.expectVersion !== me.version) return reply(200, { ok: false, reason: 'version', record: me.record, version: me.version });
      me.record = normalizeWallet(body?.record); me.version++;
      return reply(200, { ok: true, record: me.record, version: me.version });
    }
    if (method === 'POST' && path === '/api/v1/wallet/testgrant') {
      if (!this.testGrant.open) return reply(410, { ok: false, error: 'closed', message: 'closed' });
      const granted = me.testGrantClaimed ? 0 : this.testGrant.marks;
      if (!me.testGrantClaimed) { me.testGrantClaimed = true; this.credit(me, granted, [], 'testgrant:test:grant', 'testgrant'); }
      return reply(200, { ok: true, granted, record: me.record, version: me.version });
    }
    if (method === 'POST' && path === '/api/v1/gifts/redeem') {
      const gift = this.gifts.find(item => item.code === String(body?.code ?? ''));
      if (!gift) return reply(404, { ok: false, error: 'bad-code', message: 'no such code' });
      return this.open(me, gift, reply);
    }
    const claim = path.match(/^\/api\/v1\/gifts\/([^/]+)\/claim$/);
    if (method === 'POST' && claim) {
      const gift = this.gifts.find(item => item.id === claim[1] && item.kind === 'direct');
      if (!gift) return reply(404, { ok: false, error: 'bad-code', message: 'none' });
      return this.open(me, gift, reply);
    }
    return reply(404, { ok: false, error: 'not-found', message: path });
  };

  private open(me: FakeAccount, gift: FakeGift, reply: (status: number, data: unknown) => Response): Response {
    if (me.opened.has(gift.id)) return reply(410, { ok: false, error: 'already-opened', message: 'opened' });
    me.opened.add(gift.id);
    const owned = new Set(me.record?.owned ?? []);
    const gained = gift.items.filter(id => !owned.has(id));
    this.credit(me, gift.marks, gained, `gift:${gift.id}`, 'gift');
    return reply(200, { ok: true, already: false, marks: gift.marks, gained, skipped: gift.items.filter(id => owned.has(id)), gift: { id: gift.id, kind: gift.kind, marks: gift.marks, items: gift.items, message: gift.message, from: gift.from, createdAt: 1 }, record: me.record, version: me.version });
  }
  private credit(me: FakeAccount, marks: number, items: string[], claim: string, source: string): void {
    const base = me.record ?? emptyWallet(1);
    me.record = normalizeWallet({ ...base, owned: [...base.owned, ...items], earned: { ...base.earned, [source]: (base.earned[source] ?? 0) + marks }, claims: [...(base.claims ?? []), claim] });
    me.version++;
  }
  private walletBody(me: FakeAccount): Record<string, unknown> {
    const gifts = this.gifts.filter(gift => gift.kind === 'direct' && !me.opened.has(gift.id)).map(gift => ({ id: gift.id, kind: gift.kind, marks: gift.marks, items: gift.items, message: gift.message, from: gift.from, createdAt: 1, expiresAt: null }));
    return { record: me.record, version: me.version, serverCreatedAt: me.record ? 1_000 : null, gifts, testGrant: { ...this.testGrant, claimed: me.testGrantClaimed } };
  }
  private code(): string { const n = ++this.seq; return `AAAA-BBBB-CCCC-${String(n).padStart(4, '0')}`; }
  private make(name: string): FakeAccount {
    const n = ++this.seq;
    const account: FakeAccount = { accountId: `acc-${n}`, name, recoveryCode: this.code(), tokens: new Set([`tok-acc-${n}-xxxxxxxxxxxxxxxx`]), record: null, version: 0, testGrantClaimed: false, opened: new Set() };
    this.accounts.set(account.accountId, account);
    return account;
  }
  /** Direct access for tests. */
  byName(name: string): FakeAccount { return [...this.accounts.values()].find(account => account.name === name)!; }
}

/** Runs timers that were scheduled with a manual clock. */
export function manualClock(): { now(): number; schedule(fn: () => void, ms: number): number; advance(ms: number): void; pending(): number } {
  let time = 0, id = 0;
  const queue: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => time,
    schedule(fn, ms) { queue.push({ id: ++id, at: time + ms, fn }); return id; },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift(); time = Math.max(time, next.at); next.fn();
      }
      time = end;
    },
    pending: () => queue.length,
  };
}
