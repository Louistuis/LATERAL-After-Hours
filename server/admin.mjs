#!/usr/bin/env node
/* global process, console, fetch */
// LATERAL admin CLI. Talks to the local server over loopback with X-Admin-Key (never over the network).
//   node admin.mjs gift --to <name> --marks 500 --items paint-id,... --message "..."   [--expires-days N]
//   node admin.mjs code --marks 500 [--items ...] [--message ...] [--max-claims N] [--expires-days N]
//   node admin.mjs email --to someone@example.com --marks 500 --message "..."
//   node admin.mjs gift --to all-active-days:7 --marks 100
//   node admin.mjs stats | gifts | flags | accounts [query] | ledger <name>
//   node admin.mjs ban <name> [--reason "..."] | unban <name> | promote <name> | demote <name> | rename <name> <newName> | revoke <giftId>
// Environment: ADMIN_KEY (or read from /etc/lateral/server.env when readable), PORT (default 4416), LATERAL_URL (override base).
import { readFileSync } from 'node:fs';

function envFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch { return {}; }
}
const file = envFile(process.env.LATERAL_ENV_FILE || '/etc/lateral/server.env');
const key = process.env.ADMIN_KEY || file.ADMIN_KEY || '';
const port = process.env.PORT || file.PORT || '4416';
const base = process.env.LATERAL_URL || `http://127.0.0.1:${port}`;

const args = process.argv.slice(2);
const cmd = args.shift();
const flags = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const name = args[i].slice(2); const next = args[i + 1]; if (next === undefined || next.startsWith('--')) flags[name] = true; else { flags[name] = next; i++; } }
  else rest.push(args[i]);
}

async function call(method, path, body) {
  if (!key) { console.error('ADMIN_KEY is not set and /etc/lateral/server.env is not readable.'); process.exit(2); }
  const res = await fetch(`${base}/api/v1/admin/${path}`, { method, headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`error ${res.status}: ${data.error ?? ''} ${data.message ?? ''}`.trim()); process.exit(1); }
  return data;
}
const giftBody = () => {
  const b = {};
  if (flags.marks !== undefined) b.marks = Number(flags.marks);
  if (typeof flags.items === 'string') b.items = flags.items.split(',').map(s => s.trim()).filter(Boolean);
  if (typeof flags.message === 'string') b.message = flags.message;
  if (typeof flags['expires-days'] === 'string') b.expiresInDays = Number(flags['expires-days']);
  if (typeof flags['max-claims'] === 'string') b.maxClaims = Number(flags['max-claims']);
  if (typeof flags.from === 'string') b.fromLabel = flags.from;
  return b;
};
const show = data => console.log(JSON.stringify(data, null, 2));
const need = (value, what) => { if (!value) { console.error(`missing ${what}`); process.exit(2); } return value; };

switch (cmd) {
  case 'gift': {
    const out = await call('POST', 'gift', { ...giftBody(), to: need(flags.to, '--to <name>') });
    if (out.kind === 'direct') console.log(`gift ${out.gift.id} sent to ${out.gift.toName}: ${out.gift.marks} Marks, ${out.gift.items.length} items`);
    else show(out);
    break;
  }
  case 'code': {
    const out = await call('POST', 'gift', { ...giftBody(), code: true });
    console.log(`code ${out.gift.code}\nlink ${out.link}`);
    break;
  }
  case 'email': {
    const out = await call('POST', 'gift', { ...giftBody(), email: need(flags.to, '--to <address>') });
    console.log(`gift ${out.gift.id} for ${out.gift.emailMasked}: email ${out.emailStatus}\nlink ${out.link}\n\n${out.message.subject}\n\n${out.message.text}`);
    break;
  }
  case 'stats': show(await call('GET', 'stats')); break;
  case 'gifts': {
    const out = await call('GET', 'gifts');
    for (const g of out.gifts) console.log(`${g.id}  ${g.state.padEnd(8)} ${g.kind.padEnd(6)} ${String(g.marks).padStart(6)}M ${g.items.length}i  to ${g.toName ?? g.emailMasked ?? g.code ?? '-'}  claimed by ${g.claimedBy.join(',') || '-'}`);
    break;
  }
  case 'flags': show(await call('GET', 'flags')); break;
  case 'accounts': {
    const out = await call('GET', `accounts?q=${encodeURIComponent(rest[0] ?? '')}`);
    for (const a of out.accounts) console.log(`${a.name.padEnd(16)} ${a.admin ? 'admin ' : '      '}${a.banned ? 'BANNED' : ''}  last seen ${a.lastSeen ? new Date(a.lastSeen).toISOString() : '-'}`);
    break;
  }
  case 'ledger': {
    const out = await call('GET', `ledger?name=${encodeURIComponent(need(rest[0], '<name>'))}`);
    console.log(`${out.account.name}: balance ${out.balance ?? 'no wallet'}, owns ${out.owned.length} items`);
    for (const l of out.ledger) console.log(`${new Date(l.ts).toISOString()}  ${l.kind.padEnd(34)} ${String(l.amount).padStart(7)}  ${l.ref}`);
    break;
  }
  case 'ban': show(await call('POST', `account/${need(rest[0], '<name>')}/ban`, { reason: typeof flags.reason === 'string' ? flags.reason : '' })); break;
  case 'unban': case 'promote': case 'demote': show(await call('POST', `account/${need(rest[0], '<name>')}/${cmd}`, {})); break;
  case 'rename': show(await call('POST', `account/${need(rest[0], '<name>')}/rename`, { newName: need(rest[1], '<newName>') })); break;
  case 'revoke': show(await call('POST', `gift/${need(rest[0], '<giftId>')}/revoke`, {})); break;
  default:
    console.error('usage: admin.mjs gift|code|email|stats|gifts|flags|accounts|ledger|ban|unban|promote|demote|rename|revoke ...  (see the header of this file)');
    process.exit(2);
}
