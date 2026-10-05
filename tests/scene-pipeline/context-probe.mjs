/** Actual WebGL2 loss/restoration probe against the S2 renderer stage. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const url = process.env.LATERAL_PROBE_URL ?? 'http://127.0.0.1:5174/';
const out = fileURLToPath(new URL('../../evidence/S2/2026-09-30/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true, executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
});
const messages = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('console', message => {
    if (message.type() === 'warning' || message.type() === 'error') messages.push(message.text());
  });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/@vite/client*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.route('**/src/core/main.ts*', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.goto(url);
  const observations = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { createRenderStage } = await import('/src/scene-pipeline/stage.ts');
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const stage = createRenderStage(canvas, 'balanced', 'golden-hour'); stage.resize(800, 600, 1);
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: '#84949b' }));
    box.castShadow = true; box.receiveShadow = true; stage.scene.add(box);
    const gl = stage.renderer.getContext();
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Real WEBGL_lose_context extension unavailable');
    const samples = [{ phase: 'initial', stats: stage.render(), glError: gl.getError() }];
    for (let index = 0; index < 2; index++) {
      const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
      extension.loseContext(); await lost;
      await new Promise(resolve => setTimeout(resolve, 700));
      stage.setLighting(index === 0 ? 'blue-hour' : 'golden-hour');
      stage.setQuality(index === 0 ? 'low' : 'balanced');
      stage.resize(index === 0 ? 640 : 800, index === 0 ? 480 : 600, 1);
      samples.push({ phase: `lost-${index}`, stats: stage.render(), glError: null });
      const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      extension.restoreContext(); await restored;
      await new Promise(resolve => setTimeout(resolve, 100));
      samples.push({ phase: `restored-${index}`, stats: stage.render(), glError: gl.getError() });
    }
    stage.dispose();
    return samples;
  });
  const report = {
    base: '847bf0cbe1c08e5ff78e6347c2dee1d829fc1214', sourceState: 'uncommitted shared worktree',
    browser: browser.version(), url, gpuFlags: ['--use-gl=angle', '--use-angle=gl-egl'],
    observations, messages, errors,
    scope: 'S2 stage with one shadow-casting mesh, not the full GLB/game runtime lifecycle',
  };
  await writeFile(join(out, 'context-stage-two-restores.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(messages, []);
  assert.deepEqual(observations.map(sample => sample.stats.contextState), ['ready', 'lost', 'ready', 'lost', 'ready']);
  assert.deepEqual(observations.map(sample => sample.stats.lighting), ['golden-hour', 'blue-hour', 'blue-hour', 'golden-hour', 'golden-hour']);
  assert.deepEqual(observations.map(sample => sample.stats.quality), ['balanced', 'low', 'low', 'balanced', 'balanced']);
  assert.ok(observations.every(sample => sample.glError === null || sample.glError === 0));
  assert.ok(observations.filter(sample => sample.stats.contextState === 'ready').every(sample => sample.stats.drawCallsAllPasses > 0));
  console.log(JSON.stringify({ result: 'PASS', observations: observations.map(sample => ({ phase: sample.phase, contextState: sample.stats.contextState, glError: sample.glError })), messages, errors }, null, 2));
} finally {
  await browser.close();
}
