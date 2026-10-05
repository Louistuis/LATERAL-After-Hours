import type { QualityPreset, QualitySelection } from '../../contracts/runtime-contracts';

export type DeviceKind = 'phone' | 'tablet' | 'desktop';
export interface DeviceProfile {
  readonly kind: DeviceKind;
  /** A touchscreen is the primary pointer (or the device is an iPad posing as a Mac). */
  readonly touch: boolean;
  /**
   * Fixed tier the renderer boots on before the save loads, and Auto's starting tier when the GPU is not recognised
   * (src/render/gpu-tier.ts). Never Low on a desktop with a real GPU.
   */
  readonly defaultQuality: Extract<QualityPreset, 'low' | 'balanced'>;
  /**
   * First-run Graphics setting for players with no saved choice; a saved choice always wins. Desktops use Auto, which
   * buys frame rate back with resolution before it touches quality (src/render/auto-quality.ts). Phones and tablets
   * keep their fixed preset: Auto has no measurements on touch devices yet.
   */
  readonly defaultSelection: QualitySelection;
  /** Upper bound for the canvas devicePixelRatio, applied before the quality preset's own cap. */
  readonly pixelRatioCap: number;
}
export interface DeviceSignals {
  readonly coarsePointer: boolean;
  readonly hoverNone: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly userAgent: string;
  /** Screen size in CSS pixels; orientation does not matter. */
  readonly screenWidth: number;
  readonly screenHeight: number;
}

/** Shortest screen side, in CSS px, below which a touch device counts as a phone. */
const PHONE_MAX_SHORT_SIDE = 600;

/** Pure classification so it can be unit tested without a browser. */
export function classifyDevice(signals: DeviceSignals): DeviceProfile {
  // iPadOS 13+ Safari reports "MacIntel" and a desktop UA; real Macs report 0 touch points.
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(signals.userAgent);
  const iPadAsMac = /Mac/i.test(signals.platform) && signals.maxTouchPoints > 1 && !/Android|iPhone|iPod|Mobile/i.test(signals.userAgent);
  const touch = iPadAsMac || (signals.maxTouchPoints > 0 && (signals.coarsePointer || signals.hoverNone || mobileUa));
  if (!touch) return { kind: 'desktop', touch: false, defaultQuality: 'balanced', defaultSelection: 'auto', pixelRatioCap: 2 };
  const shortSide = Math.min(signals.screenWidth, signals.screenHeight);
  const phone = !iPadAsMac && !/iPad|Tablet/i.test(signals.userAgent) && shortSide > 0 && shortSide < PHONE_MAX_SHORT_SIDE;
  return phone
    ? { kind: 'phone', touch: true, defaultQuality: 'low', defaultSelection: 'low', pixelRatioCap: 1.5 }
    : { kind: 'tablet', touch: true, defaultQuality: 'balanced', defaultSelection: 'balanced', pixelRatioCap: 2 };
}

function readSignals(): DeviceSignals | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null;
  const media = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const screen = typeof window.screen === 'object' && window.screen ? window.screen : { width: 0, height: 0 };
  return {
    coarsePointer: media('(pointer: coarse)'), hoverNone: media('(hover: none)'),
    maxTouchPoints: navigator.maxTouchPoints ?? 0, platform: navigator.platform ?? '', userAgent: navigator.userAgent ?? '',
    screenWidth: screen.width || 0, screenHeight: screen.height || 0,
  };
}

let cached: DeviceProfile | null = null;
/** The current browser's profile, computed once (screen size is orientation independent). */
export function detectDeviceProfile(): DeviceProfile {
  if (cached) return cached;
  const signals = readSignals();
  const profile: DeviceProfile = signals ? classifyDevice(signals) : { kind: 'desktop', touch: false, defaultQuality: 'balanced', defaultSelection: 'auto', pixelRatioCap: 2 };
  if (signals) cached = profile;
  return profile;
}

/** Device pixel ratio to hand the renderer: the real ratio, capped for the device class. */
export function cappedPixelRatio(raw: number, profile: DeviceProfile = detectDeviceProfile()): number {
  const ratio = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.min(ratio, profile.pixelRatioCap);
}
