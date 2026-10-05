// Smoke test of the built game's audio (nc2 only): unlock, drive, engine slider at 0, errors.
// Usage: node tools/audio-review/game-smoke.mjs http://127.0.0.1:PORT/
import { chromium } from 'playwright-core';

const url = process.argv[2];
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route(/websim\.(com|ai)/, route => route.abort());
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.addInitScript(() => {
    const probe = { contexts: [], sources: 0, engineLayers: 0, engineStops: 0, oscillators: 0, compressors: 0 };
    window.__audioProbe = probe;
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(...args) { super(...args); probe.contexts.push(this); } };
    const proto = Native.prototype;
    const createBufferSource = proto.createBufferSource;
    proto.createBufferSource = function () {
      const node = createBufferSource.call(this); probe.sources++;
      const start = node.start.bind(node), stop = node.stop.bind(node);
      node.start = (...a) => { if (node.buffer?.numberOfChannels === 3) probe.engineLayers++; return start(...a); };
      node.stop = (...a) => { if (node.buffer?.numberOfChannels === 3) probe.engineStops++; return stop(...a); };
      return node;
    };
    const createOscillator = proto.createOscillator;
    proto.createOscillator = function () { probe.oscillators++; return createOscillator.call(this); };
    const createDynamicsCompressor = proto.createDynamicsCompressor;
    proto.createDynamicsCompressor = function () { probe.compressors++; return createDynamicsCompressor.call(this); };
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('[data-action="drive"], .lp-shell', { timeout: 150000, state: 'attached' });
  await page.waitForTimeout(3000);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(1500);
  const report = async label => console.log(label, JSON.stringify(await page.evaluate(() => {
    const p = window.__audioProbe;
    return { contexts: p.contexts.length, state: p.contexts[0]?.state, sampleRate: p.contexts[0]?.sampleRate, sources: p.sources, engineLayers: p.engineLayers, engineStops: p.engineStops, oscillators: p.oscillators, compressors: p.compressors };
  })));
  await report('after unlock');
  // Start a solo event from the menu: Play, then Start (the countdown exercises the race cues).
  // First run shows the starter gift: tap through the box and the reveal, then "Let's drive".
  for (let i = 0; i < 24; i++) {
    const state = await page.evaluate(() => {
      const drive = [...document.querySelectorAll('button')].find(b => /let.s drive/i.test(b.textContent ?? '') && b.offsetParent);
      if (drive) { const r = drive.getBoundingClientRect(); return { drive: [r.x + r.width / 2, r.y + r.height / 2] }; }
      const gift = [...document.querySelectorAll('h1,h2,h3,b,strong,div')].some(node => /your starter gift/i.test(node.textContent ?? '') && node.childElementCount === 0 && node.offsetParent);
      return { gift };
    });
    if (state.drive) { await page.mouse.click(state.drive[0], state.drive[1]); await page.waitForTimeout(3000); break; }
    if (!state.gift) { if (i > 3) break; await page.mouse.click(640, 360); }
    else await page.mouse.click(640, 380);
    await page.waitForTimeout(1200);
  }
  const afterGift = await page.evaluate(() => document.querySelector('[data-action="solo"]') !== null);
  if (afterGift) {
  await page.click('[data-action="solo"]', { timeout: 10000 }).catch(error => errors.push(`solo: ${error.message.split('\n')[0]}`));
  await page.waitForTimeout(1200);
  await page.click('.lt-start:not(:disabled)', { timeout: 10000 }).catch(error => errors.push(`start: ${error.message.split('\n')[0]}`));
  await page.waitForTimeout(5000);
  }
  if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT });
  console.log('screen', JSON.stringify(await page.evaluate(() => ({ buttons: [...document.querySelectorAll('button:not([hidden])')].filter(b => b.offsetParent).slice(0, 14).map(b => (b.dataset.action ?? b.dataset.menu ?? '') + ':' + b.textContent.trim().slice(0, 24)) }))));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(800);
  await report('after driving');
  // Settings: engine slider exists and 0 tears the engine down.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  // Menu ticks: moving the pointer across two controls plays hover cues (buffer sources) through the facade.
  const beforeHover = await page.evaluate(() => window.__audioProbe.sources);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent && !b.closest('.lp-sr')).slice(-2).map(b => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
  for (const [x, y] of boxes) { await page.mouse.move(x, y, { steps: 4 }); await page.waitForTimeout(300); }
  console.log('hover cues', (await page.evaluate(() => window.__audioProbe.sources)) - beforeHover, 'over', boxes.length, 'controls');
  await page.evaluate(() => document.querySelector('[data-action="settings"]')?.click());
  await page.waitForTimeout(800);
  const slider = await page.evaluate(() => {
    const input = document.querySelector('input[data-setting="engineVolume"]');
    if (!input) return null;
    const label = input.closest('label');
    const before = { value: input.value, text: label?.textContent?.trim() };
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: label?.querySelector('output')?.textContent, valuetext: input.getAttribute('aria-valuetext') };
  });
  console.log('engine slider', JSON.stringify(slider));
  await page.waitForTimeout(800);
  await report('after engine 0');
  console.log('errors', JSON.stringify(errors.slice(0, 10)));
} finally {
  await browser.close();
}
