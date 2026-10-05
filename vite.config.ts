import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfhostPages, selfhostScrub, selfhostStatic } from './tools/selfhost/vite-plugin.mjs';
const targets = ['owner-review', 'standalone', 'poki', 'crazygames-basic', 'crazygames-full', 'selfhost'];
function filesBelow(directory:string):string[] {
  if(!existsSync(directory))return [];
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?filesBelow(path):entry.isFile()?[path]:[];
  }).sort();
}
function fileManifest(files:string[]) {
  return [...new Set(files)].sort().map(path=>{
    const bytes=readFileSync(path);
    return {path,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
}
/**
 * The Rapier compat build inlines its 3 MB wasm as 4 MB of base64 inside the main chunk, which then has to be
 * parsed as JavaScript and decoded on the main thread. Builds ship the binary as its own hashed asset instead:
 * the download starts as soon as the module evaluates and compiles while streaming when the host sends
 * application/wasm (it falls back to an ArrayBuffer compile otherwise, without the wasm-bindgen MIME warning).
 */
function rapierWasmAsset() {
  const inline = /module_or_path:([A-Za-z_$][\w$]*)\.toByteArray\("[A-Za-z0-9+/=]+"\)\.buffer/;
  return {
    name: 'rapier-wasm-asset',
    apply: 'build' as const,
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, '/').includes('/@dimforge/rapier3d-compat/dist/rapier.mjs')) return null;
      if (!inline.test(code)) throw new Error('rapier-wasm-asset: the inlined wasm pattern changed; update the plugin for this Rapier version');
      // The package exports map hides the .wasm file, so it is imported by its resolved path next to rapier.mjs.
      const wasmPath = `${id.replace(/[?#].*$/, '').replace(/rapier\.mjs$/, 'rapier_wasm3d_bg.wasm')}?url`;
      const loader = `import __lateralRapierWasmUrl from ${JSON.stringify(wasmPath)};
const __lateralRapierWasmResponse = typeof fetch === 'function' ? fetch(__lateralRapierWasmUrl) : null;
__lateralRapierWasmResponse?.catch(() => undefined);
async function __lateralRapierWasmModule() {
  const response = await (__lateralRapierWasmResponse ?? fetch(__lateralRapierWasmUrl));
  if (!response.ok) throw new Error('Physics engine download failed (' + response.status + ')');
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim();
  if (type === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') return WebAssembly.compileStreaming(response);
  return WebAssembly.compile(await response.arrayBuffer());
}
`;
      return { code: loader + code.replace(inline, 'module_or_path:__lateralRapierWasmModule()'), map: null };
    },
  };
}
function manifestHash(manifest:ReturnType<typeof fileManifest>):string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
export default defineConfig(({ mode }) => {
  const target = targets.includes(mode) ? mode : 'owner-review';
  const sdkScript=target==='poki'?'https://game-cdn.poki.com/scripts/v2/poki-sdk.js'
    :target.startsWith('crazygames-')?'https://sdk.crazygames.com/crazygames-sdk-v3.js':null;
  let commit = 'uncommitted';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Initial bootstrap. */ }
  const contentManifest=fileManifest([...filesBelow('content'),...filesBelow('public')]);
  const contentHash=manifestHash(contentManifest);
  const sourceHash=manifestHash(fileManifest([...filesBelow('src'),...filesBelow('contracts'),'package.json','package-lock.json','vite.config.ts']));
  let workingTreeDirty=true;
  try {workingTreeDirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;} catch { /* Missing Git is explicit. */ }
  const identity = { version: '0.1.0', target, commit, buildId: process.env.LATERAL_BUILD_ID || `dev-${sourceHash.slice(0, 12)}`,
    contentHash,sourceHash,workingTreeDirty,
    contractsHash: createHash('sha256').update(readFileSync('contracts/runtime-contracts.ts')).digest('hex') };
  return {
    base: './',
    define: { __BUILD__: JSON.stringify(identity), __OWNER_REVIEW__: JSON.stringify(target === 'owner-review'), __SELFHOST__: JSON.stringify(target === 'selfhost') },
    build: { target: 'es2022', outDir: `${process.env.LATERAL_OUT_ROOT ?? 'dist'}/${target}`, sourcemap: false, chunkSizeWarningLimit: 1800, ...(target === 'selfhost' ? { emptyOutDir: true } : {}) },
    plugins: [rapierWasmAsset(), ...(target === 'selfhost' ? [selfhostPages(), selfhostStatic(), selfhostScrub()] : []), { name: 'target-sdk', transformIndexHtml() {
      return sdkScript?[{tag:'script',attrs:{src:sdkScript},injectTo:'head-prepend' as const}]:[];
    } },{ name: 'build-identity', generateBundle() {
      this.emitFile({type:'asset', fileName:'build-manifest.json', source:JSON.stringify(identity, null, 2)});
      this.emitFile({type:'asset', fileName:'content-manifest.json', source:JSON.stringify({contentHash,files:contentManifest},null,2)});
    } }],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  };
});
