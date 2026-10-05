import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProceduralTextures } from './generate-textures';

// Regenerates only the procedural Harbor textures and patches their entries in
// asset-manifest.json. Unlike export-assets.ts it never re-exports GLBs, so car
// and world model hashes authored elsewhere are left exactly as they are.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(project, 'public/assets/asset-manifest.json');
async function sha(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(resolve(project, path));
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
}
const generated = await writeProceduralTextures();
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  sourceHashes: Record<string, string>; assets: { path: string; sha256: string; bytes: number }[];
};
for (const path of generated) {
  const entry = manifest.assets.find((asset) => asset.path === path);
  if (entry) Object.assign(entry, await sha(path));
  else manifest.assets.push({ path, ...(await sha(path)) });
  const source = path.replace('public/assets/materials/', 'assets-source/textures/');
  manifest.sourceHashes[source] = (await sha(source)).sha256;
}
manifest.sourceHashes['tools/assets/generate-textures.ts'] = (await sha('tools/assets/generate-textures.ts')).sha256;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`updated ${generated.length} texture entries`);
