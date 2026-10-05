import { describe, expect, it } from 'vitest';
import { cappedPixelRatio, classifyDevice, type DeviceSignals } from '../../src/platform/device-profile';

const desktop: DeviceSignals = {
  coarsePointer: false, hoverNone: false, maxTouchPoints: 0, platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  screenWidth: 1512, screenHeight: 982,
};

describe('device profile', () => {
  it('starts new desktop players on Auto, booting the renderer on Balanced, with the renderer cap', () => {
    expect(classifyDevice(desktop)).toEqual({ kind: 'desktop', touch: false, defaultQuality: 'balanced', defaultSelection: 'auto', pixelRatioCap: 2 });
  });

  it('treats a touchscreen laptop with a fine primary pointer as a desktop', () => {
    expect(classifyDevice({ ...desktop, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 }).kind).toBe('desktop');
  });

  it('puts phones on Low with the DPR capped at 1.5', () => {
    const iphone = classifyDevice({ ...desktop, coarsePointer: true, hoverNone: true, maxTouchPoints: 5, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', screenWidth: 393, screenHeight: 852 });
    expect(iphone).toEqual({ kind: 'phone', touch: true, defaultQuality: 'low', defaultSelection: 'low', pixelRatioCap: 1.5 });
    const android = classifyDevice({ ...desktop, coarsePointer: true, maxTouchPoints: 5, platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', screenWidth: 915, screenHeight: 412 });
    expect(android.kind).toBe('phone');
  });

  it('recognises iPadOS reporting itself as a Mac with touch points', () => {
    expect(classifyDevice({ ...desktop, maxTouchPoints: 5, screenWidth: 1024, screenHeight: 1366 })).toEqual({ kind: 'tablet', touch: true, defaultQuality: 'balanced', defaultSelection: 'balanced', pixelRatioCap: 2 });
    // Even an iPad mini, whose short side is under the phone threshold.
    expect(classifyDevice({ ...desktop, maxTouchPoints: 5, screenWidth: 744, screenHeight: 1133 }).kind).toBe('tablet');
  });

  it('does not mistake a phone UA on a Mac-reporting platform (device emulation) for an iPad', () => {
    expect(classifyDevice({ ...desktop, coarsePointer: true, hoverNone: true, maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36', screenWidth: 375, screenHeight: 812 }).kind).toBe('phone');
  });

  it('classifies large Android touch devices as tablets', () => {
    expect(classifyDevice({ ...desktop, coarsePointer: true, maxTouchPoints: 10, platform: 'Linux', userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-X710)', screenWidth: 800, screenHeight: 1280 }).kind).toBe('tablet');
  });

  it('caps the pixel ratio per device class and survives bad input', () => {
    const phone = classifyDevice({ ...desktop, coarsePointer: true, maxTouchPoints: 5, platform: 'iPhone', userAgent: 'iPhone', screenWidth: 390, screenHeight: 844 });
    expect(cappedPixelRatio(3, phone)).toBe(1.5);
    expect(cappedPixelRatio(1, phone)).toBe(1);
    expect(cappedPixelRatio(Number.NaN, phone)).toBe(1);
    expect(cappedPixelRatio(3, classifyDevice({ ...desktop, maxTouchPoints: 5 }))).toBe(2);
  });
});
