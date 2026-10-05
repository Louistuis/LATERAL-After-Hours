#!/usr/bin/env node
/** Cold owner-artifact first-playable transfer measurement. Browser execution requires an A0-pinned artifact/window. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { accountTransferToBoundary, p95NearestRank } from './cold-transfer-accounting.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const artifactRoot = path.resolve(process.env.L6_COLD_ARTIFACT_ROOT ?? path.join(projectRoot, 'dist'));
const ownerRoot = path.join(artifactRoot, 'owner-review');
const expectedBuildId = process.env.L6_COLD_EXPECTED_BUILD_ID;
const expectedCommit = process.env.L6_COLD_EXPECTED_COMMIT;
const evidenceDirectory = path.resolve(process.env.L6_COLD_EVIDENCE_DIR ?? path.join(projectRoot, 'evidence/L6/R-L6-09'));
const outputPath = path.join(evidenceDirectory, 'cold-first-playable-report.json');
const baseURLOverride = process.env.L6_COLD_BASE_URL;
const runCount = Number(process.env.L6_COLD_RUNS ?? '10');
const profiles = [
  { id: '20Mbps-100ms', latencyMs: 100, downloadBps: 2_500_000, uploadBps: 312_500, p95LimitMs: 10_000, label: '20 Mbps down / 2.5 Mbps up / 100 ms RTT' },
  { id: '5Mbps-150ms', latencyMs: 150, downloadBps: 625_000, uploadBps: 125_000, p95LimitMs: 20_000, label: '5 Mbps down / 1 Mbps up / 150 ms RTT' },
];

if (!expectedBuildId || !expectedCommit) throw new Error('Set L6_COLD_EXPECTED_BUILD_ID and L6_COLD_EXPECTED_COMMIT from A0’s exact artifact pin.');
if (!Number.isInteger(runCount) || runCount !== 10) throw new Error('PER-02 cold p95 requires exactly ten independent boots per throttle profile.');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function directoryBytes(root) {
  let total = 0;
  let count = 0;
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) { total += (await stat(full)).size; count += 1; }
    }
  };
  await visit(root);
  return { totalBytes: total, fileCount: count };
}

const manifestPath = path.join(ownerRoot, 'build-manifest.json');
const indexPath = path.join(ownerRoot, 'index.html');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const indexBytes = await readFile(indexPath);
const manifestSha256 = sha256(manifestBytes);
const localIndexSha256 = sha256(indexBytes);
const packageInfo = await directoryBytes(ownerRoot);
const identity = {
  version: manifest.version,
  target: manifest.target,
  commit: manifest.commit,
  buildId: manifest.buildId,
  sourceHash: manifest.sourceHash,
  contentHash: manifest.contentHash,
  contractsHash: manifest.contractsHash,
  workingTreeDirty: manifest.workingTreeDirty,
};
for (const key of ['version', 'target', 'commit', 'buildId', 'sourceHash', 'contentHash', 'contractsHash', 'workingTreeDirty']) {
  if (identity[key] === undefined || identity[key] === null || identity[key] === '') throw new Error(`Artifact identity is missing ${key}`);
}
if (manifest.target !== 'owner-review' || manifest.buildId !== expectedBuildId || manifest.commit !== expectedCommit || manifest.workingTreeDirty !== false) {
  throw new Error(`Artifact identity does not match A0 pin: ${JSON.stringify(identity)}`);
}

let previewServer;
let serverOutput = '';
const baseURL = baseURLOverride ?? await new Promise((resolve, reject) => {
  const previewScript = path.join(projectRoot, 'tools/preview_build.mjs');
  previewServer = spawn(process.execPath, [previewScript, '--dir', ownerRoot, '--port', '0'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  const timer = setTimeout(() => reject(new Error(`Pinned preview did not start: ${serverOutput}`)), 10_000);
  previewServer.stdout.on('data', chunk => {
    serverOutput += chunk.toString();
    const match = /Preview: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(serverOutput);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  previewServer.once('exit', code => { clearTimeout(timer); reject(new Error(`Pinned preview exited ${code}: ${serverOutput}`)); });
});

let browser;
const report = {
  schemaVersion: 1,
  status: 'IN_PROGRESS',
  artifactRoot,
  identity,
  manifestSha256,
  packageBytes: packageInfo.totalBytes,
  packageFileCount: packageInfo.fileCount,
  shippedBundleBudget: { maxBytes: 120_000_000, maxFiles: 800, withinBytes: packageInfo.totalBytes <= 120_000_000, withinFiles: packageInfo.fileCount <= 800 },
  firstPlayableTransferBudgetBytes: 8_000_000,
  localIndexSha256,
  servedIndexSha256: null,
  servedArtifactMatches: false,
  preview: {
    url: baseURL,
    implementation: 'tools/preview_build.mjs; static read-only loopback HTTP; compression headers recorded per response',
    throttleOnLoopback: null,
    throttleProbeMethod: 'CDP request-to-response time for the main document compared with requested RTT',
  },
  browser: null,
  constraints: {
    coldContextPerBoot: true,
    diskCacheDisabled: true,
    serviceWorkerBypassAndBlocked: true,
    bytesMetric: 'CDP Network.loadingFinished.encodedDataLength for complete successful uncached same-origin responses before firstPlayableAtMs',
    incompleteCoverage: 'transferred total is null; known subtotal and per-request unknown reasons remain available',
    packageResidentAndAllocationBytes: null,
    deviceAndPortalClaim: false,
  },
  profiles: [],
  failures: [],
};
let browserPath;
let servedIndexSha256;

async function persistReport() {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function closePreview() {
  if (!previewServer) return;
  previewServer.kill('SIGTERM');
  await once(previewServer, 'exit').catch(() => {});
  previewServer = undefined;
}

async function readWebGLRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    if (!gl) return null;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

function safePath(url) {
  try { return `${new URL(url).origin}${new URL(url).pathname}`; } catch { return '<invalid-url>'; }
}

async function runBoot(profile, ordinal) {
  const beforeBytes = await readFile(manifestPath);
  if (sha256(beforeBytes) !== manifestSha256 || sha256(await readFile(indexPath)) !== localIndexSha256) {
    throw new Error('Pinned owner artifact changed during cold boot series');
  }
  const servedResponse = await fetch(baseURL, { cache: 'no-store' });
  if (!servedResponse.ok) throw new Error(`Per-run served index probe returned HTTP ${servedResponse.status}`);
  const runServedIndexSha256 = sha256(Buffer.from(await servedResponse.arrayBuffer()));
  if (runServedIndexSha256 !== localIndexSha256) throw new Error('Served index hash changed during cold boot series');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const marks = { coverCreatedAtMs: null, coverHiddenAtMs: null, driveMenuAtMs: null };
    Object.defineProperty(window, '__L6_COLD_DOM_MARKS__', { configurable: false, value: marks });
    const observe = () => {
      const now = performance.now();
      const cover = document.querySelector('.lateral-boot');
      if (cover && marks.coverCreatedAtMs === null) marks.coverCreatedAtMs = now;
      if (cover?.hidden && marks.coverHiddenAtMs === null) marks.coverHiddenAtMs = now;
      if (document.querySelector('.lp-menu button[data-action="drive"]') && marks.driveMenuAtMs === null) marks.driveMenuAtMs = now;
      if (marks.coverHiddenAtMs !== null && marks.driveMenuAtMs !== null) observer.disconnect();
    };
    const observer = new window.MutationObserver(observe);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    observe();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const cdp = await context.newCDPSession(page);
  const requests = new Map();
  const errors = [];
  let monotonicToEpochOffsetMs = null;
  let firstPlayableMark = null;
  let pageTimeOriginMs = null;
  let webglRenderer = null;
  let docResponseLatencyMs = null;
  const urlOrigin = new URL(baseURL).origin;
  const getRecord = requestId => {
    if (!requests.has(requestId)) requests.set(requestId, { requestId, url: '', requestedAt: null, dataReceived: [] });
    return requests.get(requestId);
  };
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadBps,
    uploadThroughput: profile.uploadBps,
    connectionType: 'wifi',
  });
  cdp.on('Network.requestWillBeSent', event => {
    if (monotonicToEpochOffsetMs === null && Number.isFinite(event.wallTime) && Number.isFinite(event.timestamp)) {
      monotonicToEpochOffsetMs = (event.wallTime - event.timestamp) * 1000;
    }
    const record = getRecord(event.requestId);
    if (event.redirectResponse) {
      record.redirected = true;
      record.failure = 'redirect chain not fully attributable';
    }
    record.url = event.request.url;
    record.method = event.request.method;
    record.initiatorType = event.initiator?.type ?? null;
    record.type = event.type ?? null;
    record.requestedAt = event.timestamp;
  });
  cdp.on('Network.responseReceived', event => {
    const record = getRecord(event.requestId);
    record.responseAt = event.timestamp;
    record.type = event.type ?? record.type;
    record.status = event.response.status;
    record.contentEncoding = event.response.headers?.['content-encoding'] ?? event.response.headers?.['Content-Encoding'] ?? null;
    record.contentLength = event.response.headers?.['content-length'] ?? event.response.headers?.['Content-Length'] ?? null;
    record.fromDiskCache = event.response.fromDiskCache === true;
    record.fromServiceWorker = event.response.fromServiceWorker === true;
    record.fromPrefetchCache = event.response.fromPrefetchCache === true;
    record.protocol = event.response.protocol ?? null;
    record.mimeType = event.response.mimeType ?? null;
    record.remoteIPAddress = event.response.remoteIPAddress ?? null;
    record.connectionReused = event.response.connectionReused ?? null;
    record.encodedResponseHeaderBytes = Number.isFinite(event.response.encodedDataLength) ? event.response.encodedDataLength : null;
    if (record.type === 'Document' && record.requestedAt !== null) {
      docResponseLatencyMs = (event.timestamp - record.requestedAt) * 1000;
    }
  });
  cdp.on('Network.dataReceived', event => {
    getRecord(event.requestId).dataReceived.push({ timestamp: event.timestamp, dataLength: event.dataLength, encodedDataLength: event.encodedDataLength });
  });
  cdp.on('Network.loadingFinished', event => {
    const record = getRecord(event.requestId);
    record.finishedAt = event.timestamp;
    record.encodedBytes = event.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', event => {
    const record = getRecord(event.requestId);
    record.failedAt = event.timestamp;
    record.failure = event.errorText ?? 'network request failed';
    record.canceled = event.canceled === true;
    record.blockedReason = event.blockedReason ?? null;
  });
  cdp.on('Network.requestServedFromCache', event => { getRecord(event.requestId).servedFromCache = true; });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 500)); });
  await page.route('**/*', async route => {
    try {
      if (new URL(route.request().url()).origin !== urlOrigin) await route.abort('blockedbyclient');
      else await route.continue();
    } catch { /* A request may finish as navigation tears down the route. CDP keeps the record. */ }
  });

  const startAt = new Date().toISOString();
  let outcome;
  try {
    await page.goto(baseURL, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__LATERAL_BENCH__ === 'object' || document.querySelector('.lateral-boot [role="alert"]'), null, { timeout: 60_000, polling: 100 });
    const markerContractAvailable = await page.evaluate(() => typeof window.__LATERAL_BENCH__ === 'object' &&
      Object.prototype.hasOwnProperty.call(window.__LATERAL_BENCH__, 'firstPlayableAtMs'));
    if (!markerContractAvailable) throw new Error('Required owner firstPlayableAtMs marker is absent; UI timing is diagnostic only, not a PER-02 result');
    await page.waitForFunction(() => Number.isFinite(window.__LATERAL_BENCH__?.firstPlayableAtMs), null, { timeout: 120_000, polling: 100 });
    const mark = await page.evaluate(() => ({
      value: window.__LATERAL_BENCH__?.firstPlayableAtMs,
      identity: window.__LATERAL_BENCH__?.identity,
      timeOriginMs: performance.timeOrigin,
      navigationStartMs: performance.getEntriesByType('navigation')[0]?.startTime ?? 0,
      readiness: {
        ...window.__L6_COLD_DOM_MARKS__,
        coverHidden: document.querySelector('.lateral-boot')?.hidden === true,
        driveMenuVisible: Boolean(document.querySelector('.lp-menu button[data-action="drive"]')),
        canvasWidth: document.querySelector('canvas')?.width ?? null,
        canvasHeight: document.querySelector('canvas')?.height ?? null,
        webglContextReady: Boolean(document.querySelector('canvas')?.getContext('webgl2') ?? document.querySelector('canvas')?.getContext('webgl')),
        visibilityState: document.visibilityState,
      },
    }));
    if (!Number.isFinite(mark.value) || !Number.isFinite(mark.timeOriginMs) || monotonicToEpochOffsetMs === null) {
      throw new Error('Owner first-playable boundary or CDP/page time mapping is unavailable; transfer coverage is unknown');
    }
    firstPlayableMark = mark.value;
    pageTimeOriginMs = mark.timeOriginMs;
    const runtimeIdentity = mark.identity;
    for (const key of ['target', 'commit', 'buildId', 'sourceHash', 'contentHash', 'contractsHash', 'workingTreeDirty']) {
      if (runtimeIdentity?.[key] !== identity[key]) throw new Error(`Runtime artifact identity mismatch at ${key}`);
    }
    webglRenderer = await readWebGLRenderer(page);
    await page.waitForTimeout(40); // allow already-timestamped CDP events to flush; cutoff remains the marker.
    const boundaryTimestamp = (pageTimeOriginMs + firstPlayableMark - monotonicToEpochOffsetMs) / 1000;
    const requestRecords = [...requests.values()].filter(record => Number.isFinite(record.requestedAt)).map(record => ({
      ...record,
      url: record.url,
      resourceClass: undefined,
    }));
    const transfer = accountTransferToBoundary(requestRecords, boundaryTimestamp, urlOrigin);
    const observedLatency = docResponseLatencyMs;
    const throttleEffective = Number.isFinite(observedLatency) && observedLatency >= profile.latencyMs * 0.7;
    const servedFromCache = transfer.requests.some(request => request.fromDiskCache || request.fromServiceWorker || request.fromPrefetchCache || request.servedFromCache);
    const coverageErrors = [];
    if (!transfer.coverageComplete) coverageErrors.push('one or more pre-marker requests are incomplete or unattributed');
    if (servedFromCache) coverageErrors.push('a response came from cache or a service worker');
    if (!throttleEffective) coverageErrors.push('CDP throttling was not observed on loopback');

    await page.locator('.lp-menu button[data-action="drive"]').click({ timeout: 20_000 });
    await page.locator('.lp-hud[aria-label="Driving information"]').waitFor({ timeout: 20_000 });
    const initial = await page.evaluate(() => {
      const snapshot = window.__LATERAL_QA__?.view?.frame?.current;
      return snapshot?.position ?? null;
    });
    if (!initial || ![initial.x, initial.y, initial.z].every(Number.isFinite)) throw new Error('QA vehicle position is unavailable after Drive');
    await page.keyboard.down('KeyW');
    let movementHandle;
    try {
      movementHandle = await page.waitForFunction(start => {
        const snapshot = window.__LATERAL_QA__?.view?.frame?.current;
        const point = snapshot?.position;
        const hud = document.querySelector('.lp-hud[aria-label="Driving information"]')?.innerText ?? '';
        const speed = Number(/^\s*(\d+)/.exec(hud)?.[1] ?? 0);
        if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) return false;
        const displacementM = Math.hypot(point.x - start.x, point.y - start.y, point.z - start.z);
        return speed > 0 && displacementM > 0.25 ? { speedKmh: speed, position: point, displacementM, tick: window.__LATERAL_QA__?.view?.frame?.current?.simulationTick } : false;
      }, initial, { timeout: 15_000, polling: 100 });
    } finally { await page.keyboard.up('KeyW').catch(() => {}); }
    const movement = await movementHandle.jsonValue();
    if (!(movement.speedKmh > 0 && movement.displacementM > 0.25)) throw new Error('Keyboard input did not produce both HUD speed and vehicle displacement');
    const boundaryRequests = transfer.requests;
    const detail = boundaryRequests.map(request => {
      const original = requests.get(request.requestId);
      const timestampToPerf = timestamp => Number.isFinite(timestamp) ? timestamp * 1000 + monotonicToEpochOffsetMs - pageTimeOriginMs : null;
      return {
        ...request,
        requestPath: safePath(original?.url ?? ''),
        method: original?.method ?? null,
        initiatorType: original?.initiatorType ?? null,
        requestedAtPerfMs: timestampToPerf(original?.requestedAt),
        responseAtPerfMs: timestampToPerf(original?.responseAt),
        finishedAtPerfMs: timestampToPerf(original?.finishedAt),
        failedAtPerfMs: timestampToPerf(original?.failedAt),
        protocol: original?.protocol ?? null,
        mimeType: original?.mimeType ?? null,
        remoteIPAddress: original?.remoteIPAddress ?? null,
        connectionReused: original?.connectionReused ?? null,
        encodedResponseHeaderBytes: original?.encodedResponseHeaderBytes ?? null,
        dataReceived: (original?.dataReceived ?? []).filter(chunk => chunk.timestamp <= boundaryTimestamp),
        failure: original?.failure ?? request.failure,
        blockedReason: original?.blockedReason ?? null,
      };
    });
    outcome = {
      index: ordinal,
      throttleProfile: profile.id,
      throttleLabel: profile.label,
      status: coverageErrors.length ? 'INVALID_COVERAGE' : 'PASS',
      coverageErrors,
      startedAt: startAt,
      navigationStartEpochMs: pageTimeOriginMs + mark.navigationStartMs,
      firstPlayableAtMs: firstPlayableMark,
      timeToFirstPlayableMs: firstPlayableMark - mark.navigationStartMs,
      markerName: '__LATERAL_BENCH__.firstPlayableAtMs',
      runtimeIdentity,
      artifactProof: { buildManifestSha256: manifestSha256, localIndexSha256, servedIndexSha256: runServedIndexSha256 },
      readiness: mark.readiness,
      webglRenderer,
      transfer: { ...transfer, requests: detail },
      throttleProbe: {
        requestedRttMs: profile.latencyMs,
        mainDocumentRequestToResponseMs: observedLatency,
        effectiveOnLoopback: throttleEffective,
      },
      cacheFlags: {
        httpCacheDisabled: true,
        serviceWorkerBypass: true,
        serviceWorkersBlocked: true,
        anyResponseFromCache: servedFromCache,
      },
      errors,
      movement: { triggeredBy: 'Playwright keyboard KeyW', hudSpeedKmh: movement.speedKmh, displacementM: movement.displacementM, finalPosition: movement.position, simulationTick: movement.tick },
      coverageEligible: transfer.coverageComplete && !servedFromCache && throttleEffective,
      packageBytes: packageInfo.totalBytes,
      within8MBInitialTransferBudget: transfer.totalBytes === null ? null : transfer.totalBytes <= 8_000_000,
      residentAllocationBytes: null,
    };
  } catch (error) {
    const markMessage = String(error?.message ?? error);
    const markerUnavailable = !Number.isFinite(firstPlayableMark) && /firstPlayable|timeout/i.test(markMessage);
    const epochOffset = monotonicToEpochOffsetMs;
    const boundaryTimestamp = Number.isFinite(firstPlayableMark) && Number.isFinite(pageTimeOriginMs) && Number.isFinite(epochOffset)
      ? (pageTimeOriginMs + firstPlayableMark - epochOffset) / 1000 : Number.POSITIVE_INFINITY;
    const rawRecords = [...requests.values()].filter(record => Number.isFinite(record.requestedAt));
    const diagnosticTransfer = Number.isFinite(boundaryTimestamp)
      ? accountTransferToBoundary(rawRecords, boundaryTimestamp, urlOrigin)
      : { totalBytes: null, knownSubtotalBytes: 0, coverageComplete: false, requestCount: rawRecords.length, unknownCount: rawRecords.length, requests: [], unknown: rawRecords.map(record => ({ requestId: record.requestId, path: safePath(record.url), reason: 'first-playable boundary unavailable' })) };
    outcome = {
      index: ordinal,
      throttleProfile: profile.id,
      throttleLabel: profile.label,
      status: 'FAIL',
      startedAt: startAt,
      markerName: '__LATERAL_BENCH__.firstPlayableAtMs',
      markerUnavailable,
      error: markMessage,
      artifactProof: { buildManifestSha256: manifestSha256, localIndexSha256, servedIndexSha256: runServedIndexSha256 },
      transfer: diagnosticTransfer,
      runtimeIdentity: null,
      webglRenderer,
      errors,
      coverageEligible: false,
      packageBytes: packageInfo.totalBytes,
      within8MBInitialTransferBudget: null,
      residentAllocationBytes: null,
    };
  } finally {
    await cdp.detach().catch(() => {});
    await context.close().catch(() => {});
  }
  return outcome;
}

try {
  if (manifest.workingTreeDirty !== false) throw new Error('Pinned artifact manifest reports a dirty working tree');
  const indexResponse = await fetch(baseURL, { cache: 'no-store' });
  if (!indexResponse.ok) throw new Error(`Preview index returned HTTP ${indexResponse.status}`);
  servedIndexSha256 = sha256(Buffer.from(await indexResponse.arrayBuffer()));
  report.servedIndexSha256 = servedIndexSha256;
  report.servedArtifactMatches = servedIndexSha256 === localIndexSha256;
  if (!report.servedArtifactMatches) throw new Error('Served index bytes do not match pinned artifact index');

  const browserPathExpected = chromium.executablePath();
  const browserCache = path.join(process.env.HOME ?? '/root', '.cache/ms-playwright');
  const fallbackBrowser = existsSync(browserCache)
    ? readdirSync(browserCache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
      .map(name => path.join(browserCache, name, 'chrome-linux64/chrome')).find(existsSync)
    : undefined;
  browserPath = process.env.L6_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : existsSync(browserPathExpected) ? browserPathExpected : fallbackBrowser);
  if (!browserPath) throw new Error('No Chromium executable is available');
  browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] });
  report.browser = { executable: browserPath, version: browser.version(), platform: process.platform, node: process.version, webglBackend: 'captured per boot from canvas WEBGL_debug_renderer_info' };
  await persistReport();

  let stop = false;
  for (const profile of profiles) {
    const profileReport = { ...profile, runs: [], p95TimeToFirstPlayableMs: null, timeTargetMet: null, transferredBytesAtFirstPlayable: null, transferBudgetResults: null, p95Eligible: false };
    report.profiles.push(profileReport);
    for (let ordinal = 1; ordinal <= runCount; ordinal += 1) {
      const outcome = await runBoot(profile, ordinal);
      profileReport.runs.push(outcome);
      process.stdout.write(`${JSON.stringify({ event: 'cold-boot', ...outcome })}\n`);
      await persistReport();
      if (outcome.status !== 'PASS') {
        report.failures.push({ throttleProfile: profile.id, run: ordinal, reason: outcome.error ?? outcome.coverageErrors?.join('; ') ?? 'run did not qualify as a cold first-playable measurement' });
        stop = true;
        break;
      }
    }
    if (profileReport.runs.length === runCount && profileReport.runs.every(run => run.status === 'PASS')) {
      profileReport.p95TimeToFirstPlayableMs = p95NearestRank(profileReport.runs.map(run => run.timeToFirstPlayableMs));
      profileReport.timeTargetMet = profileReport.p95TimeToFirstPlayableMs <= profile.p95LimitMs;
      const complete = profileReport.runs.every(run => run.transfer.coverageComplete);
      const cacheClean = profileReport.runs.every(run => !run.cacheFlags.anyResponseFromCache);
      const throttleEffective = profileReport.runs.every(run => run.throttleProbe.effectiveOnLoopback);
      profileReport.transferredBytesAtFirstPlayable = complete
        ? profileReport.runs.map(run => run.transfer.totalBytes)
        : null;
      profileReport.transferBudgetResults = complete
        ? profileReport.runs.map(run => run.within8MBInitialTransferBudget)
        : null;
      profileReport.p95Eligible = complete && cacheClean && throttleEffective && profileReport.runs.every(run => run.movement?.hudSpeedKmh > 0 && run.movement?.displacementM > 0.25);
    }
    if (stop) break;
  }
  report.status = report.profiles.length === profiles.length && report.profiles.every(profile => profile.p95Eligible) ? 'MEASURED_SUBSET' : 'INCOMPLETE_OR_UNKNOWN';
} catch (error) {
  report.status = 'FAIL';
  report.failures.push({ reason: String(error?.stack ?? error) });
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
} finally {
  await persistReport().catch(error => process.stderr.write(`Could not persist evidence JSON: ${String(error)}\n`));
  await browser?.close().catch(() => {});
  await closePreview();
  process.stdout.write(`${JSON.stringify({ event: 'summary', status: report.status, outputPath, artifactIdentity: identity, manifestSha256, localIndexSha256, servedIndexSha256 })}\n`);
}
