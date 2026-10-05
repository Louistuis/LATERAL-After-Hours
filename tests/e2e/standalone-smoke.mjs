#!/usr/bin/env node
// Smoke test of the normal standalone build: the menu loads, the starter gift opens once, driving starts, no console errors.
// Usage: node tests/e2e/standalone-smoke.mjs <distDir>   (build with LATERAL_OUT_ROOT=/some/other/dir npm run -s build:standalone)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from '@playwright/test';
const dist = path.resolve(process.argv[2] ?? 'dist/standalone');
const server = spawn(process.execPath, ['tools/preview_build.mjs', '--dir', dist, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('preview did not start')), 15000); server.stdout.on('data', c => { out += c; const m = /Preview: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } }); });
const browser = await chromium.launch({ headless: true, executablePath: process.env.L6_CHROMIUM_EXECUTABLE ?? '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] });
const errors = [];
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push(`pageerror ${String(e).slice(0, 200)}`));
  await page.goto(base);
  await page.waitForSelector('.lt-wallet b', { timeout: 120000 });
  check(true, 'menu loads');
  check(await page.locator('#sh-name').count() === 0, 'no account step in the standalone build');
  await page.waitForSelector('.lp-gf-box', { timeout: 60000 }).catch(() => page.click('.lt-gift'));
  await page.waitForSelector('.lp-gf-box', { timeout: 20000 });
  await page.click('.lp-gf-box', { force: true });
  await page.locator('.lp-gf button', { hasText: "Let's drive" }).click({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.lp-shell')?.dataset.screen === 'drive', null, { timeout: 30000 });
  check(true, 'drive starts after the gift');
  await page.keyboard.press('Escape');
  await page.click('[data-action="main-menu"]');
  await page.waitForSelector('.lt-tile[data-action="shop"]');
  check(await page.locator('.lt-gift').count() === 0, 'gift opens once');
  check(/1,?500/.test(await page.locator('.lt-wallet b').first().innerText()), 'balance 1,500');
  check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
} catch (error) { console.log(`FAIL ${error.message}`); failed = true; }
await browser.close(); server.kill('SIGTERM');
process.exit(failed ? 1 : 0);
