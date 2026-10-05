import { Biquad, fadeEdges, filterInPlace, gauss, loopedWobble, normalize, rng, scale, softClip, type Rng } from './dsp';
import type { CombustionVoice } from './engine-voices';

/**
 * Generated waveforms for every LATERAL sound. Each renderer is pure and deterministic and returns plain
 * Float32Arrays, so the browser fills AudioBuffers from them and the offline review renderer can write the
 * exact same samples to WAV. Nothing is downloaded.
 */

// ---------------------------------------------------------------------------------------------- helpers

const TAU = Math.PI * 2;
const seconds = (sampleRate: number, value: number): number => Math.max(1, Math.round(sampleRate * value));

/** Adds `source * gain` into `buffer` at `start`, wrapping around for loops and clipping for one-shots. */
function mixInto(buffer: Float32Array, source: Float32Array, start: number, gain: number, loop: boolean): void {
  const length = buffer.length;
  if (loop) {
    let index = ((start % length) + length) % length;
    for (let n = 0; n < source.length; n++) { buffer[index]! += source[n]! * gain; if (++index === length) index = 0; }
    return;
  }
  const from = Math.max(0, -start), to = Math.min(source.length, length - start);
  for (let n = from; n < to; n++) buffer[start + n]! += source[n]! * gain;
}

function noiseArray(length: number, random: Rng): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

interface ToneOptions {
  readonly attack?: number;
  /** Exponential decay time constant in seconds (Infinity holds). */
  readonly decay?: number;
  readonly glideTo?: number;
  /** Relative harmonic amplitudes, starting at the fundamental. */
  readonly harmonics?: readonly number[];
  /** FM brightness: modulator at `fmRatio` times the carrier with this index, fading with the envelope. */
  readonly fm?: number;
  readonly fmRatio?: number;
}

/** Envelope floor below which a decaying voice stops being computed (-60 dB under its own peak). */
const SILENT = 1e-3;

function addTone(buffer: Float32Array, sampleRate: number, start: number, duration: number, frequency: number, amplitude: number, options: ToneOptions = {}): void {
  const attackSamples = Math.max(0.0005, options.attack ?? 0.004) * sampleRate;
  const decay = options.decay ?? duration / 3;
  const decayStep = Number.isFinite(decay) ? Math.exp(-1 / (decay * sampleRate)) : 1;
  // Zero harmonics are skipped rather than computed.
  const all = options.harmonics ?? [1];
  const multiples = Float64Array.from(all.map((_, index) => index + 1).filter(index => all[index - 1] !== 0));
  const gains = Float64Array.from(all.filter(gain => gain !== 0));
  const partials = gains.length;
  const fm = options.fm ?? 0;
  const fmRatio = options.fmRatio ?? 1;
  const first = Math.round(start * sampleRate);
  const count = seconds(sampleRate, duration);
  const glide = Math.pow((options.glideTo ?? frequency) / frequency, 1 / count);
  const tail = sampleRate * 0.004;
  let increment = TAU * frequency / sampleRate, phase = 0, envelope = 1;
  for (let n = 0; n < count; n++) {
    const index = first + n;
    if (index >= buffer.length) break;
    phase += increment; increment *= glide;
    const level = (n < attackSamples ? n / attackSamples : 1) * envelope * (count - n < tail ? (count - n) / tail : 1);
    envelope *= decayStep;
    if (n > attackSamples && envelope < SILENT) break;
    if (index < 0) continue;
    const modulation = fm > 0 ? fm * level * Math.sin(phase * fmRatio) : 0;
    let value = 0;
    for (let h = 0; h < partials; h++) value += gains[h]! * Math.sin(phase * multiples[h]! + modulation);
    buffer[index]! += value * level * amplitude;
  }
}

/** Filtered noise with an attack/exponential-decay envelope, added at `start`. */
function addNoiseBurst(buffer: Float32Array, sampleRate: number, random: Rng, start: number, duration: number, amplitude: number,
  filters: readonly Biquad[], options: { attack?: number; decay?: number; loop?: boolean } = {}): void {
  const count = seconds(sampleRate, duration);
  const attackSamples = Math.max(0.0002, options.attack ?? 0.001) * sampleRate;
  const decayStep = Math.exp(-1 / ((options.decay ?? duration / 4) * sampleRate));
  const first = Math.round(start * sampleRate);
  const loop = options.loop ?? false;
  const length = buffer.length;
  let envelope = 1;
  let index = loop ? ((first % length) + length) % length : first;
  for (let n = 0; n < count; n++, index++) {
    let x = random() * 2 - 1;
    for (const filter of filters) x = filter.process(x);
    const level = (n < attackSamples ? n / attackSamples : 1) * envelope;
    envelope *= decayStep;
    if (n > attackSamples && envelope < SILENT) break;
    if (loop) { if (index === length) index = 0; }
    else if (index >= length) break;
    else if (index < 0) continue;
    buffer[index]! += x * level * amplitude;
  }
}

function finishOneShot(buffer: Float32Array, sampleRate: number, peakLevel: number): Float32Array {
  filterInPlace(buffer, Biquad.highpass(28, 0.7, sampleRate));
  normalize(buffer, peakLevel);
  return fadeEdges(buffer, sampleRate, 0.5, 10);
}

// ---------------------------------------------------------------------------------------------- engine

export interface CombustionLayer {
  /** Channel 0 on-load exhaust, 1 coasting exhaust, 2 intake. All loop seamlessly. */
  readonly channels: readonly [Float32Array, Float32Array, Float32Array];
  readonly cycles: number;
}

/**
 * Renders a whole number of four-stroke cycles at `layerRpm`: every firing event becomes an exhaust pulse (a
 * low pressure lobe for body, a damped resonance for bark, a little rasp) placed at its crank angle, with
 * per-cylinder and per-cycle variation. The coasting channel uses weaker, less regular pulses; the intake
 * channel is induction noise timed between firings. Played back at rpm / layerRpm, this follows any engine speed.
 */
export function renderCombustionLayer(voice: CombustionVoice, layerRpm: number, sampleRate: number, seed: number): CombustionLayer {
  const random = rng(seed);
  const cycleSeconds = 120 / layerRpm;
  const cycles = Math.max(4, Math.round(0.72 / cycleSeconds));
  const length = Math.round(cycles * cycleSeconds * sampleRate);
  const cycleSamples = length / cycles;
  const interval = cycleSamples / voice.cylinders;
  const on = new Float32Array(length), off = new Float32Array(length), intake = new Float32Array(length);
  const cylinderVariation = voice.firing.map(() => 1 + (random() - 0.5) * 0.14);
  const lobeLength = Math.max(4, interval * 0.55);
  const pulseLength = Math.min(Math.round(sampleRate * voice.pulseDecayMs / 1000 * 5), Math.round(cycleSamples));
  // A few pulse shapes per bank (slightly different resonance and rasp), picked at random per firing: the cost is a
  // multiply-add per sample instead of computing every pulse.
  const VARIANTS = 4;
  const shapes = ([0, 1] as const).map(bank => Array.from({ length: VARIANTS }, () => {
    const resonance = voice.resonanceHz[bank] * (1 + gauss(random) * 0.015);
    const grit = noiseArray(pulseLength + 1, random);
    return {
      on: pulseShape(pulseLength, sampleRate, resonance, voice.pulseDecayMs, voice.lobe, lobeLength, voice.rasp, grit),
      off: pulseShape(pulseLength, sampleRate, resonance * 0.92, voice.pulseDecayMs * 0.65, voice.lobe * 0.8, lobeLength * 0.8, voice.rasp * 0.45, grit),
    };
  }));
  const intakeLength = Math.round(interval * 1.4) + 2;
  const intakeDecay = interval * 0.35;
  const puffs = Array.from({ length: VARIANTS }, () => {
    const puff = noiseArray(intakeLength, random);
    for (let n = 0; n < intakeLength; n++) puff[n]! *= Math.exp(-n / intakeDecay) * Math.min(1, n / 6);
    return puff;
  });
  for (let cycle = 0; cycle < cycles; cycle++) {
    // A lazy engine also varies a little from cycle to cycle (combustion is not perfectly repeatable).
    const cycleSwing = 1 + gauss(random) * voice.jitter * 0.1;
    for (let event = 0; event < voice.firing.length; event++) {
      const { angle, bank } = voice.firing[event]!;
      const start = Math.round((cycle + angle / 720) * cycleSamples + gauss(random) * voice.jitter * interval * 0.035);
      const amplitude = voice.bankGain[bank] * cylinderVariation[event]! * cycleSwing * (1 + gauss(random) * (0.04 + voice.jitter * 0.14));
      const shape = shapes[bank]![Math.floor(random() * VARIANTS)]!;
      // Coasting: weak, irregular pulses with the odd near-misfire, which reads as burble.
      const coast = amplitude * (0.32 + random() * 0.35 * (0.4 + voice.jitter)) * (random() < 0.06 * (0.5 + voice.jitter) ? 0.25 : 1);
      mixInto(on, shape.on, start, amplitude, true);
      mixInto(off, shape.off, start, coast, true);
      // Intake roar: a noise puff as each cylinder draws in, half an interval after its neighbour fires.
      mixInto(intake, puffs[Math.floor(random() * VARIANTS)]!, start + Math.round(interval * 0.5), amplitude, true);
    }
  }
  // Remove the DC the pressure lobes carry and keep the loop seamless.
  filterInPlace(on, Biquad.highpass(Math.min(40, layerRpm / 60), 0.7, sampleRate), true);
  filterInPlace(off, Biquad.highpass(Math.min(40, layerRpm / 60), 0.7, sampleRate), true);
  filterInPlace(intake, Biquad.bandpass(voice.intakeHz, 1.1, sampleRate), true);
  // Gentle top end limit so pitching the layer up cannot alias.
  filterInPlace(on, Biquad.lowpass(Math.min(sampleRate * 0.42, 7800), 0.6, sampleRate), true);
  filterInPlace(off, Biquad.lowpass(Math.min(sampleRate * 0.42, 7800), 0.6, sampleRate), true);
  const factor = normalize(on, 0.92);
  scale(off, factor);
  normalize(intake, 0.8);
  return { channels: [on, off, intake], cycles };
}

/** One exhaust pulse: a low pressure lobe (body), a damped resonance (bark) and differentiated noise (rasp). */
function pulseShape(length: number, sampleRate: number, resonanceHz: number, decayMs: number, lobe: number, lobeLength: number,
  rasp: number, grit: Float32Array): Float32Array {
  const out = new Float32Array(length);
  const tau = sampleRate * decayMs / 1000;
  const w = TAU * resonanceHz / sampleRate;
  const attack = sampleRate * 0.00035;
  for (let n = 0; n < length; n++) {
    const body = n < lobeLength ? Math.sin(Math.PI * n / lobeLength) * lobe : 0;
    const bark = Math.exp(-n / tau) * Math.sin(w * n) * (1 - Math.exp(-n / attack)) * (1 - lobe * 0.5);
    const noise = (grit[n + 1]! - grit[n]!) * Math.exp(-n / (tau * 0.6)) * rasp * 0.5;
    out[n] = body + bark + noise;
  }
  return out;
}

/**
 * Overrun crackle: about two seconds of pops thinning out, the way an exhaust spits after a lift. The synth plays it
 * from the start on each lift with a falling gain.
 */
export function renderCrackle(voice: CombustionVoice, sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const duration = 2.2;
  const out = new Float32Array(seconds(sampleRate, duration));
  const deep = voice.resonanceHz[0] < 300;
  const race = voice.resonanceHz[0] > 800;
  let t = 0.02;
  while (t < duration - 0.1) {
    const progress = t / duration;
    const strength = Math.pow(1 - progress, 1.4) * (0.45 + random() * 0.55);
    const popHz = (race ? 2300 : deep ? 720 : 1500) * (0.75 + random() * 0.6);
    addNoiseBurst(out, sampleRate, random, t, 0.012 + random() * 0.01, strength, [Biquad.bandpass(popHz, 1.6, sampleRate)], { attack: 0.0003, decay: race ? 0.0025 : deep ? 0.006 : 0.004 });
    // The low "bang" under a pop.
    addTone(out, sampleRate, t, 0.05, deep ? 85 : race ? 210 : 140, strength * (deep ? 0.7 : 0.35), { attack: 0.0008, decay: deep ? 0.018 : 0.01, glideTo: deep ? 55 : 120 });
    // Pops come in bursts early, then thin out.
    const rate = 18 * Math.pow(1 - progress, 1.6) + 2;
    t += -Math.log(1 - random() * 0.98) / rate;
  }
  return finishOneShot(out, sampleRate, 0.9);
}

/** Blow-off valve: a sharp hiss with a fluttering tail (rally four) or a deeper turbo chuff (Agera). */
export function renderBlowOff(style: 'flutter' | 'chuff', sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const duration = style === 'flutter' ? 0.55 : 0.7;
  const out = new Float32Array(seconds(sampleRate, duration));
  const noise = noiseArray(out.length, random);
  const [f0, f1] = style === 'flutter' ? [3200, 1300] : [1700, 650];
  // A swept band-pass, updated in short blocks.
  const block = 128;
  for (let begin = 0; begin < out.length; begin += block) {
    const k = begin / out.length;
    const filter = Biquad.bandpass(f0 * Math.pow(f1 / f0, k), style === 'flutter' ? 1.4 : 0.9, sampleRate);
    for (let n = begin; n < Math.min(out.length, begin + block); n++) out[n] = filter.process(noise[n]!);
  }
  for (let n = 0; n < out.length; n++) {
    const t = n / sampleRate;
    const envelope = Math.min(1, t / 0.006) * Math.exp(-t / (style === 'flutter' ? 0.12 : 0.2));
    const flutterRate = style === 'flutter' ? 24 : 14;
    const flutter = 1 - (style === 'flutter' ? 0.7 : 0.35) * Math.min(1, t / 0.08) * (0.5 + 0.5 * Math.sin(TAU * flutterRate * t * (1 - t)));
    out[n]! *= envelope * flutter;
  }
  return finishOneShot(out, sampleRate, 0.85);
}

// ---------------------------------------------------------------------------------------------- driving

/** Base pitch of the generated squeal loop; the synth sets playbackRate = pitch / SQUEAL_BASE_HZ. */
export const SQUEAL_BASE_HZ = 1000;

/**
 * Tyre squeal loop: a stick-slip tone that wavers in pitch and chatters in level, with two harmonics and a hiss
 * of scrub. Total phase over the loop is a whole number of cycles so it loops without a click.
 */
export function renderSquealLoop(sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const length = seconds(sampleRate, 1.6);
  const out = new Float32Array(length);
  const slow = loopedWobble(length, [1, 2, 3, 5], random);
  const fast = loopedWobble(length, [37, 53, 71], random);
  const chatter = loopedWobble(length, [11, 17, 29], random);
  const frequency = new Float32Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) { frequency[i] = SQUEAL_BASE_HZ * (1 + 0.04 * slow[i]! + 0.012 * fast[i]!); total += frequency[i]! / sampleRate; }
  const correction = Math.round(total) / total;
  let phase = 0;
  for (let i = 0; i < length; i++) {
    phase += TAU * frequency[i]! * correction / sampleRate;
    const level = 0.72 + 0.28 * chatter[i]!;
    out[i] = level * (Math.sin(phase) + 0.32 * Math.sin(2 * phase + 0.4) + 0.14 * Math.sin(3 * phase + 1.1));
  }
  const hiss = noiseArray(length, random);
  filterInPlace(hiss, Biquad.bandpass(SQUEAL_BASE_HZ * 1.6, 0.9, sampleRate), true);
  for (let i = 0; i < length; i++) out[i]! += hiss[i]! * 0.5;
  normalize(out, 0.85);
  return out;
}

/** Gravel and dirt: dense random grains of filtered noise over a low rumble, looped. */
export function renderGravelLoop(sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const length = seconds(sampleRate, 1.5);
  const out = new Float32Array(length);
  const grains = Math.round(1.5 * 520);
  for (let g = 0; g < grains; g++) {
    const start = random() * 1.5;
    const hz = 350 + random() * random() * 3200;
    addNoiseBurst(out, sampleRate, random, start, 0.012, 0.25 + random() * 0.75, [Biquad.bandpass(hz, 1.3, sampleRate)], { attack: 0.0004, decay: 0.002 + random() * 0.003, loop: true });
  }
  const rumble = noiseArray(length, random);
  filterInPlace(rumble, Biquad.lowpass(170, 0.8, sampleRate), true);
  normalize(rumble, 0.6);
  normalize(out, 0.7);
  for (let i = 0; i < length; i++) out[i]! += rumble[i]!;
  normalize(out, 0.85);
  return out;
}

/** Metal grind against a barrier: narrow inharmonic resonances over rough, grainy noise. */
export function renderScrapeLoop(sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const length = seconds(sampleRate, 1.4);
  const base = noiseArray(length, random);
  const roughness = loopedWobble(length, [23, 31, 47, 59, 83], random);
  for (let i = 0; i < length; i++) base[i]! *= Math.max(0, 0.55 + 0.6 * roughness[i]!);
  const out = new Float32Array(length);
  for (const [hz, q, gain] of [[760, 9, 0.8], [1290, 11, 0.7], [2140, 12, 0.55], [3470, 10, 0.45], [5120, 7, 0.3]] as const) {
    const band = Float32Array.from(base);
    filterInPlace(band, Biquad.bandpass(hz, q, sampleRate), true);
    normalize(band, gain);
    for (let i = 0; i < length; i++) out[i]! += band[i]!;
  }
  const grit = Float32Array.from(base);
  filterInPlace(grit, Biquad.bandpass(1800, 0.7, sampleRate), true);
  normalize(grit, 0.9);
  for (let i = 0; i < length; i++) out[i]! += grit[i]!;
  normalize(out, 0.85);
  return out;
}

export function renderNoiseLoop(sampleRate: number, seed: number, duration = 2): Float32Array {
  const out = noiseArray(seconds(sampleRate, duration), rng(seed));
  return scale(out, 0.9);
}

/** Wall impacts: 0 a light knock, 1 a solid crunch, 2 a heavy crash with ringing metal and debris. */
export function renderImpact(level: 0 | 1 | 2, sampleRate: number, seed: number): Float32Array {
  const random = rng(seed + level * 97);
  const duration = [0.32, 0.7, 1.35][level]!;
  const out = new Float32Array(seconds(sampleRate, duration));
  // Body thump.
  addTone(out, sampleRate, 0, [0.2, 0.35, 0.6][level]!, [105, 82, 68][level]!, [0.9, 1, 1.1][level]!, { attack: 0.0015, decay: [0.05, 0.1, 0.2][level]!, glideTo: [55, 42, 30][level]!, harmonics: [1, 0.25] });
  // Initial crack.
  addNoiseBurst(out, sampleRate, random, 0, 0.06, [0.5, 0.7, 0.9][level]!, [Biquad.bandpass([1500, 1100, 900][level]!, 0.8, sampleRate)], { attack: 0.0003, decay: [0.01, 0.018, 0.03][level]! });
  // Panel resonances: plastic knock for a tap, sheet metal for harder hits.
  const panels = level === 0 ? [[430, 0.35], [690, 0.2]] : level === 1 ? [[310, 0.4], [523, 0.32], [845, 0.25], [1270, 0.15]] : [[182, 0.4], [437, 0.38], [712, 0.32], [1190, 0.26], [1630, 0.2], [2440, 0.12]];
  for (const [hz, gain] of panels) addTone(out, sampleRate, 0.002 + random() * 0.006, duration * 0.6, hz! * (0.97 + random() * 0.06), gain! * (level === 2 ? 0.6 : 1), { attack: 0.001, decay: [0.03, 0.06, 0.15][level]! });
  if (level > 0) {
    // Crunch: grainy noise for the deformation.
    for (let g = 0; g < (level === 1 ? 34 : 110); g++) {
      const t = Math.pow(random(), 2) * (level === 1 ? 0.25 : 0.55);
      addNoiseBurst(out, sampleRate, random, t, 0.02, (0.3 + random() * 0.6) * (1 - t * 1.5), [Biquad.bandpass(500 + random() * 2500, 1.1, sampleRate)], { attack: 0.0004, decay: 0.004 });
    }
  }
  if (level === 2) {
    // Debris: small bright tinkles settling.
    for (let g = 0; g < 22; g++) {
      const t = 0.12 + random() * 0.9;
      addTone(out, sampleRate, t, 0.08, 2600 + random() * 3600, 0.08 * (1 - t / 1.2), { attack: 0.0005, decay: 0.012 });
    }
  }
  softClip(out, 1.3);
  return finishOneShot(out, sampleRate, 0.95);
}

/** Gear change: a mechanical clunk with a short metallic click. */
export function renderShift(sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(seconds(sampleRate, 0.18));
  addTone(out, sampleRate, 0, 0.12, 78, 0.9, { attack: 0.001, decay: 0.03, glideTo: 58 });
  addNoiseBurst(out, sampleRate, random, 0.002, 0.03, 0.55, [Biquad.bandpass(2600, 2.2, sampleRate)], { attack: 0.0002, decay: 0.004 });
  addTone(out, sampleRate, 0.004, 0.08, 1420, 0.16, { attack: 0.0005, decay: 0.012 });
  addNoiseBurst(out, sampleRate, random, 0.045, 0.03, 0.22, [Biquad.bandpass(1800, 2, sampleRate)], { attack: 0.0002, decay: 0.004 });
  return finishOneShot(out, sampleRate, 0.9);
}

/** Handbrake pull: a ratchet click and a short tyre chirp as the rears lock. */
export function renderHandbrake(sampleRate: number, seed: number): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(seconds(sampleRate, 0.32));
  for (let i = 0; i < 3; i++) addNoiseBurst(out, sampleRate, random, i * 0.018, 0.012, 0.35 - i * 0.07, [Biquad.bandpass(2300, 3, sampleRate)], { attack: 0.0002, decay: 0.0025 });
  addTone(out, sampleRate, 0.03, 0.26, 1180, 0.8, { attack: 0.008, decay: 0.09, glideTo: 860, harmonics: [1, 0.3, 0.12] });
  addNoiseBurst(out, sampleRate, random, 0.03, 0.24, 0.35, [Biquad.bandpass(1700, 1, sampleRate)], { attack: 0.01, decay: 0.07 });
  return finishOneShot(out, sampleRate, 0.85);
}

// ---------------------------------------------------------------------------------------------- cues

export type CueKind =
  | 'count' | 'go' | 'checkpoint' | 'finish' | 'medal-gold' | 'medal-silver' | 'medal-bronze'
  | 'marks' | 'purchase' | 'tick' | 'deny' | 'hover' | 'select' | 'back';

export const CUE_KINDS: readonly CueKind[] = ['count', 'go', 'checkpoint', 'finish', 'medal-gold', 'medal-silver', 'medal-bronze', 'marks', 'purchase', 'tick', 'deny', 'hover', 'select', 'back'];

/** Peak level per cue: menu ticks are deliberately tiny, race cues clear but below a heavy impact. */
export const CUE_PEAKS: Readonly<Record<CueKind, number>> = {
  count: 0.5, go: 0.6, checkpoint: 0.45, finish: 0.6, 'medal-gold': 0.6, 'medal-silver': 0.55, 'medal-bronze': 0.5,
  marks: 0.42, purchase: 0.55, tick: 0.14, deny: 0.34, hover: 0.07, select: 0.2, back: 0.17,
};

/** A soft electric-piano bell: FM sine with a quiet octave, decaying. */
function bell(out: Float32Array, sampleRate: number, start: number, hz: number, amplitude: number, decay = 0.35, duration = decay * 4): void {
  addTone(out, sampleRate, start, duration, hz, amplitude, { attack: 0.003, decay, fm: 1.3, fmRatio: 1, harmonics: [1, 0.18] });
  addTone(out, sampleRate, start, duration * 0.6, hz * 2, amplitude * 0.12, { attack: 0.002, decay: decay * 0.4 });
}

export function renderCue(kind: CueKind, sampleRate: number, seed = 0x5eed): Float32Array {
  const random = rng(seed + kind.length * 131);
  const durations: Record<CueKind, number> = {
    count: 0.32, go: 0.95, checkpoint: 0.6, finish: 1.9, 'medal-gold': 1.8, 'medal-silver': 1.5, 'medal-bronze': 1.2,
    marks: 0.75, purchase: 1.1, tick: 0.03, deny: 0.32, hover: 0.035, select: 0.09, back: 0.1,
  };
  const out = new Float32Array(seconds(sampleRate, durations[kind]));
  switch (kind) {
    case 'count':
      // Start light beep: a rounded square wave with a sine underneath, short and clear.
      addTone(out, sampleRate, 0, 0.3, 660, 0.8, { attack: 0.004, decay: 0.09, harmonics: [1, 0, 0.22, 0, 0.08] });
      addTone(out, sampleRate, 0, 0.3, 330, 0.3, { attack: 0.004, decay: 0.08 });
      break;
    case 'go':
      for (const [hz, gain] of [[1320, 0.7], [990, 0.4], [660, 0.35]] as const) addTone(out, sampleRate, 0, 0.9, hz, gain, { attack: 0.004, decay: 0.32, harmonics: [1, 0, 0.18, 0, 0.06] });
      addNoiseBurst(out, sampleRate, random, 0, 0.3, 0.06, [Biquad.highpass(5000, 0.7, sampleRate)], { attack: 0.002, decay: 0.08 });
      break;
    case 'checkpoint':
      bell(out, sampleRate, 0, 784, 0.6, 0.12, 0.3);
      bell(out, sampleRate, 0.075, 1175, 0.7, 0.18, 0.5);
      break;
    case 'finish':
      [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => bell(out, sampleRate, i * 0.075, hz, 0.55, 0.3, 1.2));
      for (const hz of [523.25, 783.99, 1318.5]) addTone(out, sampleRate, 0.3, 1.55, hz, 0.14, { attack: 0.08, decay: 0.6 });
      sparkle(out, sampleRate, random, 0.3, 1.2, 0.05);
      break;
    case 'medal-gold':
      [783.99, 987.77, 1174.66, 1567.98, 1975.53].forEach((hz, i) => bell(out, sampleRate, i * 0.065, hz, 0.5, 0.35, 1.3));
      sparkle(out, sampleRate, random, 0.2, 1.4, 0.07);
      break;
    case 'medal-silver':
      [659.25, 830.61, 987.77, 1318.51].forEach((hz, i) => bell(out, sampleRate, i * 0.07, hz, 0.5, 0.3, 1.1));
      sparkle(out, sampleRate, random, 0.2, 1, 0.04);
      break;
    case 'medal-bronze':
      [523.25, 659.25, 783.99].forEach((hz, i) => bell(out, sampleRate, i * 0.08, hz, 0.5, 0.28, 0.95));
      break;
    case 'marks':
      // Coin: two quick bright notes and a little shimmer.
      bell(out, sampleRate, 0, 987.77, 0.55, 0.06, 0.12);
      bell(out, sampleRate, 0.06, 1318.51, 0.7, 0.22, 0.65);
      sparkle(out, sampleRate, random, 0.06, 0.6, 0.035);
      break;
    case 'purchase':
      // Stamp thud, then a two-note chime.
      addTone(out, sampleRate, 0, 0.16, 92, 0.9, { attack: 0.001, decay: 0.04, glideTo: 60 });
      addNoiseBurst(out, sampleRate, random, 0, 0.04, 0.4, [Biquad.bandpass(1300, 0.9, sampleRate)], { attack: 0.0003, decay: 0.008 });
      bell(out, sampleRate, 0.09, 1046.5, 0.55, 0.25, 0.8);
      bell(out, sampleRate, 0.17, 1567.98, 0.5, 0.35, 0.9);
      break;
    case 'tick':
      addTone(out, sampleRate, 0, 0.025, 2100, 0.7, { attack: 0.0004, decay: 0.004 });
      addNoiseBurst(out, sampleRate, random, 0, 0.01, 0.3, [Biquad.highpass(3000, 0.7, sampleRate)], { attack: 0.0002, decay: 0.0015 });
      break;
    case 'deny':
      addTone(out, sampleRate, 0, 0.14, 311, 0.7, { attack: 0.004, decay: 0.05, harmonics: [1, 0.25, 0.1] });
      addTone(out, sampleRate, 0.11, 0.2, 233, 0.7, { attack: 0.004, decay: 0.07, harmonics: [1, 0.25, 0.1] });
      break;
    case 'hover':
      addNoiseBurst(out, sampleRate, random, 0, 0.02, 0.6, [Biquad.bandpass(3400, 1.4, sampleRate)], { attack: 0.0004, decay: 0.003 });
      addTone(out, sampleRate, 0, 0.03, 1900, 0.4, { attack: 0.001, decay: 0.006 });
      break;
    case 'select':
      addNoiseBurst(out, sampleRate, random, 0, 0.012, 0.4, [Biquad.bandpass(2800, 1.2, sampleRate)], { attack: 0.0003, decay: 0.002 });
      addTone(out, sampleRate, 0.002, 0.08, 1180, 0.7, { attack: 0.002, decay: 0.022, glideTo: 1480 });
      break;
    case 'back':
      addNoiseBurst(out, sampleRate, random, 0, 0.012, 0.35, [Biquad.bandpass(2200, 1.2, sampleRate)], { attack: 0.0003, decay: 0.002 });
      addTone(out, sampleRate, 0.002, 0.09, 1050, 0.7, { attack: 0.002, decay: 0.025, glideTo: 760 });
      break;
  }
  filterInPlace(out, Biquad.highpass(60, 0.7, sampleRate));
  normalize(out, CUE_PEAKS[kind]);
  return fadeEdges(out, sampleRate, 0.3, 6);
}

function sparkle(out: Float32Array, sampleRate: number, random: Rng, start: number, length: number, amplitude: number): void {
  for (let i = 0; i < 14; i++) {
    const t = start + random() * length;
    addTone(out, sampleRate, t, 0.12, 3000 + random() * 4000, amplitude * (1 - (t - start) / (length + 0.2)), { attack: 0.001, decay: 0.03 });
  }
}
