import { afterEach, describe, expect, it } from 'vitest';
import type { InputFrame } from '../../contracts/runtime-contracts';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics';
import type { VehicleSimulationHandle, WheelDynamicsTelemetry } from '../../src/physics';

const DT = 1 / 60;
const WHEEL_INERTIA_KGM2 = 1.25;
const simulations: VehicleSimulationHandle[] = [];

async function make(options: Parameters<typeof createVehicleSimulation>[0] = {}) {
  const simulation = await createVehicleSimulation(options);
  simulations.push(simulation);
  return simulation;
}

function frame(simulationTick: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { simulationTick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false, ...patch };
}

function step(simulation: VehicleSimulationHandle, patch: Partial<InputFrame> = {}) {
  simulation.step(frame(simulation.snapshot().simulationTick + 1, patch));
  return simulation.wheelDynamicsTelemetry();
}

function run(simulation: VehicleSimulationHandle, count: number, patch: Partial<InputFrame> = {}) {
  let telemetry = simulation.wheelDynamicsTelemetry();
  for (let i = 0; i < count; i++) telemetry = step(simulation, patch);
  return telemetry;
}

function finiteWheel(wheel: WheelDynamicsTelemetry) {
  return [wheel.angularVelocityRadS, wheel.longitudinalVelocityMS, wheel.frictionCapacityN,
    wheel.appliedLongitudinalForceN, wheel.driveTorqueNm, wheel.availableBrakeTorqueNm,
    wheel.brakeLockRequiredTorqueNm, wheel.brakeLockForceN].every(Number.isFinite);
}

afterEach(() => {
  for (const simulation of simulations.splice(0)) simulation.dispose();
});

describe('Rapier moving-wheel brake torque budget', () => {
  it.each([
    { name: 'forward', spawnVelocityMS: { x: 0, y: 0, z: -12 }, expectedDirection: 1, prepare: async (_simulation: VehicleSimulationHandle) => {} },
    {
      name: 'reverse', spawnVelocityMS: { x: 0, y: 0, z: 0 }, expectedDirection: -1,
      prepare: async (simulation: VehicleSimulationHandle) => {
        simulation.step(frame(simulation.snapshot().simulationTick + 1, { shift: -1 }));
        run(simulation, 120, { throttle: 0.75 });
      },
    },
  ])('uses the moving-wheel brake budget in $name', async ({ name, spawnVelocityMS, expectedDirection, prepare }) => {
    const simulation = await make({
      carId: 'CAR-01', tune: 'Balanced',
      spawn: { position: { x: 0, y: 0.78, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: spawnVelocityMS },
    });
    expect(VEHICLE_PHYSICS_VERSION).toMatch(/^lateral-force-60hz-v\d+$/);
    await prepare(simulation);
    if (name === 'forward') run(simulation, 12);

    const speedZ = simulation.snapshot().linearVelocityMS.z;
    expect(Math.sign(-speedZ)).toBe(expectedDirection);
    expect(Math.abs(speedZ)).toBeGreaterThan(2);

    const radiusM = simulation.getConfig().wheelRadiusM;
    let prior = simulation.wheelDynamicsTelemetry();
    const rows: Array<Record<string, number | boolean>> = [];
    for (let sample = 0; sample < 8; sample++) {
      const current = step(simulation, { brake: 0.25 });
      for (let index = 0; index < current.wheels.length; index++) {
        const before = prior.wheels[index];
        const after = current.wheels[index];
        const movingSameDirection = before.angularVelocityRadS * after.angularVelocityRadS > 0.1;
        const unsaturated = Math.abs(after.appliedLongitudinalForceN) < after.frictionCapacityN * 0.8;
        const eligible = after.contact && !after.brakeLockActive && movingSameDirection && unsaturated
          && after.availableBrakeTorqueNm > 0 && after.frictionCapacityN > 0;
        if (eligible) {
          // From I*Δω/Δt = Tdrive - Tbrake - r*Fx, the inferred signed brake
          // torque should consume the offered budget on an unlocked, uncapped wheel.
          const inferredSignedBrakeTorqueNm = after.driveTorqueNm - radiusM * after.appliedLongitudinalForceN
            - WHEEL_INERTIA_KGM2 * (after.angularVelocityRadS - before.angularVelocityRadS) / DT;
          rows.push({
            simulationTick: current.simulationTick, wheelIndex: index,
            omegaBeforeRadS: before.angularVelocityRadS, omegaAfterRadS: after.angularVelocityRadS,
            longitudinalVelocityMS: after.longitudinalVelocityMS, driveTorqueNm: after.driveTorqueNm,
            appliedLongitudinalForceN: after.appliedLongitudinalForceN,
            availableBrakeTorqueNm: after.availableBrakeTorqueNm, inferredSignedBrakeTorqueNm,
            frictionCapacityN: after.frictionCapacityN, brakeLockActive: after.brakeLockActive,
          });
        }
      }
      prior = current;
    }

    console.info(`BRAKE_BUDGET_${name.toUpperCase()}`, JSON.stringify({
      physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tune: 'Balanced', direction: name,
      radiusM, wheelInertiaKgm2: WHEEL_INERTIA_KGM2, fixedDtS: DT, rows,
    }));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      const signedUsed = (row.inferredSignedBrakeTorqueNm as number) * expectedDirection;
      const available = row.availableBrakeTorqueNm as number;
      expect(signedUsed).toBeGreaterThan(available * 0.9);
      expect(signedUsed).toBeLessThan(available * 1.1);
    }
  });

  it('clamps near-zero braking without wheel sign reversal, reports bounded lock support, and releases to drive', async () => {
    const simulation = await make({
      carId: 'CAR-01', tune: 'Balanced',
      spawn: { position: { x: 0, y: 0.78, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -0.75 } },
    });
    run(simulation, 2);
    let prior = simulation.wheelDynamicsTelemetry();
    let lockedRows = 0;
    const brakingRows: Array<Record<string, number | boolean>> = [];
    for (let sample = 0; sample < 12; sample++) {
      const current = step(simulation, { brake: 1 });
      for (let index = 0; index < current.wheels.length; index++) {
        const before = prior.wheels[index];
        const after = current.wheels[index];
        expect(finiteWheel(after)).toBe(true);
        if (before.angularVelocityRadS > 0.05) expect(after.angularVelocityRadS).toBeGreaterThanOrEqual(-1e-9);
        if (after.brakeLockActive) {
          lockedRows++;
          expect(Math.abs(after.angularVelocityRadS)).toBeLessThan(1e-9);
          expect(Math.abs(after.brakeLockRequiredTorqueNm)).toBeLessThanOrEqual(after.availableBrakeTorqueNm + 1e-6);
        }
        brakingRows.push({ simulationTick: current.simulationTick, wheelIndex: index,
          omegaBeforeRadS: before.angularVelocityRadS, omegaAfterRadS: after.angularVelocityRadS,
          speedMS: Math.hypot(simulation.snapshot().linearVelocityMS.x, simulation.snapshot().linearVelocityMS.z),
          availableBrakeTorqueNm: after.availableBrakeTorqueNm, brakeLockActive: after.brakeLockActive,
          brakeLockRequiredTorqueNm: after.brakeLockRequiredTorqueNm });
      }
      prior = current;
    }
    console.info('BRAKE_NEAR_ZERO_LOCK', JSON.stringify({ physicsVersion: VEHICLE_PHYSICS_VERSION, rows: brakingRows }));
    expect(lockedRows).toBeGreaterThan(0);

    const released = run(simulation, 60, { throttle: 0.6 });
    expect(simulation.snapshot().linearVelocityMS.z).toBeLessThan(-0.2);
    expect(released.wheels.every(finiteWheel)).toBe(true);
    console.info('BRAKE_RELEASE', JSON.stringify({ simulationTick: released.simulationTick,
      speedMS: Math.hypot(simulation.snapshot().linearVelocityMS.x, simulation.snapshot().linearVelocityMS.z),
      wheelOmegaRadS: released.wheels.map(wheel => wheel.angularVelocityRadS) }));
  });
});
