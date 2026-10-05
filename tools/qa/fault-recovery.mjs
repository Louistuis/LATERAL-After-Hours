/** Injected failure checks on a real, static browser build; not device certification. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const url = process.env.LATERAL_URL || 'http://127.0.0.1:4173/';
const output = process.env.LATERAL_EVIDENCE_DIR || 'evidence/integration/fault-recovery';
mkdirSync(output, { recursive: true });
const identity = await (await fetch(new URL('build-manifest.json', url))).json();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const results = [];
async function check(name, action) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const errors = [], messages = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
  try {
    const evidence = await action(page, context);
    assert.deepEqual(errors, [], 'Unhandled page error');
    results.push({ name, status: 'PASS', evidence, messages, errors });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: String(error?.stack ?? error), messages, errors });
    await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {});
  } finally { await context.close(); }
}

try {
  await check('unsupported-webgl2', async (page, context) => {
    let assetRequests = 0;
    page.on('request', request => { if (/\.glb(?:\?|$)/.test(request.url())) assetRequests++; });
    await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return kind === 'webgl2' ? null : getContext.call(this, kind, ...args);
      };
    });
    await page.goto(url);
    await page.getByRole('heading', { name: 'The driving view could not start.' }).waitFor();
    assert.match(await page.locator('.boot-message').innerText(), /hardware acceleration/);
    assert.equal(await page.getByRole('button', { name: 'Reload', exact: true }).isVisible(), true);
    assert.equal(assetRequests, 0, 'Heavy assets fetched before WebGL2 capability check');
    await page.screenshot({ path: `${output}/unsupported-webgl2.png` });
    return { method: 'Injected getContext(webgl2) failure', assetRequests };
  });

  await check('asset-download-retry', async page => {
    let rejectedRequests = 0;
    await page.route('**/*.glb', async route => {
      rejectedRequests++;
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Injected local asset failure' });
    });
    await page.goto(url);
    await page.getByRole('heading', { name: 'A little further to go.' }).waitFor();
    assert.ok(rejectedRequests > 0);
    assert.equal(await page.locator('.lp-menu').count(), 0);
    await page.screenshot({ path: `${output}/asset-download-failed.png` });
    await page.unroute('**/*.glb');
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.locator('.lp-menu').waitFor();
    const before = await page.evaluate(() => window.__LATERAL_QA__.view.frame.current.position);
    await page.getByRole('button', { name: 'Drive', exact: true }).click();
    await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => window.__LATERAL_QA__.view.frame.current.position);
    const travelledM = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(travelledM > 2, 'Reload did not restore actual keyboard driving');
    await page.screenshot({ path: `${output}/asset-download-recovered.png` });
    return { method: 'Injected HTTP503 on GLB requests, removed before user Reload', rejectedRequests, travelledM };
  });

  await check('small-viewport-resize', async page => {
    await page.goto(url); await page.locator('.lp-menu').waitFor();
    await page.setViewportSize({ width: 640, height: 360 });
    await page.getByRole('button', { name: 'Drive', exact: true }).click();
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => window.__LATERAL_QA__.view.frame.current.simulationTick);
    await page.keyboard.down('KeyW'); await page.waitForTimeout(700); await page.keyboard.up('KeyW');
    const dimensions = await page.locator('canvas').evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      return { cssWidth: rect.width, cssHeight: rect.height, bufferWidth: canvas.width, bufferHeight: canvas.height,
        tick: window.__LATERAL_QA__.view.frame.current.simulationTick, stats: window.__LATERAL_BENCH__.stats };
    });
    assert.equal(dimensions.cssWidth, 640); assert.equal(dimensions.cssHeight, 360);
    assert.ok(dimensions.bufferWidth > 0 && dimensions.bufferHeight > 0);
    assert.ok(dimensions.tick > before && dimensions.stats.drawCallsAllPasses > 0);
    const pause = await page.getByRole('button', { name: 'Pause game' }).boundingBox();
    assert.ok(pause && pause.x >= 0 && pause.y >= 0 && pause.x + pause.width <= 640 && pause.y + pause.height <= 360);
    await page.screenshot({ path: `${output}/drive-640x360.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Pause game' }).click();
    await page.locator('.lp-menu').waitFor();
    return { method: 'Desktop viewport resize, not physical mobile/touch proof', ...dimensions };
  });
} finally {
  const report = { timestamp: new Date().toISOString(), identity, url, browser: browser.version(),
    harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    scope: 'Injected WebGL capability/download failures and actual desktop resize/input recovery on a private static build', results };
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(results.map(({ name, status, error }) => ({ name, status, error })), null, 2));
  await browser.close();
}
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
