#!/usr/bin/env node
// Loads the built selfhost game under the contract CSP and reports violations, console errors and every request origin.
// Usage: node tests/e2e/selfhost-csp-probe.mjs <url>
import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, executablePath: process.env.L6_CHROMIUM_EXECUTABLE ?? '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const origins = new Map(), consoleErrors = [];
page.on('request', r => { const o = new URL(r.url()).origin; origins.set(o, (origins.get(o) ?? 0) + 1); });
page.on('console', m => { if (m.type() === 'error' || /Content Security Policy|violat/i.test(m.text())) consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', e => { (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`); }); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(6000);
const csp = await page.evaluate(() => window.__csp ?? []);
const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
console.log(JSON.stringify({ origins: Object.fromEntries(origins), consoleErrors, csp, text }, null, 1));
await browser.close();
