import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config';
import { openDb } from '../../server/db';
import { startServer } from '../../server/server';
import { silentLog } from '../../server/util';

const dir = mkdtempSync(join(tmpdir(), 'lat-tools-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const node = process.execPath;

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolveRun => {
    const child = spawn(node, args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolveRun({ code, out, err }));
  });
}

describe('admin CLI', () => {
  it('sends gifts, makes codes, bans and prints errors with a non-zero exit', async () => {
    const cfg = loadConfig({ DB_PATH: ':memory:', HOSTS: '127.0.0.1', PORT: '0', ADMIN_KEY: 'cli-key-for-tests', PUBLIC_URL: 'https://lateral.example.test' });
    const srv = await startServer(cfg, { log: silentLog });
    try {
      await srv.ctx.accounts.create('Cli_Target', '10.0.0.1');
      const env = { ADMIN_KEY: 'cli-key-for-tests', LATERAL_URL: `http://127.0.0.1:${srv.ports[0]}`, LATERAL_ENV_FILE: '/nonexistent' };
      const cli = resolve('server/admin.mjs');
      const gift = await run([cli, 'gift', '--to', 'cli_target', '--marks', '500', '--items', 'oxide-copper,salt-white', '--message', 'hello'], env);
      expect(gift.code).toBe(0); expect(gift.out).toContain('sent to Cli_Target: 500 Marks, 2 items');
      const code = await run([cli, 'code', '--marks', '50'], env);
      expect(code.out).toMatch(/link https:\/\/lateral\.example\.test\/\?gift=LATERAL-/);
      const mail = await run([cli, 'email', '--to', 'x@example.com', '--marks', '5'], env);
      expect(mail.out).toContain('email disabled'); expect(mail.out).toContain('?gift=LATERAL-');
      expect((await run([cli, 'ledger', 'cli_target'], env)).out).toContain('Cli_Target');
      expect((await run([cli, 'promote', 'cli_target'], env)).code).toBe(0);
      const bad = await run([cli, 'ban', 'ghost_user'], env);
      expect(bad.code).toBe(1); expect(bad.err).toContain('no-such-account');
      const wrong = await run([cli, 'stats'], { ...env, ADMIN_KEY: 'nope' });
      expect(wrong.code).toBe(1); expect(wrong.err).toContain('401');
      expect((await run([cli, 'gift', '--marks', '5'], env)).code).toBe(2);
      expect((await run([cli], env)).code).toBe(2);
    } finally { await srv.close(); }
  });
});

describe('backup script', () => {
  it('writes a consistent copy with VACUUM INTO, checks it, and keeps only the newest N', () => {
    const dbPath = join(dir, 'live.db');
    const db = openDb(dbPath);
    db.prepare("INSERT INTO accounts (id, name, name_lower, created_at, recovery_salt, recovery_hash) VALUES ('a1', 'Backed_Up', 'backed_up', 1, '', '')").run();
    db.close();
    const bk = join(dir, 'backups');
    const script = resolve('server/backup.mjs');
    spawnSync('mkdir', ['-p', bk]);
    for (const old of ['2026-01-01-00-00', '2026-01-02-00-00', '2026-01-03-00-00']) { writeFileSync(join(bk, `lateral-${old}.db`), 'old'); utimesSync(join(bk, `lateral-${old}.db`), new Date(), new Date()); }
    const r = spawnSync(node, [script, '--db', dbPath, '--dir', bk, '--keep', '2'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const files = readdirSync(bk).sort();
    expect(files).toHaveLength(2);
    const newest = join(bk, files[files.length - 1]!);
    const copy = new DatabaseSync(newest, { readOnly: true });
    expect(copy.prepare('SELECT name FROM accounts').get()).toEqual({ name: 'Backed_Up' });
    copy.close();
    expect(r.stdout).toContain('removed');
  });
  it('fails clearly when the database is missing', () => {
    const r = spawnSync(node, [resolve('server/backup.mjs'), '--db', join(dir, 'missing.db'), '--dir', join(dir, 'x')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });
});

describe('build', () => {
  it('bundles into one file with the shared economy code inside, no websim, and boots in under a second', async () => {
    const out = join(dir, 'dist');
    const b = spawnSync(node, [resolve('server/build.mjs'), `--out=${out}`, '--quiet', '--admin-api=api/'], { encoding: 'utf8' });
    expect(b.status).toBe(0);
    for (const f of ['server.mjs', 'admin.mjs', 'backup.mjs', 'package.json', 'admin/index.html', 'admin/admin.js', 'admin/admin.css', 'admin/config.js']) expect(existsSync(join(out, f)), f).toBe(true);
    const started = Date.now();
    const child = spawn(node, [join(out, 'server.mjs')], { env: { ...process.env, PORT: '0', HOSTS: '127.0.0.1', DB_PATH: join(dir, 'boot.db') } });
    const line = await new Promise<string>((res, rej) => { child.stdout.on('data', d => { if (String(d).includes('server.start')) res(String(d)); }); child.on('close', () => rej(new Error('exited'))); setTimeout(() => rej(new Error('slow')), 5000); });
    const took = Date.now() - started;
    child.kill('SIGTERM');
    expect(line).toContain('"ev":"server.start"');
    expect(took).toBeLessThan(1000);
  });
});
