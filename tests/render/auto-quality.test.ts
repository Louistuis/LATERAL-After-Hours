import { describe, expect, it } from 'vitest';
import { classifyGpu, createAutoQualityController, initialQualityForGpu, MIN_RESOLUTION_SCALE, type AutoQualityController } from '../../src/render';

const HD620 = 'ANGLE (Intel, Mesa Intel(R) HD Graphics 620 (KBL GT2), OpenGL ES 3.2)';
const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)';

function feed(controller: AutoQualityController, frames: number, interval: number, active = true): void {
  for (let frame = 0; frame < frames; frame++) controller.sample(interval, active);
}

describe('automatic render quality controller', () => {
  it('upgrades at a sustained stable 60 Hz VSync cadence', () => {
    const controller = createAutoQualityController();
    expect(controller.effectivePreset).toBe('balanced');
    feed(controller, 1_800, 1000 / 60);
    expect(controller.effectivePreset).toBe('balanced');
    feed(controller, 120, 1000 / 60);
    expect(controller.effectivePreset).toBe('high');
    expect(controller.resolutionScale).toBe(1);
  });

  it('spends resolution down to the floor before dropping a tier', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced', targetFps: 60 });
    feed(controller, 45, 25);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBe(0.9);
    let lowestBeforeDrop = 1;
    for (let frame = 0; frame < 600 && controller.effectivePreset === 'balanced'; frame++) {
      lowestBeforeDrop = Math.min(lowestBeforeDrop, controller.resolutionScale);
      controller.sample(25, true);
    }
    expect(lowestBeforeDrop).toBe(MIN_RESOLUTION_SCALE);
    expect(controller.effectivePreset).toBe('low');
    expect(controller.resolutionScale).toBe(1);
  });

  it('drops a far-too-heavy starting tier after the startup probe', () => {
    const controller = createAutoQualityController({ initialPreset: 'ultra' });
    expect(controller.effectivePreset).toBe('ultra');
    feed(controller, 60, 50);
    expect(controller.effectivePreset).toBe('high');
    expect(controller.resolutionScale).toBe(1);
    feed(controller, 120, 50);
    expect(controller.effectivePreset).toBe('low');
  });

  it('restores resolution after sustained headroom without changing tier', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced' });
    feed(controller, 45, 25);
    expect(controller.resolutionScale).toBe(0.9);
    feed(controller, 600, 1000 / 60);
    expect(controller.resolutionScale).toBe(1);
    expect(controller.effectivePreset).toBe('balanced');
  });

  it('clears cadence streaks while inactive and does not count paused intervals', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced', targetFps: 60 });
    feed(controller, 30, 25);
    feed(controller, 500, 1_000, false);
    feed(controller, 44, 25);
    expect(controller.resolutionScale).toBe(1);
    controller.sample(25, true);
    expect(controller.resolutionScale).toBe(0.9);
  });

  it('does not spend scale cooldown while simulation/rendering is inactive', () => {
    const controller = createAutoQualityController({ initialPreset: 'balanced', targetFps: 60 });
    feed(controller, 45, 25);
    expect(controller.resolutionScale).toBe(0.9);
    feed(controller, 200, 1_000, false);
    feed(controller, 45, 25);
    expect(controller.resolutionScale).toBe(0.9);
    feed(controller, 20, 25);
    expect(controller.resolutionScale).toBe(0.8);
  });

  it('holds a fixed benchmark preset outside Auto and resets deterministically', () => {
    const controller = createAutoQualityController({ initialPreset: 'low' });
    controller.lockFixed('ultra');
    feed(controller, 1_000, 50);
    expect(controller.effectivePreset).toBe('ultra');
    expect(controller.resolutionScale).toBe(1);

    controller.lockFixed(null);
    expect(controller.effectivePreset).toBe('low');
    controller.reset();
    expect(controller.effectivePreset).toBe('low');
    controller.lockFixed('balanced');
    controller.reset();
    expect(controller.effectivePreset).toBe('low');
  });

  it('returns a failed trial upgrade and waits for fresh healthy headroom', () => {
    const controller = createAutoQualityController();
    feed(controller, 1_920, 1000 / 60);
    expect(controller.effectivePreset).toBe('high');

    feed(controller, 45, 25);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBe(1);

    feed(controller, 1_800, 1000 / 60);
    expect(controller.effectivePreset).toBe('balanced');
    feed(controller, 120, 1000 / 60);
    expect(controller.effectivePreset).toBe('high');
  });

  it('never climbs above the ceiling and clamps the starting tier to it', () => {
    const controller = createAutoQualityController({ initialPreset: 'ultra', maxPreset: 'high' });
    expect(controller.effectivePreset).toBe('high');
    feed(controller, 6_000, 1000 / 60);
    expect(controller.effectivePreset).toBe('high');
  });
});

describe('Auto starting tier from the GPU', () => {
  it('classifies common renderer strings', () => {
    expect(classifyGpu(HD620)).toBe('integrated');
    expect(classifyGpu(RTX)).toBe('strong');
    expect(classifyGpu('Google SwiftShader')).toBe('software');
    expect(classifyGpu('')).toBe('unknown');
  });

  it('starts strong desktops on Ultra and keeps integrated GPUs on the device default', () => {
    const desktop = { kind: 'desktop', defaultQuality: 'balanced' } as const;
    expect(initialQualityForGpu(desktop, RTX)).toEqual({ initial: 'ultra', max: 'ultra' });
    expect(initialQualityForGpu(desktop, HD620)).toEqual({ initial: 'balanced', max: 'ultra' });
    expect(initialQualityForGpu(desktop, 'Google SwiftShader')).toEqual({ initial: 'low', max: 'balanced' });
    expect(initialQualityForGpu({ kind: 'phone', defaultQuality: 'low' }, 'Apple GPU')).toEqual({ initial: 'low', max: 'high' });
  });
});
