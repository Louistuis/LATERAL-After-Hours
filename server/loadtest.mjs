/* global process, console, fetch, setTimeout, setInterval, clearInterval, performance */
// Load tester: N idle hub bots plus M lobbies of 8 bots driving car state at 12.5 Hz.
//   node server/dev.mjs --port=18486 &        (or any running server whose ADMIN_KEY you pass)
//   node server/loadtest.mjs --hub 60 --lobbies 4 --duration 30 [--url ws://127.0.0.1:18486/ws] [--api http://127.0.0.1:18486]
//        [--pid <server pid>] [--admin-key dev-admin-key] [--origin http://127.0.0.1:18486] [--json]
// Bots present a distinct X-Real-IP (the server trusts it from loopback) so the per-IP limits do not apply to the test.
// Latency is end to end: sender timestamp (Date.now in this process) to arrival at the receiving bot, so it includes this
// process's own event loop delay. The report says how busy the tester itself was.
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };
const hubBots = Number(arg('hub', 60)), lobbies = Number(arg('lobbies', 4)), duration = Number(arg('duration', 30)), warmup = Number(arg('warmup', 5));
const api = arg('api', 'http://127.0.0.1:18486'), url = arg('url', api.replace(/^http/, 'ws') + '/ws'), origin = arg('origin', api);
const adminKey = arg('admin-key', 'dev-admin-key'), serverPid = Number(arg('pid', 0)), hz = Number(arg('hz', 12.5));
const asJson = process.argv.includes('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

let ipSeq = 0;
const nextIp = () => { ipSeq++; return `10.${100 + Math.floor(ipSeq / 65025)}.${Math.floor(ipSeq / 255) % 255}.${ipSeq % 255 + 1}`; };

async function post(path, body, headers = {}) {
  const res = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function makeAccounts(count, tag) {
  const out = [];
  const run = tag + Date.now().toString(36).slice(-4);
  for (let i = 0; i < count; i += 8) {
    const batch = await Promise.all(Array.from({ length: Math.min(8, count - i) }, async (_, k) => {
      const r = await post('/api/v1/account', { name: `lt_${run}_${i + k}` }, { 'x-real-ip': nextIp() });
      if (r.status !== 201) throw new Error(`account create failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.token;
    }));
    out.push(...batch);
  }
  return out;
}

const HIST = 2001; // 1 ms buckets up to 2 s, the last bucket is "slower"
const hist = new Uint32Array(HIST);
let received = 0, sentStates = 0, connected = 0, closedEarly = 0, errors = 0, measuring = false, bytesIn = 0;
const bots = [];

function bot(token, lobby) {
  const ws = new WebSocket(url, { headers: { Origin: origin, 'X-Real-IP': nextIp() }, perMessageDeflate: false });
  const b = { ws, id: '', lobby, timer: null, seq: 0, ready: false };
  bots.push(b);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'h', token, v: 1 })));
  ws.on('message', raw => {
    const text = raw.toString();
    bytesIn += text.length;
    let f; try { f = JSON.parse(text); } catch { return; }
    if (f.t === 'w') { b.id = f.id; b.ready = true; connected++; b.onReady?.(); }
    else if (f.t === 'ping') ws.send('{"t":"pong"}');
    else if (f.t === 'err') errors++;
    else if (f.t === 'M' && f.b && measuring) {
      const now = Date.now();
      for (const [, d] of f.b) { if (d?.type === 's') { received++; const ms = Math.min(HIST - 1, Math.max(0, now - d.d[0])); hist[ms]++; } }
    }
  });
  ws.on('close', () => { if (measuring || !b.ready) closedEarly++; clearInterval(b.timer); });
  ws.on('error', () => { errors++; });
  return b;
}
const opened = b => new Promise(resolve => { if (b.ready) resolve(); else b.onReady = resolve; });
const send = (b, o) => { if (b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify(o)); };

function startDriving(b) {
  const interval = 1000 / hz;
  b.timer = setInterval(() => {
    if (b.ws.readyState !== WebSocket.OPEN) return;
    b.seq++;
    const d = [Date.now(), b.seq * 10, 0, b.seq, 0, 0, 0, 10000, 0, 0, 1500, 0, 0];
    b.ws.send(`{"t":"m","d":{"type":"s","d":[${d.join(',')}]}}`);
    if (measuring) sentStates++;
    if (b.seq % 3 === 0) b.ws.send(`{"t":"p","d":{"rp":[1,0,${b.seq},0,0],"pg":${20 + (b.seq % 7)}}}`);
  }, interval + (Math.random() * 6 - 3));
}

function cpuTicks(pid) {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const p = s.slice(s.lastIndexOf(')') + 2).split(' '); return [Number(p[11]), Number(p[12])]; } catch { return null; }
}
function rssMb(pid) { try { const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(Number(m[1]) / 1024) : null; } catch { return null; } }
const pct = q => { let total = 0; for (const c of hist) total += c; if (!total) return null; let acc = 0; for (let i = 0; i < HIST; i++) { acc += hist[i]; if (acc >= total * q) return i; } return HIST - 1; };

const stats = async () => (await (await fetch(`${api}/api/v1/admin/stats`, { headers: { 'x-admin-key': adminKey } })).json());

log(`creating ${hubBots + lobbies * 8} accounts ...`);
const tokens = await makeAccounts(hubBots + lobbies * 8, 'h');
log('connecting ...');
const hubGroup = tokens.slice(0, hubBots).map(t => bot(t, null));
const lobbyGroups = [];
for (let m = 0; m < lobbies; m++) lobbyGroups.push(tokens.slice(hubBots + m * 8, hubBots + m * 8 + 8).map(t => bot(t, `lt${m}`)));
await Promise.all(bots.map(opened));
for (const b of hubGroup) send(b, { t: 'p', d: { on: 1 } });
for (let m = 0; m < lobbies; m++) {
  const [host, ...rest] = lobbyGroups[m];
  send(host, { t: 'r', d: { lobbies: { [`lt${m}`]: { ph: 'r', race: 1, mode: 'time-trial', route: 'HW-01', at: Date.now(), t: Date.now(), rt: 0, ff: 0, g: '' } } } });
  send(host, { t: 'p', d: { on: 1, lb: `lt${m}` } });
  await new Promise(r => setTimeout(r, 100));
  for (const b of rest) send(b, { t: 'p', d: { on: 1, lb: `lt${m}` } });
}
await new Promise(r => setTimeout(r, 500));
for (const g of lobbyGroups) for (const b of g) startDriving(b);
// light hub chatter: presence changes every few seconds
const chatter = setInterval(() => { for (const b of hubGroup) if (Math.random() < 0.1) send(b, { t: 'p', d: { rd: Math.floor(Math.random() * 3) - 1 } }); }, 1000);

log(`warming up ${warmup}s, measuring ${duration}s: ${hubBots} hub bots + ${lobbies} lobbies of 8 at ${hz} Hz`);
await new Promise(r => setTimeout(r, warmup * 1000));
const before = await stats().catch(() => null);
const t0 = Date.now(), cpu0 = serverPid ? cpuTicks(serverPid) : null, self0 = process.cpuUsage();
let loopMax = 0, last = performance.now();
const lag = setInterval(() => { const n = performance.now(); loopMax = Math.max(loopMax, n - last - 20); last = n; }, 20);
hist.fill(0); received = 0; sentStates = 0; bytesIn = 0; closedEarly = 0; measuring = true;
const samples = [];
const sampler = setInterval(async () => { const s = await stats().catch(() => null); if (s) samples.push(s); }, 2000);
await new Promise(r => setTimeout(r, duration * 1000));
measuring = false;
const secs = (Date.now() - t0) / 1000;
const cpu1 = serverPid ? cpuTicks(serverPid) : null;
const selfCpu = process.cpuUsage(self0);
clearInterval(sampler); clearInterval(lag); clearInterval(chatter);
const after = await stats().catch(() => null);

const expected = lobbies * 8 * 7 * hz * secs;
const peakTickMax = Math.max(0, ...samples.map(s => s.tickMaxMs ?? 0), after?.tickMaxMs ?? 0);
const avgTick = samples.length ? samples.reduce((a, s) => a + (s.tickAvgMs ?? 0), 0) / samples.length : after?.tickAvgMs ?? null;
const report = {
  bots: { hub: hubBots, lobbies, lobbyBots: lobbies * 8, connected, closedEarly, errors },
  seconds: Math.round(secs), stateHz: hz,
  delivered: { sent: sentStates, received, expectedApprox: Math.round(expected), ratio: expected ? Math.round(received / expected * 1000) / 1000 : null, kbPerSecIn: Math.round(bytesIn / secs / 1024) },
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1) },
  server: {
    cpuPercentOfOneCore: cpu0 !== null && cpu1 !== null ? Math.round((cpu1[0] + cpu1[1] - cpu0[0] - cpu0[1]) / 100 / secs * 1000) / 10 : null,
    cpuUserPercent: cpu0 !== null && cpu1 !== null ? Math.round((cpu1[0] - cpu0[0]) / 100 / secs * 1000) / 10 : null,
    cpuSystemPercent: cpu0 !== null && cpu1 !== null ? Math.round((cpu1[1] - cpu0[1]) / 100 / secs * 1000) / 10 : null,
    rssMb: (serverPid && rssMb(serverPid)) || after?.rssMb || null, heapMb: after?.heapMb ?? null,
    tickAvgMs: avgTick === null ? null : Math.round(avgTick * 1000) / 1000, tickMaxMs: peakTickMax, droppedFrames: (after?.droppedFrames ?? 0) - (before?.droppedFrames ?? 0),
    msgsInPerSec: after?.inPerSec ?? null, msgsOutPerSec: after?.outPerSec ?? null, online: after?.online ?? null, lobbies: after?.lobbies ?? null,
  },
  tester: { cpuPercentOfOneCore: Math.round((selfCpu.user + selfCpu.system) / 1000 / secs / 10 * 10) / 10, eventLoopLagMaxMs: Math.round(loopMax) },
};
if (asJson) console.log(JSON.stringify(report));
else {
  console.log('\nresult');
  console.log(`  bots          ${connected} connected, ${closedEarly} dropped, ${errors} errors`);
  console.log(`  delivery      ${received} states received of about ${Math.round(expected)} expected (${report.delivered.ratio}), ${report.delivered.kbPerSecIn} KB/s in`);
  console.log(`  relay latency p50 ${report.latencyMs.p50} ms, p95 ${report.latencyMs.p95} ms, p99 ${report.latencyMs.p99} ms, max ${report.latencyMs.max} ms`);
  console.log(`  server        cpu ${report.server.cpuPercentOfOneCore ?? 'n/a'}% of one core (user ${report.server.cpuUserPercent}, system ${report.server.cpuSystemPercent}), rss ${report.server.rssMb} MB, tick avg ${report.server.tickAvgMs} ms, tick max ${report.server.tickMaxMs} ms, dropped frames ${report.server.droppedFrames}`);
  console.log(`  tester        cpu ${report.tester.cpuPercentOfOneCore}% of one core, event loop lag max ${report.tester.eventLoopLagMaxMs} ms (latency above includes this)`);
}
for (const b of bots) { try { b.ws.close(); } catch { /* gone */ } }
setTimeout(() => process.exit(0), 300);
