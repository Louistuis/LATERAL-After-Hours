#!/usr/bin/env node
// Local stand-in for the nginx vhost of lateral.lou15.com, for the browser tests only:
//   - serves a built selfhost directory with the contract Content-Security-Policy on every response
//   - proxies /api/ and the /ws upgrade to a local game server (node server/dev.mjs)
// Usage: node tools/selfhost/e2e/serve.mjs --dist=/root/lateral-build-selfhost/selfhost --port=18590 --api=18586 [--csp=PATH]
// Binds 127.0.0.1 only. Prints `SERVE {json}` when it listens.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const arg = (name, fallback) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const dist = arg('dist', '');
const port = Number(arg('port', '18590'));
const apiPort = Number(arg('api', '18586'));
if (!dist || !existsSync(join(dist, 'index.html'))) { console.error('serve: --dist must contain index.html'); process.exit(2); }

// The policy of the contract (SELFHOST-CONTRACT.md) plus 'wasm-unsafe-eval' in script-src: the Rapier physics module is
// WebAssembly and the browser refuses to compile it without that token (probed: pass --contract-csp to see it fail).
// Nothing else was needed. Hand this exact string to the nginx vhost.
const wasmEval = process.argv.includes('--contract-csp') ? '' : " 'wasm-unsafe-eval'";
export const CSP = arg('csp', `default-src 'self'; script-src 'self'${wasmEval}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://lateral.lou15.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ktx2': 'image/ktx2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.bin': 'application/octet-stream' };
const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const up = request({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, r => { res.writeHead(r.statusCode ?? 502, { ...r.headers, ...headers }); r.pipe(res); });
    up.on('error', () => { res.writeHead(502, headers); res.end('{"ok":false,"error":"bad-gateway"}'); });
    req.pipe(up);
    return;
  }
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  let file = join(dist, rel);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { if (extname(rel) === '') file = join(dist, 'index.html'); else { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); res.end('not found'); return; } }
  res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
server.on('upgrade', (req, socket, head) => {
  if (!String(req.url).startsWith('/ws')) { socket.destroy(); return; }
  const upstream = connect(apiPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i].toLowerCase() === 'host' ? `127.0.0.1:${apiPort}` : req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(port, '127.0.0.1', () => console.log(`SERVE ${JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid })}`));
const stop = () => { server.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
