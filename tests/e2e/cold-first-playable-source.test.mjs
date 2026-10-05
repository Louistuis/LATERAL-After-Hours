import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = async relative => readFile(path.join(root, relative), 'utf8');

test('owner benchmark marker is defined and recorded after the boot-ready boundary', async () => {
  const bootstrap = await source('src/core/bootstrap.ts');
  assert.match(bootstrap, /get firstPlayableAtMs\(\) \{ return firstPlayableAtMs; \}/);
  const ready = bootstrap.indexOf('boot.ready();');
  const marker = bootstrap.indexOf('if (__OWNER_REVIEW__) firstPlayableAtMs = performance.now();');
  assert.ok(ready >= 0 && marker > ready, 'marker must follow boot.ready()');
  assert.match(bootstrap, /identity: __BUILD__/);
});

test('keyboard movement selectors map to actual driving inputs and QA vehicle position', async () => {
  const input = await source('src/input/player-input.ts');
  const ui = await source('src/ui/player-ui.ts');
  const runtime = await source('src/core/game-runtime.ts');
  const bootstrap = await source('src/core/bootstrap.ts');
  assert.match(input, /throttle: \['KeyW', 'ArrowUp'\]/);
  assert.match(ui, /data-action="drive"/);
  assert.match(ui, /aria-label="Driving information"/);
  assert.match(runtime, /view\(\):RuntimeView \{return \{frame:this\.session\.snapshot\(\)/);
  assert.match(bootstrap, /view: observedRuntime\.view\(\)/);
  assert.match(runtime, /readonly frame:FrameSnapshot/);
  const bootShell = await source('src/core/boot-shell.ts');
  assert.match(bootShell, /ready\(\) \{ cover\.hidden = true/);
  assert.match(bootShell, /className = 'lateral-boot'/);
});

test('measurement retains distinct transfer, package, and resident-allocation fields', async () => {
  const harness = await source('tests/e2e/cold-first-playable-l6.mjs');
  assert.match(harness, /Network\.loadingFinished/);
  assert.match(harness, /encodedDataLength/);
  assert.match(harness, /packageBytes/);
  assert.match(harness, /residentAllocationBytes: null/);
  assert.match(harness, /servedIndexSha256/);
  assert.match(harness, /webglContextReady/);
  assert.match(harness, /coverHidden/);
  assert.match(harness, /INVALID_COVERAGE/);
  assert.match(harness, /firstPlayableAtMs/);
  assert.match(harness, /KeyW/);
});
