import type { CarId } from '../../contracts/runtime-contracts';
import { clamp01, lerp, lerpLog } from './dsp';

/**
 * Per-car engine voices and the pure mapping from driving state to synth parameters. The synth itself
 * (engine-graph.ts) only follows these numbers, so everything that decides how a car sounds is testable here.
 */

export interface FiringEvent {
  /** Crank angle in degrees within the 720 degree four-stroke cycle. */
  readonly angle: number;
  /** Exhaust bank: crossplane V8s get their burble from each bank firing unevenly. */
  readonly bank: 0 | 1;
}
export interface TurboSpec {
  /** Compressor whistle range from spool-up to full boost. */
  readonly whistleHz: readonly [number, number];
  readonly whistle: number;
  readonly whoosh: number;
  readonly blowOff: number;
  /** Time constant of the boost build-up on throttle. */
  readonly spoolSeconds: number;
}
export interface CombustionVoice {
  readonly kind: 'combustion';
  readonly id: string;
  readonly label: string;
  readonly cylinders: number;
  readonly firing: readonly FiringEvent[];
  readonly bankGain: readonly [number, number];
  /** Exhaust pulse resonance per bank at the layer's own rpm. */
  readonly resonanceHz: readonly [number, number];
  readonly pulseDecayMs: number;
  /** Share of the low pressure lobe (body, rumble) against the resonant bark. */
  readonly lobe: number;
  /** Broadband rasp in each pulse. */
  readonly rasp: number;
  /** Cycle-to-cycle irregularity: a lazy V8 lopes, a race engine does not. */
  readonly jitter: number;
  readonly intake: number;
  readonly intakeHz: number;
  /** The synth runs at a voice rpm: physics rpm * scale + offset (a V10 screams far above the shared 7600 rpm redline). */
  readonly audioRpmScale: number;
  readonly audioRpmOffset: number;
  /** Base rpm of the two generated layers; the synth crossfades between them as the voice rpm moves. */
  readonly layerRpm: readonly [number, number];
  readonly cutoffHz: readonly [number, number];
  readonly drive: readonly [number, number];
  /** Fixed body/exhaust resonance applied after the layers (does not move with pitch). */
  readonly bodyHz: number;
  readonly crackle: number;
  readonly turbo: TurboSpec | null;
  readonly level: number;
  /** Gear shift dip depth (0 none, 1 full cut). */
  readonly shiftDip: number;
}
export interface ElectricVoice {
  readonly kind: 'electric';
  readonly id: string;
  readonly label: string;
  /** Motor whine frequency at standstill and per metre per second of road speed. */
  readonly whineBaseHz: number;
  readonly whineHzPerMS: number;
  readonly whineMaxHz: number;
  /** Gear mesh partial, as a ratio of the whine. */
  readonly meshRatio: number;
  /** Inverter switching tones that step up with speed at low speed, then fade out. */
  readonly inverterSteps: readonly { readonly belowMS: number; readonly hz: number }[];
  readonly level: number;
}
export type EngineVoice = CombustionVoice | ElectricVoice;

const evenFiring = (cylinders: number, banks: 1 | 2): FiringEvent[] =>
  Array.from({ length: cylinders }, (_, i) => ({ angle: i * 720 / cylinders, bank: (banks === 2 ? i % 2 : 0) as 0 | 1 }));

/** Chrysler Hemi crossplane order 1-8-4-3-6-5-7-2, odd cylinders on bank 0: each bank fires unevenly, hence the burble. */
const CROSSPLANE_V8: FiringEvent[] = [1, 8, 4, 3, 6, 5, 7, 2].map((cylinder, i) => ({ angle: i * 90, bank: (cylinder % 2 === 1 ? 0 : 1) as 0 | 1 }));

export const ENGINE_VOICES: Readonly<Record<CarId, EngineVoice>> = {
  // Challenger: big lazy crossplane V8. Low pitch, long loping pulses, burble and pops on the overrun.
  'CAR-01': {
    kind: 'combustion', id: 'v8-crossplane', label: 'Lazy crossplane V8', cylinders: 8, firing: CROSSPLANE_V8,
    bankGain: [1, 0.82], resonanceHz: [165, 205], pulseDecayMs: 7.5, lobe: 0.62, rasp: 0.22, jitter: 0.6,
    intake: 0.45, intakeHz: 620, audioRpmScale: 0.82, audioRpmOffset: 80, layerRpm: [1100, 3700],
    cutoffHz: [900, 3000], drive: [0.28, 0.78], bodyHz: 115, crackle: 0.75, turbo: null, level: 1, shiftDip: 0.55,
  },
  // Cybertruck: electric. No combustion at all: motor whine with a gear mesh partial and a soft inverter hum.
  'CAR-02': {
    kind: 'electric', id: 'electric-tri-motor', label: 'Electric motor whine', whineBaseHz: 70, whineHzPerMS: 27,
    whineMaxHz: 2100, meshRatio: 2.97, inverterSteps: [{ belowMS: 2.5, hz: 690 }, { belowMS: 6, hz: 1035 }, { belowMS: 11, hz: 1380 }], level: 0.28,
  },
  // McLaren F1: even-firing V10 run at a much higher voice rpm, so it screams. Short sharp pulses, little low end.
  'CAR-04': {
    kind: 'combustion', id: 'v10-race', label: 'Screaming V10', cylinders: 10, firing: evenFiring(10, 2),
    bankGain: [1, 0.94], resonanceHz: [1050, 1240], pulseDecayMs: 1.9, lobe: 0.34, rasp: 0.3, jitter: 0.12,
    intake: 0.7, intakeHz: 2300, audioRpmScale: 2.1, audioRpmOffset: 300, layerRpm: [4200, 12500],
    cutoffHz: [2400, 9500], drive: [0.32, 0.92], bodyHz: 640, crackle: 0.25, turbo: null, level: 0.42, shiftDip: 0.7,
  },
  // Lancia Delta: raspy turbo inline four. Spool whistle on boost, a blow-off valve on lift, rally pops.
  'CAR-05': {
    kind: 'combustion', id: 'i4-turbo', label: 'Turbo four', cylinders: 4, firing: evenFiring(4, 1),
    bankGain: [1, 1], resonanceHz: [430, 430], pulseDecayMs: 3.6, lobe: 0.45, rasp: 0.52, jitter: 0.28,
    intake: 0.4, intakeHz: 1350, audioRpmScale: 1, audioRpmOffset: 0, layerRpm: [1500, 5200],
    cutoffHz: [1200, 5000], drive: [0.36, 0.86], bodyHz: 260,
    crackle: 0.9, turbo: { whistleHz: [1900, 5600], whistle: 0.55, whoosh: 0.3, blowOff: 1, spoolSeconds: 0.55 }, level: 0.74, shiftDip: 0.6,
  },
  // Agera: deep twin-turbo flat-plane V8. Low, heavy pulses muffled by the turbos, big intake whoosh, a softer chuff on lift.
  'CAR-06': {
    kind: 'combustion', id: 'v8-twin-turbo', label: 'Deep twin-turbo V8', cylinders: 8, firing: evenFiring(8, 2),
    bankGain: [1, 0.9], resonanceHz: [140, 168], pulseDecayMs: 6.4, lobe: 0.6, rasp: 0.18, jitter: 0.24,
    intake: 0.35, intakeHz: 880, audioRpmScale: 0.95, audioRpmOffset: 0, layerRpm: [1200, 4600],
    cutoffHz: [820, 3600], drive: [0.3, 0.82], bodyHz: 95,
    crackle: 0.4, turbo: { whistleHz: [1300, 3500], whistle: 0.22, whoosh: 0.65, blowOff: 0.7, spoolSeconds: 0.75 }, level: 0.85, shiftDip: 0.5,
  },
};

/** Unknown or retired car ids fall back to the starter's voice. */
export function selectEngineVoice(carId: string): EngineVoice {
  return (ENGINE_VOICES as Readonly<Record<string, EngineVoice | undefined>>)[carId] ?? ENGINE_VOICES['CAR-01'];
}

export interface EngineState {
  readonly rpm: number;
  readonly throttle: number;
  readonly speedMS: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
}

export interface CombustionParams {
  readonly voiceRpm: number;
  /** Playback rate of the low and high generated layers. */
  readonly rates: readonly [number, number];
  /** Equal-power crossfade between the two layers. */
  readonly layerGains: readonly [number, number];
  /** Equal-power crossfade between the on-load and the coasting pulse trains. */
  readonly loadGains: readonly [number, number];
  readonly exhaustGain: number;
  readonly intakeGain: number;
  readonly intakeHz: number;
  readonly cutoffHz: number;
  readonly drive: number;
  /** True while bouncing off the rev limiter. */
  readonly limiter: boolean;
}

/** Normalized engine speed between idle and redline. */
export function rpmNorm(state: Pick<EngineState, 'rpm' | 'idleRpm' | 'redlineRpm'>): number {
  const span = Math.max(1, state.redlineRpm - state.idleRpm);
  return clamp01((finite(state.rpm, state.idleRpm) - state.idleRpm) / span);
}

export function combustionParams(voice: CombustionVoice, state: EngineState): CombustionParams {
  const rpm = Math.max(state.idleRpm * 0.85, finite(state.rpm, state.idleRpm));
  const throttle = clamp01(state.throttle);
  const norm = rpmNorm({ ...state, rpm });
  const voiceRpm = voice.audioRpmOffset + rpm * voice.audioRpmScale;
  const [low, high] = voice.layerRpm;
  const position = clamp01((Math.log(voiceRpm) - Math.log(low)) / (Math.log(high) - Math.log(low)));
  const layerGains: [number, number] = [Math.cos(position * Math.PI / 2), Math.sin(position * Math.PI / 2)];
  // An idling engine still fires under light load; only a closed throttle at higher revs is the coasting overrun.
  const load = clamp01(Math.max(throttle * 1.25, 0.5 * (1 - norm * 3)));
  const loadGains: [number, number] = [Math.sqrt(load), Math.sqrt(1 - load)];
  return {
    voiceRpm,
    rates: [voiceRpm / low, voiceRpm / high],
    layerGains,
    loadGains,
    // On load an engine is far louder than coasting; it also gets a little louder as it revs.
    // Idle gets a lift so the start-line burble still reads on laptop speakers.
    exhaustGain: voice.level * (0.6 + 0.4 * throttle) * (0.78 + 0.22 * norm) * (1 + 0.8 * clamp01(1 - norm * 4) * (1 - throttle)),
    intakeGain: voice.level * voice.intake * throttle * (0.15 + 0.85 * norm),
    intakeHz: voice.intakeHz * (0.8 + 0.5 * norm),
    // Closed throttle muffles; revs and load open the tone up.
    cutoffHz: lerpLog(voice.cutoffHz[0], voice.cutoffHz[1], clamp01(0.55 * norm + 0.45 * throttle)),
    drive: lerp(voice.drive[0], voice.drive[1], throttle * (0.45 + 0.55 * norm)),
    limiter: throttle > 0.6 && rpm >= state.redlineRpm * 0.975,
  };
}

export interface ElectricParams {
  readonly whineHz: number;
  readonly whineGain: number;
  readonly meshGain: number;
  readonly inverterHz: number;
  readonly inverterGain: number;
  readonly humGain: number;
}

export function electricParams(voice: ElectricVoice, state: Pick<EngineState, 'throttle' | 'speedMS'>): ElectricParams {
  const speed = Math.max(0, finite(state.speedMS, 0));
  const throttle = clamp01(state.throttle);
  const moving = clamp01(speed / 6);
  // Regen on a lift at speed keeps a quieter whine rather than silence.
  const regen = (1 - throttle) * clamp01((speed - 3) / 12) * 0.38;
  const step = voice.inverterSteps.find(entry => speed < entry.belowMS) ?? voice.inverterSteps[voice.inverterSteps.length - 1]!;
  return {
    whineHz: Math.min(voice.whineMaxHz, voice.whineBaseHz + speed * voice.whineHzPerMS),
    whineGain: voice.level * (moving * (0.12 + 0.88 * throttle) + regen),
    meshGain: voice.level * moving * (0.08 + 0.32 * throttle) * clamp01(speed / 20),
    inverterHz: step.hz,
    inverterGain: voice.level * (0.05 + 0.45 * throttle) * (1 - clamp01((speed - 5) / 10)),
    humGain: voice.level * (0.05 + 0.25 * clamp01(speed / 35)),
  };
}

/** Boost builds slowly on throttle (more with revs) and collapses quickly on a lift. */
export function turboStep(boost: number, throttle: number, norm: number, dtSeconds: number, spoolSeconds: number): number {
  const dt = Math.max(0, Math.min(0.25, finite(dtSeconds, 0)));
  const target = clamp01(throttle) * clamp01((norm - 0.18) / 0.5);
  const tau = target > boost ? spoolSeconds : 0.12;
  return clamp01(boost + (target - boost) * (1 - Math.exp(-dt / Math.max(0.01, tau))));
}

export interface TurboParams { readonly whistleHz: number; readonly whistleGain: number; readonly whooshGain: number }
export function turboParams(turbo: TurboSpec, boost: number, throttle: number): TurboParams {
  const b = clamp01(boost);
  return {
    whistleHz: lerp(turbo.whistleHz[0], turbo.whistleHz[1], b),
    whistleGain: turbo.whistle * b * b * (0.4 + 0.6 * clamp01(throttle)),
    whooshGain: turbo.whoosh * b * (0.3 + 0.7 * clamp01(throttle)),
  };
}

/** A sharp lift from real throttle: the moment for a blow-off valve, crackle or a coasting burble. */
export function isThrottleLift(previousThrottle: number | null, throttle: number): boolean {
  return previousThrottle !== null && previousThrottle >= 0.45 && throttle <= 0.12;
}

/** Overrun crackle strength for a lift at this rpm (0 means none). */
export function crackleStrength(voice: EngineVoice, norm: number): number {
  if (voice.kind !== 'combustion' || voice.crackle <= 0) return 0;
  return voice.crackle * clamp01((norm - 0.35) / 0.45);
}

/** Blow-off strength for a lift with this much boost (0 means none). */
export function blowOffStrength(voice: EngineVoice, boost: number): number {
  if (voice.kind !== 'combustion' || !voice.turbo) return 0;
  return boost < 0.35 ? 0 : voice.turbo.blowOff * clamp01((boost - 0.2) / 0.6);
}

function finite(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback; }
