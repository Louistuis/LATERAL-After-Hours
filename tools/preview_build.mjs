#!/usr/bin/env node
/** Local-only static preview helper. No game is supplied by this handoff.
 * Usage: node tools/preview_build.mjs --dir dist/owner-review --port 4173 --open
 * Uses only Node built-ins. Refuses missing index.html, outside-root symlinks,
 * traversal, hidden files and directory listings. No auto-install or rebuild.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let dir = 'dist/owner-review', port = 4173, open = false;
function fail(message) { console.error(`Preview error: ${message}`); process.exit(1); }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i+1]) dir = args[++i];
  else if (args[i] === '--port' && args[i+1]) {
    const value = args[++i];
    if (!/^\d+$/.test(value)) fail('Port must be an integer from 0 to 65535.');
    port = Number(value);
  } else if (args[i] === '--open') open = true;
  else if (args[i] === '--help') {
    console.log('node tools/preview_build.mjs --dir dist/owner-review [--port 4173] [--open]');
    process.exit(0);
  } else fail(`Unknown or incomplete argument: ${args[i]}`);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('Port must be 0..65535.');
let root;
try {
  root = await fsp.realpath(path.resolve(dir));
  if (!(await fsp.stat(root)).isDirectory()) fail('Build root must be a directory.');
  const entry = await fsp.realpath(path.join(root, 'index.html'));
  if (path.relative(root, entry).startsWith('..') || !(await fsp.stat(entry)).isFile()) {
    fail('index.html must be a real file inside the build root.');
  }
} catch { fail(`No built game at ${path.resolve(dir)}. Build/deliver owner-review first.`); }
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json', '.wasm':'application/wasm', '.glb':'model/gltf-binary',
  '.gltf':'model/gltf+json', '.ktx2':'image/ktx2', '.bin':'application/octet-stream',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.avif':'image/avif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.m4a':'audio/mp4',
  '.mp4':'video/mp4', '.webm':'video/webm', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8'
};
function error(res, code, message) {
  res.writeHead(code, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
  res.end(message);
}
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET','HEAD'].includes(req.method)) { error(res,405,'Read-only preview.'); return; }
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (!['127.0.0.1','localhost'].includes(host)) { error(res,403,'Loopback host only.'); return; }
    let decoded;
    try { decoded = decodeURIComponent((req.url || '/').split('?')[0]).replaceAll('\\','/'); }
    catch { error(res,400,'Invalid URL encoding.'); return; }
    const segments = decoded.split('/').filter(Boolean);
    if (decoded.includes('\0') || segments.some(s=>s==='..'||s.startsWith('.'))) {
      error(res,403,'Path not allowed.'); return;
    }
    const relative = segments.length ? segments.join('/') : 'index.html';
    const proposed = path.resolve(root, relative);
    if (!proposed.startsWith(root + path.sep)) { error(res,403,'Outside build root.'); return; }
    let real, stat;
    try { real = await fsp.realpath(proposed); stat = await fsp.stat(real); }
    catch { error(res,404,'Build asset not found.'); return; }
    if (!real.startsWith(root + path.sep)) { error(res,403,'Outside build root.'); return; }
    if (!stat.isFile()) { error(res,404,'Directory listing disabled.'); return; }
    let logicalName = real, encoding;
    if (logicalName.endsWith('.br')) { encoding='br'; logicalName=logicalName.slice(0,-3); }
    else if (logicalName.endsWith('.gz')) { encoding='gzip'; logicalName=logicalName.slice(0,-3); }
    const headers = {
      'Content-Type':types[path.extname(logicalName).toLowerCase()] || 'application/octet-stream',
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer', 'Accept-Ranges':encoding?'none':'bytes'
    };
    if (encoding) headers['Content-Encoding']=encoding;
    let start=0, end=stat.size-1, status=200;
    if (req.headers.range && !encoding) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1]&&!match[2]) || stat.size===0) {
        res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); res.end(); return;
      }
      if (!match[1]) { const n=Number(match[2]); start=Math.max(0,stat.size-n); }
      else { start=Number(match[1]); if(match[2]) end=Math.min(Number(match[2]),end); }
      if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=stat.size) {
        res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); res.end(); return;
      }
      status=206; headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length']=stat.size===0?0:end-start+1;
    res.writeHead(status,headers);
    if (req.method==='HEAD'||stat.size===0) {res.end();return;}
    const stream=fs.createReadStream(real,{start,end});
    stream.on('error',()=>res.destroy());
    res.on('close',()=>stream.destroy());
    stream.pipe(res);
  } catch (err) {
    console.error('Preview request failed:',err.message);
    if (!res.headersSent) error(res,500,'Preview error.'); else res.destroy();
  }
});
server.on('error',err=>fail(`${err.message}. Use another --port if occupied.`));
server.listen(port,'127.0.0.1',()=>{
  const address=server.address();
  const url=`http://127.0.0.1:${address.port}/`;
  console.log(`Preview: ${url}`);
  console.log(`Serving prebuilt files only: ${root}`);
  console.log('Local machine only. Ctrl+C stops this preview. No background hosting is promised.');
  if(open){
    let command, options;
    if(process.platform==='darwin'){command='open';options=[url];}
    else if(process.platform==='win32'){command='rundll32.exe';options=['url.dll,FileProtocolHandler',url];}
    else{command='xdg-open';options=[url];}
    const child=spawn(command,options,{stdio:'ignore'});
    child.on('error',()=>console.warn(`Browser could not be opened automatically. Open ${url} manually.`));
    child.on('exit',code=>{if(code)console.warn(`Open ${url} manually in your browser.`);});
  }
});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));
