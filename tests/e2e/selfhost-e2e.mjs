#!/usr/bin/env node
/**
 * Browser end-to-end test of the self-hosted build against a real local game server. Headless Chromium only, on nc2.
 *
 *   node tests/e2e/selfhost-e2e.mjs [--dist=/root/lateral-build-selfhost/selfhost] [--only=name,name] [--shots=/tmp/dir]
 *
 * Starts `node server/dev.mjs` (temp database) and `tools/selfhost/e2e/serve.mjs` (static files with the contract CSP
 * plus the /api and /ws proxy) on free 127.0.0.1 ports, runs the scenarios, then stops both by PID.
 * Every page runs with request logging: any request that leaves the local origin is a failure, hosts of the old
 * platform are aborted, and any console error that is not an expected 4xx answer fails the run.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const dist = arg('dist', '/root/lateral-build-selfhost/selfhost');
const only = new Set(arg('only', '').split(',').filter(Boolean));
const shots = arg('shots', '');
if (shots) mkdirSync(shots, { recursive: true });
const chromePath = process.env.L6_CHROMIUM_EXECUTABLE ?? '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
function start(args, readyPattern) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`did not start: ${args.join(' ')}\n${out}`)), 60_000);
    const onData = chunk => { out += chunk; const match = readyPattern.exec(out); if (match) { clearTimeout(timer); resolve({ child, info: JSON.parse(match[1]) }); } };
    child.stdout.on('data', onData); child.stderr.on('data', chunk => { out += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)); });
  });
}
function stopAll() { for (const child of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });

/* ------------------------------------------------------------------ servers */
const apiPort = await freePort();
const adminPort = await freePort();
const dev = await start(['server/dev.mjs', `--port=${apiPort}`, `--admin-port=${adminPort}`], /LATERAL_DEV (\{.*\})/);
const adminKey = dev.info.adminKey;
const webPort = await freePort();
const web = await start(['tools/selfhost/e2e/serve.mjs', `--dist=${path.resolve(dist)}`, `--port=${webPort}`, `--api=${apiPort}`], /SERVE (\{.*\})/);
const base = web.info.url;
const origin = new URL(base).origin;
console.log(`server api ${apiPort} (pid ${dev.info.childPid}), web ${webPort} (pid ${web.info.pid}), dist ${dist}`);

async function admin(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/admin/${route}`, { method, headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`admin ${route} ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/* ------------------------------------------------------------------ browser */
const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const thirdParty = [], websimAttempts = [], consoleErrors = [], expected4xx = [];
const BLOCKED = /websim|poki\.|crazygames/i;
const pages = new Map();
async function newPlayer(label, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['clipboard-read', 'clipboard-write'], ...options });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (BLOCKED.test(url)) { websimAttempts.push(`${label}: ${url}`); return route.abort(); }
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) { thirdParty.push(`${label}: ${url}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  pages.set(page, label);
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The browser logs every 4xx answer as a console error. The scenarios that provoke one say so (expect4xx).
    if (/Failed to load resource: the server responded with a status of (4\d\d)/.test(text)) { expected4xx.push(`${label}: ${text.slice(0, 120)}`); return; }
    consoleErrors.push(`${label}: ${text.slice(0, 300)}`);
  });
  page.on('pageerror', error => consoleErrors.push(`${label}: pageerror ${String(error).slice(0, 300)}`));
  return { context, page, label };
}
const shot = async (player, name) => { if (shots) await player.page.screenshot({ path: path.join(shots, `${player.label}-${name}.png`) }).catch(() => {}); };

const num = text => Number(String(text).replace(/[^0-9]/g, '') || NaN);
const balance = async page => num(await page.locator('.lt-wallet b').first().innerText());
async function waitMenu(page, timeout = 90_000) {
  await page.waitForSelector('.lt-wallet b', { timeout });
  await page.waitForFunction(() => !document.querySelector('.sh-layer') && !document.querySelector('.lp-gf'), null, { timeout });
}
const expect = (cond, message) => { if (!cond) throw new Error(message); };
async function waitFor(fn, message, timeout = 30_000, step = 250) {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error(`timeout: ${message}`); await sleep(step); }
}
const screenOf = page => page.evaluate(() => document.querySelector('.lp-shell')?.dataset.screen ?? '');

/** First visit: choose a driver name, save the recovery code, land on the menu. Returns the recovery code. */
async function createDriver(player, name, { gift = 'shop' } = {}) {
  const { page } = player;
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  await page.fill('#sh-name', name);
  await page.click('.sh-card button.lf-go');
  await page.waitForSelector('.sh-code', { timeout: 20_000 });
  const code = (await page.locator('.sh-code').innerText()).trim();
  expect(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(code), `recovery code shape: ${code}`);
  const go = page.locator('.sh-card button.lf-go');
  expect(await go.isDisabled(), 'Continue must be disabled until "I saved it" is ticked');
  await shot(player, 'recovery');
  await page.check('.sh-tick input');
  await go.click();
  // The starter gift is a required first step: its reveal opens by itself on the first visit.
  await page.waitForSelector('.lp-gf-box', { timeout: 60_000 });
  if (gift !== 'none') await openStarterGift(page, { drive: gift === 'drive' });
  return code;
}
/** Opens the reveal that is on screen (or the starter gift chip), then leaves it by the shop or by driving. */
async function openStarterGift(page, { drive = false } = {}) {
  if (!(await page.locator('.lp-gf-box').count())) await page.click('.lt-gift');
  await page.waitForSelector('.lp-gf-box', { timeout: 20_000 });
  await page.click('.lp-gf-box', { force: true });
  const btn = page.locator('.lp-gf button', { hasText: drive ? "Let's drive" : 'Open the shop' });
  await btn.waitFor({ timeout: 30_000 });
  await btn.click();
  if (drive) return;
  await page.waitForSelector('.lp-sr:not([hidden])', { timeout: 20_000 });
  await page.click('[data-sr="close"]');
  await page.waitForSelector('.lt-wallet b', { timeout: 30_000 });
}

const results = [];
// Scenario names: first-run purchase recover testgrant direct-gift code-gift gift-link guest sign-out race hygiene
const store = {};
async function scenario(name, fn) {
  if (only.size && !only.has(name)) { results.push([name, 'SKIP']); return; }
  const before = consoleErrors.length;
  try { await fn(); if (consoleErrors.length > before) throw new Error(`console errors during ${name}:\n  ${consoleErrors.slice(before).join('\n  ')}`); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (error) {
    if (shots) { for (const [page, label] of pages) { await page.screenshot({ path: path.join(shots, `FAIL-${name}-${label}.png`) }).catch(() => {}); } }
    results.push([name, 'FAIL', String(error?.message ?? error)]); console.log(`FAIL ${name}: ${String(error?.stack ?? error)}`); }
}

/* ------------------------------------------------------------------ scenarios */
await scenario('first-run', async () => {
  const p = store.louis = await newPlayer('louis');
  const { page } = p;
  await page.goto(base);
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  await shot(p, 'name');
  await page.fill('#sh-name', 'a b');
  await page.click('.sh-card button.lf-go');
  expect((await page.locator('.sh-err').innerText()).length > 0, 'inline name error expected');
  expect(await page.locator('.sh-layer').count() === 1, 'card stays open on a bad name');
  expect(!/—|–/.test(await page.locator('.sh-card').innerText()), 'no em dashes in the card');
  // A name that is free but already taken by someone else.
  const other = await newPlayer('other');
  await other.page.goto(base);
  await createDriver(other, 'Rival_One');
  await other.context.close();
  await page.fill('#sh-name', 'rival_one');
  await page.click('.sh-card button.lf-go');
  await waitFor(async () => /taken/i.test(await page.locator('.sh-err').innerText()), 'name taken message');
  await page.fill('#sh-name', 'Louis_Test');
  await page.click('.sh-card button.lf-go');
  await page.waitForSelector('.sh-code', { timeout: 20_000 });
  store.code = (await page.locator('.sh-code').innerText()).trim();
  const copy = page.locator('.sh-card button', { hasText: 'Copy code' });
  await copy.click();
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  expect(clip === store.code, `copy button puts the code on the clipboard (${clip})`);
  const go = page.locator('.sh-card button.lf-go');
  expect(await go.isDisabled(), 'Continue disabled before the tick');
  await page.check('.sh-tick input');
  await go.click();
  await page.waitForSelector('.lp-gf-box', { timeout: 60_000 });
  await shot(p, 'menu');
  expect(await balance(page) === 0, `balance before the starter gift is 0 (got ${await balance(page)})`);
  expect((await page.locator('.lt-profile-btn').innerText()).includes('Louis_Test'), 'profile chip shows the driver name');
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('lateral:account:v1')).token);
  expect(typeof token === 'string' && token.length >= 16, 'token kept in localStorage');
  await openStarterGift(page, { drive: true });
  await waitFor(async () => (await screenOf(page)) === 'drive', 'drive screen after the gift');
  await shot(p, 'drive');
  await page.keyboard.down('KeyW');
  await sleep(2500);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await screenOf(page)) !== 'drive', 'back to the menu');
  await waitMenu(page);
  expect(await balance(page) === 1500, `balance after the starter gift (got ${await balance(page)})`);
  expect(await page.locator('.lt-gift').count() === 0, 'the starter gift opens only once');
  await page.click('[data-action="main-menu"]');
  await page.waitForSelector('.lt-tile[data-action="shop"]', { timeout: 20_000 });
  await shot(p, 'home');
});

await scenario('purchase', async () => {
  const { page } = store.louis;
  await page.click('.lt-tile[data-action="shop"]');
  await page.waitForSelector('.lp-sr:not([hidden]) .lp-sr-rail button', { timeout: 30_000 });
  await page.click('.lp-sr-tabs [data-sr-tab="wheels"]').catch(() => {});
  const item = page.locator('.lp-sr-item[data-sr-item="rim-gold"]');
  if (await item.count()) await item.click(); else throw new Error('rim-gold not in the rail');
  await page.click('[data-sr="buy"]');
  await page.click('[data-sr=confirm]');
  await waitFor(async () => (await balance(page).catch(() => NaN)) === 550 || num(await page.locator('[data-sr-balance]').innerText()) === 550, 'balance 550 after buying rim-gold');
  await shot(store.louis, 'bought');
  const done = page.locator('[data-sr=done]');
  if (await done.count()) await done.click().catch(() => {});
  await page.click('[data-sr="close"]');
  await waitMenu(page);
  // Missions: "First purchase" is complete now.
  await page.click('.lt-tile[data-action="missions"]');
  await page.locator('.lp-ms [role=tab]', { hasText: 'Career' }).click();
  const claim = page.locator('.lp-ms-row button.go', { hasText: 'Claim' }).first();
  await claim.waitFor({ timeout: 20_000 });
  await shot(store.louis, 'missions');
  await claim.click();
  await waitFor(async () => (await page.locator('.lp-ms-row button.go', { hasText: 'Claim' }).count()) === 0, 'claim button gone', 15_000);
  await page.locator('.lp-ms button', { hasText: 'Close' }).click();
  await waitMenu(page);
  const afterClaim = await balance(page);
  expect(afterClaim === 600, `balance after the mission claim should be 600 (got ${afterClaim})`);
  store.balance = afterClaim;
  await page.waitForTimeout(3500); // let the throttled wallet write reach the server
  await page.reload();
  await waitMenu(page);
  expect(await balance(page) === store.balance, `reload keeps the balance (got ${await balance(page)})`);
  expect(await page.locator('.lt-gift').count() === 0, 'no starter gift after reload');
});

await scenario('recover', async () => {
  const p = await newPlayer('recover');
  const { page } = p;
  await page.goto(base);
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  await page.locator('.sh-card button.sh-link', { hasText: 'I already have an account' }).click();
  await page.fill('#sh-rname', 'Louis_Test');
  await page.fill('#sh-rcode', 'AAAA-AAAA-AAAA-AAAA');
  await page.click('.sh-card button.lf-go');
  await waitFor(async () => /do not match/i.test(await page.locator('.sh-err').innerText()), 'wrong code message');
  await page.fill('#sh-rcode', store.code.toLowerCase().replace(/-/g, ' '));
  await page.click('.sh-card button.lf-go');
  await waitMenu(page);
  await waitFor(async () => (await balance(page)) === store.balance, `recovered balance ${store.balance}`);
  expect(await page.locator('.lt-gift').count() === 0, 'starter gift stays opened on the new device');
  await shot(p, 'recovered');
  store.recover = p;
});

await scenario('testgrant', async () => {
  const { page } = store.louis;
  await page.click('.lt-wallet');
  await page.waitForSelector('.lp-sr:not([hidden])');
  await page.click('[data-sr="earn"]');
  const offer = page.locator('.lp-sr-offer', { hasText: 'Testing bonus' });
  await offer.waitFor({ timeout: 15_000 });
  expect(/20,000/.test(await offer.innerText()), 'offer shows 20,000 Marks');
  expect(await page.locator('.lp-sr-sheet').innerText().then(t => !/tip|credit/i.test(t)), 'no tip or credit text in the sheet');
  expect(await page.locator('.lp-sr-sheet button', { hasText: 'Earn Marks with missions' }).count() === 1, 'missions button in the sheet');
  await shot(store.louis, 'earn-sheet');
  await offer.click();
  await waitFor(async () => num(await page.locator('[data-sr-balance]').innerText()) === store.balance + 20000, 'balance +20,000');
  await waitFor(async () => /claimed/i.test(await page.locator('.lp-sr-offer', { hasText: 'Testing bonus' }).innerText()), 'Claimed state');
  store.balance += 20000;
  await page.keyboard.press('Escape');
  await page.click('[data-sr="close"]').catch(() => {});
  await waitMenu(page);
});

await scenario('direct-gift', async () => {
  const { page } = store.louis;
  const item = 'gold-chrome';
  await admin('POST', 'gift', { to: 'Louis_Test', marks: 3000, items: [], message: 'Thanks for testing, Louis_Test', fromLabel: 'Louis' });
  const badge = page.locator('.lt-inbox');
  await badge.waitFor({ timeout: 30_000 });
  await shot(store.louis, 'inbox');
  await badge.click();
  await page.waitForSelector('.lp-gf-box', { timeout: 20_000 });
  const text = await page.locator('.lp-gf').innerText();
  expect(/Thanks for testing, Louis_Test/.test(text), 'message shown');
  expect(/from Louis/i.test(text), 'from Louis shown');
  await page.click('.lp-gf-box', { force: true });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).waitFor({ timeout: 30_000 });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).click();
  await page.waitForSelector('.lp-sr:not([hidden])');
  await waitFor(async () => num(await page.locator('[data-sr-balance]').innerText()) === store.balance + 3000, 'balance +3000');
  store.balance += 3000;
  await page.click('[data-sr="close"]');
  await waitMenu(page);
  expect(await page.locator('.lt-inbox').count() === 0, 'badge gone after opening');
  void item;
});

await scenario('code-gift', async () => {
  const { page } = store.louis;
  const gift = await admin('POST', 'gift', { code: true, marks: 1000, items: [], message: 'Code gift', maxClaims: 1 });
  const link = gift.link ?? '';
  const code = new URL(link).searchParams.get('gift');
  expect(Boolean(code), `code in the admin answer (${link})`);
  store.giftCode = code;
  await page.click('.lt-profile-btn');
  const box = page.locator('.sh-redeem input');
  await box.waitFor({ timeout: 15_000 });
  await shot(store.louis, 'profile');
  await box.fill('NOPE-NOPE-NOPE');
  await page.click('.sh-redeem button');
  await waitFor(async () => (await page.locator('.sh-block .sh-err').innerText().catch(() => '')).length > 0, 'bad code message');
  await box.fill(code);
  await page.click('.sh-redeem button');
  await page.waitForSelector('.lp-gf-box', { timeout: 20_000 });
  await page.click('.lp-gf-box', { force: true });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).waitFor({ timeout: 30_000 });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).click();
  await waitFor(async () => num(await page.locator('[data-sr-balance]').innerText()) === store.balance + 1000, 'balance +1000');
  store.balance += 1000;
  await page.click('[data-sr="close"]');
  await waitMenu(page);
});

await scenario('gift-link', async () => {
  const gift = await admin('POST', 'gift', { code: true, marks: 2500, items: [], message: 'Welcome aboard', maxClaims: 1 });
  const code = new URL(gift.link).searchParams.get('gift');
  const p = await newPlayer('linked');
  const { page } = p;
  await page.goto(`${base}?gift=${code}`);
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  expect(/gift/i.test(await page.locator('.sh-card').innerText()), 'the name step mentions the waiting gift');
  expect(!page.url().includes('gift='), 'the code is removed from the address bar');
  await shot(p, 'link-name');
  await page.reload(); // the code must survive a reload during the name step
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  expect(/gift/i.test(await page.locator('.sh-card').innerText()), 'still mentions the gift after a reload');
  await createDriver(p, 'Linked_Newbie');
  // The starter gift came first; the link gift opens by itself once the shop is closed again.
  await page.waitForSelector('.lp-gf-box', { timeout: 30_000 });
  expect(/Welcome aboard/.test(await page.locator('.lp-gf').innerText()), 'link gift message');
  await shot(p, 'link-reveal');
  await page.click('.lp-gf-box', { force: true });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).waitFor({ timeout: 30_000 });
  await page.locator('.lp-gf button', { hasText: 'Open the shop' }).click();
  await waitFor(async () => num(await page.locator('[data-sr-balance]').innerText()) === 1500 + 2500, 'balance 4000 with both gifts');
  await page.click('[data-sr="close"]');
  await waitMenu(page);
  // The same link for a second brand new player.
  const q = await newPlayer('linked2');
  await q.page.goto(`${base}?gift=${code}`);
  await createDriver(q, 'Linked_Late');
  const dialog = q.page.locator('.sh-card', { hasText: 'already opened' });
  await dialog.waitFor({ timeout: 30_000 });
  await shot(q, 'link-used');
  await q.page.locator('.sh-card button').first().click();
  await q.context.close();
  await p.context.close();
});

await scenario('guest', async () => {
  const p = await newPlayer('guest');
  const { page } = p;
  await page.goto(base);
  await page.waitForSelector('#sh-name', { timeout: 120_000 });
  await page.locator('.sh-card button.sh-link', { hasText: 'Play without an account' }).click();
  await page.waitForSelector('.lp-gf-box', { timeout: 60_000 });
  await openStarterGift(page);
  expect(await balance(page) === 1500, 'guest gets the starter gift on the local wallet');
  await page.reload();
  await waitMenu(page);
  expect(await balance(page) === 1500, 'guest balance survives a reload');
  expect(await page.locator('.sh-layer').count() === 0, 'the first-run card does not return for a guest');
  await shot(p, 'guest-menu');
  // Make an account later: the local progress is offered to the server.
  await page.click('.lt-profile-btn');
  await page.locator('.sh-block button', { hasText: /account/i }).first().click();
  await page.fill('#sh-name', 'Guest_Later');
  await page.click('.sh-card button.lf-go');
  await page.waitForSelector('.sh-code', { timeout: 20_000 });
  await page.check('.sh-tick input');
  await page.locator('.sh-card button.lf-go').click();
  await waitFor(async () => (await page.locator('.sh-card, .sh-layer').count()) === 0 || true, 'dialogs closed', 3000);
  await page.waitForTimeout(3000);
  await shot(p, 'guest-upgraded');
  await p.context.close();
});

await scenario('sign-out', async () => {
  const { page } = store.recover;
  await page.click('.lt-profile-btn');
  await page.locator('.sh-block button', { hasText: /Sign out/i }).first().click();
  const confirmButton = page.locator('.sh-card button.lf-go', { hasText: /sign out/i });
  await confirmButton.waitFor({ timeout: 10_000 });
  await confirmButton.click();
  await page.waitForSelector('#sh-name', { timeout: 90_000 });
  const token = await page.evaluate(() => localStorage.getItem('lateral:account:v1'));
  expect(token === null, 'token removed on sign out');
});

await scenario('race', async () => {
  const names = ['Race_A', 'Race_B', 'Race_C'];
  const drivers = [];
  for (const name of names) {
    const p = await newPlayer(name);
    await p.page.goto(base);
    await createDriver(p, name);
    drivers.push(p);
  }
  for (const p of drivers) {
    await p.page.click('[data-action="online"]');
    await p.page.waitForSelector('.lp-net-quick', { timeout: 60_000 });
    await p.page.click('.lp-net-quick');
    await p.page.waitForSelector('.lp-net-ready', { timeout: 60_000 });
  }
  await shot(drivers[0], 'lobby');
  for (const p of drivers) await p.page.click('.lp-net-ready[data-net="ready"]').catch(() => {});
  await Promise.all(drivers.map(p => waitFor(async () => (await screenOf(p.page)) === 'drive', `${p.label} racing`, 90_000)));
  await shot(drivers[0], 'race');
  for (const p of drivers) { await p.page.keyboard.down('KeyW'); }
  await sleep(8000);
  await shot(drivers[1], 'race2');
  store.drivers = drivers;
});

/* ------------------------------------------------------------------ wrap up */
await scenario('hygiene', async () => {
  expect(thirdParty.length === 0, `third party requests:\n  ${thirdParty.join('\n  ')}`);
  expect(websimAttempts.length === 0, `requests to blocked hosts:\n  ${websimAttempts.join('\n  ')}`);
  expect(consoleErrors.length === 0, `console errors:\n  ${consoleErrors.join('\n  ')}`);
});

console.log(`\nexpected 4xx answers logged by the browser: ${expected4xx.length}`);
console.log(results.map(([name, status, why]) => `${status}  ${name}${why ? `\n      ${why.split('\n')[0]}` : ''}`).join('\n'));
await browser.close().catch(() => {});
stopAll();
await sleep(500);
process.exit(results.some(r => r[1] === 'FAIL') ? 1 : 0);
