import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGates } from '../../tools/selfhost/release-gates.mjs';

const dirs: string[] = [];
function dist(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lateral-gates-'));
  dirs.push(dir);
  const base: Record<string, string> = {
    'index.html': '<!doctype html><title>t</title><link rel="icon" href="/favicon.svg"><script type="module" src="/assets/index-abc.js"></script>',
    'og.png': 'png', 'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'robots.txt': 'User-agent: *',
    'assets/index-abc.js': 'console.log("hello")',
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) {
    if (text === '') continue;
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('selfhost release gates', () => {
  it('passes a clean build and allows the W3C namespace string', () => {
    const result = runGates(dist());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
  it('fails on the word websim in any case, in any text file, and in file names', () => {
    expect(runGates(dist({ 'assets/index-abc.js': 'var a="WebSim"' })).ok).toBe(false);
    expect(runGates(dist({ 'build-manifest.json': '{"x":"websim"}' })).ok).toBe(false);
    expect(runGates(dist({ 'assets/websim-thing.txt': 'x' })).problems.join()).toMatch(/file name/);
  });
  it('fails on foreign URLs but not on lateral.lou15.com', () => {
    expect(runGates(dist({ 'assets/index-abc.js': 'fetch("https://example.com/x")' })).problems.join()).toMatch(/external URL/);
    expect(runGates(dist({ 'assets/index-abc.js': 'var u="https://lateral.lou15.com/og.png"' })).ok).toBe(true);
    expect(runGates(dist({ 'assets/index-abc.js': 'var u="http://lateral.lou15.com.evil.test/"' })).ok).toBe(false);
  });
  it('fails on portal hosts', () => {
    expect(runGates(dist({ 'assets/index-abc.js': 'load("https://game-cdn.poki.com/sdk.js")' })).ok).toBe(false);
  });
  it('fails when a required file is missing', () => {
    for (const [name, label] of [['og.png', 'og.png'], ['robots.txt', 'robots.txt'], ['favicon.svg', 'favicon'], ['index.html', 'index.html']] as const) {
      const result = runGates(dist({ [name]: '' }));
      expect(result.ok, name).toBe(false);
      expect(result.problems.join()).toContain(label);
    }
  });
  it('fails when the JS entry is over budget', () => {
    expect(runGates(dist({ 'assets/index-abc.js': 'x'.repeat(2000) }), { entryBudget: 1000 }).problems.join()).toMatch(/over budget/);
  });
  it('fails on an inline script (the CSP forbids it)', () => {
    expect(runGates(dist({ 'index.html': '<title>t</title><link rel="icon" href="/favicon.svg"><script>alert(1)</script>' })).problems.join()).toMatch(/inline script/);
  });
});
