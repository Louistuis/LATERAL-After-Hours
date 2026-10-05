/**
 * Tiny offline DSP kit used to generate every LATERAL sound at runtime (no samples are downloaded).
 * Everything here is pure and deterministic: the same seed renders the same Float32Array in the browser,
 * in vitest and in the offline review renderer.
 */

export type Rng = () => number;

/** Deterministic LCG in [0, 1). */
export function rng(seed: number): Rng {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Cheap bell-shaped noise in roughly [-1.7, 1.7], unit-ish variance. */
export function gauss(random: Rng): number { return (random() + random() + random() - 1.5) * 1.15; }

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Interpolates in log space, for frequencies. */
export const lerpLog = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  private z1 = 0;
  private z2 = 0;
  private constructor(private readonly b0: number, private readonly b1: number, private readonly b2: number, private readonly a1: number, private readonly a2: number) {}

  static lowpass(frequency: number, q: number, sampleRate: number): Biquad {
    const { cos, alpha } = Biquad.omega(frequency, q, sampleRate);
    const a0 = 1 + alpha;
    return new Biquad((1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, -2 * cos / a0, (1 - alpha) / a0);
  }
  static highpass(frequency: number, q: number, sampleRate: number): Biquad {
    const { cos, alpha } = Biquad.omega(frequency, q, sampleRate);
    const a0 = 1 + alpha;
    return new Biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, -2 * cos / a0, (1 - alpha) / a0);
  }
  /** Constant 0 dB peak gain band-pass. */
  static bandpass(frequency: number, q: number, sampleRate: number): Biquad {
    const { cos, alpha } = Biquad.omega(frequency, q, sampleRate);
    const a0 = 1 + alpha;
    return new Biquad(alpha / a0, 0, -alpha / a0, -2 * cos / a0, (1 - alpha) / a0);
  }

  private static omega(frequency: number, q: number, sampleRate: number): { cos: number; alpha: number } {
    const f = Math.max(10, Math.min(frequency, sampleRate * 0.45));
    const w = 2 * Math.PI * f / sampleRate;
    return { cos: Math.cos(w), alpha: Math.sin(w) / (2 * Math.max(0.05, q)) };
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Filters a buffer in place. `loop` runs a warm-up pass first so the filter state wraps and the loop has no seam. */
export function filterInPlace(data: Float32Array, filter: Biquad, loop = false): Float32Array {
  if (loop) for (let i = 0; i < data.length; i++) filter.process(data[i]!);
  for (let i = 0; i < data.length; i++) data[i] = filter.process(data[i]!);
  return data;
}

export function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]!); if (v > max) max = v; }
  return max;
}

export function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return data.length ? Math.sqrt(sum / data.length) : 0;
}

/** Scales to the given peak and returns the factor used. */
export function normalize(data: Float32Array, target: number): number {
  const max = peak(data);
  if (max < 1e-9) return 1;
  const factor = target / max;
  for (let i = 0; i < data.length; i++) data[i]! *= factor;
  return factor;
}

export function scale(data: Float32Array, factor: number): Float32Array {
  for (let i = 0; i < data.length; i++) data[i]! *= factor;
  return data;
}

/** Short linear fades at both ends of a one-shot so nothing clicks. */
export function fadeEdges(data: Float32Array, sampleRate: number, inMs = 1.5, outMs = 8): Float32Array {
  const fin = Math.min(data.length, Math.round(inMs * sampleRate / 1000));
  const fout = Math.min(data.length, Math.round(outMs * sampleRate / 1000));
  for (let i = 0; i < fin; i++) data[i]! *= i / fin;
  for (let i = 0; i < fout; i++) data[data.length - 1 - i]! *= i / fout;
  return data;
}

/** Soft clip used when baking one-shots, so a generated asset never exceeds full scale. */
export function softClip(data: Float32Array, drive = 1): Float32Array {
  const norm = Math.tanh(drive);
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i]! * drive) / norm;
  return data;
}

/** A tanh transfer curve for a WaveShaperNode. */
export function saturationCurve(points = 1024, hardness = 3): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const norm = Math.tanh(hardness);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1) * 2 - 1;
    curve[i] = Math.tanh(hardness * x) / norm;
  }
  return curve;
}

/** Post-gain that keeps a tanh stage's peak output steady while its input drive changes. */
export function saturationMakeup(drive: number, hardness = 3): number {
  const d = Math.max(0.05, Math.min(1, drive));
  return 0.5 / (Math.tanh(hardness * d) / Math.tanh(hardness));
}

/** Smooth random walk built from sines whose periods divide the loop, so it wraps seamlessly (recursive oscillators). */
export function loopedWobble(length: number, cyclesPerLoop: readonly number[], random: Rng): Float32Array {
  const out = new Float32Array(length);
  for (const cycles of cyclesPerLoop) {
    const phase = random() * Math.PI * 2;
    const amp = (0.5 + random()) / cyclesPerLoop.length;
    const w = 2 * Math.PI * cycles / length;
    const c = Math.cos(w), s = Math.sin(w);
    let x = Math.cos(phase), y = Math.sin(phase);
    for (let i = 0; i < length; i++) {
      out[i]! += y * amp;
      const nx = x * c - y * s;
      y = x * s + y * c; x = nx;
    }
  }
  return out;
}
