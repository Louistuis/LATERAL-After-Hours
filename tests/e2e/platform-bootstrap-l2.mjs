#!/usr/bin/env node
/** Frozen compiled-player Poki/standalone bootstrap checks using only a local fake SDK. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve('/root/.cache/lateral-checkpoints/8a7a98ed/dist');
const outputRoot = path.resolve('evidence/L2/R-L2-15');
const sdkURL = 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js';
const browserPath = '/usr/bin/chromium';
const failures = [];
const cases = [];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  }).sort();
}
function directoryIdentity(directory) {
  const entries = filesBelow(directory).map(file => ({ path: path.relative(directory, file).split(path.sep).join('/'), sha256: sha256(readFileSync(file)) }));
  return { entries, sha256: sha256(JSON.stringify(entries)) };
}
function fakeSdk(mode) {
  return `(() => {
    const record = (type, extra = {}) => window.__L2_POKI_FIXTURE__.events.push({type, ...extra});
    window.__L2_POKI_FIXTURE__ = {mode:${JSON.stringify(mode)}, events:[]};
    window.PokiSDK = {
      init() { record('init'); ${mode === 'reject' ? "return Promise.reject(new Error('local fixture init rejection'));" : mode === 'timeout' ? 'return new Promise(() => {});' : 'return Promise.resolve();'} },
      gameLoadingFinished() { record('gameLoadingFinished'); },
      gameplayStart() { record('gameplayStart'); },
      gameplayStop() { record('gameplayStop'); },
      commercialBreak(onStart) { record('commercialBreak'); onStart?.(); return Promise.resolve(); },
      rewardedBreak(onStart) { record('rewardedBreak'); onStart?.(); return Promise.resolve(false); }
    };
  })();`;
}

async function startPreview(target) {
  const directory = path.join(root, target);
  if (!existsSync(path.join(directory, 'index.html'))) throw new Error(`Missing frozen ${target} artifact at ${directory}`);
  const child = spawn(process.execPath, ['tools/preview_build.mjs', '--dir', directory, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000 && !/Preview: http:\/\/127\.0\.0\.1:\d+\//.test(stdout)) {
    if (child.exitCode !== null) throw new Error(`Preview exited (${child.exitCode}): ${stdout}${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const baseURL = /Preview: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1];
  if (!baseURL) { child.kill('SIGTERM'); throw new Error(`Preview startup timeout: ${stdout}${stderr}`); }
  return { child, baseURL, directory, stdout: () => stdout, stderr: () => stderr };
}

async function stopPreview(preview) {
  if (!preview || preview.child.exitCode !== null) return;
  preview.child.kill('SIGTERM');
  await Promise.race([once(preview.child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
}

async function openCase(browser, name, target, sdkMode = null) {
  const preview = await startPreview(target);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], externalRequests: [], sdkRequests: [] };
  page.on('pageerror', error => diagnostics.pageErrors.push(String(error?.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => diagnostics.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== new URL(preview.baseURL).origin) diagnostics.externalRequests.push(request.url());
    if (request.url() === sdkURL) diagnostics.sdkRequests.push(request.url());
  });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === sdkURL && sdkMode) {
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: fakeSdk(sdkMode) });
      return;
    }
    if (new URL(url).origin === new URL(preview.baseURL).origin) await route.continue();
    else await route.abort('blockedbyclient');
  });
  const indexResponse = await page.goto(preview.baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!indexResponse?.ok()) throw new Error(`${name}: compiled index did not load (${indexResponse?.status() ?? 'no response'})`);
  return { name, target, sdkMode, preview, context, page, diagnostics,
    servedIndexSha256: sha256(await indexResponse.body()), artifact: directoryIdentity(preview.directory) };
}

async function waitForUsableDrive(testCase) {
  const { page } = testCase;
  await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true });
  const hudSpeed = page.locator('.lp-hud[aria-label="Driving information"] > div:first-child strong');
  await hudSpeed.waitFor({ timeout: 10_000 });
  const before = Number((await hudSpeed.innerText()).trim());
  await page.keyboard.down('KeyW');
  try {
    await page.waitForFunction(() => {
      const value = Number(document.querySelector('.lp-hud[aria-label="Driving information"] > div:first-child strong')?.textContent);
      return Number.isFinite(value) && value >= 4;
    }, null, { timeout: 8_000 });
  } finally { await page.keyboard.up('KeyW'); }
  const after = Number((await hudSpeed.innerText()).trim());
  if (!(after > before)) throw new Error(`${testCase.name}: keyboard input did not increase visible speed (${before}→${after} km/h)`);
  await page.screenshot({ path: path.join(outputRoot, `${testCase.name}.png`), fullPage: true });
  return { speedBeforeKmh: before, speedAfterKeyboardKmh: after };
}

async function runCase(browser, spec, body) {
  let testCase;
  const item = { name: spec.name, target: spec.target, sdkMode: spec.sdkMode ?? null, result: 'FAIL' };
  try {
    testCase = await openCase(browser, spec.name, spec.target, spec.sdkMode ?? null);
    item.servedIndexSha256 = testCase.servedIndexSha256;
    item.artifactTreeSha256 = testCase.artifact.sha256;
    item.diagnostics = testCase.diagnostics;
    await body(testCase, item);
    item.result = 'PASS';
    process.stdout.write(`PASS ${spec.name}\n`);
  } catch (error) {
    item.error = String(error?.stack ?? error);
    failures.push({ name: spec.name, error: item.error });
    process.stdout.write(`FAIL ${spec.name}: ${String(error)}\n`);
  } finally {
    if (testCase) {
      if (testCase.resultData) item.resultData = testCase.resultData;
      item.previewOutput = `${testCase.preview.stdout()}${testCase.preview.stderr()}`;
      await testCase.context.close().catch(() => {});
      await stopPreview(testCase.preview);
    }
    cases.push(item);
  }
}

await mkdir(outputRoot, { recursive: true });
const artifacts = {};
for (const target of ['poki', 'standalone']) {
  const directory = path.join(root, target);
  if (!existsSync(path.join(directory, 'index.html'))) throw new Error(`Required frozen artifact missing: ${directory}`);
  artifacts[target] = { directory, tree: directoryIdentity(directory), manifest: JSON.parse(await readFile(path.join(directory, 'build-manifest.json'), 'utf8')) };
}
if (artifacts.poki.manifest.commit !== '8a7a98ed2955a4d69a012d3b100608def173d10e' || artifacts.standalone.manifest.commit !== artifacts.poki.manifest.commit) {
  throw new Error('Frozen artifact commit identity did not match the required 8a7a98ed baseline');
}
const browser = await chromium.launch({ headless: true, executablePath: browserPath,
  args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] });
const rendererInfo = async page => page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

try {
  await runCase(browser, { name: 'poki-init-reject', target: 'poki', sdkMode: 'reject' }, async testCase => {
    const usability = await waitForUsableDrive(testCase);
    if (testCase.diagnostics.sdkRequests.length !== 1) throw new Error('Poki SDK loader was not intercepted exactly once');
    const fixture = await testCase.page.evaluate(() => window.__L2_POKI_FIXTURE__);
    if (fixture?.events.filter(event => event.type === 'init').length !== 1) throw new Error('Reject fixture init was not called exactly once');
    if (fixture?.events.some(event => event.type === 'gameplayStart' || event.type === 'gameplayStop')) throw new Error('Failed SDK received gameplay lifecycle notification');
    const idleSDK = await testCase.page.evaluate(() => ({ mode: window.__L2_POKI_FIXTURE__?.mode, events: window.__L2_POKI_FIXTURE__?.events }));
    await testCase.page.keyboard.press('Escape');
    await testCase.page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    testCase.resultData = { usability, idleSDK, renderer: await rendererInfo(testCase.page) };
  });

  await runCase(browser, { name: 'poki-init-timeout', target: 'poki', sdkMode: 'timeout' }, async testCase => {
    const usability = await waitForUsableDrive(testCase);
    if (testCase.diagnostics.sdkRequests.length !== 1) throw new Error('Poki SDK loader was not intercepted exactly once');
    const fixture = await testCase.page.evaluate(() => window.__L2_POKI_FIXTURE__);
    if (fixture?.events.filter(event => event.type === 'init').length !== 1) throw new Error('Non-settling init fixture was not called exactly once');
    if (fixture?.events.some(event => event.type === 'gameplayStart' || event.type === 'gameplayStop')) throw new Error('Timed-out SDK received gameplay lifecycle notification');
    const idleSDK = await testCase.page.evaluate(() => ({ mode: window.__L2_POKI_FIXTURE__?.mode, events: window.__L2_POKI_FIXTURE__?.events }));
    await testCase.page.keyboard.press('Escape');
    await testCase.page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    testCase.resultData = { usability, idleSDK, renderer: await rendererInfo(testCase.page) };
  });

  await runCase(browser, { name: 'poki-success-gameplay-clock', target: 'poki', sdkMode: 'success' }, async testCase => {
    const { page } = testCase;
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor({ timeout: 12_000 });
    const sdkAtShellReady = await page.evaluate(() => window.__L2_POKI_FIXTURE__);
    const freeDrive = await waitForUsableDrive(testCase);
    const sdkAfterDrive = await page.evaluate(() => window.__L2_POKI_FIXTURE__);
    const freeDriveStartCount = sdkAfterDrive?.events.filter(event => event.type === 'gameplayStart').length ?? 0;
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    const sdkAfterFreePause = await page.evaluate(() => window.__L2_POKI_FIXTURE__);
    const freeDriveStopCount = sdkAfterFreePause?.events.filter(event => event.type === 'gameplayStop').length ?? 0;

    await page.getByRole('button', { name: 'Time trial', exact: true }).click({ force: true });
    const hud = page.locator('.lp-hud[aria-label="Driving information"]');
    await hud.waitFor({ timeout: 10_000 });
    const elapsed = hud.locator(':scope > div:nth-child(3) strong');
    await page.waitForFunction(() => Number(document.querySelector('.lp-hud[aria-label="Driving information"] > div:nth-child(3) strong')?.textContent?.replace('s', '')) > 0.4, null, { timeout: 15_000 });
    await page.keyboard.down('KeyW');
    try { await page.waitForTimeout(1_300); }
    finally { await page.keyboard.up('KeyW'); }
    const speedAfterInputKmh = Number((await hud.locator(':scope > div:first-child strong').innerText()).trim());
    if (!(speedAfterInputKmh > 0)) throw new Error('Time Trial keyboard input did not produce visible vehicle speed');
    const elapsedBeforePause = Number((await elapsed.innerText()).replace('s', '').trim());
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true });
    await hud.waitFor();
    const elapsedAfterResume = Number((await hud.locator(':scope > div:nth-child(3) strong').innerText()).replace('s', '').trim());
    const sdk = await page.evaluate(() => window.__L2_POKI_FIXTURE__);
    const starts = sdk?.events.filter(event => event.type === 'gameplayStart').length ?? 0;
    const stops = sdk?.events.filter(event => event.type === 'gameplayStop').length ?? 0;
    const loadingFinished = sdk?.events.filter(event => event.type === 'gameLoadingFinished').length ?? 0;
    const lifecycleErrors = [];
    if (Math.abs(elapsedAfterResume - elapsedBeforePause) > 0.35) lifecycleErrors.push(`event clock advanced across pause (${elapsedBeforePause}→${elapsedAfterResume}s)`);
    if (freeDriveStartCount !== 1) lifecycleErrors.push(`expected one gameplayStart after Drive; observed ${freeDriveStartCount}`);
    if (freeDriveStopCount !== 1) lifecycleErrors.push(`expected one gameplayStop after pausing free Drive; observed ${freeDriveStopCount}`);
    if (starts !== 2) lifecycleErrors.push(`expected one start for Drive and one for Time Trial; observed ${starts}`);
    if (stops !== 2) lifecycleErrors.push(`expected one stop for each pause; observed ${stops}`);
    if (loadingFinished !== 1) lifecycleErrors.push(`expected one gameLoadingFinished after shell readiness; observed ${loadingFinished}`);
    if (sdk.events.some(event => event.type === 'rewardedBreak' || event.type === 'commercialBreak')) lifecycleErrors.push('normal play unexpectedly invoked a fake ad/reward callback');
    testCase.resultData = { shellReadyEvents: sdkAtShellReady?.events, freeDrive, freeDriveEvents: sdkAfterDrive?.events,
      freeDrivePauseEvents: sdkAfterFreePause?.events, elapsedBeforePause, elapsedAfterResume, speedAfterInputKmh,
      finalSdkEvents: sdk?.events, renderer: await rendererInfo(page), lifecycleErrors };
    await page.screenshot({ path: path.join(outputRoot, 'poki-success-gameplay-clock.png'), fullPage: true });
    if (lifecycleErrors.length) throw new Error(lifecycleErrors.join('; '));
  });

  await runCase(browser, { name: 'standalone-offline-playable', target: 'standalone' }, async testCase => {
    const usability = await waitForUsableDrive(testCase);
    if (testCase.diagnostics.sdkRequests.length !== 0) throw new Error('Standalone attempted to load Poki SDK');
    const pokiPresent = await testCase.page.evaluate(() => typeof window.PokiSDK !== 'undefined');
    if (pokiPresent) throw new Error('Standalone unexpectedly exposed a Poki SDK global');
    await testCase.page.keyboard.press('Escape');
    await testCase.page.getByRole('heading', { name: 'After hours. All yours.' }).waitFor();
    testCase.resultData = { usability, pokiPresent, renderer: await rendererInfo(testCase.page) };
  });
} finally {
  await browser.close();
}

const report = {
  taskId: 'R-L2-15', baselineCommit: '8a7a98ed2955a4d69a012d3b100608def173d10e',
  browser: { path: browserPath, version: browser.version(), headless: true, flags: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] },
  artifacts, cases, failures, externalPortalCalls: 0,
  claims: { localFakeSdkOnly: true, externalOriginsAborted: true, realAds: false, portalApproval: false, physicalGpu: false },
};
await writeFile(path.join(outputRoot, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`Browser ${report.browser.version}; artifacts ${Object.keys(artifacts).join(', ')}; failures=${failures.length}\n`);
process.exitCode = failures.length ? 1 : 0;
