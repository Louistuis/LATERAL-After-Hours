import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { chromium } from '@playwright/test';
import ts from 'typescript';

const url = process.env.LATERAL_URL ?? 'http://127.0.0.1:5173/';
const durationSeconds = Number(process.env.L3_AUTO_SAMPLE_SECONDS ?? 42);
const outputPath = process.env.L3_AUTO_SAMPLE_JSON ??
  `evidence/L3/${new Date().toISOString().slice(0, 10)}/auto-quality-rAF.json`;
const flags = [
  '--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl',
];
if (!Number.isFinite(durationSeconds) || durationSeconds < 32) {
  throw new Error('L3_AUTO_SAMPLE_SECONDS must be at least 32 to capture the policy headroom decision');
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: flags });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const consoleWarnings = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

try {
  const controllerSource = readFileSync('src/render/auto-quality.ts', 'utf8');
  const controllerModule = ts.transpileModule(controllerSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await page.route(url, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
  }));
  await page.route('**/src/render/auto-quality.ts', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: controllerModule,
  }));
  await page.goto(url);
  const run = await page.evaluate(async ({ sampleDurationMs }) => {
    const { createAutoQualityController } = await import('/src/render/auto-quality.ts');
    const controller = createAutoQualityController({ initialPreset: 'balanced', targetFps: 60 });
    const samples = [];
    const start = performance.now();
    let previous = null;
    return new Promise((resolve) => {
      const onFrame = (now) => {
        const interval = previous === null ? null : now - previous;
        previous = now;
        if (interval !== null) {
          const effectivePreset = controller.sample(interval, document.visibilityState === 'visible');
          samples.push({
            elapsedMs: now - start,
            frameIntervalMs: interval,
            active: document.visibilityState === 'visible',
            effectivePreset,
          });
        }
        if (now - start >= sampleDurationMs) resolve({ samples, finalPreset: controller.effectivePreset });
        else requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
    });
  }, { sampleDurationMs: durationSeconds * 1000 });

  const intervals = run.samples.map((sample) => sample.frameIntervalMs);
  const report = {
    scope: 'real browser requestAnimationFrame intervals fed into the render-only adaptive controller; blank fixture, not gameplay performance evidence',
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: true,
    timestamp: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    os: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length },
    flags,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    input: { source: 'requestAnimationFrame(performance.now())', targetFps: 60, initialPreset: 'balanced', durationSeconds },
    summary: {
      frames: intervals.length,
      activeFrames: run.samples.filter((sample) => sample.active).length,
      averageFps: intervals.length ? intervals.length * 1000 / intervals.reduce((sum, interval) => sum + interval, 0) : null,
      frameIntervalP95Ms: percentile(intervals, 0.95),
      frameIntervalP99Ms: percentile(intervals, 0.99),
      maxFrameIntervalMs: intervals.length ? Math.max(...intervals) : null,
      finalPreset: run.finalPreset,
      percentileMethod: 'nearest rank: sorted[Math.ceil(p*N)-1]',
    },
    rawSamples: run.samples,
    pageErrors,
    consoleErrors,
    consoleWarnings,
    limitations: [
      'blank browser fixture only; no ScenePipeline, Harbor assets, physics or gameplay work is rendered',
      'measures delivered browser callback cadence and policy response, not CPU/GPU rendering time or game performance',
      'does not replace the approved-device matrix or fixed-preset benchmark',
    ],
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, browser: report.browser, os: report.os, summary: report.summary, pageErrors, consoleErrors, consoleWarnings }, null, 2));
  if (pageErrors.length || consoleErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
