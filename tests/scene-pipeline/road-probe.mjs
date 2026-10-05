/** Browser-only on-road steering probe; never part of the shipped game. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] ?? 'hero-probe';
const clipMode = process.env.LATERAL_CLIP_CAPTURE === '1';
const quality = process.env.LATERAL_PROBE_QUALITY ?? 'balanced';
const baseUrl = process.env.LATERAL_PROBE_URL ?? 'http://127.0.0.1:5174/';
const out = fileURLToPath(new URL('../../evidence/S2/2026-09-30/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.route('**/@vite/client*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.route('**/src/core/main.ts*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  const errors = [], warnings = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const setup = await page.evaluate(async selectedQuality => {
    const { createScenePipeline } = await import('/src/scene-pipeline/index.ts');
    const { GameRuntime } = await import('/src/core/game-runtime.ts');
    const { RouteProgressTracker } = await import('/src/core/route-progress.ts');
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#17242b';
    document.querySelector('#app')?.remove();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.append(canvas);
    const scene = await createScenePipeline(canvas, { quality: selectedQuality, lighting: 'golden-hour' });
    scene.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    const route = scene.world.routes[0];
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    const cumulative = [0];
    for (let i = 1; i < route.centerline.length; i++) {
      const a = route.centerline[i - 1], b = route.centerline[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const pointAt = distance => {
      const d = Math.min(cumulative.at(-1), distance);
      let i = 1;
      while (i < cumulative.length - 1 && cumulative[i] < d) i++;
      const a = route.centerline[i - 1], b = route.centerline[i];
      const t = (d - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1]);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    let runtime;
    let progress = tracker.update(route.spawn.position);
    const input = {
      read(tick) {
        const current = runtime.simulation.snapshot();
        const speed = Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z);
        const target = pointAt(progress.progressM + Math.max(5, speed * .42));
        const q = current.rotation;
        const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const heading = Math.atan2(fx, -fz);
        const desired = Math.atan2(target.x - current.position.x, -(target.z - current.position.z));
        const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
        const steering = Math.max(-1, Math.min(1, wrap(desired - heading) * 1.6));
        progress = tracker.update(current.position);
        return {
          simulationTick: tick,
          throttle: speed < 8 ? .72 : .08,
          brake: speed > 9.5 ? .35 : 0,
          steering,
          handbrake: 0,
          shift: 0,
          resetPressed: false,
        };
      },
      clear() {},
    };
    runtime = await GameRuntime.create(scene, input);
    runtime.start();
    window.__heroProbe = { runtime, scene, tracker, getProgress: () => progress };
    const gl = scene.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      routes: scene.world.routes.map(route => ({ id: route.id, lengthM: route.lengthM, checkpoints: route.checkpoints.length,
        clippingZones: route.clippingZones ?? [] })),
      colliders: scene.world.collisionMeshes.map(mesh => ({ id: mesh.surfaceId, drivableRoad: mesh.drivableRoad, triangles: mesh.indices.length / 3 })),
    };
  }, quality);
  let captures;
  if (clipMode) {
    await page.waitForFunction(() => window.__heroProbe.getProgress().progressM >= 75, null, { timeout: 90_000 });
    await page.screenshot({ path: join(out, `${label}-clip-approach.png`) });
    await page.waitForFunction(() => window.__heroProbe.getProgress().progressM >= 104, null, { timeout: 90_000 });
    await page.screenshot({ path: join(out, `${label}-clip-near.png`) });
    captures = [`${label}-clip-approach.png`, `${label}-clip-near.png`];
  } else {
    await page.waitForFunction(() => window.__heroProbe.runtime.view().frame.current.simulationTick >= 180, null, { timeout: 60_000 });
    await page.screenshot({ path: join(out, `${label}-t180.png`) });
    await page.waitForFunction(() => window.__heroProbe.runtime.view().frame.current.simulationTick >= 360, null, { timeout: 60_000 });
    await page.screenshot({ path: join(out, `${label}-t360.png`) });
    captures = [`${label}-t180.png`, `${label}-t360.png`];
  }
  const status = await page.evaluate(() => {
    const { runtime, scene } = window.__heroProbe;
    const vehicle = runtime.view().frame.current;
    return {
      tick: vehicle.simulationTick,
      position: vehicle.position,
      speedMS: Math.hypot(vehicle.linearVelocityMS.x, vehicle.linearVelocityMS.z),
      driftAngleRad: vehicle.driftAngleRad,
      routeProgress: window.__heroProbe.getProgress(),
      contacts: vehicle.wheels.map(wheel => ({ contact: wheel.contact, surfaceId: wheel.surfaceId, load: wheel.normalLoadN, slipAngle: wheel.slipAngleRad })),
      stats: scene.lastStats,
      canvas: { width: scene.renderer.domElement.width, height: scene.renderer.domElement.height },
    };
  });
  const report = {
    base: '847bf0cbe1c08e5ff78e6347c2dee1d829fc1214',
    sourceState: 'uncommitted shared worktree',
    browser: 'Chromium 148.0.7778.178 headless',
    flags: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
    viewport: '1280x720', label, baseUrl, quality, setup, status, errors, warnings,
    captures,
  };
  await writeFile(join(out, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await page.evaluate(() => window.__heroProbe.runtime.dispose());
} finally {
  await browser.close();
}
