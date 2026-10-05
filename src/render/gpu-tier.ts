import type { QualityPreset } from '../../contracts/runtime-contracts';
import type { DeviceKind } from '../platform/device-profile';

export type GpuClass = 'software' | 'integrated' | 'mid' | 'strong' | 'unknown';

/**
 * Coarse GPU class from the WebGL renderer string (UNMASKED_RENDERER_WEBGL, or RENDERER where the browser
 * already unmasks it). Only a starting guess for Auto: the startup probe and the frame-time controller
 * correct it within seconds, so a wrong guess costs a short dip, never a stuck tier.
 */
export function classifyGpu(renderer: string): GpuClass {
  const r = renderer.toLowerCase();
  if (!r.trim()) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render|software/.test(r)) return 'software';
  if (/rtx|radeon rx ?[5-9]\d{3}|rx ?[67]\d{2}0|radeon pro w|quadro rtx|gtx 1[6-9]\d0|gtx 10[78]0|titan|apple m\d (pro|max|ultra)|arc\(tm\) a[57]|arc a[57]/.test(r)) return 'strong';
  if (/apple m\d|iris\(r\) xe|iris xe|radeon\(tm\) (\d{3}m|graphics)|radeon graphics|vega|geforce mx|gtx (9\d0|10[56]0)|adreno \(tm\) [78]\d{2}|adreno [78]\d{2}/.test(r)) return 'mid';
  if (/intel|mali|adreno|powervr|videocore|apple gpu/.test(r)) return 'integrated';
  if (/nvidia|geforce|radeon|amd/.test(r)) return 'mid';
  return 'unknown';
}

/**
 * Starting tier and ceiling for Auto. Strong desktop GPUs start on Ultra, mid-range on High, and anything
 * integrated or unknown on the device's own default (Balanced on desktop, Low on phones).
 */
export function initialQualityForGpu(
  device: Readonly<{ kind: DeviceKind; defaultQuality: QualityPreset }>,
  renderer: string,
): Readonly<{ initial: QualityPreset; max: QualityPreset }> {
  const gpu = classifyGpu(renderer);
  if (device.kind === 'phone') return { initial: gpu === 'software' ? 'low' : device.defaultQuality, max: 'high' };
  if (gpu === 'software') return { initial: 'low', max: 'balanced' };
  if (device.kind === 'tablet') return { initial: device.defaultQuality, max: 'high' };
  if (gpu === 'strong') return { initial: 'ultra', max: 'ultra' };
  if (gpu === 'mid') return { initial: 'high', max: 'ultra' };
  return { initial: device.defaultQuality, max: 'ultra' };
}

/** The live context's renderer string, or '' where the browser hides it. */
export function readGpuRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined): string {
  if (!gl) return '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const value: unknown = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
