/** Gifts from Louis: direct (to one account), code (redeemable links), and email (a one-claim code sent by mail). */
import { createHash, randomBytes } from 'node:crypto';
import { catalogEntry } from '../src/economy/catalog';
import type { WalletRecord } from '../src/economy/types';
import { type Db, metaGet, tx } from './db';
import type { Config } from './config';
import type { Accounts, Account } from './accounts';
import type { WalletService } from './wallet';
import { buildGiftMessage, maskEmail, normalizeEmail, validEmail, type MailTransport } from './mailer';
import { ApiError, CODE_ALPHABET, Lockout, WindowLimiter, cleanText, dayOf, isRecord, randomCode, type Logger } from './util';

export interface GiftView {
  readonly id: string;
  readonly kind: 'direct' | 'code';
  readonly marks: number;
  readonly items: readonly string[];
  readonly message: string;
  readonly from: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}
export interface AdminGiftRow extends GiftView {
  readonly toName: string | null;
  readonly code: string | null;
  readonly link: string | null;
  readonly status: 'open' | 'revoked';
  readonly maxClaims: number;
  readonly claims: number;
  readonly claimedBy: readonly string[];
  readonly emailMasked: string | null;
  readonly emailStatus: string | null;
  readonly createdBy: string;
  /** open | claimed | revoked | expired, as the admin table shows it. */
  readonly state: 'open' | 'claimed' | 'revoked' | 'expired';
}
interface GiftRow {
  id: string; kind: 'direct' | 'code'; to_account: string | null; code: string | null; marks: number; items: string; message: string; from_label: string;
  created_at: number; expires_at: number | null; max_claims: number; claims: number; status: 'open' | 'revoked'; created_by: string; email_masked: string | null; email_status: string | null;
}

export interface GiftSpec {
  readonly marks: number;
  readonly items: readonly string[];
  readonly message: string;
  readonly fromLabel: string;
  readonly expiresAt: number | null;
  readonly maxClaims: number;
}

export interface ClaimOutcome {
  readonly gift: GiftView;
  /** true when this account had already opened the gift (nothing was credited again). */
  readonly already: boolean;
  readonly marks: number;
  readonly gained: readonly string[];
  readonly skipped: readonly string[];
  readonly record: WalletRecord | null;
  readonly version: number;
}

const CODE_RE = /^LATERAL[A-HJ-NP-Z2-9]{8}$/;
export const formatCode = (tail: string): string => `LATERAL-${tail.slice(0, 4)}-${tail.slice(4)}`;
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(clean) ? formatCode(clean.slice(7)) : null;
}

export class Gifts {
  readonly redeemRate = new WindowLimiter(10, 60_000);
  readonly redeemLock = new Lockout(5, 10 * 60_000, 15 * 60_000);
  private readonly salt: string;

  constructor(
    private readonly db: Db, private readonly cfg: Config, private readonly accounts: Accounts, private readonly wallets: WalletService,
    private readonly log: Logger, private readonly now: () => number = Date.now, private transport: MailTransport | null = null,
  ) { this.salt = metaGet(db, 'salt') ?? ''; }

  /** Called when a direct gift lands in an inbox (the hub pushes a wallet notice). */
  onInbox: (accountId: string) => void = () => {};
  private notify(accountId: string): void { try { this.onInbox(accountId); } catch { /* push is best effort */ } }
  setTransport(t: MailTransport | null): void { this.transport = t; }

  /* ---- validation ---- */
  parseSpec(raw: unknown, kind: 'direct' | 'code'): GiftSpec {
    if (!isRecord(raw)) throw new ApiError(400, 'bad-request', 'Expected a JSON object.');
    const marks = raw.marks === undefined ? 0 : raw.marks;
    if (typeof marks !== 'number' || !Number.isSafeInteger(marks) || marks < 0 || marks > this.cfg.giftMaxMarks) throw new ApiError(400, 'bad-marks', `Marks must be a whole number from 0 to ${this.cfg.giftMaxMarks}.`);
    const itemsRaw = raw.items === undefined ? [] : raw.items;
    if (!Array.isArray(itemsRaw) || itemsRaw.length > this.cfg.giftMaxItems) throw new ApiError(400, 'bad-items', `At most ${this.cfg.giftMaxItems} items.`);
    const items: string[] = [];
    for (const id of itemsRaw) {
      if (typeof id !== 'string') throw new ApiError(400, 'bad-items', 'Item ids must be text.');
      const entry = catalogEntry(id);
      if (!entry || entry.hidden || entry.price <= 0) throw new ApiError(400, 'bad-items', `Unknown item: ${id.slice(0, 40)}`);
      if (!items.includes(id)) items.push(id);
    }
    if (marks === 0 && items.length === 0) throw new ApiError(400, 'empty-gift', 'A gift needs Marks or at least one item.');
    const message = raw.message === undefined ? '' : cleanText(raw.message, 140);
    if (raw.message !== undefined && typeof raw.message !== 'string') throw new ApiError(400, 'bad-message', 'The message must be text.');
    if (typeof raw.message === 'string' && Array.from(raw.message.replace(/\s+/g, ' ').trim()).length > 140) throw new ApiError(400, 'bad-message', 'The message is limited to 140 characters.');
    const fromLabel = raw.fromLabel === undefined ? 'Louis' : cleanText(raw.fromLabel, 24) || 'Louis';
    let expiresAt: number | null = null;
    if (raw.expiresInDays !== undefined && raw.expiresInDays !== null) {
      const d = raw.expiresInDays;
      if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > 3650) throw new ApiError(400, 'bad-expiry', 'expiresInDays must be between 0 and 3650.');
      expiresAt = this.now() + Math.round(d * 86_400_000);
    } else if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
      const e = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : raw.expiresAt;
      if (typeof e !== 'number' || !Number.isFinite(e) || e <= this.now()) throw new ApiError(400, 'bad-expiry', 'The expiry must be in the future.');
      expiresAt = Math.floor(e);
    }
    let maxClaims = 1;
    if (kind === 'code' && raw.maxClaims !== undefined) {
      const m = raw.maxClaims;
      if (typeof m !== 'number' || !Number.isSafeInteger(m) || m < 1 || m > 100_000) throw new ApiError(400, 'bad-max-claims', 'maxClaims must be between 1 and 100000.');
      maxClaims = m;
    }
    return { marks, items, message, fromLabel, expiresAt, maxClaims };
  }

  /* ---- creation ---- */
  private insert(kind: 'direct' | 'code', spec: GiftSpec, by: string, toAccount: string | null, code: string | null, extra: { emailMasked?: string; maxClaims?: number } = {}): string {
    const id = `g${randomBytes(9).toString('base64url')}`;
    this.db.prepare(`INSERT INTO gifts (id, kind, to_account, code, marks, items, message, from_label, created_at, expires_at, max_claims, claims, status, created_by, email_masked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`)
      .run(id, kind, toAccount, code, spec.marks, JSON.stringify(spec.items), spec.message, spec.fromLabel, this.now(), spec.expiresAt, extra.maxClaims ?? (kind === 'direct' ? 1 : spec.maxClaims), by.slice(0, 80), extra.emailMasked ?? null);
    return id;
  }

  createDirect(by: string, toName: string, raw: unknown): AdminGiftRow {
    const spec = this.parseSpec(raw, 'direct');
    const account = this.accounts.byName(toName);
    if (!account) throw new ApiError(404, 'no-such-account', 'No account with that name.');
    if (account.banned) throw new ApiError(409, 'banned', 'That account is banned.');
    const id = this.insert('direct', spec, by, account.id, null);
    this.log('gift.create', { id, kind: 'direct' });
    this.notify(account.id);
    return this.adminRow(this.rowById(id)!);
  }

  /** One direct gift per account seen in the last `days` days. */
  createForActive(by: string, days: number, raw: unknown): { count: number; giftIds: string[] } {
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new ApiError(400, 'bad-days', 'Days must be between 1 and 365.');
    const spec = this.parseSpec(raw, 'direct');
    const targets = this.accounts.activeSince(Math.floor(days), this.cfg.giftMaxAllActive);
    const ids = tx(this.db, () => targets.map(acc => this.insert('direct', spec, by, acc.id, null)));
    for (const acc of targets) this.notify(acc.id);
    this.log('gift.create-all', { count: ids.length });
    return { count: ids.length, giftIds: ids };
  }

  createCode(by: string, raw: unknown, extra: { emailMasked?: string; maxClaims?: number } = {}): AdminGiftRow {
    const spec = this.parseSpec(raw, 'code');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = formatCode(randomCode(8));
      try {
        const id = this.insert('code', spec, by, null, code, { ...extra, maxClaims: extra.maxClaims ?? spec.maxClaims });
        this.log('gift.create', { id, kind: 'code' });
        return this.adminRow(this.rowById(id)!);
      } catch (error) {
        if (!String((error as Error)?.message ?? '').includes('UNIQUE')) throw error;
      }
    }
    throw new ApiError(500, 'code-collision', 'Could not make a unique code. Try again.');
  }

  link(code: string): string { return `${this.cfg.publicUrl}/?gift=${code}`; }

  /** A ready to paste message for a gift link (what the email would say). */
  copyMessage(gift: AdminGiftRow): { subject: string; text: string } {
    const mail = buildGiftMessage({ link: this.link(gift.code ?? ''), marks: gift.marks, itemCount: gift.items.length, message: gift.message, fromName: gift.from });
    return { subject: mail.subject, text: mail.text };
  }

  /** What a visitor with a link may learn before signing in: only whether it is still good, and who it is from. */
  preview(raw: unknown): { state: 'open' | 'opened' | 'expired' | 'revoked' | 'invalid'; from?: string } {
    const code = normalizeCode(raw);
    const row = code ? this.db.prepare("SELECT * FROM gifts WHERE code = ? AND kind = 'code'").get(code) as GiftRow | undefined : undefined;
    if (!row) return { state: 'invalid' };
    if (row.status === 'revoked') return { state: 'revoked', from: row.from_label };
    if (row.expires_at !== null && row.expires_at <= this.now()) return { state: 'expired', from: row.from_label };
    if (row.claims >= row.max_claims) return { state: 'opened', from: row.from_label };
    return { state: 'open', from: row.from_label };
  }

  /** A code gift for one email address (max 1 claim) and the email itself. Only a hash and the masked form are kept. */
  async createForEmail(by: string, email: unknown, raw: unknown): Promise<{ gift: AdminGiftRow; link: string; message: { subject: string; text: string }; emailSent: boolean; emailStatus: string }> {
    if (!validEmail(email)) throw new ApiError(400, 'bad-email', 'That does not look like an email address.');
    const norm = normalizeEmail(email);
    const hash = createHash('sha256').update(`${this.salt}:email:${norm}`).digest('hex');
    const now = this.now(), day = dayOf(now);
    const sending = this.cfg.emailEnabled && this.transport !== null;
    if (sending) {
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE day = ?').get(day) as { n: number }).n;
      if (total >= this.cfg.emailDailyMax) throw new ApiError(429, 'email-daily-limit', `Daily email limit reached (${this.cfg.emailDailyMax}).`);
      const same = (this.db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE day = ? AND hash = ?').get(day, hash) as { n: number }).n;
      if (same >= this.cfg.emailPerAddressDay) throw new ApiError(429, 'email-address-limit', 'Already sent to this address today.');
    }
    const gift = this.createCode(by, raw, { emailMasked: maskEmail(norm), maxClaims: 1 });
    const link = this.link(gift.code!);
    const mail = buildGiftMessage({ link, marks: gift.marks, itemCount: gift.items.length, message: gift.message, fromName: gift.from });
    let status = 'disabled', sent = false;
    if (sending) {
      this.db.prepare('INSERT INTO email_log (hash, ts, day) VALUES (?, ?, ?)').run(hash, now, day);
      try {
        const result = await this.transport!.send({ from: this.cfg.emailFrom, to: norm, subject: mail.subject, text: mail.text, html: mail.html });
        sent = result.ok;
        status = result.ok ? 'sent' : 'failed';
        if (!result.ok) this.log('gift.email-failed', { id: gift.id, error: String(result.error).slice(0, 120) });
      } catch (error) {
        status = 'failed';
        this.log('gift.email-failed', { id: gift.id, error: String((error as Error)?.message ?? error).slice(0, 120) });
      }
    }
    this.db.prepare('UPDATE gifts SET email_status = ? WHERE id = ?').run(status, gift.id);
    this.log('gift.email', { id: gift.id, status });
    return { gift: { ...gift, emailStatus: status }, link, message: { subject: mail.subject, text: mail.text }, emailSent: sent, emailStatus: status };
  }

  revoke(giftId: string): AdminGiftRow {
    const row = this.rowById(giftId);
    if (!row) throw new ApiError(404, 'no-such-gift', 'No such gift.');
    this.db.prepare("UPDATE gifts SET status = 'revoked' WHERE id = ?").run(giftId);
    this.log('gift.revoke', { id: giftId });
    return this.adminRow(this.rowById(giftId)!);
  }

  /* ---- reads ---- */
  private rowById(id: string): GiftRow | undefined {
    return this.db.prepare('SELECT * FROM gifts WHERE id = ?').get(id) as GiftRow | undefined;
  }
  private view(r: GiftRow): GiftView {
    return { id: r.id, kind: r.kind, marks: r.marks, items: JSON.parse(r.items) as string[], message: r.message, from: r.from_label, createdAt: r.created_at, expiresAt: r.expires_at };
  }
  private adminRow(r: GiftRow): AdminGiftRow {
    const claimedBy = (this.db.prepare('SELECT a.name AS name FROM gift_claims c JOIN accounts a ON a.id = c.account_id WHERE c.gift_id = ? ORDER BY c.ts LIMIT 5').all(r.id) as Array<{ name: string }>).map(x => x.name);
    const toName = r.to_account ? this.accounts.byId(r.to_account)?.name ?? null : null;
    const expired = r.expires_at !== null && r.expires_at <= this.now();
    const state = r.status === 'revoked' ? 'revoked' : r.claims >= r.max_claims ? 'claimed' : expired ? 'expired' : 'open';
    return {
      ...this.view(r), toName, code: r.code, link: r.code ? this.link(r.code) : null, status: r.status, maxClaims: r.max_claims, claims: r.claims, claimedBy,
      emailMasked: r.email_masked, emailStatus: r.email_status, createdBy: r.created_by, state,
    };
  }
  list(limit = 100): AdminGiftRow[] {
    const rows = this.db.prepare('SELECT * FROM gifts ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(300, limit)) as unknown as GiftRow[];
    return rows.map(r => this.adminRow(r));
  }

  /** Pending direct gifts for an account: open, not expired, not yet claimed. */
  inbox(accountId: string): GiftView[] {
    const now = this.now();
    const rows = this.db.prepare(`SELECT g.* FROM gifts g WHERE g.kind = 'direct' AND g.to_account = ? AND g.status = 'open' AND g.claims < g.max_claims
      AND (g.expires_at IS NULL OR g.expires_at > ?) AND NOT EXISTS (SELECT 1 FROM gift_claims c WHERE c.gift_id = g.id AND c.account_id = ?)
      ORDER BY g.created_at ASC LIMIT 50`).all(accountId, now, accountId) as unknown as GiftRow[];
    return rows.map(r => this.view(r));
  }

  /* ---- claiming ---- */
  /** Credits one gift to one account, once. Runs in one transaction. */
  private claimRow(account: Account, row: GiftRow): ClaimOutcome {
    const now = this.now();
    return tx(this.db, () => {
      const fresh = this.rowById(row.id)!;
      const view = this.view(fresh);
      const mine = this.db.prepare('SELECT 1 AS x FROM gift_claims WHERE gift_id = ? AND account_id = ?').get(fresh.id, account.id);
      if (mine) {
        const s = this.wallets.get(account.id);
        return { gift: view, already: true, marks: 0, gained: [], skipped: [], record: s.record, version: s.version };
      }
      if (fresh.status === 'revoked') throw new ApiError(410, 'revoked', 'This gift was taken back.');
      if (fresh.expires_at !== null && fresh.expires_at <= now) throw new ApiError(410, 'expired', 'This gift has expired.');
      if (fresh.claims >= fresh.max_claims) throw new ApiError(410, 'already-opened', 'This gift was already opened.');
      this.db.prepare('INSERT INTO gift_claims (gift_id, account_id, ts) VALUES (?, ?, ?)').run(fresh.id, account.id, now);
      this.db.prepare('UPDATE gifts SET claims = claims + 1 WHERE id = ?').run(fresh.id);
      const out = this.wallets.creditGift(account.id, { id: fresh.id, marks: fresh.marks, items: view.items });
      this.log('gift.claim', { id: fresh.id, account: account.id });
      return { gift: view, already: false, marks: fresh.marks, gained: out.gained, skipped: out.skipped, record: out.record, version: out.version };
    });
  }

  claimDirect(account: Account, giftId: unknown): ClaimOutcome {
    if (typeof giftId !== 'string' || giftId.length > 40) throw new ApiError(404, 'no-such-gift', 'No such gift.');
    const row = this.rowById(giftId);
    if (!row || row.kind !== 'direct' || row.to_account !== account.id) throw new ApiError(404, 'no-such-gift', 'No such gift.');
    return this.claimRow(account, row);
  }

  redeem(account: Account, rawCode: unknown): ClaimOutcome {
    const now = this.now();
    if (this.redeemLock.locked(account.id, now)) throw new ApiError(429, 'locked', 'Too many wrong codes. Try again in 15 minutes.');
    if (!this.redeemRate.hit(account.id, now)) throw new ApiError(429, 'rate-limited', 'Slow down a little.');
    const code = normalizeCode(rawCode);
    const row = code ? this.db.prepare("SELECT * FROM gifts WHERE code = ? AND kind = 'code'").get(code) as GiftRow | undefined : undefined;
    if (!row) {
      this.redeemLock.fail(account.id, now);
      throw new ApiError(404, 'bad-code', 'That code is not valid.');
    }
    return this.claimRow(account, row);
  }

  static alphabet = CODE_ALPHABET;
}
