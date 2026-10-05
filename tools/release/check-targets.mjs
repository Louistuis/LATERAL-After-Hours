import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { javascriptChunkReferences } from './chunk-graph.mjs';

const targets = ['owner-review', 'standalone', 'poki', 'crazygames-basic', 'crazygames-full', 'selfhost'];
const root = path.resolve(process.argv[2] ?? 'dist');
const forbiddenProductionMarkers = [
  'src/owner-tools/', 'QA_MUTATION_HOOK', 'qaMutationHook',
];
const ownerUiSignatures = ['Review controls', 'Export career before reset', 'Preview local report', 'Download reviewed report'];
const ownerSaveSignatures = [
  'exportProfileSave', 'previewProfileImport', 'importProfileSave', 'resetProfile', 'exportBugReport',
  'Profile reset requires explicit confirmation after exporting a backup',
  'Import belongs to a different or unknown profile namespace', 'Profile change failed (',
  'sanitizedDiagnostics', 'automaticUpload', 'tick=${',
];
const ownerRequiredSignatures = [
  'exportProfileSave', 'resetProfile',
  'Profile reset requires explicit confirmation after exporting a backup', 'Profile change failed (',
  'sanitizedDiagnostics', 'automaticUpload', 'tick=${',
];
const recoverySignatures = ['startSessionOnlyRecovery', 'Session-only recovery requires explicit consent', 'Download stored save', 'Play for this session'];
const sdkAllowlist = {
  'owner-review': [],
  standalone: [],
  // The hosted build names only its own public origin (canonical link, share card). tools/selfhost/release-gates.mjs is the strict check.
  selfhost: ['https://lateral.lou15.com/', 'https://lateral.lou15.com/og.png'],
  poki: ['https://game-cdn.poki.com/scripts/v2/poki-sdk.js'],
  'crazygames-basic': ['https://sdk.crazygames.com/crazygames-sdk-v3.js'],
  'crazygames-full': ['https://sdk.crazygames.com/crazygames-sdk-v3.js'],
};
const requiredSdk = {
  'owner-review': null,
  standalone: null,
  selfhost: null,
  poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
  'crazygames-basic': 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
  'crazygames-full': 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
};

const report = { root, targets: [], generatedAt: new Date().toISOString(), result: 'PASS' };
for (const target of targets) {
  const directory = path.join(root, target);
  const files = await walk(directory);
  const manifestPath = path.join(directory, 'build-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.target !== target) fail(`${target}: manifest says target ${String(manifest.target)}`);
  if (!files.some(file => path.basename(file) === 'index.html')) fail(`${target}: root index.html is missing`);
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  if (requiredSdk[target] && !html.includes(requiredSdk[target])) fail(`${target}: target SDK loader is missing from index.html`);
  const graph = await emittedChunkGraph(directory, files, html);

  let totalBytes = 0;
  const contentHashes = [];
  const externalUrls = new Set();
  const leakedMarkers = [];
  for (const file of files) {
    const info = await stat(file);
    totalBytes += info.size;
    const bytes = await readFile(file);
    contentHashes.push([path.relative(directory, file).split(path.sep).join('/'), createHash('sha256').update(bytes).digest('hex')]);
    if (!/\.(?:js|html|css|json|wasm)$/i.test(file)) continue;
    const text = bytes.toString('utf8');
    for (const url of externalReferences(text, file)) externalUrls.add(url);
    for (const marker of forbiddenProductionMarkers) if (text.includes(marker)) leakedMarkers.push({ file: path.relative(directory, file), marker });
    if (target !== 'owner-review') {
      for (const marker of ['__LATERAL_BENCH__', '__LATERAL_QA__']) {
        if (text.includes(marker)) leakedMarkers.push({ file: path.relative(directory, file), marker });
      }
    }
  }
  if (target === 'owner-review') {
    for (const marker of ['__LATERAL_BENCH__', '__LATERAL_QA__']) {
      if (!await anyReachableChunkContains(directory, graph, marker)) fail(`owner-review: expected owner QA global ${marker} is missing from the entry graph`);
    }
    for (const signature of ownerUiSignatures) {
      if (!await anyReachableChunkContains(directory, graph, signature)) fail(`owner-review: expected owner-only UI signature ${signature} is missing from the entry graph`);
    }
    for (const signature of ownerRequiredSignatures) {
      if (!await anyReachableChunkContains(directory, graph, signature)) fail(`owner-review: expected owner-only save/report signature ${signature} is missing from the entry graph`);
    }
  }
  if (target !== 'owner-review') {
    for (const signature of [...ownerUiSignatures, '__LATERAL_BENCH__', '__LATERAL_QA__']) {
      if (await anyBundleContains(files, signature)) fail(`${target}: owner-only UI or QA signature is present: ${signature}`);
    }
    for (const signature of ownerSaveSignatures) {
      if (await anyBundleContains(files, signature)) fail(`${target}: owner-only save/report implementation is present: ${signature}`);
    }
  }
  for (const signature of recoverySignatures) {
    if (!await anyReachableChunkContains(directory, graph, signature)) fail(`${target}: required general save-recovery signature is missing from the entry graph: ${signature}`);
  }
  const ownerOnlyChunks = [];
  for (const chunk of graph.reachable) {
    const source = await readFile(path.join(directory, chunk), 'utf8');
    if ([...ownerUiSignatures, ...ownerSaveSignatures].some(marker => source.includes(marker))) ownerOnlyChunks.push(chunk);
  }
  if (target !== 'owner-review' && ownerOnlyChunks.length) fail(`${target}: owner-only code is reachable from production entry chunks: ${ownerOnlyChunks.join(', ')}`);
  for (const url of externalUrls) {
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) fail(`${target}: development URL is bundled: ${url}`);
    if (!sdkAllowlist[target].some(allowed => url === allowed || url.startsWith(`${allowed}?`))) fail(`${target}: unexpected external URL is bundled: ${url}`);
  }
  if (leakedMarkers.length) fail(`${target}: owner QA hooks leaked: ${JSON.stringify(leakedMarkers)}`);
  if (files.some(file => file.endsWith('.map'))) fail(`${target}: source map is present`);
  if (target.startsWith('crazygames-') && (totalBytes > 250 * 1024 * 1024 || files.length > 1500)) fail(`${target}: CrazyGames total package limit exceeded`);
  report.targets.push({ target, fileCount: files.length, packageBytes: totalBytes, initialPlayableBytes: null,
    entryChunks: graph.entries, reachableChunkCount: graph.reachable.length, unreachableChunkCount: graph.unreachable.length,
    ownerOnlyChunks,
    externalUrls: [...externalUrls].sort(), fileManifestSha256: hashManifest(contentHashes.sort(([a], [b]) => a.localeCompare(b))) });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { fail(`Missing target output: ${directory}`); return []; }
  const files = [];
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else if (entry.isFile()) files.push(item);
  }
  return files;
}
async function anyBundleContains(files, marker) {
  for (const file of files) {
    if (!/\.(?:js|html)$/i.test(file)) continue;
    if ((await readFile(file, 'utf8')).includes(marker)) return true;
  }
  return false;
}
async function anyReachableChunkContains(directory, graph, marker) {
  for (const chunk of graph.reachable) if ((await readFile(path.join(directory, chunk), 'utf8')).includes(marker)) return true;
  return false;
}
async function emittedChunkGraph(directory, files, html) {
  const chunks = new Set(files.filter(file => /\.js$/i.test(file)).map(file => path.relative(directory, file).split(path.sep).join('/')));
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
    .map(match => path.posix.normalize(match[1].split('?')[0].replace(/^\/+/, ''))).filter(file => chunks.has(file));
  if (!entries.length) fail(`${path.basename(directory)}: no JavaScript entry chunk is referenced by index.html`);
  const reachable = new Set();
  const queue = [...entries];
  while (queue.length) {
    const current = queue.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    const source = await readFile(path.join(directory, current), 'utf8');
    const references = javascriptChunkReferences(source);
    for (const specifier of references) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier));
      if (chunks.has(resolved) && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  return { entries, reachable: [...reachable], unreachable: [...chunks].filter(file => !reachable.has(file)) };
}
function hashManifest(entries) { return createHash('sha256').update(JSON.stringify(entries)).digest('hex'); }
function externalReferences(text, file) {
  const urls = new Set();
  const candidates = /\.(?:html|css)$/i.test(file)
    ? [...text.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi), ...text.matchAll(/url\(\s*["']?(https?:\/\/[^\s"')]+)["']?\s*\)/gi)]
    : [...text.matchAll(/(?:fetch|import|open|WebSocket|EventSource)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g)];
  for (const match of candidates) urls.add(match[1].replace(/[),.;]+$/, ''));
  return urls;
}
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  report.result = 'FAIL';
}
