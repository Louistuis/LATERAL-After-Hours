#!/usr/bin/env node
/** Bounded browser checks against the built private owner-review artifact. No portal or device claims. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const artifactRoot = path.resolve(process.env.L6_E2E_ARTIFACT_ROOT ?? 'dist');
const ownerArtifact = path.join(artifactRoot, 'owner-review');
const standaloneArtifact = path.join(artifactRoot, 'standalone');
const externalOwnerURL = process.env.L6_E2E_BASE_URL;
const preview = externalOwnerURL ? undefined : spawn(process.execPath, ['tools/preview_build.mjs', '--dir', ownerArtifact, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
const baseURL = externalOwnerURL ?? await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Preview did not start: ${output}`)), 10_000);
  preview.stdout.on('data', chunk => {
    output += chunk.toString();
    const match = /Preview: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  preview.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${output}`)); });
});

const failures = [];
const results = [];
const contexts = new Set();
const onlyCases = new Set((process.env.L6_E2E_CASES ?? '').split(',').map(value => value.trim()).filter(Boolean));
const newContext = async options => { const context = await browser.newContext(options); contexts.add(context); return context; };
const report = async (name, run) => {
  if (onlyCases.size && ![...onlyCases].some(selector => name.toLowerCase().includes(selector.toLowerCase()))) {
    results.push({ name, result: 'SKIP', reason: 'not selected by L6_E2E_CASES' }); return;
  }
  try { await run(); results.push({ name, result: 'PASS' }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push({ name, error: String(error?.stack ?? error) }); results.push({ name, result: 'FAIL', error: String(error) }); process.stdout.write(`FAIL ${name}: ${String(error)}\n`); }
  finally { const pending = [...contexts]; contexts.clear(); await Promise.all(pending.map(context => context.close().catch(() => {}))); }
};
const expectedBrowser = chromium.executablePath();
const cachedBrowsers = path.join(process.env.HOME ?? '/root', '.cache/ms-playwright');
const fallbackBrowser = readdirSync(cachedBrowsers).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(name => path.join(cachedBrowsers, name, 'chrome-linux64/chrome')).find(existsSync);
const systemBrowser = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const browserPath = process.env.L6_CHROMIUM_EXECUTABLE ?? systemBrowser ?? (existsSync(expectedBrowser) ? expectedBrowser : fallbackBrowser);
const browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] });
let webglRenderer = 'unobserved';
const captureWebGLRenderer = async page => {
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  if (typeof renderer === 'string' && renderer) webglRenderer = renderer;
};
const expectProfileValue = async (page, expected) => page.waitForFunction(value =>
  document.querySelector('.owner-tools select[data-select="profile"]')?.value === value, expected);
const profileStorageKey = profile => `lateral:save:v1:owner-review:lateral:owner-review:${profile}:v1`;
const waitForSavedCameraSettings = async (page, profile, expected) => page.waitForFunction(({ storageKey, fov, shake, reduced }) => {
  try {
    const settings = JSON.parse(localStorage.getItem(storageKey) ?? 'null')?.settings;
    return settings?.['experience.cameraFovDeg'] === fov &&
      settings?.['experience.cameraShakeEnabled'] === shake &&
      settings?.['experience.reducedMotion'] === reduced;
  } catch { return false; }
}, { storageKey: profileStorageKey(profile), fov: expected.fov, shake: expected.shake, reduced: expected.reduced });
const waitForCameraControls = async (page, expected) => page.waitForFunction(({ fov, shake, reduced }) => {
  const fovInput = document.querySelector('input[data-setting="cameraFovDeg"]');
  const shakeInput = document.querySelector('input[data-setting="cameraShakeEnabled"]');
  const reducedInput = document.querySelector('input[data-setting="reducedMotion"]');
  return fovInput?.value === String(fov) && shakeInput?.checked === shake && reducedInput?.checked === reduced;
}, expected);
const setCameraFov = async (page, value) => page.locator('input[data-setting="cameraFovDeg"]').evaluate((input, value) => {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
try {
  await report('owner report textarea retains focus; local bug report includes allowlisted settings', async () => {
    const context = await newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await captureWebGLRenderer(page);
    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    const textarea = page.locator('textarea[data-report-field="description"]');
    const reportText = 'continuous typing while runtime diagnostics update; token=private https://private.invalid/item';
    await textarea.fill(reportText);
    await page.waitForTimeout(900);
    if (!(await textarea.evaluate(el => el === document.activeElement))) throw new Error('Textarea lost focus after owner panel re-render');
    if (await textarea.inputValue() !== reportText) throw new Error('Textarea draft was not preserved');
    await page.locator('textarea[data-report-field="reproductionSteps"]').fill('Tap drive; token=private https://private.invalid/item');
    await page.locator('textarea[data-report-field="expected"]').fill('Expected stable input');
    await page.locator('textarea[data-report-field="observed"]').fill('Observed issue');
    await page.locator('.owner-tools [data-action="preview-bug-report"]').click({ force: true });
    const preview = page.locator('textarea[aria-label="Exact report JSON preview"]');
    await preview.waitFor();
    const previewPayload = JSON.parse(await preview.inputValue());
    if (previewPayload.automaticUpload !== false || !previewPayload.settings || typeof previewPayload.settings.keyboardBindings !== 'string') throw new Error('Preview omitted allowlisted settings or upload-off marker');
    const previewText = await preview.inputValue();
    if (previewText.includes('private.invalid') || previewText.includes('token=private') || !previewText.includes('[url]') || !previewText.includes('token=[redacted]')) throw new Error('Preview did not redact URL/secret sentinels');
    await textarea.fill('edited after preview');
    if (await preview.count()) throw new Error('Editing did not invalidate the preview');
    await page.locator('.owner-tools [data-action="preview-bug-report"]').click({ force: true });
    await preview.waitFor();
    await page.locator('.owner-tools [data-action="cancel-bug-report"]').click({ force: true });
    if (await preview.count()) throw new Error('Cancel left a reviewed preview active');
    await page.locator('.owner-tools [data-action="preview-bug-report"]').click({ force: true });
    await preview.waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.owner-tools [data-action="download-bug-report"]').click({ force: true });
    const download = await downloadPromise;
    const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
    if (payload.automaticUpload !== false || !payload.settings || typeof payload.settings.keyboardBindings !== 'string') throw new Error('Downloaded bug report omitted allowlisted settings or upload-off marker');
    await context.close();
  });

  await report('camera settings persist independently per profile and report download matches its preview', async () => {
    const context = await newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await captureWebGLRenderer(page);

    await page.locator('.lp-menu button[data-action="settings"]').click({ force: true });
    await page.getByRole('region', { name: 'Settings' }).waitFor();
    await waitForCameraControls(page, { fov: 58, shake: false, reduced: false });
    await setCameraFov(page, 66);
    await page.locator('input[data-setting="cameraShakeEnabled"]').check();
    await page.locator('input[data-setting="reducedMotion"]').check();
    await waitForSavedCameraSettings(page, 'career', { fov: 66, shake: true, reduced: true });
    await waitForCameraControls(page, { fov: 66, shake: true, reduced: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await page.locator('.lp-menu button[data-action="settings"]').click({ force: true });
    await page.getByRole('region', { name: 'Settings' }).waitFor();
    await waitForCameraControls(page, { fov: 66, shake: true, reduced: true });

    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools select[data-select="profile"]').selectOption('sandbox');
    await expectProfileValue(page, 'sandbox');
    await waitForSavedCameraSettings(page, 'sandbox', { fov: 58, shake: false, reduced: false });
    await page.locator('.owner-tools .ot-toggle').click({ force: true });
    await page.locator('.lp-garage button[data-action="settings"]').click({ force: true });
    await waitForCameraControls(page, { fov: 58, shake: false, reduced: false });
    await setCameraFov(page, 72);
    await waitForSavedCameraSettings(page, 'sandbox', { fov: 72, shake: false, reduced: false });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools select[data-select="profile"]').selectOption('sandbox');
    await expectProfileValue(page, 'sandbox');
    await waitForSavedCameraSettings(page, 'sandbox', { fov: 72, shake: false, reduced: false });
    await page.locator('.owner-tools .ot-toggle').click({ force: true });
    await page.locator('.lp-garage button[data-action="settings"]').click({ force: true });
    await waitForCameraControls(page, { fov: 72, shake: false, reduced: false });

    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools select[data-select="profile"]').selectOption('career');
    await expectProfileValue(page, 'career');
    await waitForSavedCameraSettings(page, 'career', { fov: 66, shake: true, reduced: true });
    const sandboxSettings = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).settings, profileStorageKey('sandbox'));
    if (sandboxSettings['experience.cameraFovDeg'] !== 72 || sandboxSettings['experience.cameraShakeEnabled'] !== false || sandboxSettings['experience.reducedMotion'] !== false) {
      throw new Error('Career settings change altered the isolated sandbox camera preferences');
    }
    await page.locator('.owner-tools .ot-toggle').click({ force: true });
    await page.locator('.lp-garage button[data-action="settings"]').click({ force: true });
    await waitForCameraControls(page, { fov: 66, shake: true, reduced: true });

    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools textarea[data-report-field="description"]').fill('Camera settings save and restore check');
    await page.locator('.owner-tools [data-action="preview-bug-report"]').click({ force: true });
    const preview = page.locator('textarea[aria-label="Exact report JSON preview"]');
    await preview.waitFor();
    const previewText = await preview.inputValue();
    const previewPayload = JSON.parse(previewText);
    const expectedSettingKeys = [
      'masterVolume', 'musicVolume', 'sfxVolume', 'muted', 'reducedMotion', 'cameraFovDeg', 'cameraShakeEnabled',
      'uiScale', 'ghostVisible', 'keyboardBindings', 'gamepadBindings',
    ];
    if (JSON.stringify(Object.keys(previewPayload.settings)) !== JSON.stringify(expectedSettingKeys)) throw new Error('Report preview settings keys/order differ from the approved allowlist');
    if (previewPayload.settings.cameraFovDeg !== 66 || previewPayload.settings.cameraShakeEnabled !== true || previewPayload.settings.reducedMotion !== true) {
      throw new Error('Report preview did not include the active career camera and reduced-motion preferences');
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.owner-tools [data-action="download-bug-report"]').click({ force: true }),
    ]);
    const downloadedText = await readFile(await download.path(), 'utf8');
    if (downloadedText !== previewText) throw new Error('Downloaded report bytes differ from the reviewed exact preview');
    const downloaded = JSON.parse(downloadedText);
    if (downloaded.automaticUpload !== false) throw new Error('Downloaded bug report enabled automatic upload');
    await context.close();
  });

  await report('keyboard/menu pause and photo/replay presentations keep simulation frozen; context event is synthetic', async () => {
    const context = await newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await captureWebGLRenderer(page);
    await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2_000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    let tick = await page.evaluate(() => window.__LATERAL_BENCH__.tick);
    await page.waitForTimeout(350);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) !== tick) throw new Error('Simulation advanced while menu-paused');
    await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true });
    await page.waitForTimeout(350);
    // Synthetic WebGL event coverage only; a physical GPU context-loss path is not claimed.
    await page.locator('canvas').evaluate(canvas => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
    await page.waitForTimeout(250);
    tick = await page.evaluate(() => window.__LATERAL_BENCH__.tick);
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) !== tick) throw new Error('Simulation advanced with graphics context lost');
    await page.locator('canvas').evaluate(canvas => canvas.dispatchEvent(new Event('webglcontextrestored')));
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools [data-action="replay"]').click({ force: true });
    await page.getByRole('heading', { name: 'Replay' }).waitFor();
    tick = await page.evaluate(() => window.__LATERAL_BENCH__.tick);
    await page.waitForTimeout(350);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) !== tick) throw new Error('Simulation advanced in replay mode');
    await page.getByRole('button', { name: 'Return to drive' }).click({ force: true });
    await page.getByRole('button', { name: 'Pause game' }).click({ force: true });
    const ownerPanel = page.locator('.owner-tools');
    if (!(await ownerPanel.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    await page.locator('.owner-tools [data-action="photo"]').click({ force: true });
    await page.getByRole('heading', { name: 'Photo mode' }).waitFor();
    tick = await page.evaluate(() => window.__LATERAL_BENCH__.tick);
    await page.waitForTimeout(350);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) !== tick) throw new Error('Simulation advanced in photo mode');
    await context.close();
  });

  await report('simulated gamepad pause and resume edges plus synthetic touch pointercancel are software-only', async () => {
    const context = await newContext({ viewport: { width: 800, height: 600 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
      const pad = { connected: true, buttons, axes: [0, 0, 0, 0], id: 'L6 simulated pad', index: 0, mapping: 'standard', timestamp: 1, vibrationActuator: null };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
      window.__L6_SIMULATED_PAD__ = pad;
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true });
    await page.evaluate(() => { window.__L6_SIMULATED_PAD__.buttons[9].pressed = true; });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 5_000 });
    await page.evaluate(() => { window.__L6_SIMULATED_PAD__.buttons[9].pressed = false; });
    const pausedTick = await page.evaluate(() => window.__LATERAL_BENCH__.tick);
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) !== pausedTick) throw new Error('Gamepad-paused simulation advanced');
    await page.evaluate(() => { window.__L6_SIMULATED_PAD__.buttons[9].pressed = true; });
    await page.getByRole('button', { name: 'Pause game' }).waitFor({ timeout: 5_000 });
    await page.evaluate(() => { window.__L6_SIMULATED_PAD__.buttons[9].pressed = false; });
    await page.waitForTimeout(350);
    if (await page.evaluate(() => window.__LATERAL_BENCH__.tick) <= pausedTick) throw new Error('Second simulated gamepad edge did not resume simulation');
    await page.locator('.lateral-touch-controls [data-control="throttle"]').waitFor();
    const gas = page.locator('.lateral-touch-controls [data-control="throttle"]');
    await gas.evaluate(button => {
      button.setPointerCapture = () => {};
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', buttons: 1 }));
      if (!button.classList.contains('is-pressed')) throw new Error('Simulated touch down did not engage');
      button.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
      if (button.classList.contains('is-pressed')) throw new Error('Pointer cancellation did not release touch input');
    });
    await context.close();
  });

  await report('custom tune restored from the career save is cleared by owner export-confirmed factory reset', async () => {
    const context = await newContext();
    await context.addInitScript(() => {
      if (window.sessionStorage.getItem('L6_CUSTOM_TUNE_FIXTURE_SEEDED') === 'yes') return;
      window.sessionStorage.setItem('L6_CUSTOM_TUNE_FIXTURE_SEEDED', 'yes');
      const save = {
        schemaVersion: 1, revision: 1, updatedAtIso: new Date().toISOString(), garageCredits: 0,
        selectedCar: 'CAR-01', unlockedCars: ['CAR-01'], bestResults: [],
        settings: {
          'profile.profile': 'career', 'profile.route': 'HW-01', 'profile.tune': 'Balanced',
          'profile.lighting': 'golden-hour', 'profile.quality': 'balanced',
          'profile.customTune.id': 'Custom', 'profile.customTune.frontMuScale': 1.03,
          'profile.customTune.rearMuScale': 1.12, 'profile.customTune.springScale': 0.96,
          'profile.customTune.steeringScale': 1.04, 'profile.customTune.engineScale': 1,
          'profile.customTune.handbrakeRearMuScale': 0.3,
        }, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [],
      };
      localStorage.setItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1', JSON.stringify(save));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    await page.getByRole('button', { name: 'Garage' }).click({ force: true });
    const quality = page.locator('.lp-garage select[data-select="quality"]');
    await quality.selectOption('auto');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1')).settings['profile.quality'] === 'auto');
    const loadedTune = await page.locator('.lp-garage .lp-tuning summary').innerText();
    if (!/custom/i.test(loadedTune)) throw new Error(`Saved custom tune did not restore; Settings reports ${loadedTune}`);
    await page.locator('.lp-garage [data-tune="frontMuScale"]').evaluate(input => {
      input.value = '1.09'; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1')).settings['profile.customTune.frontMuScale'] === 1.09);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    await page.getByRole('button', { name: 'Garage' }).click({ force: true });
    if (await page.locator('.lp-garage select[data-select="quality"]').inputValue() !== 'auto') throw new Error('Auto quality selection did not restore');
    if (!(await page.locator('.lp-garage .lp-tuning summary').innerText()).toLowerCase().includes('custom')) throw new Error('Custom tune did not restore after page reload');
    if (await page.locator('.lp-garage [data-tune="frontMuScale"]').inputValue() !== '1.09') throw new Error('Custom tune edit did not survive reload');
    await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.owner-tools [data-action="save-export"]').click({ force: true });
    await downloadPromise;
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.owner-tools [data-action="reset-career"]').click({ force: true });
    await page.locator('.lp-garage').waitFor();
    const resetTune = await page.locator('.lp-garage .lp-tuning summary').innerText();
    if (!/using balanced/i.test(resetTune)) throw new Error(`Factory reset did not restore preset tune; Garage reports ${resetTune}`);
    const savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1')).settings);
    if (Object.keys(savedSettings).some(key => key.startsWith('profile.customTune.'))) throw new Error('Factory reset retained custom tune settings');
    await context.close();
  });

  await report('session-only denial remains playable and future saves are preserved without overwrite', async () => {
    const denied = await newContext();
    await denied.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (String(key).startsWith('lateral:save:')) throw new DOMException('denied by e2e', 'SecurityError'); return original.call(this, key, value); };
    });
    const page = await denied.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByText(/stored for this browser session only/i).first().waitFor();
    await denied.close();

    const future = await newContext();
    const futureRaw = JSON.stringify({ schemaVersion: 99 });
    await future.addInitScript(raw => {
      if (window.sessionStorage.getItem('L6_FUTURE_FIXTURE_SEEDED') === 'yes') return;
      window.sessionStorage.setItem('L6_FUTURE_FIXTURE_SEEDED', 'yes');
      localStorage.setItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1', raw);
    }, futureRaw);
    const futurePage = await future.newPage();
    futurePage.setDefaultTimeout(20_000);
    await futurePage.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await futurePage.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await futurePage.locator('.lateral-boot:not([hidden]) .boot-message').waitFor({ timeout: 60_000 });
    await futurePage.getByRole('heading', { name: 'Your save needs a newer game version.' }).waitFor();
    const downloadPromise = futurePage.waitForEvent('download');
    await futurePage.getByRole('button', { name: 'Download stored save' }).click();
    const rawBackup = await downloadPromise;
    if (await readFile(await rawBackup.path(), 'utf8') !== futureRaw) throw new Error('Recovery download did not preserve the exact stored save bytes');
    if (await futurePage.evaluate(() => localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1')) !== futureRaw) throw new Error('Raw backup action changed stored future save');
    await futurePage.getByRole('button', { name: 'Play for this session' }).click();
    await futurePage.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await futurePage.getByRole('button', { name: 'Garage' }).click({ force: true });
    await futurePage.locator('.lp-garage select[data-select="quality"]').selectOption('auto');
    await futurePage.waitForTimeout(200);
    if (await futurePage.locator('.lp-garage select[data-select="quality"]').inputValue() !== 'auto') throw new Error('Session-only setting did not apply in the recovered profile');
    if (await futurePage.evaluate(() => localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1')) !== futureRaw) throw new Error('Session-only play overwrote the future save');
    await futurePage.reload({ waitUntil: 'domcontentloaded' });
    await futurePage.getByRole('heading', { name: 'Your save needs a newer game version.' }).waitFor({ timeout: 60_000 });
    const stored = await futurePage.evaluate(() => localStorage.getItem('lateral:save:v1:owner-review:lateral:owner-review:career:v1'));
    if (stored !== futureRaw) throw new Error('Future save was overwritten after reload');
    await future.close();
  });

  await report('corrupt save recovery downloads exact bytes and session play does not overwrite after reload', async () => {
    const context = await newContext();
    const corruptRaw = '{ damaged save token=private https://private.invalid/keep-exactly }';
    const key = 'lateral:save:v1:owner-review:lateral:owner-review:career:v1';
    await context.addInitScript(({ key: storageKey, raw }) => {
      if (window.sessionStorage.getItem('L6_CORRUPT_FIXTURE_SEEDED') === 'yes') return;
      window.sessionStorage.setItem('L6_CORRUPT_FIXTURE_SEEDED', 'yes');
      localStorage.setItem(storageKey, raw);
    }, { key, raw: corruptRaw });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'This save could not be read.' }).waitFor({ timeout: 60_000 });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download stored save' }).click();
    const backup = await downloadPromise;
    if (await readFile(await backup.path(), 'utf8') !== corruptRaw) throw new Error('Corrupt recovery download changed the exact stored bytes');
    if (await page.evaluate(storageKey => localStorage.getItem(storageKey), key) !== corruptRaw) throw new Error('Corrupt backup action changed localStorage');
    await page.getByRole('button', { name: 'Play for this session' }).click();
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Garage' }).click({ force: true });
    await page.locator('.lp-garage select[data-select="quality"]').selectOption('auto');
    await page.waitForTimeout(200);
    if (await page.evaluate(storageKey => localStorage.getItem(storageKey), key) !== corruptRaw) throw new Error('Session-only setting overwrote corrupt stored bytes');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'This save could not be read.' }).waitFor({ timeout: 60_000 });
    if (await page.evaluate(storageKey => localStorage.getItem(storageKey), key) !== corruptRaw) throw new Error('Reload after session-only play replaced corrupt stored bytes');
    await context.close();
  });

  for (const scenario of [
    { code: 'future-version', raw: JSON.stringify({ schemaVersion: 99 }), safeCopy: 'newer game version' },
    { code: 'corrupt', raw: 'not-json sandbox payload that must be preserved byte for byte', safeCopy: 'damaged and could not be validated' },
  ]) {
    await report(`owner sandbox ${scenario.code} recovery keeps career active and preserves saved bytes`, async () => {
      const context = await newContext();
      const careerKey = 'lateral:save:v1:owner-review:lateral:owner-review:career:v1';
      const sandboxKey = 'lateral:save:v1:owner-review:lateral:owner-review:sandbox:v1';
      const careerEnvelope = {
        schemaVersion: 1, revision: 1, updatedAtIso: new Date().toISOString(), garageCredits: 0,
        selectedCar: 'CAR-01', unlockedCars: ['CAR-01'], bestResults: [],
        settings: {
          'profile.profile': 'career', 'profile.route': 'HW-01', 'profile.tune': 'Balanced',
          'profile.lighting': 'golden-hour', 'profile.quality': 'balanced',
        },
        cosmetics: {}, appliedRewardOperationIds: [], ghosts: [],
      };
      const seedMarker = `L6_SANDBOX_FIXTURE_SEEDED_${scenario.code}`;
      await context.addInitScript(({ careerStorageKey, sandboxStorageKey, careerSave, sandboxRaw, marker }) => {
        if (window.sessionStorage.getItem(marker) === 'yes') return;
        window.sessionStorage.setItem(marker, 'yes');
        localStorage.setItem(careerStorageKey, JSON.stringify(careerSave));
        localStorage.setItem(sandboxStorageKey, sandboxRaw);
      }, { careerStorageKey: careerKey, sandboxStorageKey: sandboxKey, careerSave: careerEnvelope, sandboxRaw: scenario.raw, marker: seedMarker });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
      await captureWebGLRenderer(page);
      await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
      const recovery = page.locator('.owner-tools .ot-recovery');
      await recovery.waitFor();
      await page.locator('.owner-tools textarea[data-report-field="description"]').fill(`sandbox recovery report draft ${scenario.code}`);
      const profile = page.locator('.owner-tools select[data-select="profile"]');
      await profile.selectOption('sandbox');
      await page.locator('.owner-tools .ot-recovery[data-recovery-status="recovery-required"]').waitFor();
      await page.locator('.owner-tools [role="alert"]').first().waitFor();
      await expectProfileValue(page, 'career');
      await recovery.getByText(new RegExp(scenario.safeCopy, 'i')).waitFor();
      if (await profile.inputValue() !== 'career') throw new Error('Failed sandbox profile load changed the active profile from career');
      const draft = page.locator('.owner-tools textarea[data-report-field="description"]');
      if (await draft.inputValue() !== `sandbox recovery report draft ${scenario.code}`) throw new Error('Report draft was lost during recovery panel rerender');
      const panelText = await recovery.innerText();
      if (panelText.includes(scenario.raw) || panelText.includes('rawBytes')) throw new Error('Recovery panel exposed raw stored save data');
      if (!(await recovery.locator('[data-action="export-sandbox-backup"]').isVisible()) || !(await recovery.locator('[data-action="play-sandbox-session"]').isVisible())) {
        throw new Error('Sandbox recovery did not expose separate backup and explicit session-play actions');
      }
      const downloadPromise = page.waitForEvent('download');
      await recovery.locator('[data-action="export-sandbox-backup"]').click();
      const backup = await downloadPromise;
      if (await readFile(await backup.path(), 'utf8') !== scenario.raw) throw new Error('Sandbox recovery download did not preserve exact stored bytes');
      if (await page.evaluate(storageKey => localStorage.getItem(storageKey), sandboxKey) !== scenario.raw) throw new Error('Raw sandbox backup action changed stored bytes');
      await recovery.locator('[data-action="play-sandbox-session"]').click();
      await expectProfileValue(page, 'sandbox');
      await page.getByText(/Sandbox is active for this session using temporary data/i).waitFor();
      if (await draft.inputValue() !== `sandbox recovery report draft ${scenario.code}`) throw new Error('Report draft was lost when temporary sandbox play opened');
      const quality = page.locator('.owner-tools select[data-select="quality"]');
      await quality.selectOption('auto');
      await page.waitForFunction(() => document.querySelector('.owner-tools select[data-select="quality"]')?.value === 'auto');
      await page.waitForTimeout(300); // let the async profile save path settle before checking raw bytes and reloading
      if (await page.evaluate(storageKey => localStorage.getItem(storageKey), sandboxKey) !== scenario.raw) throw new Error('Session-only sandbox setting overwrote original stored bytes');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 60_000 });
      if (await page.evaluate(storageKey => localStorage.getItem(storageKey), sandboxKey) !== scenario.raw) throw new Error('Reload after temporary sandbox play replaced original bytes');
      await page.getByRole('button', { name: 'Owner tools', exact: true }).click({ force: true });
      await page.locator('.owner-tools .ot-recovery[data-recovery-status="recovery-required"]').waitFor();
      await page.locator('.owner-tools .ot-recovery').getByText(new RegExp(scenario.safeCopy, 'i')).waitFor();
      if (await page.locator('.owner-tools select[data-select="profile"]').inputValue() !== 'career') throw new Error('Reload did not restore career as the active profile');
      if (await page.evaluate(storageKey => localStorage.getItem(storageKey), sandboxKey) !== scenario.raw) throw new Error('Reload recovery prompt did not preserve exact sandbox bytes');
      await context.close();
    });
  }

  await report('production standalone browser has no owner tools, bench global or QA global', async () => {
    const productionPreview = spawn(process.execPath, ['tools/preview_build.mjs', '--dir', standaloneArtifact, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let lines = '';
    const productionURL = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Production preview did not start: ${lines}`)), 10_000);
      productionPreview.stdout.on('data', chunk => {
        lines += chunk.toString();
        const match = /Preview: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(lines);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      productionPreview.once('exit', code => { clearTimeout(timer); reject(new Error(`Production preview exited ${code}`)); });
    });
    try {
      const context = await newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.route('**/*', route => new URL(route.request().url()).origin === new URL(productionURL).origin ? route.continue() : route.abort());
      await page.goto(productionURL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
      if (await page.locator('[aria-label="Owner review tools"]').count()) throw new Error('Production UI mounted owner tools');
      const globals = await page.evaluate(() => ({ bench: '__LATERAL_BENCH__' in window, qa: '__LATERAL_QA__' in window }));
      if (globals.bench || globals.qa) throw new Error(`Owner globals are present in production: ${JSON.stringify(globals)}`);
      await page.close();
    } finally { productionPreview.kill('SIGTERM'); await once(productionPreview, 'exit').catch(() => {}); }
  });
} finally {
  await browser.close();
  if (preview) {
    preview.kill('SIGTERM');
    await once(preview, 'exit').catch(() => {});
  }
}

const manifest = JSON.parse(readFileSync(path.join(ownerArtifact, 'build-manifest.json'), 'utf8'));
process.stdout.write(`${JSON.stringify({ artifact: ownerArtifact, identity: manifest,
  browser: { executable: browserPath, webglRenderer },
  classification: 'automated desktop browser with simulated input; no physical device or portal verification', results }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
