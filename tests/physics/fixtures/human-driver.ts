import type { VehicleSnapshot } from '../../../contracts/runtime-contracts.js';
import { VEHICLE_CONFIGS } from '../../../src/vehicle/configs.js';
import type { CarId } from '../../../contracts/runtime-contracts.js';
import type { VehicleTune } from '../../../src/vehicle/types.js';

/**
 * Closed-loop "deliberate countersteer" used by the drift fixtures. A player does not hold a frozen wheel
 * angle through a slide; they steer toward the velocity vector plus a proportional term that holds a target
 * slide angle. Input is a pure function of the previous snapshot and the tick, so replays stay tick-indexed.
 * Convention: positive driftAngleRad = tail out for a RIGHT-hand initiation (steering +).
 */
export interface SlideDriverOptions {
  readonly carId: CarId;
  readonly tune: VehicleTune;
  /** Slide angle to hold while the driver is "in the drift", radians. */
  readonly targetAngleRad?: number;
  /** After this many ticks the driver straightens the car (clean exit). */
  readonly exitAfterTicks: number;
}

export function slideDriverSteering(options: SlideDriverOptions, state: VehicleSnapshot, ticksSinceInitiation: number): number {
  const config = VEHICLE_CONFIGS[options.carId];
  const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
  const lock = (config.steering.maxAngleLowSpeedRad + (config.steering.maxAngleHighSpeedRad - config.steering.maxAngleLowSpeedRad) * Math.min(1, speed / config.steering.highSpeedMS)) * options.tune.steeringScale;
  const beta = state.driftAngleRad;
  const target = ticksSinceInitiation >= options.exitAfterTicks ? 0 : (options.targetAngleRad ?? 0.6);
  const wheelAngle = -beta * (target === 0 ? 1.3 : 1) + (target === 0 ? 0 : (target - beta));
  return Math.max(-1, Math.min(1, wheelAngle / lock));
}
