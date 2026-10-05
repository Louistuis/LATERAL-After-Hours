import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame } from '../../contracts/runtime-contracts.js';
import { createVehicleSimulation, type AssistLevel } from '../../src/physics/index.js';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs.js';

const frame = (tick: number, throttle: number, steering: number, handbrake = 0): InputFrame => ({
  simulationTick: tick, throttle, steering, handbrake, brake: 0, shift: 0, resetPressed: false,
} as InputFrame);
const speedOf = (v: { x: number; z: number }): number => Math.hypot(v.x, v.z);

/** Seconds to 100 km/h from rest at full throttle, and speed after 6 s. */
async function launch(carId: CarId): Promise<{ t100: number; v6: number }> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced' });
  let t100 = Number.POSITIVE_INFINITY, v6 = 0;
  for (let tick = 1; tick <= 600; tick++) {
    sim.step(frame(tick, 1, 0));
    const speed = speedOf(sim.snapshot().linearVelocityMS);
    if (!Number.isFinite(t100) && speed >= 100 / 3.6) t100 = tick / 60;
    if (tick === 360) v6 = speed;
  }
  sim.dispose();
  return { t100, v6 };
}
/** Peak drift angle (degrees) from a 0.4 s handbrake pull plus steering at 15 m/s, no countersteer. */
async function handbrakeTurn(carId: CarId, tune: 'Balanced' | 'Drift'): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune, spawn: { linearVelocityMS: { x: 0, y: 0, z: -15 } } });
  let peak = 0;
  for (let tick = 1; tick <= 120; tick++) {
    sim.step(frame(tick, tick > 5 ? 0.8 : 0.3, tick > 5 && tick < 60 ? 0.8 : 0, tick > 5 && tick < 30 ? 1 : 0));
    peak = Math.max(peak, Math.abs(sim.snapshot().driftAngleRad));
  }
  sim.dispose();
  return peak * 180 / Math.PI;
}

/** Top speed (km/h) at full throttle on a 12 km by 6 km plain (wide enough that a slow sideways drift never runs off it). */
async function topSpeedKmh(carId: CarId): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', ground: { halfExtentsM: { x: 3000, y: 0.25, z: 6000 } }, spawn: { position: { x: 0, y: 0.78, z: 5950 } } } as never);
  let top = 0;
  for (let tick = 1; tick <= 60 * 90; tick++) {
    sim.step(frame(tick, 1, 0));
    const s = sim.snapshot();
    top = Math.max(top, speedOf(s.linearVelocityMS) * 3.6);
    if (tick > 600 && Math.hypot(s.position.x, s.position.z) > 5900) break;
  }
  sim.dispose();
  return top;
}
/** Settled lateral acceleration (g) for a half-lock step steer at a given speed on light throttle. */
async function cornerG(carId: CarId, assist: AssistLevel, speedMS: number): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', assist, ground: { halfExtentsM: { x: 2000, y: 0.25, z: 2000 } }, spawn: { position: { x: 0, y: 0.78, z: 1500 }, linearVelocityMS: { x: 0, y: 0, z: -speedMS } } } as never);
  let tick = 0;
  for (; tick < 30; tick++) sim.step(frame(tick + 1, 0.35, 0));
  const lat: number[] = [];
  for (let i = 0; i < 80; i++) { sim.step(frame(++tick, 0.45, 0.5)); const s = sim.snapshot(); lat.push(Math.abs(s.angularVelocityRadS.y) * speedOf(s.linearVelocityMS) / 9.81); }
  sim.dispose();
  return lat.slice(40).reduce((a, b) => a + b, 0) / 40;
}

/** Settle into a 20 m/s corner on light throttle, then floor it: peak body slip (degrees). */
async function powerOversteer(carId: CarId, assist: AssistLevel): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', assist, ground: { halfExtentsM: { x: 2000, y: 0.25, z: 2000 } }, spawn: { position: { x: 0, y: 0.78, z: 1500 }, linearVelocityMS: { x: 0, y: 0, z: -20 } } } as never);
  let tick = 0;
  for (; tick < 60; tick++) sim.step(frame(tick + 1, 0.3, 0.45));
  let peak = 0;
  for (let i = 0; i < 90; i++) { sim.step(frame(++tick, 1, 0.45)); peak = Math.max(peak, Math.abs(sim.snapshot().driftAngleRad)); }
  sim.dispose();
  return peak * 180 / Math.PI;
}
/** Peak body slip (degrees) holding a steering input at speed on part throttle for 2 s. */
async function steadySlip(carId: CarId, assist: AssistLevel, speedMS: number, steering: number): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', assist, ground: { halfExtentsM: { x: 3000, y: 0.25, z: 3000 } }, spawn: { position: { x: 0, y: 0.78, z: 2500 }, linearVelocityMS: { x: 0, y: 0, z: -speedMS } } } as never);
  let tick = 0;
  for (; tick < 30; tick++) sim.step(frame(tick + 1, 0.5, 0));
  let peak = 0;
  for (let i = 0; i < 120; i++) { sim.step(frame(++tick, 0.6, steering)); peak = Math.max(peak, Math.abs(sim.snapshot().driftAngleRad)); }
  sim.dispose();
  return peak * 180 / Math.PI;
}
/** Newcomer abuse: full throttle and full lock at 25 m/s for 3 s. Peak body slip (degrees) while still moving. */
async function abuse(carId: CarId, assist: AssistLevel): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', assist, ground: { halfExtentsM: { x: 2000, y: 0.25, z: 2000 } }, spawn: { position: { x: 0, y: 0.78, z: 1500 }, linearVelocityMS: { x: 0, y: 0, z: -25 } } } as never);
  let peak = 0;
  for (let tick = 1; tick <= 180; tick++) {
    sim.step(frame(tick, 1, 1));
    const s = sim.snapshot();
    if (speedOf(s.linearVelocityMS) > 5) peak = Math.max(peak, Math.abs(s.driftAngleRad));
  }
  sim.dispose();
  return peak * 180 / Math.PI;
}

describe('CAR-05 Lancia Delta handling character (nimble AWD rally car)', () => {
  it('is light and four wheel drive with a rear bias: the fronts take engine torque, rear-drive fronts never do', async () => {
    const delta = VEHICLE_CONFIGS['CAR-05'];
    expect(delta.massKg).toBeLessThan(VEHICLE_CONFIGS['CAR-02'].massKg);
    expect(delta.drivetrain!.frontDriveShare).toBeGreaterThan(0.15);
    expect(delta.drivetrain!.frontDriveShare).toBeLessThan(0.5);
    for (const carId of ['CAR-01', 'CAR-02', 'CAR-04', 'CAR-06'] as const) expect(VEHICLE_CONFIGS[carId].drivetrain).toBeUndefined();
    const frontDrive = async (carId: CarId): Promise<number> => {
      const sim = await createVehicleSimulation({ carId, tune: 'Balanced', assist: 'off' } as never);
      for (let tick = 1; tick <= 30; tick++) sim.step(frame(tick, 1, 0));
      const wheels = sim.wheelDynamicsTelemetry().wheels;
      sim.dispose();
      return wheels[0]!.driveTorqueNm + wheels[1]!.driveTorqueNm;
    };
    expect(await frontDrive('CAR-05')).toBeGreaterThan(50);
    expect(await frontDrive('CAR-01')).toBe(0);
  });

  it('launches harder than the Challenger on four driven wheels, but is mid-pack on top speed', async () => {
    const [delta, challenger, f1] = await Promise.all([launch('CAR-05'), launch('CAR-01'), launch('CAR-04')]);
    expect(delta.t100).toBeLessThan(challenger.t100 - 1);
    expect(delta.t100).toBeGreaterThan(f1.t100 + 1);
    const top = await topSpeedKmh('CAR-05');
    expect(top).toBeGreaterThan(200);
    expect(top).toBeLessThan(260);
  }, 90_000);

  it('is drift-happy: the handbrake swings it far wider than the grip cars, Drift wider still, and power steps the tail out', async () => {
    const balanced = await handbrakeTurn('CAR-05', 'Balanced');
    const drift = await handbrakeTurn('CAR-05', 'Drift');
    expect(balanced).toBeGreaterThan(60);
    expect(balanced).toBeGreaterThan(await handbrakeTurn('CAR-06', 'Balanced'));
    expect(drift).toBeGreaterThan(balanced);
    // Assists off: flooring it mid-corner kicks the tail out like the Challenger does.
    expect(await powerOversteer('CAR-05', 'off')).toBeGreaterThan(15);
  }, 60_000);

  it('stays safe on Beginner: full throttle and full lock, or a fast corner, never gets past a mild slide', async () => {
    expect(await abuse('CAR-05', 'high')).toBeLessThan(20);
    expect(await steadySlip('CAR-05', 'high', 45, 0.3)).toBeLessThan(20);
    expect(await powerOversteer('CAR-05', 'high')).toBeLessThan(15);
    // Beginner still lets it corner: well above a crawl.
    expect(await cornerG('CAR-05', 'high', 30)).toBeGreaterThan(0.6);
  }, 60_000);
});
