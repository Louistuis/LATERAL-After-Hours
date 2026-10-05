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

/** Top speed (km/h) at full throttle down a 8 km straight. */
async function topSpeedKmh(carId: CarId): Promise<number> {
  const sim = await createVehicleSimulation({ carId, tune: 'Balanced', ground: { halfExtentsM: { x: 200, y: 0.25, z: 4000 } }, spawn: { position: { x: 0, y: 0.78, z: 3950 } } } as never);
  let top = 0;
  for (let tick = 1; tick <= 60 * 60; tick++) {
    sim.step(frame(tick, 1, 0));
    const s = sim.snapshot();
    top = Math.max(top, speedOf(s.linearVelocityMS) * 3.6);
    if (s.position.z < -3950) break;
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

describe('CAR-04 McLaren Formula 1 handling character', () => {
  it('is the lightest car and only CAR-04 carries aero; aero-free cars get no downforce', () => {
    const f1 = VEHICLE_CONFIGS['CAR-04'];
    for (const carId of ['CAR-01', 'CAR-02'] as const) {
      expect(f1.massKg).toBeLessThan(VEHICLE_CONFIGS[carId].massKg);
      expect(VEHICLE_CONFIGS[carId].aero).toBeUndefined();
      expect(aeroDownforceN(VEHICLE_CONFIGS[carId], 80)).toBe(0);
    }
    // Downforce grows with the square of speed up to its cap: about a third of the car's weight at 100 km/h, about its weight at 200 km/h.
    const weightN = f1.massKg * 9.81;
    expect(aeroDownforceN(f1, 100 / 3.6) / weightN).toBeGreaterThan(0.2);
    expect(aeroDownforceN(f1, 100 / 3.6) / weightN).toBeLessThan(0.5);
    expect(aeroDownforceN(f1, 200 / 3.6) / weightN).toBeGreaterThan(0.9);
    expect(aeroDownforceN(f1, 400 / 3.6)).toBe(f1.aero!.maxDownforceN);
  });

  it('accelerates far harder than the Challenger', async () => {
    const [f1, challenger] = await Promise.all([launch('CAR-04'), launch('CAR-01')]);
    // Target: about 2.5 s to 100 km/h, clearly the fastest car by a wide margin.
    expect(f1.t100).toBeLessThan(2.8);
    expect(f1.t100).toBeLessThan(challenger.t100 - 2.5);
    expect(f1.v6).toBeGreaterThan(challenger.v6 * 1.4);
  }, 30_000);

  it('tops out above 360 km/h while the road cars stay far below', async () => {
    expect(await topSpeedKmh('CAR-04')).toBeGreaterThan(360);
    expect(await topSpeedKmh('CAR-01')).toBeLessThan(260);
  }, 60_000);

  it('corners hard on Beginner, close to its raw grip, so the assist helps without strangling it', async () => {
    const raw = await cornerG('CAR-04', 'off', 30);
    const beginner = await cornerG('CAR-04', 'high', 30);
    const challenger = await cornerG('CAR-01', 'high', 30);
    expect(beginner).toBeGreaterThan(1.5);
    expect(beginner).toBeGreaterThan(raw * 0.85);
    expect(beginner).toBeGreaterThan(challenger * 2);
  }, 30_000);

  it('the handbrake still kicks it into a held slide on Beginner (Drift tune)', async () => {
    const sim = await createVehicleSimulation({ carId: 'CAR-04', tune: 'Drift', assist: 'high' });
    let tick = 0;
    while (tick < 900 && speedOf(sim.snapshot().linearVelocityMS) < 18) sim.step(frame(++tick, 1, 0));
    for (let i = 0; i < 30; i++) sim.step(frame(++tick, 0.6, -1, i < 24 ? 1 : 0));
    let held = 0, spun = false;
    for (let i = 0; i < 180; i++) {
      sim.step(frame(++tick, 0.8, -0.6));
      const slip = Math.abs(sim.snapshot().driftAngleRad);
      if (slip > 0.3) held++;
      if (slip > 1.3) spun = true;
    }
    sim.dispose();
    expect(held / 60).toBeGreaterThan(1);
    expect(spun).toBe(false);
  }, 30_000);

  it('downforce raises the tyre friction capacity at speed', async () => {
    const capacityAt = async (speedMS: number): Promise<number> => {
      const sim = await createVehicleSimulation({ carId: 'CAR-04', tune: 'Balanced', spawn: { linearVelocityMS: { x: 0, y: 0, z: -speedMS } } });
      for (let tick = 1; tick <= 30; tick++) sim.step(frame(tick, 0.3, 0));
      const wheels = sim.wheelDynamicsTelemetry().wheels;
      sim.dispose();
      return wheels.reduce((sum, wheel) => sum + wheel.frictionCapacityN / Math.max(1, wheel.normalLoadN), 0) / 4;
    };
    // Capacity per newton of suspension load is the effective mu: aero load is added on top of the suspension load.
    expect(await capacityAt(70)).toBeGreaterThan((await capacityAt(10)) * 1.8);
  }, 30_000);

  it('is a grip car on Balanced, yet the handbrake still breaks it loose and Drift loosens it further', async () => {
    const balanced = await handbrakeTurn('CAR-04', 'Balanced');
    const drift = await handbrakeTurn('CAR-04', 'Drift');
    const challenger = await handbrakeTurn('CAR-01', 'Balanced');
    expect(balanced).toBeGreaterThan(15);
    expect(balanced).toBeLessThan(75);
    expect(balanced).toBeLessThan(challenger);
    expect(drift).toBeGreaterThan(balanced);
  }, 30_000);
});
