// Offline audio review: renders scripted scenarios through the real PlayerAudio in headless Chromium and writes WAVs.
// nc2 only. Usage: node tools/audio-review/run.mjs [outDir] [port] [scenarioFilter]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(new URL('../..', import.meta.url).pathname);
const outDir = process.argv[2] ?? '/root/audio-review';
const port = Number(process.argv[3] ?? 8791);
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;
const executablePath = '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
mkdirSync(outDir, { recursive: true });

function wav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const stats = {};
try {
  const page = await browser.newPage();
  await page.route(/websim\.(com|ai)/, route => route.abort());
  page.on('pageerror', error => console.error('page error', error.message));
  await page.goto(`http://127.0.0.1:${port}/tools/audio-review/index.html`);
  await page.waitForFunction(() => typeof window.renderNamed === 'function');
  const names = (await page.evaluate(() => window.scenarioNames())).filter(name => !filter || filter.test(name));
  for (const name of names) {
    const started = Date.now();
    const base64 = await page.evaluate(n => window.renderNamed(n), name);
    const bytes = Buffer.from(base64, 'base64');
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    let peak = 0, sum = 0, clipped = 0;
    for (const s of samples) { const a = Math.abs(s); if (a > peak) peak = a; sum += s * s; if (a >= 0.999) clipped++; }
    const rms = Math.sqrt(sum / samples.length);
    stats[name] = { seconds: +(samples.length / 48000).toFixed(2), peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), rmsDb: +(20 * Math.log10(rms || 1e-9)).toFixed(1), clipped, renderMs: Date.now() - started };
    writeFileSync(join(outDir, `${name}.wav`), wav(samples, 48000));
    console.log(name, JSON.stringify(stats[name]));
  }
} finally {
  writeFileSync(join(outDir, 'levels.json'), JSON.stringify(stats, null, 2));
  await browser.close();
  await server.close();
}
