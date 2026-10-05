/** Accounts: names, tokens, recovery codes, bans. No passwords, no email. */
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { type Db, tx, metaGet } from './db';
import type { Config } from './config';
import { ApiError, Lockout, WindowLimiter, randomCode, randomToken, safeEqual, sha256hex, type Logger } from './util';

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
  readonly banned: boolean;
  readonly createdAt: number;
}
interface AccountRow { id: string; name: string; name_lower: string; created_at: number; admin: number; banned: number; ban_reason: string | null; recovery_salt: string; recovery_hash: string; last_seen: number }

const toAccount = (r: AccountRow): Account => ({ id: r.id, name: r.name, admin: r.admin === 1, banned: r.banned === 1, createdAt: r.created_at });

export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
/** Reserved: the name itself (separators and trailing digits ignored, leetspeak folded). */
const RESERVED = ['louis', 'admin', 'administrator', 'moderator', 'lateral', 'system', 'staff', 'nordcore', 'support', 'official', 'root', 'server', 'lou'];
/** Reserved fragments: any name containing one of these is refused. */
const RESERVED_PARTS = ['lou15', 'nordcore', 'nordbo', 'moderator'];
/** Severe terms only (a long list would block honest names such as "grape" or "Dickson"). */
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'nigg', 'fagg', 'rapist', 'nazi', 'hitler', 'porn', 'pussy', 'bitch', 'whore', 'slut', 'asshole', 'vagina', 'retard',
  'wanker', 'paedo', 'pedophile', 'molest', 'jihad', 'cocksuck', 'dickhead', 'blowjob', 'handjob', 'cumshot',
];
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };

/** Lowercase, leetspeak folded, separators removed, repeated letters collapsed. */
export function foldName(name: string): string {
  const folded = name.toLowerCase().replace(/[0-9]/g, d => LEET[d] ?? d).replace(/[_-]/g, '');
  return folded.replace(/(.)\1+/g, '$1');
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: 'invalid' | 'reserved' | 'blocked'; message: string };
export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== 'string' || !NAME_RE.test(raw)) return { ok: false, reason: 'invalid', message: 'Use 3 to 16 letters, numbers, dashes or underscores.' };
  const folded = foldName(raw);
  const stripped = foldName(raw.toLowerCase().replace(/[_-]/g, '').replace(/[0-9]+$/, ''));
  for (const word of RESERVED) if (stripped === foldName(word) || folded === foldName(word)) return { ok: false, reason: 'reserved', message: 'That name is reserved.' };
  const plain = raw.toLowerCase().replace(/[_-]/g, '');
  for (const part of RESERVED_PARTS) if (plain.includes(part) || plain.replace(/[^a-z0-9]/g, '').includes(part)) return { ok: false, reason: 'reserved', message: 'That name is reserved.' };
  if (/k[_-]*k[_-]*k/i.test(raw)) return { ok: false, reason: 'blocked', message: 'Please pick a different name.' };
  for (const word of BLOCKED) if (folded.includes(foldName(word))) return { ok: false, reason: 'blocked', message: 'Please pick a different name.' };
  return { ok: true, name: raw };
}

/** The code carries 80 random bits, so a light scrypt (4 MB per hash) is plenty and keeps bursts of sign ups cheap on memory. */
const scrypt = (code: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCb(code, salt, 32, { N: 4096, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
});

/** XXXX-XXXX-XXXX-XXXX */
export const newRecoveryCode = (): string => randomCode(16).replace(/(.{4})(?=.)/g, '$1-');
/** Uppercases and strips separators so a pasted code with spaces or lowercase letters still works. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{16}$/.test(clean) ? clean : null;
}

const MAX_TOKENS = 5;

export class Accounts {
  readonly createLimiter: WindowLimiter;
  readonly globalCreate: WindowLimiter;
  readonly recoverLock = new Lockout(5, 15 * 60_000, 15 * 60_000);
  readonly recoverNameLock = new Lockout(40, 15 * 60_000, 15 * 60_000);
  private readonly salt: string;
  private readonly lastTouch = new Map<string, number>();

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly log: Logger, private readonly now: () => number = Date.now) {
    this.createLimiter = new WindowLimiter(cfg.accountsPerIpHour, 3_600_000);
    this.globalCreate = new WindowLimiter(cfg.accountsGlobalHour, 3_600_000);
    this.salt = metaGet(db, 'salt') ?? '';
  }

  ipHash(ip: string): string { return sha256hex(`${this.salt}:${ip}`).slice(0, 24); }

  async create(rawName: unknown, ip: string): Promise<{ account: Account; token: string; recoveryCode: string }> {
    const now = this.now();
    const check = checkName(rawName);
    if (!check.ok) throw new ApiError(check.reason === 'invalid' ? 400 : 422, `name-${check.reason}`, check.message);
    const ipHash = this.ipHash(ip);
    const perIp = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE ip_hash = ? AND created_at > ?').get(ipHash, now - 3_600_000) as { n: number }).n;
    if (perIp >= this.cfg.accountsPerIpHour) throw new ApiError(429, 'rate-limited', 'Too many accounts from this network. Try again later.');
    const global = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE created_at > ?').get(now - 3_600_000) as { n: number }).n;
    if (global >= this.cfg.accountsGlobalHour) throw new ApiError(429, 'rate-limited', 'Too many new accounts right now. Try again later.');
    const recoveryCode = newRecoveryCode();
    const salt = randomBytes(16);
    const hash = (await scrypt(normalizeRecoveryCode(recoveryCode)!, salt)).toString('hex');
    const id = `a${randomBytes(9).toString('base64url')}`;
    const token = randomToken();
    try {
      tx(this.db, () => {
        this.db.prepare('INSERT INTO accounts (id, name, name_lower, created_at, recovery_salt, recovery_hash, ip_hash, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, check.name, check.name.toLowerCase(), now, salt.toString('hex'), hash, ipHash, now);
        this.db.prepare('INSERT INTO tokens (token_hash, account_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(sha256hex(token), id, now, now);
      });
    } catch (error) {
      if (String((error as Error)?.message ?? '').includes('UNIQUE')) throw new ApiError(409, 'name-taken', 'That name is taken.');
      throw error;
    }
    this.log('account.create', { id });
    return { account: { id, name: check.name, admin: false, banned: false, createdAt: now }, token, recoveryCode };
  }

  /** New token for a name + recovery code. Failed attempts lock the (name, ip) pair. */
  async recover(rawName: unknown, rawCode: unknown, ip: string): Promise<{ account: Account; token: string }> {
    const now = this.now();
    const name = typeof rawName === 'string' ? rawName.toLowerCase().slice(0, 40) : '';
    const keyIp = `${name}|${ip}`;
    if (this.recoverLock.locked(keyIp, now) || this.recoverNameLock.locked(name, now)) throw new ApiError(429, 'locked', 'Too many wrong attempts. Try again in 15 minutes.');
    const code = normalizeRecoveryCode(rawCode);
    const row = NAME_RE.test(name) ? this.db.prepare('SELECT * FROM accounts WHERE name_lower = ?').get(name) as AccountRow | undefined : undefined;
    // Always run one scrypt so an unknown name costs the same as a wrong code.
    const salt = row ? Buffer.from(row.recovery_salt, 'hex') : Buffer.alloc(16, 7);
    const derived = (await scrypt(code ?? 'XXXXXXXXXXXXXXXX', salt)).toString('hex');
    const good = Boolean(row && code && safeEqual(derived, row.recovery_hash));
    if (!good || !row) {
      this.recoverLock.fail(keyIp, now);
      this.recoverNameLock.fail(name, now);
      throw new ApiError(401, 'bad-recovery', 'That name and recovery code do not match.');
    }
    if (row.banned) throw new ApiError(403, 'banned', 'This account is not available.');
    this.recoverLock.success(keyIp);
    const token = this.issueToken(row.id, now);
    return { account: toAccount(row), token };
  }

  private issueToken(accountId: string, now: number): string {
    const token = randomToken();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO tokens (token_hash, account_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(sha256hex(token), accountId, now, now);
      this.db.prepare(`DELETE FROM tokens WHERE account_id = ? AND token_hash NOT IN (
        SELECT token_hash FROM tokens WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(accountId, accountId, MAX_TOKENS);
    });
    return token;
  }

  /** Resolves a bearer token to its account (banned accounts included: callers decide). */
  byToken(token: string): Account | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const hash = sha256hex(token);
    const row = this.db.prepare('SELECT a.* FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?').get(hash) as AccountRow | undefined;
    if (!row) return null;
    const now = this.now();
    if ((this.lastTouch.get(hash) ?? 0) < now - 600_000) {
      this.lastTouch.set(hash, now);
      if (this.lastTouch.size > 10_000) this.lastTouch.clear();
      this.db.prepare('UPDATE tokens SET last_used = ? WHERE token_hash = ?').run(now, hash);
      this.db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(now, row.id);
    }
    return toAccount(row);
  }

  revokeToken(token: string): void { this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(sha256hex(token)); }

  async regenerate(accountId: string): Promise<string> {
    const recoveryCode = newRecoveryCode();
    const salt = randomBytes(16);
    const hash = (await scrypt(normalizeRecoveryCode(recoveryCode)!, salt)).toString('hex');
    this.db.prepare('UPDATE accounts SET recovery_salt = ?, recovery_hash = ? WHERE id = ?').run(salt.toString('hex'), hash, accountId);
    this.log('account.recovery-regenerated', { id: accountId });
    return recoveryCode;
  }

  byId(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }
  byName(name: string): Account | null {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const row = this.db.prepare('SELECT * FROM accounts WHERE name_lower = ?').get(name.toLowerCase()) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }
  touch(id: string): void { this.db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(this.now(), id); }

  count(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n; }

  search(q: string, limit = 50): Array<Account & { lastSeen: number; banReason: string | null }> {
    const like = `%${String(q ?? '').toLowerCase().replace(/[%_\\]/g, m => `\\${m}`).slice(0, 40)}%`;
    const rows = this.db.prepare("SELECT * FROM accounts WHERE name_lower LIKE ? ESCAPE '\\' ORDER BY last_seen DESC LIMIT ?").all(like, Math.min(100, limit)) as unknown as AccountRow[];
    return rows.map(r => ({ ...toAccount(r), lastSeen: r.last_seen, banReason: r.ban_reason }));
  }

  /** Accounts seen in the last `days` days (for "all-active" gifts). */
  activeSince(days: number, limit: number): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts WHERE last_seen > ? AND banned = 0 ORDER BY last_seen DESC LIMIT ?').all(this.now() - days * 86_400_000, limit) as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  setBanned(name: string, banned: boolean, reason = ''): Account {
    const acc = this.requireByName(name);
    if (acc.admin && banned) throw new ApiError(409, 'is-admin', 'Demote the admin first.');
    this.db.prepare('UPDATE accounts SET banned = ?, ban_reason = ? WHERE id = ?').run(banned ? 1 : 0, banned ? reason.slice(0, 200) : null, acc.id);
    if (banned) this.db.prepare('DELETE FROM tokens WHERE account_id = ?').run(acc.id);
    this.log(banned ? 'account.ban' : 'account.unban', { id: acc.id });
    return { ...acc, banned };
  }
  setAdmin(name: string, admin: boolean): Account {
    const acc = this.requireByName(name);
    this.db.prepare('UPDATE accounts SET admin = ? WHERE id = ?').run(admin ? 1 : 0, acc.id);
    this.log(admin ? 'account.promote' : 'account.demote', { id: acc.id });
    return { ...acc, admin };
  }
  /** Admin rename: bypasses the reserved list (Louis may take "louis") but not the format or uniqueness. */
  rename(name: string, newName: string): Account {
    const acc = this.requireByName(name);
    if (typeof newName !== 'string' || !NAME_RE.test(newName)) throw new ApiError(400, 'name-invalid', 'Use 3 to 16 letters, numbers, dashes or underscores.');
    try {
      this.db.prepare('UPDATE accounts SET name = ?, name_lower = ? WHERE id = ?').run(newName, newName.toLowerCase(), acc.id);
    } catch (error) {
      if (String((error as Error)?.message ?? '').includes('UNIQUE')) throw new ApiError(409, 'name-taken', 'That name is taken.');
      throw error;
    }
    this.log('account.rename', { id: acc.id });
    return { ...acc, name: newName };
  }
  private requireByName(name: string): Account {
    const acc = this.byName(name);
    if (!acc) throw new ApiError(404, 'no-such-account', 'No account with that name.');
    return acc;
  }
}
