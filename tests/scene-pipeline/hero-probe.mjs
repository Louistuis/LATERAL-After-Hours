/** Browser-only authored-scene probe; never part of the shipped game. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] ?? 'hero-probe';
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
  const setup = await page.evaluate(async () => {
    const { createScenePipeline } = await import('/src/scene-pipeline/index.ts');
    const { GameRuntime } = await import('/src/core/game-runtime.ts');
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#17242b';
    document.querySelector('#app')?.remove();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.append(canvas);
    const scene = await createScenePipeline(canvas, { quality: 'balanced', lighting: 'golden-hour' });
    scene.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    const input = {
      read(tick) {
        return {
          simulationTick: tick,
          throttle: tick < 280 ? 1 : 0.45,
          brake: 0,
          steering: tick < 110 ? 0 : tick < 260 ? 0.32 : 0,
          handbrake: tick >= 130 && tick < 195 ? 0.65 : 0,
          shift: 0,
          resetPressed: false,
        };
      },
      clear() {},
    };
    const runtime = await GameRuntime.create(scene, input);
    runtime.start();
    window.__heroProbe = { runtime, scene };
    const gl = scene.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      routes: scene.world.routes.map(route => ({ id: route.id, lengthM: route.lengthM, checkpoints: route.checkpoints.length })),
      colliders: scene.world.collisionMeshes.map(mesh => ({ id: mesh.surfaceId, drivableRoad: mesh.drivableRoad, triangles: mesh.indices.length / 3 })),
    };
  });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(out, `${label}-2s.png`) });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(out, `${label}-5s.png`) });
  const status = await page.evaluate(() => {
    const { runtime, scene } = window.__heroProbe;
    const vehicle = runtime.view().frame.current;
    return {
      tick: vehicle.simulationTick,
      position: vehicle.position,
      speedMS: Math.hypot(vehicle.linearVelocityMS.x, vehicle.linearVelocityMS.z),
      driftAngleRad: vehicle.driftAngleRad,
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
    viewport: '1280x720', label, baseUrl, setup, status, errors, warnings,
    captures: [`${label}-2s.png`, `${label}-5s.png`],
  };
  await writeFile(join(out, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await page.evaluate(() => window.__heroProbe.runtime.dispose());
} finally {
  await browser.close();
}
