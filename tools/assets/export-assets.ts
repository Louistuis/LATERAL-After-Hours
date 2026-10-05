import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createHarborSource } from '../../assets-source/3d/harbor-source';
import { source } from '../../src/world/index';
import { writeProceduralTextures } from './generate-textures';

// Three's GLTFExporter uses FileReader for its final GLB Blob; Node 24 has Blob
// but not FileReader. This small async adapter covers the exporter's two reads.
class NodeFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  async readAsArrayBuffer(blob: Blob): Promise<void> {
    this.result = await blob.arrayBuffer(); this.onloadend?.();
  }
  async readAsDataURL(blob: Blob): Promise<void> {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onloadend?.();
  }
}
globalThis.FileReader = NodeFileReader as unknown as typeof FileReader;

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exporter = new GLTFExporter();
const generatedTextures = await writeProceduralTextures();
async function glb(path: string, root: THREE.Group, onlyVisible = true): Promise<void> {
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible, trs: true });
  if (!(result instanceof ArrayBuffer)) throw new Error(`Expected binary GLB for ${path}`);
  await mkdir(dirname(resolve(project, path)), { recursive: true });
  await writeFile(resolve(project, path), Buffer.from(result));
}
async function sha(path: string): Promise<string> { return createHash('sha256').update(await readFile(resolve(project, path))).digest('hex'); }

const worldSource = createHarborSource();
await glb('public/assets/world/harbor-works.glb', worldSource);
// Cars are owner models built outside this tool (nc2: /root/mkcar.py, /root/mkf1.py); they are hashed, not generated.
const ownerCars = ['public/assets/cars/challenger.glb', 'public/assets/cars/cybertruck.glb', 'public/assets/cars/mclaren-f1.glb', 'public/assets/cars/lancia-delta.glb', 'public/assets/cars/agera.glb'];
const { route, collision } = source.buildRoute();
const apron = source.buildApron();
const water = source.buildWater();
const curbs = source.buildCurbs();
const guardrails = source.buildGuardrails();
const runtimeRoutePath = 'public/assets/world/hw-01-built.json';
await mkdir(dirname(resolve(project, runtimeRoutePath)), { recursive: true });
await writeFile(resolve(project, runtimeRoutePath), `${JSON.stringify({ route, collisionMeshes: [collision, apron, water, ...curbs, ...guardrails] })}\n`);

const generated = [
  'public/assets/world/harbor-works.glb', runtimeRoutePath, ...generatedTextures, ...ownerCars,
];
const sourceFiles = ['content/routes/hw-01.json', 'assets-source/3d/harbor-source.ts',
  'assets-source/textures/harbor-asphalt.png', 'assets-source/textures/harbor-concrete.png',
  'assets-source/textures/harbor-curb.png', 'assets-source/textures/harbor-steel.png',
  'assets-source/textures/harbor-shed-paint.png', 'tools/assets/generate-textures.ts',
  'src/world/route-data.ts', 'src/world/index.ts', 'tools/assets/export-assets.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [path, await sha(path)])));
const assets = await Promise.all(generated.map(async (path) => ({ path, sha256: await sha(path), bytes: (await readFile(resolve(project, path))).byteLength })));
await writeFile(resolve(project, 'public/assets/asset-manifest.json'), `${JSON.stringify({ generator: 'tools/assets/export-assets.ts', sourceHashes, assets }, null, 2)}\n`);

for (const object of [worldSource]) object.traverse((node) => {
  if (!(node instanceof THREE.Mesh)) return;
  node.geometry.dispose();
  for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
});
console.log(JSON.stringify({ assets, sourceHashes }, null, 2));
