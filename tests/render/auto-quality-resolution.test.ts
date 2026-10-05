import { describe, expect, it } from 'vitest';
import type { QualityPreset } from '../../contracts/runtime-contracts';
import { createAutoQualityController, MIN_RESOLUTION_SCALE, type AutoQualityController } from '../../src/render';

const VSYNC = 1000 / 60;

/**
 * Closed-loop GPU model of a fill-bound laptop on a 60 Hz display: GPU frame time scales with pixel count
 * (resolution scale squared), and delivered intervals snap to whole vsyncs, so 25 ms of GPU work shows up as
 * the familiar 16.7 / 33.3 ms alternation (40 fps) rather than 25 ms frames.
 */
function drive(controller: AutoQualityController, gpuMsAtFullScale: Readonly<Partial<Record<QualityPreset, number>>>, seconds: number) {
  let debt = 0, elapsed = 0;
  const log: { preset: QualityPreset; scale: number; interval: number }[] = [];
  const presets = new Set<QualityPreset>();
  while (elapsed < seconds * 1000) {
    const preset = controller.effectivePreset, scale = controller.resolutionScale;
    const gpu = (gpuMsAtFullScale[preset] ?? 8) * scale * scale;
    // Present on the first vsync after the GPU finishes; carry the remainder (pipelined frames).
    debt += gpu;
    const vsyncs = Math.max(1, Math.ceil((debt - 1e-6) / VSYNC));
    const interval = vsyncs * VSYNC;
    debt = Math.max(0, debt - interval);
    controller.sample(interval, true);
    presets.add(preset);
    log.push({ preset, scale, interval });
    elapsed += interval;
  }
  const tail = (lastSeconds: number) => {
    let ms = 0, frames = 0;
    for (let i = log.length - 1; i >= 0 && ms < lastSeconds * 1000; i--) { ms += log[i]!.interval; frames++; }
    return 1000 * frames / ms;
  };
  return { log, presets, tail };
}

// MacBook Air M3 at 1470x956 on a 2x display, measured with the real build: Balanced at its 1.35 DPR cap is ~25 ms of
// GPU (40 fps), High at 1.75 is about twice that, Low at 1x is comfortably inside budget.
const M3_AIR = { high: 50, balanced: 25, low: 9 } as const;

describe('Auto spends resolution before quality', () => {
  it('sees the 40 fps vsync alternation as slow (half the frames hit budget, so a count alone never fired)', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced' });
    for (let frame = 0; frame < 60; frame++) controller.sample(frame % 2 ? 2 * VSYNC : VSYNC, true);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBeLessThan(1);
  });

  it('an M3 Air on Balanced buys 60 fps back with resolution and keeps the Balanced look', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced' });
    const run = drive(controller, M3_AIR, 30);
    expect([...run.presets]).toEqual(['balanced']);
    expect(controller.resolutionScale).toBeGreaterThanOrEqual(MIN_RESOLUTION_SCALE);
    expect(controller.resolutionScale).toBeLessThanOrEqual(0.8);
    // Settled within the first few seconds and holding 60 fps afterwards.
    expect(run.tail(20)).toBeGreaterThan(57);
  });

  it('a High start that the resolution floor cannot save drops one tier, never to Low, and settles at 60 fps', () => {
    const controller = createAutoQualityController({ initialPreset: 'high' });
    const run = drive(controller, M3_AIR, 40);
    expect(run.presets.has('low')).toBe(false);
    expect(controller.effectivePreset).toBe('balanced');
    expect(run.tail(20)).toBeGreaterThan(57);
  });

  it('a slow probe that only needs a little resolution never touches the tier', () => {
    const controller = createAutoQualityController({ initialPreset: 'high' });
    const run = drive(controller, { high: 21, balanced: 12, low: 6 }, 30);
    expect([...run.presets]).toEqual(['high']);
    expect(controller.resolutionScale).toBeGreaterThanOrEqual(0.8);
    // Periodic scale-up trials cost a short dip each; the average stays at about 60.
    expect(run.tail(15)).toBeGreaterThan(55);
  });

  it('a hitch during the probe (shader compile) is not read as a slow GPU', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced' });
    for (let frame = 0; frame < 240; frame++) controller.sample(frame === 100 ? 900 : VSYNC, true);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBe(1);
  });

  it('scattered long frames from elsewhere on the machine do not chase resolution or quality down', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced' });
    // One frame in ten takes 100 ms (another app, a resize), the rest are on time: 20 s of it.
    for (let frame = 0; frame < 1_100; frame++) controller.sample(frame % 10 === 5 ? 100 : VSYNC, true);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBe(1);
  });
});
