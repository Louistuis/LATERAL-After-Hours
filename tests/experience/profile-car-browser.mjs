/** Exact pinned owner-review diagnostic for the Garage sandbox/car transition. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = process.env.LATERAL_URL;
const artifactRoot = process.env.LATERAL_ARTIFACT_ROOT;
const output = resolve(process.env.S3_PROFILE_EVIDENCE_DIR ?? 'evidence/S3/profile-car-pinned-53');
if (!url || !artifactRoot) throw new Error('Set LATERAL_URL and LATERAL_ARTIFACT_ROOT to an exact pinned owner-review build');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(artifactRoot, 'build-manifest.json'), 'utf8'));
const indexHash = createHash('sha256').update(await readFile(resolve(artifactRoot, 'index.html'))).digest('hex');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const s2PadMode = process.env.S3_FAKE_PAD === '1';
if (s2PadMode) await context.addInitScript(() => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { connected: true, buttons, axes: [0, 0, 0, 0], id: 'S2 visual QA controller', index: 0, mapping: 'standard', timestamp: 1 };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
  window.__S2_PAD__ = pad;
});
const page = await context.newPage();
const errors = [], warnings = [], failedRequests = [], steps = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.type() === 'warning') warnings.push(message.text()); });
page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await page.addInitScript(() => {
  window.__S3_UI_EVENTS__ = [];
  for (const type of ['click', 'change']) document.addEventListener(type, event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.lp-garage,.owner-tools')) return;
    window.__S3_UI_EVENTS__.push({ atMs: performance.now(), type, tag: target.tagName,
      action: target.dataset.action ?? null, select: target.dataset.select ?? null,
      value: 'value' in target ? target.value : null, trusted: event.isTrusted });
  }, true);
});
async function capture(label) {
  const state = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('select[data-select="car"]')].map(node => ({
      container: node.closest('.lp-garage') ? 'garage' : node.closest('.owner-tools') ? 'owner-tools' : 'other',
      value: node.value, options: [...node.options].map(option => ({ value: option.value, disabled: option.disabled, selected: option.selected })),
    }));
    const saved = Object.keys(localStorage).sort().map(key => {
      try { const item = JSON.parse(localStorage.getItem(key)); return { key, profile: item.profile ?? null, car: item.selection?.car ?? null }; }
      catch { return { key, profile: null, car: null }; }
    });
    return { atMs: performance.now(), garageVisible: Boolean(document.querySelector('.lp-garage')),
      profileToggle: document.querySelector('.lp-garage [data-action="profile"]')?.textContent?.trim() ?? null,
      ownerProfile: document.querySelector('.owner-tools [data-select="profile"]')?.value ?? null,
      carSelects: selects, error: document.querySelector('.lp-error')?.textContent ?? null,
      qa: window.__LATERAL_QA__ ? { carId: window.__LATERAL_QA__.view.carId, paused: window.__LATERAL_QA__.view.paused,
        presentation: window.__LATERAL_QA__.view.presentation, mode: window.__LATERAL_QA__.view.mode } : null,
      saved, events: [...(window.__S3_UI_EVENTS__ ?? [])] };
  });
  steps.push({ label, ...state });
  await page.screenshot({ path: resolve(output, `${String(steps.length).padStart(2, '0')}-${label}.png`) });
  return state;
}
let result = 'INCOMPLETE', failure = null;
try {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const servedIndexHash = createHash('sha256').update(await response.body()).digest('hex');
  if (servedIndexHash !== indexHash) throw new Error('Served index differs from pinned artifact');
  await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
  await capture('menu');
  await page.getByRole('button', { name: 'Garage', exact: true }).click();
  await page.locator('.lp-garage').waitFor();
  await capture('garage-career');
  const switchButton = page.locator('.lp-garage [data-action="profile"]');
  if ((await switchButton.textContent())?.includes('sandbox')) await switchButton.click();
  await page.getByRole('button', { name: 'Switch to career', exact: true }).waitFor({ timeout: 20_000 });
  await capture('sandbox-label');
  await page.waitForTimeout(700);
  await capture('sandbox-settled');
  await page.locator(s2PadMode ? 'select[data-select="car"]' : '.lp-garage select[data-select="car"]').selectOption('CAR-02');
  await capture('car-change-event');
  await page.waitForTimeout(1200);
  const after = await capture('car-settled');
  if (after.qa?.carId !== 'CAR-02') {
    await page.getByRole('button', { name: 'Owner tools', exact: true }).click();
    await capture('owner-inspect-after-failure');
  }
  result = after.qa?.carId === 'CAR-02' ? 'CAR02_SELECTED' : 'CAR02_REJECTED';
} catch (error) { failure = String(error?.stack ?? error); result = 'PROBE_ERROR'; }
finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ result, failure, s2PadMode, url, artifactRoot, manifest, indexHash,
    browser: browser.version(), steps, errors, warnings, failedRequests }, null, 2) + '\n');
  await context.close(); await browser.close();
}
console.log(JSON.stringify({ result, failure, steps: steps.map(step => ({ label: step.label, profileToggle: step.profileToggle,
  ownerProfile: step.ownerProfile, car: step.qa?.carId, error: step.error })), errors, warnings, failedRequests }, null, 2));
if (result === 'PROBE_ERROR') process.exitCode = 1;
