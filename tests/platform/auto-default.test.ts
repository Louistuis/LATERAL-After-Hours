import { describe, expect, it } from 'vitest';
import { classifyDevice, type DeviceSignals } from '../../src/platform/device-profile';
import { initialQualityForGpu } from '../../src/render/gpu-tier';
import { createAutoQualityController } from '../../src/render/auto-quality';

const mac: DeviceSignals = {
  coarsePointer: false, hoverNone: false, maxTouchPoints: 0, platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  screenWidth: 1470, screenHeight: 956,
};
const M3 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)';
const HD620 = 'ANGLE (Intel, Mesa Intel(R) HD Graphics 620 (KBL GT2), OpenGL ES 3.2)';

describe('Auto as the first-run desktop default', () => {
  it('starts Auto on a real tier for desktop GPUs (never Low), so the resolution-first probe does the work', () => {
    const desktop = classifyDevice(mac);
    expect(desktop.defaultSelection).toBe('auto');
    expect(initialQualityForGpu(desktop, M3).initial).toBe('high');
    expect(initialQualityForGpu(desktop, HD620).initial).toBe('balanced');
    expect(initialQualityForGpu(desktop, '').initial).toBe('balanced');
    // Only a software renderer starts on Low, as before.
    expect(initialQualityForGpu(desktop, 'Google SwiftShader').initial).toBe('low');
  });

  it('a slow start spends resolution before the first tier step', () => {
    const tiers = initialQualityForGpu(classifyDevice(mac), HD620);
    const controller = createAutoQualityController({ initialPreset: tiers.initial, maxPreset: tiers.max });
    // 3 s of 22 ms frames (about 45 fps): the probe lowers resolution and keeps the tier.
    for (let frame = 0; frame < 140; frame++) controller.sample(22, true);
    expect(controller.effectivePreset).toBe('balanced');
    expect(controller.resolutionScale).toBeLessThan(1);
  });

  it('phones and tablets keep their fixed first-run preset', () => {
    const phone = classifyDevice({ ...mac, coarsePointer: true, hoverNone: true, maxTouchPoints: 5, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile', screenWidth: 393, screenHeight: 852 });
    const tablet = classifyDevice({ ...mac, maxTouchPoints: 5, screenWidth: 1024, screenHeight: 1366 });
    expect(phone.defaultSelection).toBe('low');
    expect(tablet.defaultSelection).toBe('balanced');
  });
});
