/**
 * Photo mode looks: colour filters, vignette and a tilt-shift depth of field. The preview and the saved PNG use the same
 * numbers: the colour matrix drives both an SVG feColorMatrix (CSS filter on the live canvas, sRGB) and the per-pixel
 * pass on the capture; the vignette and focus band are the same gradients in CSS and on the 2D canvas.
 * The game's post-processing has no depth pass on every tier, so depth of field is a focus band (tilt shift) that
 * costs nothing in the 3D pipeline and looks the same on phones.
 */
export type PhotoFilterId = 'none' | 'noir' | 'warm' | 'cool' | 'vivid' | 'neon' | 'film';
/** 4x5 colour matrix, rows R G B A, last column is an offset in 0..1 (feColorMatrix layout). */
export type ColorMatrix = readonly number[];
export const PHOTO_FILTERS: readonly { readonly id: PhotoFilterId; readonly name: string; readonly matrix: ColorMatrix }[] = [
  { id: 'none', name: 'Natural', matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  { id: 'noir', name: 'Noir', matrix: [0.38, 0.75, 0.17, 0, -0.08, 0.38, 0.75, 0.17, 0, -0.08, 0.38, 0.75, 0.17, 0, -0.08, 0, 0, 0, 1, 0] },
  { id: 'warm', name: 'Sodium', matrix: [1.12, 0.08, 0, 0, 0.02, 0.02, 1.02, 0, 0, 0.01, 0, 0, 0.82, 0, -0.01, 0, 0, 0, 1, 0] },
  { id: 'cool', name: 'Harbor', matrix: [0.86, 0.04, 0.04, 0, -0.01, 0.02, 1.0, 0.06, 0, 0.01, 0.04, 0.08, 1.12, 0, 0.03, 0, 0, 0, 1, 0] },
  { id: 'vivid', name: 'Vivid', matrix: [1.32, -0.24, -0.08, 0, 0, -0.08, 1.24, -0.16, 0, 0, -0.08, -0.24, 1.32, 0, 0, 0, 0, 0, 1, 0] },
  { id: 'neon', name: 'Neon', matrix: [1.18, -0.1, 0.12, 0, 0.02, -0.06, 0.9, 0.2, 0, 0, 0.16, -0.04, 1.2, 0, 0.04, 0, 0, 0, 1, 0] },
  { id: 'film', name: 'Film', matrix: [0.82, 0.12, 0.04, 0, 0.07, 0.06, 0.8, 0.08, 0, 0.06, 0.04, 0.1, 0.72, 0, 0.08, 0, 0, 0, 1, 0] },
];

export interface PhotoLook {
  readonly filter: PhotoFilterId;
  /** 0..1 */
  readonly vignette: number;
  /** Depth of field strength 0..1 (0 = off). */
  readonly blur: number;
  /** Centre of the sharp band, 0 (top) .. 1 (bottom). */
  readonly focus: number;
}
export const DEFAULT_LOOK: PhotoLook = { filter: 'none', vignette: 0.25, blur: 0, focus: 0.58 };
/** Blur radius at full strength, CSS pixels. */
export const MAX_BLUR_CSS_PX = 9;

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
export function matrixFor(id: PhotoFilterId): ColorMatrix { return (PHOTO_FILTERS.find(entry => entry.id === id) ?? PHOTO_FILTERS[0]!).matrix; }
export function isIdentity(matrix: ColorMatrix): boolean { return matrix.every((value, index) => value === PHOTO_FILTERS[0]!.matrix[index]); }

/** Applies a colour matrix to RGBA bytes in place (sRGB values, same as feColorMatrix with color-interpolation-filters sRGB). */
export function applyColorMatrix(data: Uint8ClampedArray, matrix: ColorMatrix): void {
  if (isIdentity(matrix)) return;
  const m = matrix;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255, a = data[i + 3]! / 255;
    data[i] = (m[0]! * r + m[1]! * g + m[2]! * b + m[3]! * a + m[4]!) * 255;
    data[i + 1] = (m[5]! * r + m[6]! * g + m[7]! * b + m[8]! * a + m[9]!) * 255;
    data[i + 2] = (m[10]! * r + m[11]! * g + m[12]! * b + m[13]! * a + m[14]!) * 255;
  }
}

/** Gradient stops (0..1) of the blur mask: blurred above `a`, sharp between `b` and `c`, blurred below `d`. */
export function focusStops(focus: number, band = 0.22): readonly [number, number, number, number] {
  const f = clamp01(focus), half = band / 2;
  const b = clamp01(f - half), c = clamp01(f + half);
  return [clamp01(b - 0.18), b, c, clamp01(c + 0.18)];
}

/** CSS mask for the live blur layer: opaque where blurred. */
export function focusMaskCss(focus: number): string {
  const [a, b, c, d] = focusStops(focus).map(stop => `${(stop * 100).toFixed(1)}%`);
  return `linear-gradient(to bottom,#000 0%,#000 ${a},transparent ${b},transparent ${c},#000 ${d},#000 100%)`;
}
export function vignetteCss(strength: number): string {
  const s = clamp01(strength);
  return `radial-gradient(ellipse at center,rgba(0,0,0,0) ${(62 - s * 22).toFixed(1)}%,rgba(0,0,0,${(s * 0.85).toFixed(3)}) 100%)`;
}
/** feColorMatrix values attribute. */
export function matrixValues(matrix: ColorMatrix): string { return matrix.map(value => String(value)).join(' '); }

/**
 * Output size of a saved photo: the screen's physical resolution (CSS size x devicePixelRatio), capped so the long
 * side stays at or under `maxSide`. The canvas may render below that (auto quality); the capture scales up to it.
 */
export function photoSize(cssWidth: number, cssHeight: number, dpr: number, maxSide = 4096): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1;
  let width = Math.max(1, Math.round((Number.isFinite(cssWidth) ? cssWidth : 1) * ratio));
  let height = Math.max(1, Math.round((Number.isFinite(cssHeight) ? cssHeight : 1) * ratio));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
  return { width, height };
}

/**
 * Composes the saved photo from the rendered frame (call in the same task as the render, so the WebGL buffer is
 * still valid). Returns a canvas at `size` with the look applied.
 */
export function composePhoto(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, size: { width: number; height: number }, look: PhotoLook, cssWidth: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = size.width; out.height = size.height;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, size.width, size.height);
  const blur = clamp01(look.blur);
  if (blur > 0.01) {
    // Box-ish blur by down and up sampling: works in every browser (no ctx.filter needed).
    const radius = blur * MAX_BLUR_CSS_PX * (size.width / Math.max(1, cssWidth));
    const factor = Math.max(2, Math.min(24, radius * 0.9));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(size.width / factor)); small.height = Math.max(1, Math.round(size.height / factor));
    const sctx = small.getContext('2d');
    const layer = document.createElement('canvas');
    layer.width = size.width; layer.height = size.height;
    const lctx = layer.getContext('2d');
    if (sctx && lctx) {
      sctx.imageSmoothingEnabled = true; sctx.drawImage(out, 0, 0, small.width, small.height);
      lctx.imageSmoothingEnabled = true; lctx.imageSmoothingQuality = 'high';
      lctx.drawImage(small, 0, 0, size.width, size.height);
      const [a, b, c, d] = focusStops(look.focus);
      const mask = lctx.createLinearGradient(0, 0, 0, size.height);
      mask.addColorStop(0, '#000'); mask.addColorStop(a, '#000'); mask.addColorStop(b, 'rgba(0,0,0,0)');
      mask.addColorStop(c, 'rgba(0,0,0,0)'); mask.addColorStop(d, '#000'); mask.addColorStop(1, '#000');
      lctx.globalCompositeOperation = 'destination-in';
      lctx.fillStyle = mask; lctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(layer, 0, 0);
    }
  }
  const matrix = matrixFor(look.filter);
  if (!isIdentity(matrix)) {
    const image = ctx.getImageData(0, 0, size.width, size.height);
    applyColorMatrix(image.data, matrix);
    ctx.putImageData(image, 0, 0);
  }
  const vignette = clamp01(look.vignette);
  if (vignette > 0.01) {
    // Same ellipse as CSS "ellipse at center" (farthest corner): radii (w/2, h/2) x sqrt 2, drawn as a scaled circle.
    const cx = size.width / 2, cy = size.height / 2, r = cx * Math.SQRT2;
    const gradient = ctx.createRadialGradient(cx, cy, r * (0.62 - vignette * 0.22), cx, cy, r);
    gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(1, `rgba(0,0,0,${vignette * 0.85})`);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(1, size.height / size.width || 1); ctx.translate(-cx, -cy);
    ctx.fillStyle = gradient; ctx.fillRect(-size.width, -size.height, size.width * 3, size.height * 3); ctx.restore();
  }
  return out;
}
