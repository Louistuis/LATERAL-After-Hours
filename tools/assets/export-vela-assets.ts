import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createVelaGt } from '../../assets-source/3d/vela-gt-source';
import { disposeVelaGt } from '../../assets-source/3d/vela-gt-source';

// Three's GLTFExporter reads its GLB Blob through FileReader; Node does not provide one.
class NodeFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  async readAsArrayBuffer(blob: Blob): Promise<void> { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  async readAsDataURL(blob: Blob): Promise<void> {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onloadend?.();
  }
}

globalThis.FileReader = NodeFileReader as unknown as typeof FileReader;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(project, 'public/assets/asset-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  readonly generator: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly assets: readonly { path: string; sha256: string; bytes: number }[];
};
const exporter = new GLTFExporter();

async function exportGlb(path: string, root: THREE.Group): Promise<void> {
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: false, trs: true });
  if (!(result instanceof ArrayBuffer)) throw new Error(`Expected binary GLB for ${path}`);
  const outputPath = resolve(project, path);
  await writeFile(outputPath, Buffer.from(result));
}

async function sha(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(resolve(project, path))).digest('hex');
}

const vela = createVelaGt();
const velaLod1 = createVelaGt({ lod: 1 });
const velaPaths = ['public/assets/cars/vela-gt.glb', 'public/assets/cars/vela-gt-lod1.glb'] as const;
try {
  await exportGlb(velaPaths[0], vela);
  await exportGlb(velaPaths[1], velaLod1);
  const existingAssets = await Promise.all(manifest.assets
    .filter((asset) => !velaPaths.includes(asset.path as (typeof velaPaths)[number]))
    .map(async ({ path }) => ({ path, sha256: await sha(path), bytes: (await readFile(resolve(project, path))).byteLength })));
  const velaAssets = await Promise.all(velaPaths.map(async (path) => ({
    path, sha256: await sha(path), bytes: (await readFile(resolve(project, path))).byteLength,
  })));
  const sourceFiles = new Set([
    ...Object.keys(manifest.sourceHashes),
    'assets-source/3d/vela-gt-source.ts',
    'src/world/index.ts',
    'tools/assets/export-assets.ts',
    'tools/assets/export-vela-assets.ts',
  ]);
  const sourceHashes = Object.fromEntries(await Promise.all([...sourceFiles]
    .map(async (path) => [path, await sha(path)] as const)));
  const assets = [...existingAssets, ...velaAssets];
  await writeFile(manifestPath, `${JSON.stringify({ generator: manifest.generator, sourceHashes, assets }, null, 2)}\n`);
  console.log(JSON.stringify({ assets: velaAssets, sourceHashes }, null, 2));
} finally {
  disposeVelaGt(vela);
  disposeVelaGt(velaLod1);
}
