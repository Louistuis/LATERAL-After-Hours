/** HTTP JSON API. One handler; routes are matched by hand (no framework). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { catalogEntry } from '../src/economy/catalog';
import type { Accounts, Account } from './accounts';
import { AdminAuth, type AdminIdentity } from './admin-auth';
import { giftableItems } from './catalog-list';
import type { Collections } from './collections';
import type { Config } from './config';
import type { Gifts } from './gifts';
import type { Hub } from './hub';
import type { WalletService } from './wallet';
import { ApiError, WindowLimiter, isRecord, normIp, type Logger } from './util';

export interface Ctx {
  cfg: Config; accounts: Accounts; wallets: WalletService; gifts: Gifts; colls: Collections; hub: Hub; adminAuth: AdminAuth; log: Logger; now: () => number; startedAt: number;
}

const MAX_BODY = 100 * 1024;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

/** Real client address: the socket, or X-Real-IP when the socket is a trusted proxy. */
export function clientIp(cfg: Config, headers: IncomingMessage['headers'], remote: string | undefined): string {
  const peer = normIp(remote);
  if (cfg.trustedProxies.includes(peer)) {
    const real = headers['x-real-ip'];
    const v = typeof real === 'string' ? real.trim() : '';
    if (v && IP_RE.test(v)) return normIp(v);
  }
  return peer;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...SECURITY_HEADERS, ...extra });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) return reject(new ApiError(415, 'bad-content-type', 'Send application/json.'));
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > MAX_BODY) return reject(new ApiError(413, 'too-large', 'That request is too large.'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'too-large', 'That request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(400, 'bad-json', 'That is not valid JSON.')); }
    });
    req.on('error', () => reject(new ApiError(400, 'bad-request', 'Request failed.')));
  });
}

const accountView = (a: Account): { accountId: string; name: string; admin: boolean; createdAt: number } => ({ accountId: a.id, name: a.name, admin: a.admin, createdAt: a.createdAt });

export function createApi(ctx: Ctx): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, accounts, wallets, gifts, colls, hub } = ctx;
  const ipLimit = new WindowLimiter(600, 60_000);
  const previewLimit = new WindowLimiter(10, 60_000);
  const previewLock = new WindowLimiter(20, 10 * 60_000);

  const authed = (req: IncomingMessage): Account => {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h);
    const account = m ? accounts.byToken(m[1]!) : null;
    if (!account) throw new ApiError(401, 'unauthorized', 'Sign in again.');
    if (account.banned) throw new ApiError(403, 'banned', 'This account is not available.');
    return account;
  };
  const tokenOf = (req: IncomingMessage): string => /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const seg = path.split('/').slice(1); // ['api','v1',...]
    if (seg[0] !== 'api' || seg[1] !== 'v1') throw new ApiError(404, 'not-found', 'Not found.');
    const r = seg.slice(2);
    const key = r.join('/');

    if (r[0] === 'admin') return admin(req, res, url, r.slice(1));

    /* ---- public ---- */
    if (method === 'GET' && key === 'health') return send(res, 200, { ok: true, version: cfg.version, uptimeS: Math.floor((ctx.now() - ctx.startedAt) / 1000) });
    if (method === 'GET' && key === 'config') return send(res, 200, { testGrant: { marks: cfg.testGrantMarks, open: wallets.testGrantOpen() }, emailGifts: cfg.emailEnabled, version: cfg.version, protocol: 1 });

    if (method === 'POST' && key === 'account') {
      const body = await readBody(req);
      const out = await accounts.create(isRecord(body) ? body.name : undefined, ip);
      return send(res, 201, { accountId: out.account.id, name: out.account.name, token: out.token, recoveryCode: out.recoveryCode });
    }
    if (method === 'POST' && key === 'recover') {
      const body = await readBody(req);
      const b = isRecord(body) ? body : {};
      const out = await accounts.recover(b.name, b.recoveryCode, ip);
      return send(res, 200, { token: out.token, accountId: out.account.id, name: out.account.name });
    }
    if (method === 'GET' && key === 'gifts/preview') {
      if (!previewLimit.hit(ip, ctx.now()) || previewLock.full(ip, ctx.now())) throw new ApiError(429, 'rate-limited', 'Slow down a little.');
      const p = gifts.preview(url.searchParams.get('code'));
      if (p.state === 'invalid') previewLock.add(ip, ctx.now());
      return send(res, 200, p);
    }
    if (method === 'GET' && r[0] === 'collections' && r.length >= 2) {
      const name = r[1]!;
      if (r.length === 3) {
        const row = colls.get(name, r[2]!);
        if (!row) throw new ApiError(404, 'not-found', 'Not found.');
        return send(res, 200, { row });
      }
      const rows = colls.list(name, { route: url.searchParams.get('route') ?? undefined, mode: url.searchParams.get('mode') ?? undefined });
      return send(res, 200, { rows }, { 'Cache-Control': 'public, max-age=5' });
    }

    /* ---- signed in ---- */
    const account = authed(req);
    if (method === 'GET' && key === 'me') return send(res, 200, accountView(account));
    if (method === 'POST' && key === 'logout') { accounts.revokeToken(tokenOf(req)); return send(res, 200, { ok: true }); }
    if (method === 'POST' && key === 'recovery/regenerate') return send(res, 200, { recoveryCode: await accounts.regenerate(account.id) });

    if (method === 'GET' && key === 'wallet') {
      const s = wallets.get(account.id);
      return send(res, 200, { record: s.record, version: s.version, serverCreatedAt: s.serverCreatedAt, gifts: gifts.inbox(account.id), testGrant: { marks: cfg.testGrantMarks, open: wallets.testGrantOpen(), claimed: wallets.testGrantClaimed(account.id) } });
    }
    if (method === 'POST' && key === 'wallet') {
      const body = await readBody(req);
      if (!isRecord(body)) throw new ApiError(400, 'bad-request', 'Expected a JSON object.');
      const out = wallets.write(account.id, body.record, body.expectVersion);
      return send(res, 200, out);
    }
    if (method === 'POST' && key === 'wallet/testgrant') {
      const out = wallets.claimTestGrant(account.id);
      return send(res, 200, { ok: true, granted: out.granted, record: out.record, version: out.version });
    }
    if (method === 'GET' && key === 'gifts') return send(res, 200, { gifts: gifts.inbox(account.id) });
    if (method === 'POST' && key === 'gifts/redeem') {
      const body = await readBody(req);
      return send(res, 200, claimView(gifts.redeem(account, isRecord(body) ? body.code : undefined)));
    }
    if (method === 'POST' && r[0] === 'gifts' && r.length === 3 && r[2] === 'claim') return send(res, 200, claimView(gifts.claimDirect(account, r[1])));
    if (method === 'POST' && r[0] === 'collections' && r.length === 2) {
      const body = await readBody(req);
      const out = colls.write(account, r[1]!, isRecord(body) ? body.data : undefined, isRecord(body) && typeof body.id === 'string' ? body.id : undefined);
      return send(res, out.ok ? 200 : 422, out);
    }
    throw new ApiError(404, 'not-found', 'Not found.');
  }

  function claimView(o: ReturnType<Gifts['claimDirect']>): Record<string, unknown> {
    return { ok: true, already: o.already, marks: o.marks, gained: o.gained, skipped: o.skipped, gift: o.gift, record: o.record, version: o.version };
  }

  /* ---------------------------------------------------------------- admin */
  async function admin(req: IncomingMessage, res: ServerResponse, url: URL, r: string[]): Promise<void> {
    const method = req.method ?? 'GET';
    const who: AdminIdentity = await ctx.adminAuth.authenticate(method, req.headers, req.socket.remoteAddress);
    const key = r.join('/');
    if (method === 'GET' && key === 'whoami') return send(res, 200, { who: who.who, via: who.via, emailEnabled: cfg.emailEnabled, publicUrl: cfg.publicUrl, testGrant: { marks: cfg.testGrantMarks, open: wallets.testGrantOpen() } });
    if (method === 'GET' && key === 'catalog') return send(res, 200, { items: giftableItems(), limits: { marks: cfg.giftMaxMarks, items: cfg.giftMaxItems, message: 140 } });
    if (method === 'GET' && key === 'stats') {
      const h = hub.stats();
      return send(res, 200, { ...h, accounts: accounts.count(), flags: wallets.flagCount(), collRows: colls.rowCount(), emailEnabled: cfg.emailEnabled, version: cfg.version });
    }
    if (method === 'GET' && key === 'gifts') return send(res, 200, { gifts: gifts.list(Number(url.searchParams.get('limit')) || 100) });
    if (method === 'GET' && key === 'flags') return send(res, 200, { flags: wallets.recentFlags() });
    if (method === 'GET' && key === 'accounts') {
      const rows = accounts.search(url.searchParams.get('q') ?? '').map(a => ({ name: a.name, accountId: a.id, admin: a.admin, banned: a.banned, banReason: a.banReason, createdAt: a.createdAt, lastSeen: a.lastSeen }));
      return send(res, 200, { accounts: rows });
    }
    if (method === 'GET' && key === 'ledger') {
      const acc = accounts.byName(url.searchParams.get('name') ?? '');
      if (!acc) throw new ApiError(404, 'no-such-account', 'No account with that name.');
      const s = wallets.get(acc.id);
      return send(res, 200, {
        account: { name: acc.name, accountId: acc.id, admin: acc.admin, banned: acc.banned, createdAt: acc.createdAt },
        balance: s.record ? Object.values(s.record.earned).reduce((a, b) => a + b, 0) - s.record.spent : null,
        owned: s.record?.owned ?? [], ledger: wallets.ledger(acc.id, Number(url.searchParams.get('limit')) || 200),
      });
    }
    if (method === 'POST' && key === 'gift') {
      const body = await readBody(req);
      if (!isRecord(body)) throw new ApiError(400, 'bad-request', 'Expected a JSON object.');
      const by = who.who;
      if (typeof body.email === 'string' && body.email) {
        const out = await gifts.createForEmail(by, body.email, body);
        return send(res, 201, { ok: true, kind: 'email', gift: out.gift, link: out.link, message: out.message, emailSent: out.emailSent, emailStatus: out.emailStatus });
      }
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (body.code === true || to === 'code') {
        const gift = gifts.createCode(by, body);
        return send(res, 201, { ok: true, kind: 'code', gift, link: gifts.link(gift.code!), message: gifts.copyMessage(gift) });
      }
      const m = /^all-active-days:(\d{1,3})$/.exec(to);
      if (m) return send(res, 201, { ok: true, kind: 'all', ...gifts.createForActive(by, Number(m[1]), body) });
      if (!to) throw new ApiError(400, 'bad-request', 'Say who the gift is for: a driver name, an email, or a code.');
      const gift = gifts.createDirect(by, to, body);
      return send(res, 201, { ok: true, kind: 'direct', gift });
    }
    let m = /^gift\/([A-Za-z0-9_-]{1,40})\/revoke$/.exec(key);
    if (method === 'POST' && m) return send(res, 200, { ok: true, gift: gifts.revoke(m[1]!) });
    m = /^account\/([A-Za-z0-9_-]{3,16})\/(ban|unban|rename|promote|demote)$/.exec(key);
    if (method === 'POST' && m) {
      const [, name, action] = m;
      const body = await readBody(req);
      const b = isRecord(body) ? body : {};
      let acc: Account;
      if (action === 'ban') { acc = accounts.setBanned(name!, true, typeof b.reason === 'string' ? b.reason : ''); hub.kick(acc.id, 'banned'); }
      else if (action === 'unban') acc = accounts.setBanned(name!, false);
      else if (action === 'promote') acc = accounts.setAdmin(name!, true);
      else if (action === 'demote') acc = accounts.setAdmin(name!, false);
      else { acc = accounts.rename(name!, String(b.newName ?? '')); hub.kick(acc.id, 'renamed', 4409); }
      wallets.note(acc.id, `${action} by ${who.who}`.slice(0, 80));
      ctx.log('admin.account', { action, id: acc.id, by: who.via });
      return send(res, 200, { ok: true, account: accountView(acc), banned: acc.banned });
    }
    throw new ApiError(404, 'not-found', 'Not found.');
  }

  return async (req, res) => {
    const now = ctx.now();
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.url && req.url.length > 2048) throw new ApiError(414, 'uri-too-long', 'URL too long.');
      const ip = clientIp(cfg, req.headers, req.socket.remoteAddress);
      if (!ipLimit.hit(ip, now)) throw new ApiError(429, 'rate-limited', 'Too many requests.');
      await route(req, res, url, ip);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ApiError) {
        const retry: Record<string, string> = error.status === 429 ? { 'Retry-After': '60' } : {};
        return send(res, error.status, { ok: false, error: error.code, message: error.message, ...(error.extra ?? {}) }, retry);
      }
      ctx.log('http.error', { err: String((error as Error)?.message ?? error).slice(0, 120) });
      send(res, 500, { ok: false, error: 'server-error', message: 'Something went wrong on our side.' });
    }
  };
}

export { catalogEntry };
