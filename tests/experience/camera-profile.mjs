/** Bounded same-pose browser CPU sample near the HW-01 cargo corner. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const url = process.env.LATERAL_URL ?? 'http://127.0.0.1:4173/';
const output = resolve(process.env.S3_CAMERA_PROFILE_DIR ?? 'evidence/S3/camera-profile-pinned-8a');
const expectedCommit = process.env.S3_EXPECT_COMMIT;
const flags = ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'];
const runnerSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: flags });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { connected: true, buttons, axes: [0, 0, 0, 0], id: 'S2 visual QA controller', index: 0, mapping: 'standard', timestamp: 1 };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
  window.__S2_PAD__ = pad;
});

const page = await context.newPage();
const errors = [], warnings = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.version === 1 && window.__LATERAL_QA__?.view?.route, null, { timeout: 30_000 });
  const setup = await page.evaluate(async () => {
    const bridge = window.__LATERAL_BENCH__;
    bridge.setQuality('balanced');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (bridge.quality !== 'balanced' || bridge.stats.quality !== 'balanced') throw new Error('Balanced preset was not applied');
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 canvas is unavailable');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      identity: bridge.identity,
      quality: bridge.quality,
      graphics: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl: gl.getParameter(gl.VERSION),
      route: { id: window.__LATERAL_QA__.view.route.id, version: window.__LATERAL_QA__.view.route.version },
    };
  });
  if (expectedCommit && setup.identity.commit !== expectedCommit) throw new Error(`Expected pinned ${expectedCommit}, got ${setup.identity.commit}`);
  if (setup.identity.workingTreeDirty) throw new Error('Static build identity is marked dirty');
  if (/SwiftShader|llvmpipe|Software/i.test(setup.graphics)) throw new Error(`Hardware GL path not active: ${setup.graphics}`);
  await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true, timeout: 20_000 });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === false, null, { timeout: 10_000 });
  await page.waitForTimeout(250); // neutral input clears PlayerInput's reconnect block

  await page.evaluate(() => {
    const route = window.__LATERAL_QA__.view.route;
    const points = route.centerline;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
    const axis = value => Math.sign(value) * (value === 0 ? 0 : .14 + .86 * Math.pow(Math.abs(value), 1 / 1.35));
    const trigger = value => value <= 0 ? 0 : .08 + .92 * value;
    const pointAt = distance => {
      const d = clamp(distance, 0, cumulative.at(-1));
      let index = 1;
      while (index < cumulative.length - 1 && cumulative[index] < d) index++;
      const a = points[index - 1], b = points[index];
      const t = (d - cumulative[index - 1]) / Math.max(1e-9, cumulative[index] - cumulative[index - 1]);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    let segment = 0, progressM = 0, distanceM = 0, offsetM = 0, legal = true;
    const update = () => {
      const current = window.__LATERAL_QA__.view.frame.current;
      const pos = current.position;
      let nearest = Infinity, candidateProgress = progressM, bestSegment = segment, lateral = 0;
      for (let i = Math.max(0, segment - 3); i < Math.min(points.length - 1, segment + 9); i++) {
        const a = points[i], b = points[i + 1], dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const length2 = dx * dx + dy * dy + dz * dz;
        const t = length2 ? clamp(((pos.x - a.x) * dx + (pos.y - a.y) * dy + (pos.z - a.z) * dz) / length2, 0, 1) : 0;
        const distance = Math.hypot(pos.x - a.x - t * dx, pos.y - a.y - t * dy, pos.z - a.z - t * dz);
        if (distance < nearest) {
          nearest = distance; candidateProgress = cumulative[i] + t * Math.sqrt(length2); bestSegment = i;
          const horizontal = Math.hypot(dx, dz);
          lateral = horizontal > 1e-6 ? ((pos.x - a.x - t * dx) * -dz + (pos.z - a.z - t * dz) * dx) / horizontal : 0;
        }
      }
      legal = nearest <= route.widthM * .5 + 1.5 && candidateProgress + 2 >= progressM;
      if (legal) { progressM = Math.max(progressM, candidateProgress); segment = bestSegment; }
      distanceM = nearest; offsetM = lateral;
      const speed = Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z);
      const target = pointAt(progressM + Math.max(5, speed * .42));
      const q = current.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(target.x - pos.x, -(target.z - pos.z));
      const steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
      const pad = window.__S2_PAD__;
      pad.axes[0] = axis(steering);
      pad.buttons[7].value = trigger(speed < 8 ? .72 : .08);
      pad.buttons[7].pressed = pad.buttons[7].value > .5;
      pad.buttons[6].value = trigger(speed > 9.5 ? .35 : 0);
      pad.buttons[6].pressed = pad.buttons[6].value > .5;
    };
    const timer = window.setInterval(update, 50);
    window.__S2_VIS__ = {
      get progressM() { return progressM; }, get distanceM() { return distanceM; },
      get offsetM() { return offsetM; }, get legal() { return legal; },
      stop() { window.clearInterval(timer); window.__S2_PAD__.buttons[7].value = 0; window.__S2_PAD__.axes[0] = 0; },
    };
    update();
  });

  const sample = () => page.evaluate(() => {
    const bridge = window.__LATERAL_BENCH__, view = window.__LATERAL_QA__.view, vehicle = view.frame.current;
    const canvas = document.querySelector('canvas');
    return {
      identity: bridge.identity, tick: vehicle.simulationTick, paused: bridge.paused, quality: bridge.quality,
      position: vehicle.position, speedMS: Math.hypot(vehicle.linearVelocityMS.x, vehicle.linearVelocityMS.z),
      driftAngleRad: vehicle.driftAngleRad,
      routeProgressM: window.__S2_VIS__.progressM, routeDistanceM: window.__S2_VIS__.distanceM,
      lateralOffsetM: window.__S2_VIS__.offsetM, routeLegal: window.__S2_VIS__.legal,
      wheels: vehicle.wheels.map(wheel => ({ contact: wheel.contact, surfaceId: wheel.surfaceId, loadN: wheel.normalLoadN })),
      stats: bridge.stats,
      canvas: { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, width: canvas.width, height: canvas.height },
    };
  });
  await page.waitForFunction(() => window.__S2_VIS__?.progressM >= 245 && window.__S2_VIS__?.legal, null, { timeout: 80_000 });
  await page.evaluate(() => window.__S2_VIS__.stop());
  await page.getByRole('button', { name: 'Pause game' }).click({ force: true });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === true, null, { timeout: 5_000 });
  await page.waitForTimeout(200);
  const before = await sample();
  const client = await context.newCDPSession(page);
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 100 });
  await client.send('Profiler.start');
  await page.waitForTimeout(3000);
  const { profile } = await client.send('Profiler.stop');
  await client.send('Profiler.disable');
  const after = await sample();
  const stablePose = before.tick === after.tick && before.paused && after.paused &&
    before.position.x === after.position.x && before.position.z === after.position.z;
  if (!stablePose || !before.routeLegal || before.wheels.filter(wheel => wheel.contact && wheel.surfaceId === 'road:harbor:hw01').length !== 4) {
    throw new Error('Camera CPU sample did not stay at a legal four-contact HW-01 cargo pose');
  }
  const byName = new Map();
  for (const node of profile.nodes) {
    const name = node.callFrame.functionName || '(anonymous)';
    byName.set(name, (byName.get(name) ?? 0) + (node.hitCount ?? 0));
  }
  const topSelfSamples = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const report = { scope: 'three-second CDP CPU sample at paused legal cargo pose; diagnostic only, not FPS or performance acceptance', url,
    runnerSha256, browser: browser.version(), flags, setup, before, after, stablePose,
    profileSummary: { durationUs: profile.endTime - profile.startTime, totalSamples: profile.samples?.length ?? 0,
      topSelfSamples, cameraNamedNodes: profile.nodes.filter(node => /intersect|raycast|avoidOcclusion|updateProjectionMatrix/i.test(node.callFrame.functionName))
        .map(node => ({ name: node.callFrame.functionName, hitCount: node.hitCount ?? 0, url: node.callFrame.url })) },
    errors, warnings };
  await writeFile(resolve(output, 'cpu-profile.json'), `${JSON.stringify(profile)}\n`);
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ identity: setup.identity, graphics: setup.graphics, stablePose,
    routeProgressM: before.routeProgressM, roadContacts: before.wheels.filter(w => w.contact && w.surfaceId === 'road:harbor:hw01').length,
    profileSummary: report.profileSummary, errors, warnings }, null, 2));
} finally {
  await browser.close();
}
