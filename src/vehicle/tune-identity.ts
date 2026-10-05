import type { TunePresetId, VehicleConfig, VehicleTune } from './types';

export const VEHICLE_PHYSICS_VERSION = 'lateral-force-60hz-v6';

const TUNE_BOUNDS = {
  frontMuScale: [0.65, 1.4],
  rearMuScale: [0.65, 1.4],
  springScale: [0.75, 1.25],
  steeringScale: [0.75, 1.3],
  engineScale: [0.75, 1.25],
  handbrakeRearMuScale: [0.1, 0.75],
  rearDiffLock: [0, 1],
  frontBrakeBias: [0.45, 0.75],
} as const;

/** Copies and bounds a tune before it can affect the running simulation. */
export function validateVehicleTune(value: VehicleTune): VehicleTune {
  const source = {
    ...value,
    rearDiffLock: value.rearDiffLock ?? 0,
    frontBrakeBias: value.frontBrakeBias ?? 0.5,
  };
  const fields = Object.keys(TUNE_BOUNDS) as (keyof typeof TUNE_BOUNDS)[];
  for (const field of fields) {
    const number = source[field];
    const [minimum, maximum] = TUNE_BOUNDS[field];
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new RangeError(`${field} must be finite and within [${minimum}, ${maximum}]`);
    }
  }
  if (!['Grip', 'Balanced', 'Drift', 'Custom'].includes(value.id)) {
    throw new RangeError(`Unknown tune identity: ${String(value.id)}`);
  }
  return Object.freeze({
    id: source.id,
    frontMuScale: source.frontMuScale,
    rearMuScale: source.rearMuScale,
    springScale: source.springScale,
    steeringScale: source.steeringScale,
    engineScale: source.engineScale,
    handbrakeRearMuScale: source.handbrakeRearMuScale,
    rearDiffLock: source.rearDiffLock,
    frontBrakeBias: source.frontBrakeBias,
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

/** Lossless, version-tagged identity string; callers may synchronously hash it for event metadata. */
export function createVehicleTuneIdentity(config: VehicleConfig, tune: VehicleTune): string {
  return `lateral-tune-identity-v2:${canonical({ physicsVersion: VEHICLE_PHYSICS_VERSION, simulationHz: 60, config, tune })}`;
}

export function isTunePresetId(value: string): value is TunePresetId {
  return value === 'Grip' || value === 'Balanced' || value === 'Drift';
}
