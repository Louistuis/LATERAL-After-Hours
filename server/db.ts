/** SQLite (built-in node:sqlite, WAL). Parameterised statements only. */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  recovery_salt TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  ip_hash TEXT,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS accounts_ip ON accounts(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS accounts_created ON accounts(created_at);
CREATE INDEX IF NOT EXISTS accounts_seen ON accounts(last_seen);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account_id, created_at);
CREATE TABLE IF NOT EXISTS wallets (
  account_id TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  client_writes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ref TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id, ts);
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  to_account TEXT,
  code TEXT,
  marks INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL DEFAULT '',
  from_label TEXT NOT NULL DEFAULT 'Louis',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_claims INTEGER NOT NULL DEFAULT 1,
  claims INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL DEFAULT '',
  email_masked TEXT,
  email_status TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS gifts_code ON gifts(code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS gifts_to ON gifts(to_account, status);
CREATE INDEX IF NOT EXISTS gifts_created ON gifts(created_at);
CREATE TABLE IF NOT EXISTS gift_claims (
  gift_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE(gift_id, account_id)
);
CREATE TABLE IF NOT EXISTS email_log (
  hash TEXT NOT NULL,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_log_day ON email_log(day, hash);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS coll_rows (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  username TEXT NOT NULL,
  rkey TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS coll_owner ON coll_rows(coll, account_id, rkey);
CREATE INDEX IF NOT EXISTS coll_rank ON coll_rows(coll, rkey, value);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  db.exec(SCHEMA);
  const get = db.prepare('SELECT v FROM meta WHERE k = ?');
  if (!get.get('schema')) db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema', '1');
  if (!get.get('salt')) db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('salt', randomBytes(24).toString('hex'));
  return db;
}

export function metaGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
  return row ? row.v : null;
}

const depth = new WeakMap<Db, number>();
/** Runs `fn` in an IMMEDIATE transaction (single writer, rolls back on throw). Nested calls join the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  } finally {
    depth.set(db, 0);
  }
}
