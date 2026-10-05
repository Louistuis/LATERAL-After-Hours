/**
 * Showroom spec sheet: player-facing numbers derived from the real vehicle configs (src/vehicle/configs.ts),
 * so a car added there gets a spec sheet with no extra work. Ratings are 0..100 against fixed reference
 * ranges, not against the current roster, so they stay stable as cars come and go.
 */
import type { VehicleConfig, VehicleTune } from '../vehicle/types';

export interface CarSpec {
  readonly powerHp: number;
  readonly massKg: number;
  /** 0..100 ratings for the bars. */
  readonly power: number;
  readonly grip: number;
  readonly agility: number;
  readonly slide: number;
  /** Short drift character label and one line of copy (no em dashes). */
  readonly character: string;
  readonly line: string;
}

const clamp100 = (value: number): number => Math.round(Math.max(4, Math.min(100, value)));

export function peakPowerKw(config: VehicleConfig): number {
  let best = 0;
  for (const point of config.engine.torqueCurve) best = Math.max(best, point.torqueNm * point.rpm * (2 * Math.PI / 60) / 1000);
  return best;
}

export function carSpec(config: VehicleConfig | undefined | null): CarSpec | null {
  if (!config) return null;
  const kw = peakPowerKw(config);
  const hp = Math.round(kw * 1.341);
  const mu = (config.tires.frontMu + config.tires.rearMu) / 2;
  const kwPerTonne = kw / (config.massKg / 1000);
  // Rear-biased grip loss and a steep post-peak drop make a car rotate and keep sliding.
  const balance = config.tires.frontMu - config.tires.rearMu;
  const falloff = 1 - config.tires.postPeakGripFactor;
  const slideScore = balance * 380 + falloff * 140 + kwPerTonne * 0.12 - config.assists.stabilityStrength * 300;
  const agilityScore = (config.steering.maxAngleLowSpeedRad * 70 + (0.2 - config.steering.responseSeconds) * 300) * (1300 / config.massKg);
  const slide = clamp100(slideScore);
  const character = slide >= 70 ? 'Tail happy' : slide >= 45 ? 'Smooth slider' : 'Planted';
  const line = slide >= 70 ? 'Rotates on a lift and wants to stay sideways.'
    : slide >= 45 ? 'Predictable breakaway, holds a long angle.'
      : 'Grips hard. Needs commitment to break loose.';
  return {
    powerHp: hp, massKg: config.massKg,
    power: clamp100((kwPerTonne - 80) / 1.6),
    grip: clamp100((mu - 0.9) / 0.35 * 100),
    agility: clamp100(agilityScore),
    slide, character, line,
  };
}

/** A config with a tune's scales applied, so presets get comparable spec sheets. */
export function tunedConfig(config: VehicleConfig, tune: VehicleTune): VehicleConfig {
  return {
    ...config,
    engine: { ...config.engine, torqueCurve: config.engine.torqueCurve.map(point => ({ rpm: point.rpm, torqueNm: point.torqueNm * tune.engineScale })) },
    tires: { ...config.tires, frontMu: config.tires.frontMu * tune.frontMuScale, rearMu: config.tires.rearMu * tune.rearMuScale },
    steering: { ...config.steering, maxAngleLowSpeedRad: config.steering.maxAngleLowSpeedRad * tune.steeringScale, maxAngleHighSpeedRad: config.steering.maxAngleHighSpeedRad * tune.steeringScale },
  };
}

/** Plain-language summary of each preset (no em dashes). */
export const TUNE_COPY: Readonly<Record<string, { readonly title: string; readonly line: string }>> = {
  Grip: { title: 'Grip', line: 'More grip at both ends and calmer steering. Clean, fast laps. Harder to get sideways.' },
  Balanced: { title: 'Balanced', line: 'The factory setup. Predictable, easy to catch, good at everything.' },
  Drift: { title: 'Drift', line: 'Less rear grip, quicker steering, a little more power. Swings out early and holds the angle.' },
};
