#!/usr/bin/env node
// Test helper (run on nc2): an HTTPS front for lateral.lou15.com that forwards to nginx on nc1 :80 the way cloudflared does
// (Host kept, X-Forwarded-Proto: https, CF-Connecting-IP set), including WebSocket upgrades. It lets a headless browser on nc2
// see a real https://lateral.lou15.com (secure context, correct Origin) before DNS exists: launch Chromium with
//   --host-resolver-rules="MAP lateral.lou15.com 127.0.0.1:18443" --ignore-certificate-errors
// Usage: node tls-origin-proxy.mjs [--listen=18443] [--origin=192.168.100.1:80] [--host=lateral.lou15.com]
// A throwaway self-signed certificate is created under /tmp on first use. Binds 127.0.0.1 only.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const LISTEN = Number(arg('listen', 18443));
const [O_HOST, O_PORT = '80'] = arg('origin', '192.168.100.1:80').split(':');
const HOST = arg('host', 'lateral.lou15.com');
const KEY = '/tmp/lateral-e2e.key', CRT = '/tmp/lateral-e2e.crt';
if (!fs.existsSync(CRT)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CRT, '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
}
const extra = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.' + (10 + Math.floor(Math.random() * 200)) };

const server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, (req, res) => {
  const up = http.request({ host: O_HOST, port: Number(O_PORT), path: req.url, method: req.method, headers: { ...req.headers, host: HOST, ...extra } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(up);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(O_PORT), O_HOST, () => {
    const h = { ...req.headers, host: HOST, ...extra };
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
    up.write(raw + '\r\n'); if (head?.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
server.listen(LISTEN, '127.0.0.1', () => console.log(`tls-origin-proxy: https://${HOST} -> http://${O_HOST}:${O_PORT} (listening 127.0.0.1:${LISTEN})`));
