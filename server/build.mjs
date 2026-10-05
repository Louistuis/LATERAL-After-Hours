/* global process, console */
// Bundles the server into server/dist: server.mjs (one file, `ws` and the shared src/economy modules inside),
// admin.mjs (CLI), backup.mjs, admin/ (static page) and package.json. Usage: node server/build.mjs [--admin-api=api/] [--out=server/dist]
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const out = resolve(arg('out', join(here, 'dist')));
const adminApi = arg('admin-api', 'api/');
const quiet = process.argv.includes('--quiet');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const started = Date.now();
await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(out, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: false, sourcemap: false, legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: quiet ? 'error' : 'warning',
});
for (const file of ['admin.mjs', 'backup.mjs']) if (existsSync(join(here, file))) cpSync(join(here, file), join(out, file));
if (existsSync(join(here, 'admin'))) {
  cpSync(join(here, 'admin'), join(out, 'admin'), { recursive: true });
  writeFileSync(join(out, 'admin', 'config.js'), `window.LATERAL_ADMIN_API = ${JSON.stringify(adminApi)};\n`);
}
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'lateral-server-dist', private: true, type: 'module' }, null, 2) + '\n');
const bytes = statSync(join(out, 'server.mjs')).size;
const bundle = readFileSync(join(out, 'server.mjs'), 'utf8');
if (/websim/i.test(bundle)) { console.error('release gate: the word websim appears in the server bundle'); process.exit(1); }
if (!quiet) console.log(`built ${join(out, 'server.mjs')} (${(bytes / 1024).toFixed(0)} KB) in ${Date.now() - started} ms; admin api base "${adminApi}"`);
