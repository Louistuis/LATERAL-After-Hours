import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { cpus, platform, release, arch } from 'node:os';
import { chromium } from '@playwright/test';
import { validatePassCensusRecord } from './pass-census-contract.mjs';

const baseUrl = process.env.L3_CENSUS_URL;
const outputPath = process.env.L3_CENSUS_OUTPUT;
const quality = process.env.L3_CENSUS_QUALITY ?? 'balanced';
const targetProgressM = Number(process.env.L3_CENSUS_TARGET_PROGRESS_M ?? 225);
const expected = {
  buildId: process.env.L3_CENSUS_EXPECTED_BUILD_ID,
  commit: process.env.L3_CENSUS_EXPECTED_COMMIT,
  sourceHash: process.env.L3_CENSUS_EXPECTED_SOURCE_HASH,
  contentHash: process.env.L3_CENSUS_EXPECTED_CONTENT_HASH,
};
const flags = ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'];

if (!baseUrl || !outputPath || Object.values(expected).some(value => !value)) {
  throw new Error('Require L3_CENSUS_URL, L3_CENSUS_OUTPUT, and expected buildId/commit/sourceHash/contentHash environment values');
}
if (!['low', 'balanced', 'high'].includes(quality)) throw new Error(`Invalid L3_CENSUS_QUALITY: ${quality}`);
if (!Number.isFinite(targetProgressM) || targetProgressM < 20 || targetProgressM > 500) {
  throw new Error('L3_CENSUS_TARGET_PROGRESS_M must be between 20 and 500m');
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: flags });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { connected: true, buttons, axes: [0, 0, 0, 0], id: 'L3 census QA controller', index: 0, mapping: 'standard', timestamp: 1, vibrationActuator: null };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
  window.__L3_PAD__ = pad;
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const consoleWarnings = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});

function assertExpectedIdentity(identity) {
  for (const [field, value] of Object.entries(expected)) {
    if (identity?.[field] !== value) throw new Error(`Pinned build mismatch: ${field} expected ${value}, got ${identity?.[field]}`);
  }
  if (identity?.target !== 'owner-review' || identity?.workingTreeDirty !== false) {
    throw new Error('Expected a clean owner-review build identity');
  }
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.version === 1 && window.__LATERAL_QA__);
  const setup = await page.evaluate(async requestedQuality => {
    const bridge = window.__LATERAL_BENCH__;
    if (!Object.isFrozen(bridge)) throw new Error('Expected frozen version-1 owner-review bridge');
    bridge.setQuality(requestedQuality);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (bridge.quality !== requestedQuality || bridge.stats?.quality !== requestedQuality) {
      throw new Error(`Preset mismatch: requested ${requestedQuality}, bridge/stage report ${bridge.quality}/${bridge.stats?.quality}`);
    }
    const canvas = document.querySelector('canvas');
    if (!canvas || canvas.clientWidth !== 1280 || canvas.clientHeight !== 720 || canvas.width !== 1280 || canvas.height !== 720) {
      throw new Error('Expected 1280x720 CSS and render dimensions');
    }
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 unavailable');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const identity = window.structuredClone(bridge.identity);
    const route = window.__LATERAL_QA__.view.route;
    if (route?.id !== 'HW-01' || !route.centerline?.length || !route.widthM) throw new Error('Expected loaded HW-01 route');
    return {
      identity, quality: bridge.quality, pausedAtBoot: bridge.paused,
      canvasCss: { width: canvas.clientWidth, height: canvas.clientHeight },
      canvasRender: { width: canvas.width, height: canvas.height },
      graphics: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl: gl.getParameter(gl.VERSION),
      route: { id: route.id, lengthM: route.lengthM, widthM: route.widthM, centerlinePoints: route.centerline.length },
    };
  }, quality);
  assertExpectedIdentity(setup.identity);

  await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true, timeout: 20_000 });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === false, { timeout: 10_000 });
  await page.waitForTimeout(250);
  await page.evaluate(target => {
    const view = window.__LATERAL_QA__.view;
    const route = view.route;
    const points = route.centerline;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const pointAt = distance => {
      const d = Math.max(0, Math.min(cumulative.at(-1), distance));
      let i = 1;
      while (i < cumulative.length - 1 && cumulative[i] < d) i++;
      const a = points[i - 1], b = points[i];
      const t = (d - cumulative[i - 1]) / Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    const project = position => {
      let nearest = Infinity, progress = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const length2 = dx * dx + dy * dy + dz * dz;
        const t = length2 ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy + (position.z - a.z) * dz) / length2)) : 0;
        const distance = Math.hypot(position.x - a.x - t * dx, position.y - a.y - t * dy, position.z - a.z - t * dz);
        if (distance < nearest) { nearest = distance; progress = cumulative[i - 1] + t * Math.sqrt(length2); }
      }
      return { routeDistanceM: nearest, routeProgressM: progress };
    };
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
    const invertAxis = value => Math.sign(value) * (value === 0 ? 0 : .14 + .86 * Math.pow(Math.abs(value), 1 / 1.35));
    const trigger = value => value <= 0 ? 0 : .08 + .92 * value;
    const pad = window.__L3_PAD__;
    const driver = { timer: null, telemetry: [], targetReached: false, stop() {
      if (driver.timer !== null) window.clearInterval(driver.timer);
      driver.timer = null; pad.axes[0] = 0; pad.buttons[7].value = 0; pad.buttons[7].pressed = false;
      pad.buttons[6].value = 0; pad.buttons[6].pressed = false;
    } };
    const update = () => {
      const current = window.__LATERAL_QA__.view.frame.current;
      const pos = current.position;
      const projected = project(pos);
      const speed = Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z);
      const aim = pointAt(projected.routeProgressM + Math.max(5, speed * .42));
      const q = current.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(aim.x - pos.x, -(aim.z - pos.z));
      const steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
      pad.axes[0] = invertAxis(steering);
      pad.buttons[7].value = trigger(speed < 8 ? .72 : .08);
      pad.buttons[7].pressed = pad.buttons[7].value > .5;
      pad.buttons[6].value = trigger(speed > 9.5 ? .35 : 0);
      pad.buttons[6].pressed = pad.buttons[6].value > .5;
      const roadWheelContactCount = current.wheels.filter(w => w.contact && String(w.surfaceId).startsWith('road:')).length;
      driver.telemetry.push({ tick: current.simulationTick, ...projected, speedMS: speed, roadWheelContactCount });
      if (projected.routeProgressM >= target && projected.routeDistanceM <= route.widthM * .5 + 1.5 && roadWheelContactCount === 4) {
        driver.targetReached = true;
        driver.stop();
      }
    };
    driver.timer = window.setInterval(update, 50);
    update();
    window.__L3_CENSUS_DRIVER__ = driver;
  }, targetProgressM);

  await page.waitForFunction(() => window.__L3_CENSUS_DRIVER__?.targetReached === true, { timeout: 45_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === true, { timeout: 10_000 });
  const poseBefore = await page.evaluate(() => {
    const view = window.__LATERAL_QA__.view;
    const current = view.frame.current;
    const points = view.route.centerline;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    let routeDistanceM = Infinity, routeProgressM = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const length2 = dx * dx + dy * dy + dz * dz;
      const t = length2 ? Math.max(0, Math.min(1, ((current.position.x - a.x) * dx + (current.position.y - a.y) * dy + (current.position.z - a.z) * dz) / length2)) : 0;
      const distance = Math.hypot(current.position.x - a.x - t * dx, current.position.y - a.y - t * dy, current.position.z - a.z - t * dz);
      if (distance < routeDistanceM) { routeDistanceM = distance; routeProgressM = cumulative[i - 1] + t * Math.sqrt(length2); }
    }
    const wheels = current.wheels.filter(w => w.contact && String(w.surfaceId).startsWith('road:')).length;
    const routeLegal = routeDistanceM <= view.route.widthM * .5 + 1.5;
    return {
      routeId: view.route.id, routeProgressM, routeDistanceM, routeLegal, roadWheelContactCount: wheels,
      tick: current.simulationTick,
      position: { ...current.position }, rotation: { ...current.rotation },
      speedMS: Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.y, current.linearVelocityMS.z),
    };
  });
  if (!poseBefore.routeLegal || poseBefore.roadWheelContactCount !== 4 || Math.abs(poseBefore.routeProgressM - targetProgressM) > 12) {
    throw new Error(`Paused pose invalid or outside match window: ${JSON.stringify(poseBefore)}`);
  }

  await page.evaluate(() => {
    const bridge = window.__LATERAL_BENCH__;
    if (!bridge.paused || bridge.contextState !== 'ready') throw new Error('Census requires a paused game and ready WebGL context');
    if (bridge.passCensus !== null) throw new Error('Unexpected stale pass-census result before request');
    bridge.requestPassCensus();
  });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.passCensus !== null, { timeout: 5_000 });
  const result = await page.evaluate(() => {
    const bridge = window.__LATERAL_BENCH__;
    const view = window.__LATERAL_QA__.view;
    const current = view.frame.current;
    return {
      identity: window.structuredClone(bridge.identity), quality: bridge.quality,
      paused: bridge.paused, contextState: bridge.contextState, tickAfter: bridge.tick,
      framePose: { position: { ...current.position }, rotation: { ...current.rotation } },
      stats: window.structuredClone(bridge.stats), census: bridge.passCensus,
    };
  });
  assertExpectedIdentity(result.identity);
  if (result.quality !== quality) throw new Error(`Census preset changed: requested ${quality}, bridge reports ${result.quality}`);
  const samePoseAfter = poseBefore.tick === result.tickAfter
    && JSON.stringify(poseBefore.position) === JSON.stringify(result.framePose.position)
    && JSON.stringify(poseBefore.rotation) === JSON.stringify(result.framePose.rotation);
  const record = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    workload: 'one explicitly requested owner-review paused render; no frame-time sampling',
    url: baseUrl,
    identity: result.identity,
    route: setup.route,
    quality: result.quality,
    contextState: result.contextState,
    paused: result.paused,
    targetProgressM,
    pose: { ...poseBefore, tickBefore: poseBefore.tick, tickAfter: result.tickAfter, samePoseAfter },
    snapshotBracket: {
      beforeCensus: {
        tick: poseBefore.tick, position: poseBefore.position, rotation: poseBefore.rotation,
        paused: true, quality: result.quality, contextState: result.contextState,
        routeId: poseBefore.routeId, routeProgressM: poseBefore.routeProgressM,
        routeDistanceM: poseBefore.routeDistanceM, routeLegal: poseBefore.routeLegal,
        roadWheelContactCount: poseBefore.roadWheelContactCount,
      },
      afterCensus: {
        tick: result.tickAfter, position: result.framePose.position, rotation: result.framePose.rotation,
        paused: result.paused, quality: result.quality, contextState: result.contextState,
      },
    },
    diagnosticFrame: {
      tick: result.tickAfter, quality: result.quality, contextState: result.contextState,
      stageCounters: {
        drawCallsAllPasses: result.stats?.drawCallsAllPasses ?? null,
        trianglesAllPasses: result.stats?.trianglesAllPasses ?? null,
      },
      census: result.census,
    },
    host: {
      os: `${platform()} ${release()}`, arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length,
      chromium: browser.version(), flags, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      graphics: setup.graphics, webgl: setup.webgl,
    },
    pageErrors, consoleErrors, consoleWarnings,
  };
  const validation = validatePassCensusRecord(record);
  if (!validation.valid) throw new Error(`Pass-census record failed validation: ${validation.errors.join('; ')}`);
  if (pageErrors.length || consoleErrors.length) throw new Error(`Browser errors: ${[...pageErrors, ...consoleErrors].join(' | ')}`);
  record.localSource = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    helperSha256: execFileSync('sha256sum', ['src/render/pass-census.ts'], { encoding: 'utf8' }).trim().split(/\s+/)[0],
    parserSha256: execFileSync('sha256sum', ['tools/benchmark/pass-census-contract.mjs'], { encoding: 'utf8' }).trim().split(/\s+/)[0],
    runnerSha256: execFileSync('sha256sum', ['tools/benchmark/render-pass-census.mjs'], { encoding: 'utf8' }).trim().split(/\s+/)[0],
    localStatus: execFileSync('git', ['status', '--short', '--', 'src/render/pass-census.ts', 'tools/benchmark/pass-census-contract.mjs', 'tools/benchmark/render-pass-census.mjs'], { encoding: 'utf8' }).trim(),
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, identity: record.identity, quality, pose: record.pose, census: record.census, pageErrors, consoleErrors, consoleWarnings }, null, 2));
} finally {
  await browser.close();
}
