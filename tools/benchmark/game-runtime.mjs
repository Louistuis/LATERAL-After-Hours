import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { cpus, platform, release, arch } from 'node:os';
import { chromium } from '@playwright/test';
import { summarizeFrames, validateFrameSamples, validateRouteTelemetry } from './game-runtime-contract.mjs';

const baseUrl = process.env.LATERAL_URL ?? 'http://127.0.0.1:4173';
const quality = process.env.L3_QUALITY ?? 'balanced';
const mode = process.env.L3_MODE ?? 'first-lap';
const width = 1280;
const height = 720;
const smokeSeconds = Number(process.env.L3_SMOKE_SECONDS ?? 8);
const warmupSeconds = Number(process.env.L3_WARMUP_SECONDS ?? 30);
const maxLapSeconds = Number(process.env.L3_MAX_LAP_SECONDS ?? 75);
const outputPath = process.env.L3_BENCH_JSON ??
  `evidence/L3/${new Date().toISOString().slice(0, 10)}/game-runtime-${mode}-${quality}.json`;
const chromeFlags = [
  '--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl',
];

if (!['low', 'balanced', 'high'].includes(quality)) throw new Error(`Invalid L3_QUALITY: ${quality}`);
if (!['smoke', 'first-lap'].includes(mode)) throw new Error(`Invalid L3_MODE: ${mode}; 180s gate trials are intentionally not implemented`);
if (![smokeSeconds, warmupSeconds, maxLapSeconds].every(Number.isFinite) || smokeSeconds <= 0 || warmupSeconds < 0 || maxLapSeconds <= 0 || maxLapSeconds > 75) {
  throw new Error('Smoke/warmup durations must be nonnegative and first-lap limit must be 1..75 seconds');
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: chromeFlags });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { connected: true, buttons, axes: [0, 0, 0, 0], id: 'L3 synthetic QA controller', index: 0, mapping: 'standard', timestamp: 1, vibrationActuator: null };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
  window.__L3_PAD__ = pad;
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const consoleWarnings = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const bridge = window.__LATERAL_BENCH__;
    return bridge?.version === 1 && bridge.stats && window.__LATERAL_QA__;
  }, { timeout: 30_000 });
  const setup = await page.evaluate(async ({ requestedQuality }) => {
    const bridge = window.__LATERAL_BENCH__;
    if (!Object.isFrozen(bridge)) throw new Error('Expected frozen version-1 benchmark bridge');
    if (typeof bridge.setQuality !== 'function') throw new Error('Benchmark bridge lacks setQuality(preset)');
    bridge.setQuality(requestedQuality);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (bridge.quality !== requestedQuality || bridge.stats?.quality !== requestedQuality) {
      throw new Error(`Requested ${requestedQuality}, bridge/renderer reports ${bridge.quality}/${bridge.stats?.quality}`);
    }
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('Game canvas is missing');
    if (canvas.clientWidth !== 1280 || canvas.clientHeight !== 720 || canvas.width !== 1280 || canvas.height !== 720) {
      throw new Error(`Expected 1280x720 CSS and render buffer, got ${canvas.clientWidth}x${canvas.clientHeight} CSS / ${canvas.width}x${canvas.height} render`);
    }
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 context is unavailable');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const qa = window.__LATERAL_QA__;
    const route = qa.view.route;
    if (!route?.centerline?.length || !route?.widthM) throw new Error('QA bridge route is unavailable');
    return {
      identity: bridge.identity,
      quality: bridge.quality,
      canvasCss: { width: canvas.clientWidth, height: canvas.clientHeight },
      canvasRender: { width: canvas.width, height: canvas.height },
      graphics: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl: gl.getParameter(gl.VERSION),
      bridgeVersion: bridge.version,
      route: { id: route.id, lengthM: route.lengthM, widthM: route.widthM, centerlinePoints: route.centerline.length, spawn: route.spawn.position },
      pausedBeforeDrive: bridge.paused,
    };
  }, { requestedQuality: quality });
  await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true, timeout: 20_000 });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === false, { timeout: 10_000 });
  await page.waitForTimeout(250); // lets PlayerInput observe the synthetic pad neutral and clear its reconnect block

  const controller = await page.evaluate(() => {
    const route = window.__LATERAL_QA__.view.route;
    const points = route.centerline;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const pointAt = (distance) => {
      const d = Math.max(0, Math.min(cumulative.at(-1), distance));
      let i = 1;
      while (i < cumulative.length - 1 && cumulative[i] < d) i++;
      const a = points[i - 1], b = points[i];
      const t = (d - cumulative[i - 1]) / Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    let segment = 0, projected = 0, furthest = 0, previousPosition = null;
    const telemetry = [];
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
    const invertAxis = (value) => Math.sign(value) * (value === 0 ? 0 : .14 + .86 * Math.pow(Math.abs(value), 1 / 1.35));
    const trigger = (value) => value <= 0 ? 0 : .08 + .92 * value;
    const update = () => {
      const qa = window.__LATERAL_QA__.view;
      const current = qa.frame.current;
      const pos = current.position;
      let nearest = Infinity, candidateProgress = projected, bestSegment = segment;
      let lateral = null;
      for (let i = Math.max(0, segment - 3); i < Math.min(points.length - 1, segment + 9); i++) {
        const a = points[i], b = points[i + 1], dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const length2 = dx * dx + dy * dy + dz * dz;
        const t = length2 ? clamp(((pos.x - a.x) * dx + (pos.y - a.y) * dy + (pos.z - a.z) * dz) / length2, 0, 1) : 0;
        const distance = Math.hypot(pos.x - a.x - t * dx, pos.y - a.y - t * dy, pos.z - a.z - t * dz);
        const progress = cumulative[i] + t * Math.sqrt(length2);
        if (distance < nearest) {
          nearest = distance; candidateProgress = progress; bestSegment = i;
          const horizontal = Math.hypot(dx, dz);
          lateral = horizontal > 1e-6 ? ((pos.x - a.x - t * dx) * -dz + (pos.z - a.z - t * dz) * dx) / horizontal : null;
        }
      }
      const travelled = previousPosition ? Math.hypot(pos.x - previousPosition.x, pos.y - previousPosition.y, pos.z - previousPosition.z) : 0;
      const plausible = travelled <= 15 && Math.abs(candidateProgress - projected) <= Math.max(2, travelled * 1.3 + .25);
      const legal = nearest <= route.widthM * .5 + 1.5 && plausible;
      previousPosition = { ...pos };
      if (legal) { projected = candidateProgress; segment = bestSegment; furthest = Math.max(furthest, projected); }
      const speed = Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z);
      const target = pointAt(projected + Math.max(5, speed * .42));
      const q = current.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(target.x - pos.x, -(target.z - pos.z));
      const steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
      const pad = window.__L3_PAD__;
      pad.axes[0] = invertAxis(steering);
      pad.buttons[7].value = trigger(speed < 8 ? .72 : .08);
      pad.buttons[7].pressed = pad.buttons[7].value > .5;
      pad.buttons[6].value = trigger(speed > 9.5 ? .35 : 0);
      pad.buttons[6].pressed = pad.buttons[6].value > .5;
      telemetry.push({
        monotonicTimeMs: performance.now(), tick: current.simulationTick, position: { ...pos }, speedMS: speed,
        routeProgressM: furthest, routeProjectionM: projected, routeDistanceM: nearest, lateralOffsetM: lateral,
        routeLegal: legal,
        roadWheelContactCount: current.wheels.filter((wheel) => wheel.contact && String(wheel.surfaceId).startsWith('road:')).length,
        wheels: current.wheels.map((wheel) => ({ contact: wheel.contact, surfaceId: wheel.surfaceId, loadN: wheel.normalLoadN })),
      });
    };
    let timer = null;
    const start = () => { if (timer === null) timer = window.setInterval(update, 50); };
    const stop = () => { if (timer !== null) { window.clearInterval(timer); timer = null; } };
    const reseed = () => { segment = 0; projected = 0; furthest = 0; previousPosition = null; telemetry.length = 0; };
    window.__L3_CONTROLLER__ = { telemetry, routeLengthM: cumulative.at(-1), start, stop, reseed };
    start();
    update();
    return { routeId: route.id, routeLengthM: cumulative.at(-1), routeWidthM: route.widthM, centerlinePoints: points.length, updateHz: 20, speedTargetMS: 8, lookahead: 'max(5m, speedMS * .42)' };
  });

  const sample = async ({ durationMs, stopAtLapEnd = false }) => page.evaluate(({ durationMs, expectedQuality, stopAtLapEnd }) => new Promise((resolve, reject) => {
    const initialBridge = window.__LATERAL_BENCH__;
    if (!initialBridge || initialBridge.version !== 1) return reject(new Error('Benchmark bridge disappeared'));
    const metricsAtStart = initialBridge.metrics;
    const intervalsAtStart = initialBridge.intervals;
    const samples = [];
    const started = performance.now();
    let previous = null;
    let stopped = false;
    const finish = (reason) => {
      if (stopped) return;
      stopped = true;
      const finalBridge = window.__LATERAL_BENCH__;
      resolve({
        samples,
        metricsAtStart,
        intervalsAtStart,
        metricsAtEnd: finalBridge.metrics,
        intervalsAtEnd: finalBridge.intervals,
        reason,
        elapsedMs: performance.now() - started,
      });
    };
    const frame = (now) => {
      if (stopped) return;
      const liveBridge = window.__LATERAL_BENCH__;
      if (!liveBridge || liveBridge.version !== 1) return reject(new Error('Benchmark bridge disappeared during sampling'));
      const stats = liveBridge.stats;
      const currentQuality = liveBridge.quality;
      const paused = liveBridge.paused;
      const tick = liveBridge.tick;
      if (currentQuality !== expectedQuality || stats?.quality !== expectedQuality) return reject(new Error(`Quality changed to ${currentQuality}/${stats?.quality}`));
      const interval = previous === null ? null : now - previous;
      previous = now;
      samples.push({
        monotonicTimeMs: now, frameIntervalMs: interval,
        simulationCpuMs: stats.simulationCpuMs ?? null, renderingCpuMs: stats.renderingCpuMs ?? null, gpuMs: stats.gpuMs ?? null,
        drawCallsAllPasses: stats.drawCallsAllPasses ?? null, trianglesAllPasses: stats.trianglesAllPasses ?? null,
        mainPassTriangles: stats.mainPassTriangles ?? null, geometries: stats.geometries ?? null, textures: stats.textures ?? null,
        visibleSmoke: stats.visibleSmoke ?? null, activeSkidSegments: stats.activeSkidSegments ?? null,
        simulationTick: tick ?? null, paused, quality: currentQuality,
      });
      if (stopAtLapEnd && window.__L3_CONTROLLER__.telemetry.at(-1)?.routeProgressM >= window.__L3_CONTROLLER__.routeLengthM - 7) return finish('first-lap-end');
      if (now - started >= durationMs) return finish('duration-limit');
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), { durationMs, expectedQuality: quality, stopAtLapEnd });

  let warmup = null;
  if (mode === 'smoke') {
    warmup = await sample({ durationMs: smokeSeconds * 1000 });
  } else {
    warmup = await sample({ durationMs: warmupSeconds * 1000 });
    await page.evaluate(() => {
      window.__L3_CONTROLLER__.stop();
      window.__L3_PAD__.axes.fill(0);
      for (const button of window.__L3_PAD__.buttons) { button.value = 0; button.pressed = false; }
    });
    await page.keyboard.down('KeyR');
    await page.waitForTimeout(80);
    await page.keyboard.up('KeyR');
    await page.waitForTimeout(250);
    const resetVerification = await page.evaluate(() => {
      const view = window.__LATERAL_QA__.view;
      const spawn = view.route.spawn.position;
      const position = view.frame.current.position;
      return {
        position,
        spawn,
        distanceM: Math.hypot(position.x - spawn.x, position.z - spawn.z),
        speedMS: Math.hypot(view.frame.current.linearVelocityMS.x, view.frame.current.linearVelocityMS.z),
      };
    });
    if (resetVerification.distanceM > 1.5 || resetVerification.speedMS > 0.5) {
      throw new Error(`Safe-spawn reset was not verified: ${JSON.stringify(resetVerification)}`);
    }
    // Begin the measured first lap from the runtime's actual safe spawn.
    await page.evaluate(() => { window.__L3_CONTROLLER__.reseed(); window.__L3_CONTROLLER__.start(); });
    const measured = await sample({ durationMs: maxLapSeconds * 1000, stopAtLapEnd: true });
    const telemetry = await page.evaluate(() => window.__L3_CONTROLLER__.telemetry);
    const routeValidity = validateRouteTelemetry(telemetry, controller.routeLengthM);
    if (!routeValidity.valid) {
      throw new Error(`Invalid bounded first-lap segment: end=${measured.reason}, route legal ${(100 * routeValidity.legalRatio).toFixed(1)}%, road contact ${(100 * routeValidity.roadContactRatio).toFixed(1)}%, progress=${routeValidity.measuredProgressM.toFixed(1)}m/${routeValidity.requiredProgressM.toFixed(1)}m minimum`);
    }
    warmup.measured = measured;
    warmup.routeTelemetry = telemetry;
    warmup.routeValidity = routeValidity;
    warmup.resetVerification = resetVerification;
    warmup.controller = controller;
  }

  const outcome = mode === 'smoke' ? warmup : warmup.measured;
  const samples = outcome.samples;
  let capture = null;
  {
    const capturePath = outputPath.replace(/\.json$/i, '.png');
    const readCaptureContext = () => page.evaluate(() => {
      const bridge = window.__LATERAL_BENCH__;
      const view = window.__LATERAL_QA__.view;
      const frame = view.frame.current;
      return {
        phase: 'after-sampling',
        identity: bridge.identity,
        tick: bridge.tick,
        quality: bridge.quality,
        paused: bridge.paused,
        route: { id: view.route.id, position: frame.position, routeProgressM: window.__L3_CONTROLLER__.telemetry.at(-1)?.routeProgressM ?? null, routeLegal: window.__L3_CONTROLLER__.telemetry.at(-1)?.routeLegal ?? null },
        wheels: frame.wheels.map((wheel) => ({ contact: wheel.contact, surfaceId: wheel.surfaceId, loadN: wheel.normalLoadN })),
      };
    });
    const before = await readCaptureContext();
    await page.screenshot({ path: resolve(capturePath) });
    const after = await readCaptureContext();
    capture = { path: capturePath, phase: 'after-sampling', before, after, tickDelta: after.tick - before.tick, poseTiming: 'QA snapshots bracket the screenshot; they are not claimed to be the exact rendered frame pose' };
    if (mode !== 'smoke') {
      await page.evaluate(() => {
        window.__L3_CONTROLLER__.stop();
        window.__L3_PAD__.axes.fill(0);
        for (const button of window.__L3_PAD__.buttons) { button.value = 0; button.pressed = false; }
      });
    }
  }
  const sampleValidity = validateFrameSamples(samples, quality);
  if (!sampleValidity.valid) {
    throw new Error(`Invalid ${mode} frame samples: ${JSON.stringify(sampleValidity)}`);
  }
  const result = {
    protocol: mode === 'smoke' ? 'L3 bridge/input/browser smoke; synthetic QA gamepad; not a performance result' : 'L3 fixed-preset scripted first-lap active-driving render sample; one rAF observer and 20Hz synthetic QA steering controller',
    scope: mode === 'smoke' ? 'Smoke only; no performance gate claim' : 'Bounded first-lap supplemental host evidence; this does not satisfy the 3x180s PER-01 trial or reference-device matrix',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: true,
    timestamp: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    os: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length },
    graphicsFlags: chromeFlags,
    url: baseUrl,
    requestedQuality: quality,
    viewport: { width, height, deviceScaleFactor: 1 },
    setup,
    protocolTiming: mode === 'smoke' ? { smokeSeconds } : { warmupSeconds, warmupStartMetrics: warmup.metricsAtStart, warmupSummary: summarizeFrames(warmup.samples), runMaxSeconds: maxLapSeconds, measuredElapsedMs: outcome.elapsedMs, resetVerification: warmup.resetVerification },
    sampleValidity,
    sampleSummary: summarizeFrames(samples),
    bridgeMetrics: {
      atSampleStart: outcome.metricsAtStart,
      runtimeFrameIntervalsAtSampleStart: outcome.intervalsAtStart,
      afterSample: outcome.metricsAtEnd,
      runtimeFrameIntervalsAfterSample: outcome.intervalsAtEnd,
    },
    rawSamples: samples,
    capture,
    ...(mode === 'first-lap' ? { route: { ...controller, ...warmup.routeValidity, samples: warmup.routeTelemetry, resetCountBeforeMeasuredSegment: 1, resetMethod: 'Keyboard KeyR edge to GameRuntime safe spawn; tracker reseeded; warmup excluded' } } : {}),
    measurementLimits: {
      gpuTiming: 'null unless the application bridge supplies a valid disjoint-safe timer-query measurement',
      memory: 'renderer.info geometry/texture counts only; no VRAM byte estimate',
      cpuCounters: 'null unless measured by the application bridge',
      input: 'Synthetic QA gamepad; controller samples the read-only QA snapshot at 20Hz and its overhead is included',
      route: mode === 'first-lap' ? 'A bounded segment of the first authored-route lap is measured; no completed lap, multi-lap continuity or 180s PER-01 claim is implied' : 'Not assessed in the short smoke',
    },
    pageErrors,
    consoleErrors,
    consoleWarnings,
    captureActive: false,
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, mode, quality, summary: result.sampleSummary, setup, routeValid: result.route?.valid ?? null, pageErrors, consoleErrors, consoleWarnings }, null, 2));
  if (pageErrors.length || consoleErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
