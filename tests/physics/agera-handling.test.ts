import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame } from '../../contracts/runtime-contracts.js';
import { createVehicleSimulation, type AssistLevel } from '../../src/physics/index.js';
import { aeroDownforceN } from '../../src/physics/vehicle-simulation.js';
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

describe('CAR-06 Koenigsegg Agera handling character (halo car)', () => {
  it('is heavier than the McLaren, rear drive, with downforce that grows with speed but stays below the McLaren downforce', () => {
    const agera = VEHICLE_CONFIGS['CAR-06'], f1 = VEHICLE_CONFIGS['CAR-04'];
    expect(agera.massKg).toBeGreaterThan(f1.massKg);
    expect(agera.drivetrain).toBeUndefined();
    expect(aeroDownforceN(agera, 200 / 3.6)).toBeGreaterThan(aeroDownforceN(agera, 100 / 3.6) * 3);
    expect(aeroDownforceN(agera, 200 / 3.6)).toBeLessThan(aeroDownforceN(f1, 200 / 3.6));
  });

  it('is the fastest car in a straight line: about 400 km/h, well past the McLaren', async () => {
    const top = await topSpeedKmh('CAR-06');
    expect(top).toBeGreaterThan(385);
    expect(top).toBeLessThan(425);
    expect(top).toBeGreaterThan(await topSpeedKmh('CAR-04') + 20);
    const [agera, challenger] = await Promise.all([launch('CAR-06'), launch('CAR-01')]);
    expect(agera.t100).toBeLessThan(3);
    expect(agera.v6).toBeGreaterThan(challenger.v6 * 1.4);
  }, 120_000);

  it('grips just under the McLaren, far above the road cars', async () => {
    const [agera, f1, challenger] = [await cornerG('CAR-06', 'high', 30), await cornerG('CAR-04', 'high', 30), await cornerG('CAR-01', 'high', 30)];
    expect(agera).toBeLessThan(f1);
    expect(agera).toBeGreaterThan(f1 * 0.7);
    expect(agera).toBeGreaterThan(challenger * 1.4);
  }, 60_000);

  it('is more tail-happy than the McLaren: the handbrake, the throttle and a fast sweeper all slide it further', async () => {
    expect(await handbrakeTurn('CAR-06', 'Balanced')).toBeGreaterThan(await handbrakeTurn('CAR-04', 'Balanced'));
    expect(await powerOversteer('CAR-06', 'off')).toBeGreaterThan(await powerOversteer('CAR-04', 'off') + 2);
    expect(await steadySlip('CAR-06', 'off', 60, 0.3)).toBeGreaterThan(await steadySlip('CAR-04', 'off', 60, 0.3));
  }, 60_000);

  it('stays safe on Beginner: the assist catches the tail at any speed', async () => {
    expect(await abuse('CAR-06', 'high')).toBeLessThan(15);
    expect(await powerOversteer('CAR-06', 'high')).toBeLessThan(10);
    expect(await steadySlip('CAR-06', 'high', 30, 0.5)).toBeLessThan(15);
    expect(await steadySlip('CAR-06', 'high', 60, 0.3)).toBeLessThan(15);
  }, 60_000);
});
