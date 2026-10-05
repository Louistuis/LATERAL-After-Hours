/** Owner-review-only gameplay capture. Controls enter through the shipped PlayerInput. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const url = process.env.LATERAL_URL ?? 'http://127.0.0.1:4173/';
const output = resolve(process.env.S2_VISUAL_DIR ?? 'evidence/S2/2026-09-30/pinned-visual');
const expectedCommit = process.env.S2_EXPECT_COMMIT;
const requestedCar = process.env.S2_CAR_ID ?? 'CAR-01';
if (!['CAR-01', 'CAR-02'].includes(requestedCar)) throw new Error(`Unsupported visual probe car ${requestedCar}`);
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
const uiTrace = [];
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
  let garage = null;
  if (requestedCar !== 'CAR-01') {
    const traceGarage = async (step) => {
      const state = await page.evaluate(() => ({
        profileSwitch: document.querySelector('.lp-garage [data-action="profile"]')?.textContent?.trim() ?? null,
        selectedCar: document.querySelector('select[data-select="car"]')?.value ?? null,
        car02Disabled: document.querySelector('select[data-select="car"] option[value="CAR-02"]')?.disabled ?? null,
        error: document.querySelector('.lp-error')?.textContent?.trim() ?? null,
        runtimeCar: window.__LATERAL_QA__?.view?.carId ?? null,
      }));
      uiTrace.push({ step, state });
    };
    await page.getByRole('button', { name: 'Garage', exact: true }).click();
    await page.locator('.lp-garage select[data-select="car"]').waitFor({ timeout: 10_000 });
    await traceGarage('garage-open');
    const profileToggle = page.locator('.lp-garage [data-action="profile"]');
    await profileToggle.waitFor({ timeout: 10_000 });
    if ((await profileToggle.textContent())?.includes('sandbox')) {
      await profileToggle.click();
      await page.getByRole('button', { name: 'Switch to career', exact: true }).waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await traceGarage('after-sandbox-switch');
      if (!(await page.getByRole('button', { name: 'Switch to career', exact: true }).isVisible())) {
        const message = await page.locator('.lp-error').textContent();
        throw new Error(`Sandbox profile reverted before car selection: ${message}`);
      }
    }
    await page.waitForFunction(() => {
      const option = document.querySelector('select[data-select="car"] option[value="CAR-02"]');
      return option?.disabled === false;
    }, null, { timeout: 10_000 });
    await page.locator('select[data-select="car"]').selectOption(requestedCar);
    await traceGarage('after-car-select-event');
    try {
      await page.waitForFunction(carId => window.__LATERAL_QA__.view.carId === carId, requestedCar, { timeout: 20_000 });
    } catch (error) {
      await traceGarage('after-car-wait-timeout');
      await page.screenshot({ path: resolve(output, 'car-selection-failure.png') });
      await writeFile(resolve(output, 'car-selection-attempt.json'), `${JSON.stringify({
        scope: 'failed CAR02 UI selection; no visual acceptance', identity: setup.identity, requestedCar,
        uiTrace, errors, warnings,
      }, null, 2)}\n`);
      throw new Error(`Garage car switch did not settle: ${JSON.stringify(uiTrace.at(-1)?.state)}`, { cause: error });
    }
    const choices = await page.locator('button[data-cosmetic]').evaluateAll(buttons => buttons.map(button => ({
      id: button.getAttribute('data-cosmetic'), label: button.textContent?.trim(), selected: button.getAttribute('aria-pressed') === 'true',
    })));
    const alternatePaint = choices.find(choice => choice.id === 'paint:oxide-copper' && !choice.selected);
    if (alternatePaint) {
      await page.locator(`button[data-cosmetic="${alternatePaint.id}"]`).click();
      await page.locator(`button[data-cosmetic="${alternatePaint.id}"][aria-pressed="true"]`).waitFor({ timeout: 10_000 });
    }
    garage = {
      selectedCar: await page.locator('select[data-select="car"]').inputValue(),
      choices,
      chosenPaint: alternatePaint?.id ?? null,
      chosenPaintSelected: alternatePaint ? await page.locator(`button[data-cosmetic="${alternatePaint.id}"]`).getAttribute('aria-pressed') : null,
    };
    await page.screenshot({ path: resolve(output, 'garage-cosmetics.png') });
  }
  await page.getByRole('button', { name: 'Drive', exact: true }).click({ force: true, timeout: 20_000 });
  await page.waitForFunction(() => window.__LATERAL_BENCH__?.paused === false, null, { timeout: 10_000 });
  await page.waitForFunction(carId => window.__LATERAL_QA__?.view?.carId === carId, requestedCar, { timeout: 10_000 });
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
      identity: bridge.identity, carId: view.carId, tick: vehicle.simulationTick, paused: bridge.paused, quality: bridge.quality,
      position: vehicle.position, speedMS: Math.hypot(vehicle.linearVelocityMS.x, vehicle.linearVelocityMS.z),
      driftAngleRad: vehicle.driftAngleRad,
      routeProgressM: window.__S2_VIS__.progressM, routeDistanceM: window.__S2_VIS__.distanceM,
      lateralOffsetM: window.__S2_VIS__.offsetM, routeLegal: window.__S2_VIS__.legal,
      wheels: vehicle.wheels.map(wheel => ({ contact: wheel.contact, surfaceId: wheel.surfaceId, loadN: wheel.normalLoadN })),
      stats: bridge.stats,
      canvas: { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, width: canvas.width, height: canvas.height },
    };
  });
  const captures = [];
  const capture = async (name) => {
    const before = await sample();
    const file = resolve(output, `${name}.png`);
    await page.screenshot({ path: file });
    const after = await sample();
    captures.push({ name, file, before, after, poseTiming: 'QA snapshots bracket screenshot, not exact screenshot-frame pose' });
  };
  await page.waitForFunction(() => window.__S2_VIS__?.progressM >= 58 && window.__S2_VIS__?.legal, null, { timeout: 60_000 });
  await capture('road-early-1280');
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForFunction(() => document.querySelector('canvas')?.clientWidth === 640 && document.querySelector('canvas')?.width === 640, null, { timeout: 10_000 });
  await capture('road-early-640');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => document.querySelector('canvas')?.clientWidth === 1280 && document.querySelector('canvas')?.width === 1280, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__S2_VIS__?.progressM >= 245 && window.__S2_VIS__?.legal, null, { timeout: 80_000 });
  await capture('road-cargo-1280');
  const report = { scope: 'pinned full-shell visual review, not performance or scored-drift evidence', url,
    runnerSha256, browser: browser.version(), flags, setup, requestedCar, garage, uiTrace, captures, errors, warnings };
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ identity: setup.identity, graphics: setup.graphics,
    captures: captures.map(item => ({ name: item.name, progressBefore: item.before.routeProgressM,
      progressAfter: item.after.routeProgressM, legalBefore: item.before.routeLegal,
      legalAfter: item.after.routeLegal, roadContactsBefore: item.before.wheels.filter(w => w.contact && w.surfaceId === 'road:harbor:hw01').length,
      roadContactsAfter: item.after.wheels.filter(w => w.contact && w.surfaceId === 'road:harbor:hw01').length })), errors, warnings }, null, 2));
  await page.evaluate(() => window.__S2_VIS__.stop());
} finally {
  await browser.close();
}
