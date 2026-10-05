/** Wallet service: the stored record, optimistic versioning, the ledger, and server-side credits. */
import type { WalletRecord } from '../src/economy/types';
import { emptyWallet, parseWalletJson } from '../src/economy/wallet';
import { type Db, tx } from './db';
import type { Config } from './config';
import { ApiError, WindowLimiter, isRecord, type Logger } from './util';
import { applyGift, applyTestGrant, validateTransition, TESTGRANT_CLAIM, type CreditResult, type LedgerLine } from './wallet-rules';

export interface WalletState {
  readonly record: WalletRecord | null;
  readonly version: number;
  readonly serverCreatedAt: number | null;
}
interface Row { record: string; version: number; created_at: number; updated_at: number; client_writes: number }

export type WriteResult =
  | { ok: true; record: WalletRecord | null; version: number }
  | { ok: false; reason: string; record: WalletRecord | null; version: number };

export interface LedgerRow { id: number; ts: number; kind: string; amount: number; ref: string }

export class WalletService {
  private readonly limiter: WindowLimiter;
  /** Called after a server-side change (gift, test grant). The hub uses it to push `{t:'wallet'}`. */
  onChange: (accountId: string, version: number) => void = () => {};

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly log: Logger, private readonly now: () => number = Date.now) {
    this.limiter = new WindowLimiter(cfg.walletWritesPerMin, 60_000);
  }

  private row(accountId: string): Row | undefined {
    return this.db.prepare('SELECT record, version, created_at, updated_at, client_writes FROM wallets WHERE account_id = ?').get(accountId) as Row | undefined;
  }

  get(accountId: string): WalletState {
    const row = this.row(accountId);
    if (!row) return { record: null, version: 0, serverCreatedAt: null };
    return { record: parseWalletJson(row.record), version: row.version, serverCreatedAt: row.created_at };
  }

  private hourlyEarned(accountId: string, now: number): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE account_id = ? AND ts > ? AND kind IN ('earn:missions', 'earn:daily')").get(accountId, now - 3_600_000) as { n: number };
    return r.n;
  }

  private addLedger(accountId: string, ts: number, lines: readonly LedgerLine[]): void {
    const stmt = this.db.prepare('INSERT INTO ledger (account_id, ts, kind, amount, ref) VALUES (?, ?, ?, ?, ?)');
    for (const line of lines) stmt.run(accountId, ts, line.kind, line.amount, line.ref);
  }

  flag(accountId: string, kind: string, detail: string): void {
    this.db.prepare('INSERT INTO flags (account_id, ts, kind, detail) VALUES (?, ?, ?, ?)').run(accountId, this.now(), kind, detail.slice(0, 300));
    this.log('wallet.flag', { account: accountId, kind });
  }

  /** The client writes its whole record. The server judges the transition. */
  write(accountId: string, raw: unknown, expectVersion: unknown): WriteResult {
    const now = this.now();
    if (!this.limiter.hit(accountId, now)) throw new ApiError(429, 'rate-limited', 'Too many wallet writes. Slow down.');
    if (typeof expectVersion !== 'number' || !Number.isSafeInteger(expectVersion) || expectVersion < 0) throw new ApiError(400, 'bad-request', 'expectVersion must be a whole number.');
    const cur = this.row(accountId);
    const version = cur?.version ?? 0;
    const prev = cur ? parseWalletJson(cur.record) : null;
    if (expectVersion !== version) return { ok: false, reason: 'version', record: prev, version };
    const verdict = validateTransition(prev, raw, {
      now, mode: (cur?.client_writes ?? 0) === 0 ? 'import' : 'steady', launchAt: this.cfg.launchAt,
      serverCreatedAt: cur?.created_at ?? now, hourlyEarned: this.hourlyEarned(accountId, now), hourlyLimit: this.cfg.earnHourlyLimit,
    });
    if (!verdict.ok) {
      this.log('wallet.reject', { account: accountId, reason: verdict.reason });
      if (verdict.flag) this.flag(accountId, `reject:${verdict.reason}`, verdict.detail ?? '');
      return { ok: false, reason: verdict.reason, record: prev, version };
    }
    if (verdict.unchanged) return { ok: true, record: prev, version };
    const text = JSON.stringify(verdict.record);
    tx(this.db, () => {
      if (cur) this.db.prepare('UPDATE wallets SET record = ?, version = version + 1, updated_at = ?, client_writes = client_writes + 1 WHERE account_id = ?').run(text, now, accountId);
      else this.db.prepare('INSERT INTO wallets (account_id, record, version, created_at, updated_at, client_writes) VALUES (?, ?, 1, ?, ?, 1)').run(accountId, text, now, now);
      this.addLedger(accountId, now, verdict.ledger);
    });
    try { this.onChange(accountId, version + 1); } catch { /* a push must never fail a write */ }
    return { ok: true, record: verdict.record, version: version + 1 };
  }

  /**
   * Applies a server-side change to the wallet (creating an empty one when the account has none) inside the caller's
   * transaction, appends ledger rows, bumps the version and fires onChange after the outermost transaction ends.
   */
  credit(accountId: string, build: (record: WalletRecord) => CreditResult): CreditResult & { version: number } {
    const now = this.now();
    const out = tx(this.db, () => {
      const cur = this.row(accountId);
      const record = (cur ? parseWalletJson(cur.record) : null) ?? emptyWallet(now);
      const result = build(record);
      const text = JSON.stringify(result.record);
      let version: number;
      if (cur) {
        version = cur.version + 1;
        this.db.prepare('UPDATE wallets SET record = ?, version = ?, updated_at = ? WHERE account_id = ?').run(text, version, now, accountId);
      } else {
        version = 1;
        this.db.prepare('INSERT INTO wallets (account_id, record, version, created_at, updated_at, client_writes) VALUES (?, ?, 1, ?, ?, 0)').run(accountId, text, now, now);
      }
      this.addLedger(accountId, now, result.ledger);
      return { ...result, version };
    });
    try { this.onChange(accountId, out.version); } catch { /* a push must never fail a credit */ }
    return out;
  }

  creditGift(accountId: string, gift: { id: string; marks: number; items: readonly string[] }): CreditResult & { version: number } {
    return this.credit(accountId, record => applyGift(record, gift, this.now()));
  }

  /* ---- test grant ---- */
  testGrantOpen(): boolean {
    const { testGrantMarks, testGrantUntil } = this.cfg;
    return testGrantMarks > 0 && (testGrantUntil === null || this.now() < testGrantUntil);
  }
  testGrantClaimed(accountId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS x FROM ledger WHERE account_id = ? AND kind = 'earn:testgrant' LIMIT 1").get(accountId));
  }
  /** Idempotent. `granted` is 0 when it was already claimed. */
  claimTestGrant(accountId: string): { granted: number; record: WalletRecord; version: number } {
    if (!this.testGrantOpen()) throw new ApiError(410, 'closed', 'The testing bonus is closed.');
    return tx(this.db, () => {
      if (this.testGrantClaimed(accountId)) {
        const s = this.get(accountId);
        return { granted: 0, record: s.record ?? emptyWallet(this.now()), version: s.version };
      }
      const out = this.credit(accountId, record => applyTestGrant(record, this.cfg.testGrantMarks, this.now()));
      this.log('wallet.testgrant', { account: accountId });
      return { granted: this.cfg.testGrantMarks, record: out.record, version: out.version };
    });
  }

  /* ---- reads for admin ---- */
  ledger(accountId: string, limit = 200): LedgerRow[] {
    return this.db.prepare('SELECT id, ts, kind, amount, ref FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, Math.min(500, limit)) as unknown as LedgerRow[];
  }
  flagCount(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM flags').get() as { n: number }).n; }
  recentFlags(limit = 50): Array<{ id: number; account_id: string; ts: number; kind: string; detail: string }> {
    return this.db.prepare('SELECT id, account_id, ts, kind, detail FROM flags ORDER BY id DESC LIMIT ?').all(limit) as unknown as Array<{ id: number; account_id: string; ts: number; kind: string; detail: string }>;
  }
  /** Marks an admin adjustment in the ledger (no balance change here; the admin tool uses gifts for credits). */
  note(accountId: string, text: string): void { this.addLedger(accountId, this.now(), [{ kind: `admin:${text.slice(0, 80)}`, amount: 0, ref: '' }]); }
  static isRecordLike = isRecord;
  static TESTGRANT_CLAIM = TESTGRANT_CLAIM;
}
