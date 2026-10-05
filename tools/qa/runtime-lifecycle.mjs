/** Actual WebGL loss/restoration through WEBGL_lose_context on a prebuilt private game. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.env.LATERAL_URL || 'http://127.0.0.1:4173';
const output = process.env.LATERAL_EVIDENCE_DIR || 'evidence/integration/runtime-lifecycle';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const samples = [], errors = [], consoleLog = [], checks = {};
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => consoleLog.push({ type: message.type(), text: message.text() }));
async function sample(label) {
  const observation = await page.evaluate(() => ({ ...window.__LATERAL_QA__, stats: window.__LATERAL_BENCH__?.stats,
    liveContextState: window.__LATERAL_BENCH__?.contextState,
    contextLost: window.__LATERAL_CONTEXT_TEST__.gl.isContextLost() }));
  assert.ok(observation.view?.frame?.current, `Missing runtime at ${label}`);
  samples.push({ label, observation });
  return observation;
}
async function lose() {
  await page.evaluate(() => window.__LATERAL_CONTEXT_TEST__.extension.loseContext());
  await page.waitForFunction(() => window.__LATERAL_CONTEXT_TEST__.gl.isContextLost());
  await page.waitForSelector('.lateral-boot:not([hidden])');
}
async function restore() {
  await page.evaluate(() => window.__LATERAL_CONTEXT_TEST__.extension.restoreContext());
  await page.waitForFunction(() => !window.__LATERAL_CONTEXT_TEST__.gl.isContextLost());
  await page.waitForSelector('.lateral-boot[hidden]', { state: 'attached' });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.stats?.contextState === 'ready');
}
let failure = null, graphics = null;
try {
  await page.goto(url);
  await page.waitForSelector('.lp-menu', { timeout: 30000 });
  graphics = await page.locator('canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!gl || !extension) throw new Error('Real context loss extension unavailable');
    window.__LATERAL_CONTEXT_TEST__ = { gl, extension };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION), method: 'WEBGL_lose_context extension; no synthetic context events' };
  });
  const menu = await sample('menu-before-loss');
  assert.equal(menu.view.paused, true);
  await lose();
  await page.waitForTimeout(350);
  const menuLost = await sample('menu-context-lost');
  assert.equal(menuLost.contextLost, true);
  assert.equal(menuLost.liveContextState, 'lost');
  assert.equal(menuLost.view.frame.current.simulationTick, menu.view.frame.current.simulationTick);
  await restore();
  await page.waitForTimeout(300);
  const menuRestored = await sample('menu-restored');
  assert.equal(menuRestored.liveContextState, 'ready');
  assert.equal(menuRestored.view.paused, true);
  assert.equal(menuRestored.view.frame.current.simulationTick, menu.view.frame.current.simulationTick);
  checks.menuPauseSurvivesActualRestore = true;
  await page.screenshot({ path: `${output}/menu-restored.png` });

  await page.getByRole('button', { name: 'Drive', exact: true }).click();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await lose();
  const driveLost = await sample('drive-context-lost');
  await page.waitForTimeout(500);
  const driveHeld = await sample('drive-context-held');
  assert.equal(driveHeld.liveContextState, 'lost');
  assert.equal(driveHeld.view.paused, true);
  assert.equal(driveHeld.view.frame.current.simulationTick, driveLost.view.frame.current.simulationTick);
  assert.deepEqual(driveHeld.view.frame.current.position, driveLost.view.frame.current.position);
  checks.actualLossFreezesPhysics = true;
  await page.screenshot({ path: `${output}/graphics-paused.png` });
  await page.keyboard.up('KeyW');
  await restore();
  await page.waitForTimeout(700);
  const driveRestored = await sample('drive-restored');
  assert.equal(driveRestored.liveContextState, 'ready');
  checks.liveContextDiagnosticsFollowLifecycle = true;
  assert.equal(driveRestored.view.paused, false);
  assert.ok(driveRestored.view.frame.current.simulationTick > driveHeld.view.frame.current.simulationTick);
  assert.ok(driveRestored.stats.drawCallsAllPasses > 0);
  checks.actualRestoreResumesDriving = true;
  assert.equal(await page.locator('.lp-error').isVisible(), false, 'Empty error alert is visible during healthy driving');
  checks.emptyErrorAlertIsHidden = true;
  await page.screenshot({ path: `${output}/drive-restored.png` });

  await page.keyboard.press('Escape');
  await page.waitForSelector('.lp-menu');
  const paused = await sample('manual-pause-after-restore');
  await page.waitForTimeout(250);
  const later = await sample('manual-pause-held');
  assert.equal(later.view.frame.current.simulationTick, paused.view.frame.current.simulationTick);
  checks.normalControlsWorkAfterRestore = true;
  assert.deepEqual(errors, []);
  checks.noPageErrors = true;
  assert.deepEqual(consoleLog.filter(entry => /INVALID_OPERATION|does not belong to this context/i.test(entry.text)), [], 'Restoration used stale WebGL resources');
  checks.noInvalidGraphicsResourceOperations = true;
} catch (error) {
  failure = String(error?.stack ?? error); process.exitCode = 1;
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
} finally {
  const report = { timestamp: new Date().toISOString(), url, browser: browser.version(), graphics,
    scope: 'Actual desktop WebGL context recovery on this host; no mobile or other-browser certification',
    checks, failure, errors, consoleLog, samples };
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks, failure, graphics }, null, 2));
  await browser.close();
}
