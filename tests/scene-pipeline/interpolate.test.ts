import { describe, expect, it } from 'vitest';
import type { FrameSnapshot, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import { VehicleInterpolator } from '../../src/scene-pipeline/interpolate';

const quat = { x: 0, y: 0, z: 0, w: 1 };
function vehicle(x: number, tick: number): VehicleSnapshot {
  const wheel = (offset: number): WheelSnapshot => ({
    contact: true, position: { x: x + offset, y: 0.34, z: 0 }, rotation: quat,
    compressionM: 0, normalLoadN: 2800, angularVelocityRadS: 3,
    slipRatio: 0, slipAngleRad: 0, surfaceId: 'asphalt',
  });
  return {
    simulationTick: tick, carId: 'CAR-01', position: { x, y: 0.75, z: 0 },
    rotation: quat, linearVelocityMS: { x: 6, y: 0, z: 0 },
    angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [wheel(-0.8), wheel(0.8), wheel(-0.8), wheel(0.8)],
    engineRpm: 2000, gear: 2, driftAngleRad: 0,
  };
}
function frame(previous: VehicleSnapshot, current: VehicleSnapshot, alpha: number): FrameSnapshot {
  return { previous, current, interpolationAlpha: alpha, score: {
    banked: 0, unbanked: 0, multiplier: 1, validDrift: false,
    routeProgressM: 0, activeSeconds: 0,
  } };
}

describe('visual interpolation boundary', () => {
  it('positions body and wheel centers between fixed physics snapshots', () => {
    const visual = new VehicleInterpolator().apply(frame(vehicle(0, 1), vehicle(2, 2), 0.25));
    expect(visual.position.x).toBeCloseTo(0.5);
    expect(visual.wheels[0]!.position.x).toBeCloseTo(-0.3);
    expect(visual.source.simulationTick).toBe(2);
  });

  it('snaps across recovery instead of drawing a camera-length teleport', () => {
    const visual = new VehicleInterpolator().apply(frame(vehicle(40, 28), vehicle(0, 28), 0.1));
    expect(visual.position.x).toBe(0);
    expect(visual.wheels[0]!.position.x).toBeCloseTo(-0.8);
  });
});
