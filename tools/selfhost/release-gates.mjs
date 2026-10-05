#!/usr/bin/env node
// Release gates for the self-hosted build. Usage: node tools/selfhost/release-gates.mjs <distDir> [--json]
//
// Fails (exit 1) when the build directory:
//   - contains the word websim (any case) in any text file, file name or directory name
//   - carries an http(s):// URL whose host is not lateral.lou15.com (or a w3.org / xml namespace string that is only an identifier)
//   - mentions another game portal host (Poki, CrazyGames)
//   - lacks index.html, og.png, a favicon or robots.txt
//   - has a JavaScript entry above the size budget (the size of the current build plus 15%)
// INFRA's publish script calls this; the exit code is the only interface.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ALLOWED_HOSTS = new Set(['lateral.lou15.com']);
// Namespace identifiers are strings, never fetched. Each entry says why it is allowed.
const NAMESPACE_URLS = [
  { prefix: 'http://www.w3.org/', why: 'W3C namespace identifiers (SVG, XHTML, XML, MathML, XLink); never requested' },
  { prefix: 'https://www.w3.org/', why: 'W3C namespace identifiers; never requested' },
];
// Entry budget in bytes: the size of the build when this gate was written (index-*.js, minified) plus 15%.
export const ENTRY_BASELINE_BYTES = 1_772_665;
export const ENTRY_BUDGET_BYTES = Math.floor(ENTRY_BASELINE_BYTES * 1.15);
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.xml', '.webmanifest', '.map', '.md', '.glsl', '.vert', '.frag', '.wgsl', '.csv']);
const REQUIRED = [
  { label: 'index.html', any: ['index.html'] },
  { label: 'og.png', any: ['og.png'] },
  { label: 'favicon', any: ['favicon.ico', 'favicon.svg', 'favicon.png'] },
  { label: 'robots.txt', any: ['robots.txt'] },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out); else out.push({ full, size: st.size });
  }
  return out;
}

function isText(path, buffer) {
  if (TEXT_EXT.has(extname(path).toLowerCase())) return true;
  // Unknown extension: treat as text when there is no NUL byte in the first 4 KB.
  return !buffer.subarray(0, 4096).includes(0);
}

export function runGates(distDir, options = {}) {
  const root = resolve(distDir);
  const problems = [];
  const notes = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return { ok: false, problems: [`not a directory: ${root}`], notes };
  const files = walk(root);
  const rel = f => relative(root, f.full);
  const budget = options.entryBudget ?? ENTRY_BUDGET_BYTES;

  for (const need of REQUIRED) {
    if (!need.any.some(name => existsSync(join(root, name)))) problems.push(`missing required file: ${need.label}`);
  }

  const seenHosts = new Map();
  let licenceUrls = 0;
  const urlRe = /\bhttps?:\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d+)?([^\s"'`<>)\\]*)/gi;
  for (const file of files) {
    const name = rel(file);
    if (/websim/i.test(name)) problems.push(`file name mentions websim: ${name}`);
    const buffer = readFileSync(file.full);
    if (!isText(file.full, buffer)) continue;
    const text = buffer.toString('utf8');
    if (/websim/i.test(text)) {
      const at = text.search(/websim/i);
      problems.push(`websim found in ${name}: ...${text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ')}...`);
    }
    if (/poki|crazygames/i.test(text)) {
      // The word poki can appear inside other words; only flag portal hosts and SDK names.
      const hit = text.match(/[\w.-]*(?:poki(?:-gdn)?\.com|crazygames\.com|poki-sdk|CrazyGames\w*SDK)[\w./-]*/i);
      if (hit) problems.push(`portal reference in ${name}: ${hit[0]}`);
    }
    for (const match of text.matchAll(urlRe)) {
      const host = match[1].toLowerCase();
      const full = match[0];
      if (ALLOWED_HOSTS.has(host)) continue;
      // Licence texts (licenses/*.txt) are shipped for attribution, are never loaded, and quote their upstream links.
      if (/^licenses\//.test(name)) { licenceUrls++; continue; }
      const ns = NAMESPACE_URLS.find(entry => full.toLowerCase().startsWith(entry.prefix));
      if (ns) { seenHosts.set(host, ns.why); continue; }
      problems.push(`external URL in ${name}: ${full.slice(0, 120)}`);
    }
  }
  if (licenceUrls) notes.push(`${licenceUrls} URLs inside licenses/*.txt (attribution text, never loaded) ignored`);
  for (const [host, why] of seenHosts) notes.push(`allowed namespace host ${host}: ${why}`);

  // Entries: every top-level script referenced by index.html, plus any assets/index-*.js.
  const entries = files.filter(f => /(^|\/)assets\/index-[^/]+\.js$/.test(rel(f)) || /^[^/]+\.js$/.test(rel(f)));
  if (!entries.length) problems.push('no JavaScript entry found (assets/index-*.js)');
  for (const entry of entries) {
    if (entry.size > budget) problems.push(`JS entry over budget: ${rel(entry)} is ${entry.size} bytes, budget ${budget}`);
    else notes.push(`JS entry ${rel(entry)}: ${entry.size} bytes (budget ${budget})`);
  }
  const html = existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '';
  if (html) {
    if (/<script[^>]*>[^<]/i.test(html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, ''))) problems.push('index.html has an inline script (the CSP is script-src self)');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:)?\/\//i.test(ref)) { if (!ALLOWED_HOSTS.has(new URL(ref.startsWith('//') ? `https:${ref}` : ref).hostname)) problems.push(`index.html references ${ref}`); continue; }
      if (/^(data:|#|mailto:)/i.test(ref)) { if (ref.startsWith('data:') && /rel="icon"/.test(html)) notes.push('index.html has a data: URI reference'); continue; }
      const local = ref.split(/[?#]/)[0].replace(/^\//, '');
      if (local && !existsSync(join(root, local))) problems.push(`index.html references a missing file: ${ref}`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (args.length !== 1) { console.error('usage: release-gates.mjs <distDir> [--json]'); process.exit(2); }
  const result = runGates(args[0]);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const note of result.notes) console.log(`ok   ${note}`);
    for (const problem of result.problems) console.log(`FAIL ${problem}`);
    console.log(result.ok ? 'release gates: pass' : `release gates: FAIL (${result.problems.length})`);
  }
  process.exit(result.ok ? 0 : 1);
}
