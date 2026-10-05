// Times cold buffer generation in headless Chromium (nc2 only). Usage: node tools/audio-review/bench.mjs [port]
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = resolve(new URL('../..', import.meta.url).pathname);
const port = Number(process.argv[2] ?? 8791);
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.route(/websim\.(com|ai)/, route => route.abort());
  await page.goto(`http://127.0.0.1:${port}/tools/audio-review/index.html`);
  await page.waitForFunction(() => typeof window.benchGeneration === 'function');
  const times = await page.evaluate(() => window.benchGeneration());
  console.log(JSON.stringify(times, null, 1));
  console.log('total ms', Object.values(times).reduce((a, b) => a + b, 0).toFixed(1), 'max ms', Math.max(...Object.values(times)));
  console.log('update cost', JSON.stringify(await page.evaluate(() => window.benchUpdate())));
} finally { await browser.close(); await server.close(); }
