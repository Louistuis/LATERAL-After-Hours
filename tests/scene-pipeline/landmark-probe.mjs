/** Static camera inspection of authored east-quay assets; no driving claim. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../evidence/S2/2026-09-30/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [], warnings = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.route('**/@vite/client*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.route('**/src/core/main.ts*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.goto(process.env.LATERAL_PROBE_URL ?? 'http://127.0.0.1:5174/');
  const sceneData = await page.evaluate(async () => {
    const { createScenePipeline } = await import('/src/scene-pipeline/index.ts');
    document.body.style.cssText = 'margin:0;overflow:hidden';
    document.querySelector('#app')?.remove();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100vw;height:100vh;display:block';
    document.body.append(canvas);
    const pipeline = await createScenePipeline(canvas, { quality: 'balanced', lighting: 'golden-hour' });
    pipeline.resize(1280, 720, 1);
    pipeline.camera.position.set(128, 9, -25);
    pipeline.camera.lookAt(180, 5, -78);
    pipeline.camera.updateProjectionMatrix();
    pipeline.renderer.info.reset();
    pipeline.renderer.render(pipeline.scene, pipeline.camera);
    const gl = pipeline.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    window.__landmarkProbe = pipeline;
    return {
      cameraPosition: pipeline.camera.position.toArray(), target: [180, 5, -78],
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      allPassCalls: pipeline.renderer.info.render.calls,
      allPassTriangles: pipeline.renderer.info.render.triangles,
      glError: gl.getError(),
      namedNodes: ['east-quay-machine-hall', 'salt-tank-1', 'salt-tank-2', 'salt-tank-3']
        .map(name => ({ name, found: Boolean(pipeline.world.root.getObjectByName(name)) })),
    };
  });
  await page.screenshot({ path: join(out, 'east-quay-static.png') });
  await page.evaluate(() => window.__landmarkProbe.dispose());
  const report = {
    base: '847bf0cbe1c08e5ff78e6347c2dee1d829fc1214', sourceState: 'uncommitted shared worktree',
    browser: browser.version(), viewport: '1280x720', gpuFlags: ['--use-gl=angle', '--use-angle=gl-egl'],
    scope: 'Static asset inspection from a plausible late-HW01 viewpoint; not an input-driven route or performance gate',
    sceneData, errors, warnings, capture: 'east-quay-static.png',
  };
  await writeFile(join(out, 'east-quay-static.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
