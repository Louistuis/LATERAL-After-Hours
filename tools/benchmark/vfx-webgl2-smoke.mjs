import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const url = process.env.LATERAL_URL ?? 'http://127.0.0.1:5173/';
const outputPath = process.env.L3_FIXTURE_JSON ?? 'evidence/L3/2026-09-30/vfx-webgl2-fixture.json';
const screenshotPath = process.env.L3_FIXTURE_PNG ?? resolve(dirname(resolve(outputPath)), 'vfx-webgl2-fixture.png');
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
const consoleWarnings = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});

try {
  // Keep the application boot path out of this isolated renderer fixture.
  await page.route('**/src/core/main.ts', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: '',
  }));
  await page.goto(url);
  const render = await page.evaluate(async () => {
    const source = await (await fetch('/src/vfx/tire-effects.ts')).text();
    const threePath = source.match(/from "(\/node_modules\/\.vite\/deps\/three\.js\?v=[^"]+)"/)?.[1];
    if (!threePath) throw new Error('Could not resolve the Vite Three.js module for this fixture');
    const THREE = await import(threePath);
    const { createTireEffects } = await import('/src/vfx/tire-effects.ts');
    const { applySceneMaterialProfile } = await import('/src/render/material-profile.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    canvas.style.cssText = 'display:block;width:1280px;height:720px';
    document.body.style.cssText = 'margin:0;overflow:hidden';
    document.body.replaceChildren(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#78909c');
    const camera = new THREE.PerspectiveCamera(58, 1280 / 720, 0.1, 100);
    camera.position.set(0, 4, 8);
    camera.lookAt(0, 0, 0);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ name: 'road-asphalt', color: '#454545', roughness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    scene.add(floor, new THREE.HemisphereLight('#ffffff', '#777777', 2));
    const materialProfile = applySceneMaterialProfile(floor);
    const effects = createTireEffects(scene, 'balanced');
    const makeWheel = (x, z, slipping) => ({
      contact: true, position: { x, y: 0.31, z }, rotation: { x: 0, y: 0, z: 0, w: 1 },
      compressionM: 0.08, normalLoadN: 2800, angularVelocityRadS: 0,
      slipRatio: slipping ? 0.4 : 0, slipAngleRad: slipping ? 0.35 : 0, surfaceId: 'asphalt',
    });
    const sources = [makeWheel(-0.78, -0.7, false), makeWheel(0.78, -0.7, false), makeWheel(-0.78, 0.1, true), makeWheel(0.78, 0.1, true)];
    for (let tick = 1; tick <= 60; tick++) {
      const wheels = sources.map((wheel) => ({ ...wheel, position: { ...wheel.position, z: wheel.position.z - tick * 8 / 60 } }));
      const current = {
        simulationTick: tick, carId: 'CAR-01', position: { x: 0, y: 0.7, z: -tick * 8 / 60 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -8 },
        angularVelocityRadS: { x: 0, y: 0, z: 0 }, wheels, engineRpm: 3000, gear: 2, driftAngleRad: 0.2,
      };
      const visual = {
        position: new THREE.Vector3(0, 0.7, current.position.z), rotation: new THREE.Quaternion(),
        velocity: new THREE.Vector3(0, 0, -8),
        wheels: wheels.map((wheel) => ({
          position: new THREE.Vector3(wheel.position.x, wheel.position.y, wheel.position.z),
          rotation: new THREE.Quaternion(), source: wheel,
        })),
        source: current,
      };
      effects.update({
        previous: current, current, interpolationAlpha: 1,
        score: { banked: 0, unbanked: 0, multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: tick / 60 },
      }, visual, 1 / 60, true);
    }
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const result = {
      graphics: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl: gl.getParameter(gl.VERSION),
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      stats: effects.stats(),
      materialProfile,
      glError: gl.getError(),
    };
    effects.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
    return result;
  });
  await page.screenshot({ path: screenshotPath });
  const report = {
    scope: 'isolated VFX shader smoke check on a temporary ground scene; not Harbor gameplay evidence or a performance gate',
    baseCommit: '847bf0cbe1c08e5ff78e6347c2dee1d829fc1214',
    workingTree: true,
    timestamp: new Date().toISOString(),
    url,
    browser: `Chromium ${browser.version()}`,
    flags: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
    fixtureInput: {
      quality: 'balanced',
      outputCanvas: '1280x720',
      ticks: 60,
      dtSeconds: 1 / 60,
      rearWheels: 'both contacting, 2800N, slipRatio 0.4, slipAngle 0.35rad',
      frontWheels: 'contacting, 2800N, no slip',
      vehicleSpeedMS: 8,
      simulationActive: true,
    },
    ...render,
    pageErrors,
    consoleErrors,
    consoleWarnings,
    screenshotPath,
    limitations: [
      'temporary ground and light only; no authored Harbor assets or gameplay camera',
      'single fixture render; no frame-time, GPU-time or memory benchmark',
      'Intel HD Graphics 620 is supplemental hardware and does not satisfy a reference-device row',
      'application entrypoint is intercepted so only the isolated fixture initializes Three.js',
    ],
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (render.glError !== 0 || pageErrors.length || consoleErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
