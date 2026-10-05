#!/usr/bin/env node
// Remove test accounts and everything hanging off them from the LATERAL database. Run as root on nc2.
//   purge-test-accounts.mjs --name infra_test_01 [--name other] [--gift-message "infra end-to-end test"] [--apply]
// Dry run by default (prints what WOULD go). With --apply it first writes a VACUUM INTO copy next to the other backups,
// then deletes in ONE transaction and prints the deleted row counts and what is left. The schema is never touched.
// Refuses to run while lateral-server is active (stop it first), unless --allow-running is given.
// A gift is only removed when it is addressed to a purged account, or was claimed ONLY by purged accounts, or carries
// one of the --gift-message markers and has no claims by anyone else. Real players' gifts are never touched.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const DB = process.env.DB_PATH || '/var/lib/lateral/lateral.db';
const args = process.argv.slice(2);
const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const names = all('--name').map((n) => n.toLowerCase());
const markers = all('--gift-message');
const APPLY = args.includes('--apply');
if (!names.length) { console.error('give at least one --name'); process.exit(2); }

if (!args.includes('--allow-running')) {
  let state = 'unknown';
  try { state = execFileSync('systemctl', ['is-active', 'lateral-server'], { encoding: 'utf8' }).trim(); } catch (e) { state = String(e.stdout || 'inactive').trim(); }
  if (state === 'active' || state === 'activating') { console.error('lateral-server is running; stop it first (systemctl stop lateral-server)'); process.exit(3); }
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 5000');
const q = (sql, ...p) => db.prepare(sql).all(...p);
const ids = names.flatMap((n) => q('SELECT id FROM accounts WHERE name_lower = ?', n).map((r) => r.id));
const found = q(`SELECT name FROM accounts WHERE id IN (${ids.map(() => '?').join(',') || "''"})`, ...ids).map((r) => r.name);
console.log(`accounts matched: ${found.join(', ') || '(none)'}`);
if (!ids.length && !markers.length) { console.log('nothing to do'); process.exit(0); }
const inIds = ids.length ? ids.map(() => '?').join(',') : "''";

// gifts to remove
const giftIds = new Set();
for (const r of q(`SELECT id FROM gifts WHERE to_account IN (${inIds})`, ...ids)) giftIds.add(r.id);
for (const r of q(`SELECT DISTINCT gift_id id FROM gift_claims WHERE account_id IN (${inIds})`, ...ids)) giftIds.add(r.id);
for (const m of markers) for (const r of q('SELECT id FROM gifts WHERE message = ?', m)) giftIds.add(r.id);
const others = (gid) => q(`SELECT 1 FROM gift_claims WHERE gift_id = ? AND account_id NOT IN (${inIds}) LIMIT 1`, gid, ...ids).length > 0;
const keepGifts = [...giftIds].filter(others);
const dropGifts = [...giftIds].filter((g) => !others(g));
if (keepGifts.length) console.log(`gifts KEPT because another account claimed them: ${keepGifts.join(', ')}`);
const gin = dropGifts.length ? dropGifts.map(() => '?').join(',') : "''";

const plan = [
  ['tokens', `account_id IN (${inIds})`, ids],
  ['wallets', `account_id IN (${inIds})`, ids],
  ['ledger', `account_id IN (${inIds})`, ids],
  ['flags', `account_id IN (${inIds})`, ids],
  ['coll_rows', `account_id IN (${inIds})`, ids],
  ['gift_claims', `account_id IN (${inIds}) OR gift_id IN (${gin})`, [...ids, ...dropGifts]],
  ['gifts', `id IN (${gin})`, dropGifts],
  ['accounts', `id IN (${inIds})`, ids],
];
for (const [t, where, p] of plan) {
  const n = db.prepare(`SELECT count(*) c FROM ${t} WHERE ${where}`).get(...p).c;
  console.log(`${APPLY ? 'deleting' : 'would delete'} ${String(n).padStart(3)} from ${t}`);
}
if (!APPLY) { console.log('dry run only, nothing changed (add --apply)'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const backup = `/var/lib/lateral/backups/pre-purge-${stamp}.db`;
db.exec(`VACUUM INTO '${backup}'`);
console.log(`backup written: ${backup}`);
db.exec('BEGIN IMMEDIATE');
try {
  for (const [t, where, p] of plan) db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...p);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('rolled back:', e.message); process.exit(1); }
console.log('committed. remaining rows:');
for (const t of ['accounts', 'tokens', 'wallets', 'ledger', 'gifts', 'gift_claims', 'flags', 'coll_rows']) console.log(`  ${t}: ${db.prepare(`SELECT count(*) c FROM ${t}`).get().c}`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
// root wrote the files; hand them back to the service user so lateral-server can open them
try { execFileSync('sh', ['-c', `chown lateral:lateral ${DB}* /var/lib/lateral/backups/pre-purge-*.db 2>/dev/null; chmod 0640 ${DB}* 2>/dev/null; true`]); } catch {}
