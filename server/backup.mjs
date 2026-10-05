#!/usr/bin/env node
/* global process, console */
// Nightly backup: VACUUM INTO a dated file, keep the newest N, optionally copy to another host.
//   node backup.mjs [--db /var/lib/lateral/lateral.db] [--dir /var/lib/lateral/backups] [--keep 14] [--copy-to user@host:/var/backups/lateral/]
// The copy runs with a timeout (it must never hang the timer). Exit code 0 only when the local backup succeeded.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const dbPath = arg('db', process.env.DB_PATH || '/var/lib/lateral/lateral.db');
const dir = arg('dir', process.env.BACKUP_DIR || join(dbPath, '..', 'backups'));
const keep = Math.max(1, Number(arg('keep', process.env.BACKUP_KEEP || '14')));
const copyTo = arg('copy-to', process.env.BACKUP_COPY_TO || '');

if (!existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(1); }
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const target = join(dir, `lateral-${stamp}.db`);
if (existsSync(target)) rmSync(target);
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally { db.close(); }
const check = new DatabaseSync(target, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
check.close();
if (!ok || Object.values(ok)[0] !== 'ok') { console.error('integrity check failed on the new backup'); rmSync(target, { force: true }); process.exit(1); }
console.log(`backup ${target} (${statSync(target).size} bytes)`);

const old = readdirSync(dir).filter(f => /^lateral-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) rmSync(join(dir, f), { force: true });
if (old.length) console.log(`removed ${old.length} old backup(s)`);

if (copyTo) {
  const r = spawnSync('timeout', ['60', 'scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, copyTo], { stdio: 'inherit' });
  console.log(r.status === 0 ? `copied to ${copyTo}` : `copy to ${copyTo} failed (status ${r.status}); the local backup is fine`);
}
