/* global process, console, setTimeout, URL */
// Runs the real server bundle locally with a temp database, plus the admin page on a second port that injects the proxy
// headers the way nginx does on nc1. Usage: node server/dev.mjs [--port=18486] [--admin-port=18487] [--keep] [--db=/path]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const port = Number(arg('port', process.env.PORT || 18486));
const adminPort = Number(arg('admin-port', port + 1));
const keep = process.argv.includes('--keep');
const dir = mkdtempSync(join(tmpdir(), 'lateral-dev-'));
const dist = join(dir, 'dist');

const built = spawn(process.execPath, [join(here, 'build.mjs'), `--out=${dist}`, '--quiet'], { stdio: 'inherit' });
await new Promise((resolve, reject) => built.on('exit', c => (c === 0 ? resolve() : reject(new Error('build failed')))));

const adminKey = 'dev-admin-key';
const proxyKey = 'dev-proxy-key';
const env = {
  ...process.env, PORT: String(port), HOSTS: '127.0.0.1', DB_PATH: arg('db', join(dir, 'dev.db')), DEV: '1', ALLOW_LOCAL_ORIGINS: '1',
  PUBLIC_URL: `http://127.0.0.1:${port}`, ADMIN_KEY: adminKey, PROXY_KEY: proxyKey, ADMIN_PROXY_IPS: '127.0.0.1', TRUSTED_PROXIES: '127.0.0.1',
  ADMIN_ORIGIN: `http://127.0.0.1:${adminPort}`, ADMIN_EMAILS: 'dev@example.test', MAX_CONN_PER_IP: process.env.MAX_CONN_PER_IP || '50',
  ACCOUNTS_PER_IP_HOUR: process.env.ACCOUNTS_PER_IP_HOUR || '500', ACCOUNTS_GLOBAL_HOUR: process.env.ACCOUNTS_GLOBAL_HOUR || '2000',
};
const child = spawn(process.execPath, [join(dist, 'server.mjs')], { env, stdio: ['ignore', 'inherit', 'inherit'] });

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const adminDir = join(dist, 'admin');
const front = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/lateral-admin/api/')) {
    const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-lateral-proxy-key': proxyKey, 'x-lateral-admin-email': 'dev@example.test' };
    delete headers['x-forwarded-for'];
    const up = request({ host: '127.0.0.1', port, method: req.method, path: `/api/v1/admin/${url.pathname.slice('/lateral-admin/api/'.length)}${url.search}`, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  let rel = url.pathname.startsWith('/lateral-admin/') ? url.pathname.slice('/lateral-admin/'.length) : null;
  if (rel === null) { res.writeHead(302, { Location: '/lateral-admin/' }); res.end(); return; }
  if (rel === '' ) rel = 'index.html';
  const file = join(adminDir, rel.replace(/\.\.+/g, ''));
  if (!file.startsWith(adminDir) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
front.listen(adminPort, '127.0.0.1');

const info = { api: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, origin: `http://127.0.0.1:${port}`, admin: `http://127.0.0.1:${adminPort}/lateral-admin/`, adminKey, dir, pid: process.pid, childPid: child.pid };
console.log(`LATERAL_DEV ${JSON.stringify(info)}`);
const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } front.close(); if (!keep) setTimeout(() => { rmSync(dir, { recursive: true, force: true }); process.exit(0); }, 400); else process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', () => stop());
