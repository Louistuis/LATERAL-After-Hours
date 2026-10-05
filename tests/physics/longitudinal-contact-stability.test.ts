import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame } from '../../contracts/runtime-contracts.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import type { VehicleDynamicsTelemetry } from '../../src/physics/index.js';
import baseline from './fixtures/r-l1-04-baseline-wheel-response.json';
import recordedRuns from './fixtures/r-l1-04-recorded-inputs.json';

const signFlips = (values: readonly number[], from: number, to: number, minimumMagnitude: number): number => {
  let flips = 0;
  for (let i = from + 1; i < to; i++) {
    const before = values[i - 1]!;
    const after = values[i]!;
    if (Math.abs(before) > minimumMagnitude && Math.abs(after) > minimumMagnitude && before * after < 0) flips++;
  }
  return flips;
};

describe('stable longitudinal tire contact response', () => {
  it('replays the identical v2 input stream and removes rear Fx/slip sign chatter', async () => {
    expect(VEHICLE_PHYSICS_VERSION).toBe('lateral-force-60hz-v6');
    const results: Array<Record<string, number | string>> = [];

    // The recorded CAR-03 run is skipped: that car was retired from the roster (its inputs only replay on its own config).
    for (const fixture of recordedRuns.filter((run) => run.carId !== 'CAR-03')) {
      const carBaseline = baseline.find((entry) => entry.carId === fixture.carId);
      expect(carBaseline).toBeDefined();
      const sim = await createVehicleSimulation({
        carId: fixture.carId as CarId,
        tune: 'Drift',
        ground: { heightM: fixture.initialPosition.y - 0.85, halfExtentsM: { x: 1000, y: 0.25, z: 1000 }, friction: 0.9, surfaceId: 'road:harbor:hw01' },
        spawn: { position: fixture.initialPosition, rotation: fixture.initialRotation, linearVelocityMS: fixture.initialVelocityMS },
      });
      const longitudinalByWheel: number[][] = [[], []];
      const slipByWheel: number[][] = [[], []];
      const wheelRadiusM = sim.getConfig().wheelRadiusM;
      let maxAngularBalanceResidual = 0;
      let zeroCrossClamps = 0;
      let maxEllipseRatio = 0;
      let maxDemandOverCapacity = 0;
      let finite = true;
      try {
        for (const frame of fixture.inputs as InputFrame[]) {
          const previousWheels = sim.wheelDynamicsTelemetry().wheels;
          sim.step(frame);
          const telemetry: VehicleDynamicsTelemetry = sim.wheelDynamicsTelemetry();
          for (let rear = 0; rear < 2; rear++) {
            const wheelIndex = rear + 2;
            const wheel = telemetry.wheels[wheelIndex]!;
            const previousOmega = previousWheels[wheelIndex]!.angularVelocityRadS;
            const approachSign = Math.sign(previousOmega || wheel.driveTorqueNm || wheel.longitudinalVelocityMS);
            const expectedOmega = previousOmega + (wheel.driveTorqueNm - approachSign * wheel.availableBrakeTorqueNm
              - wheel.appliedLongitudinalForceN * wheelRadiusM) * (1 / 60) / 1.25;
            const residual = Math.abs(wheel.angularVelocityRadS - expectedOmega);
            if (wheel.brakeLockActive) maxAngularBalanceResidual = Math.max(maxAngularBalanceResidual,
              Math.abs(wheel.brakeLockRequiredTorqueNm - (1.25 * previousOmega / (1 / 60) + wheel.driveTorqueNm
                - wheelRadiusM * wheel.appliedLongitudinalForceN)) * (1 / 60) / 1.25);
            else if (Math.abs(expectedOmega) < Math.abs(previousOmega) && expectedOmega * previousOmega < 0 && wheel.angularVelocityRadS === 0) {
              zeroCrossClamps++;
              maxAngularBalanceResidual = Math.max(maxAngularBalanceResidual, residual);
            }
            longitudinalByWheel[rear]!.push(wheel.appliedLongitudinalForceN);
            slipByWheel[rear]!.push(wheel.slipRatio);
            finite &&= [wheel.angularVelocityRadS, wheel.slipRatio, wheel.appliedLongitudinalForceN,
              wheel.appliedLateralForceN, wheel.longitudinalForceDemandN, wheel.frictionCapacityN, wheel.normalLoadN].every(Number.isFinite);
            const forceMagnitude = Math.hypot(wheel.appliedLongitudinalForceN, wheel.appliedLateralForceN);
            if (wheel.frictionCapacityN > 0) {
              maxEllipseRatio = Math.max(maxEllipseRatio, forceMagnitude / wheel.frictionCapacityN);
              maxDemandOverCapacity = Math.max(maxDemandOverCapacity, Math.abs(wheel.longitudinalForceDemandN) / wheel.frictionCapacityN);
              expect(Math.abs(wheel.longitudinalForceDemandN) + 1e-6).toBeGreaterThanOrEqual(Math.abs(wheel.appliedLongitudinalForceN));
            }
          }
        }

        const releaseIndex = carBaseline!.handbrakeReleaseTick - 1;
        const windowEnd = Math.min(fixture.inputs.length - 1, releaseIndex + 25);
        const currentFxFlips = longitudinalByWheel.reduce((sum, forces) => sum + signFlips(forces, releaseIndex, windowEnd, 100), 0);
        const currentSlipFlips = slipByWheel.reduce((sum, slips) => sum + signFlips(slips, releaseIndex, windowEnd, 0.03), 0);
        let baselineFxFlips = 0;
        let baselineSlipFlips = 0;
        for (const wheel of [0, 1]) {
          baselineFxFlips += signFlips(carBaseline!.wheels.map((frame) => frame[wheel]!.appliedFx), releaseIndex, windowEnd, 100);
          baselineSlipFlips += signFlips(carBaseline!.wheels.map((frame) => frame[wheel]!.slipRatio), releaseIndex, windowEnd, 0.03);
        }
        results.push({ carId: fixture.carId, baselineFxFlips, currentFxFlips, baselineSlipFlips, currentSlipFlips,
          maxEllipseRatio, maxDemandOverCapacity, zeroCrossClamps, maxAngularBalanceResidual });
        expect(finite, `${fixture.carId} telemetry must remain finite`).toBe(true);
        expect(currentFxFlips, `${fixture.carId} rear Fx chatter`).toBeLessThan(12);
        expect(currentSlipFlips, `${fixture.carId} rear slip chatter`).toBeLessThan(12);
        expect(baselineFxFlips).toBeGreaterThanOrEqual(40);
        expect(baselineSlipFlips).toBeGreaterThanOrEqual(40);
        expect(maxEllipseRatio).toBeLessThanOrEqual(1 + 1e-6);
        expect(maxDemandOverCapacity).toBeGreaterThan(1);
      } finally {
        sim.dispose();
      }
    }

    console.info('LONGITUDINAL_CONTACT_STABILITY', JSON.stringify({ physicsVersion: VEHICLE_PHYSICS_VERSION, dtSeconds: 1 / 60, results }));
    expect(results).toHaveLength(2);
  }, 90_000);

  it.each([{ direction: 1, z: -0.2 }, { direction: -1, z: 0.2 }])(
    'supports a low-speed $direction wheel lock and releases continuously', async ({ direction, z }) => {
      const sim = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Balanced',
        spawn: { position: { x: 0, y: 0.78, z: 0 }, linearVelocityMS: { x: 0, y: 0, z } } });
      const neutral: InputFrame = { simulationTick: 0, throttle: 0, brake: 0, handbrake: 0, steering: 0, shift: 0, resetPressed: false };
      const brake: InputFrame = { ...neutral, simulationTick: 6, brake: 1 };
      const release: InputFrame = { ...neutral, simulationTick: 7 };
      try {
        for (let tick = 1; tick < brake.simulationTick; tick++) sim.step({ ...neutral, simulationTick: tick });
        sim.step(brake);
        const locked = sim.wheelDynamicsTelemetry();
        const lockedWheels = locked.wheels.filter((wheel) => wheel.contact);
        console.info('BRAKE_LOCK_SIGN_DIAGNOSTIC', JSON.stringify({ direction, bodyVelocityMS: sim.snapshot().linearVelocityMS,
          wheels: locked.wheels.map((wheel) => ({ longV: wheel.longitudinalVelocityMS, omega: wheel.angularVelocityRadS,
            lock: wheel.brakeLockActive, requiredTorque: wheel.brakeLockRequiredTorqueNm, brakeTorque: wheel.availableBrakeTorqueNm,
            lockFx: wheel.brakeLockForceN })) }));
        expect(lockedWheels.length).toBe(4);
        for (const wheel of lockedWheels) {
          expect(wheel.brakeLockActive).toBe(true);
          expect(Math.abs(wheel.brakeLockRequiredTorqueNm)).toBeLessThanOrEqual(wheel.availableBrakeTorqueNm + 1e-6);
          expect(Math.sign(wheel.brakeLockRequiredTorqueNm)).toBe(direction);
          expect(wheel.angularVelocityRadS).toBe(0);
          expect(Math.sign(wheel.brakeLockForceN)).toBe(-direction);
          expect(Math.hypot(wheel.appliedLongitudinalForceN, wheel.appliedLateralForceN)).toBeLessThanOrEqual(wheel.frictionCapacityN + 1e-6);
        }
        sim.step(release);
        const released = sim.wheelDynamicsTelemetry();
        for (let i = 0; i < 4; i++) {
          const before = locked.wheels[i]!, after = released.wheels[i]!;
          expect(after.brakeLockActive).toBe(false);
          expect(Math.sign(after.angularVelocityRadS)).toBe(direction);
          expect(Math.sign(after.appliedLongitudinalForceN)).toBe(-direction);
          expect(Math.abs(after.appliedLongitudinalForceN - before.appliedLongitudinalForceN)).toBeLessThan(200);
        }
        console.info('BRAKE_LOCK_RELEASE', JSON.stringify({ direction, locked: locked.wheels.map((wheel) => ({ omega: wheel.angularVelocityRadS,
          availableBrakeTorqueNm: wheel.availableBrakeTorqueNm, requiredTorqueNm: wheel.brakeLockRequiredTorqueNm,
          forceN: wheel.brakeLockForceN })), released: released.wheels.map((wheel) => ({ omega: wheel.angularVelocityRadS,
          forceN: wheel.appliedLongitudinalForceN })) }));
      } finally {
        sim.dispose();
      }
    },
  );
});
