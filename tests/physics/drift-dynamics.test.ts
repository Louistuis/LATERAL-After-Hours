import { describe, expect, it } from 'vitest';
import type { InputFrame } from '../../contracts/runtime-contracts.js';
import { createVehicleSimulation } from '../../src/physics/index.js';
import { slideDriverSteering } from './fixtures/human-driver.js';

const frame = (tick: number, throttle: number, steering: number, handbrake = 0): InputFrame => ({
  simulationTick: tick, throttle, steering, handbrake, brake: 0, shift: 0, resetPressed: false,
});

describe('sustained physical drift', () => {
  it('initiates, holds and catches a grounded slide with deliberate countersteer', async () => {
    const caught = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Drift' });
    const coast = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Drift' });
    const noCountersteer = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Drift' });
    const angles: number[] = [];
    const speeds: number[] = [];
    const forwardSpeeds: number[] = [];
    const contacts: number[] = [];
    const coastAngles: number[] = [];
    const coastSpeeds: number[] = [];
    const coastForwardSpeeds: number[] = [];
    try {
      for (let tick = 1; tick <= 340; tick++) {
        const turnTick = tick - 160;
        const throttle = tick <= 160 ? 1 : turnTick <= 35 ? 1 : 0.85;
        const handbrake = turnTick > 0 && turnTick <= 15 ? 0.7 : 0;
        // Deliberate countersteer is closed-loop (proportional to the measured slide), not a frozen wheel angle:
        // holding a fixed -0.6 lock for 2.4 s is a hard left turn, not a catch (see tests/physics/fixtures/human-driver.ts).
        const driver = { carId: 'CAR-01' as const, tune: caught.getTuning(), exitAfterTicks: 150 };
        const catchSteering = (sim: typeof caught): number => turnTick <= 0 ? 0 : turnTick <= 35 ? 0.75 : slideDriverSteering(driver, sim.snapshot(), turnTick);
        const uncaughtSteering = turnTick <= 0 ? 0 : 0.75;
        caught.step(frame(tick, throttle, catchSteering(caught), handbrake));
        coast.step(frame(tick, turnTick <= 35 ? throttle : 0, turnTick <= 35 ? catchSteering(coast) : 0, handbrake));
        noCountersteer.step(frame(tick, throttle, uncaughtSteering, handbrake));
        if (turnTick > 0) {
          const state = caught.snapshot();
          angles.push(Math.abs(state.driftAngleRad));
          speeds.push(Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z));
          const { x, y, z, w } = state.rotation;
          forwardSpeeds.push(
            state.linearVelocityMS.x * (-2 * (x * z + w * y)) +
            state.linearVelocityMS.y * (-2 * (y * z - w * x)) +
            state.linearVelocityMS.z * (-(1 - 2 * (x * x + y * y))),
          );
          contacts.push(state.wheels.filter((wheel) => wheel.contact).length);
          const coastState = coast.snapshot();
          coastAngles.push(Math.abs(coastState.driftAngleRad));
          coastSpeeds.push(Math.hypot(coastState.linearVelocityMS.x, coastState.linearVelocityMS.z));
          const coastQ = coastState.rotation;
          coastForwardSpeeds.push(
            coastState.linearVelocityMS.x * (-2 * (coastQ.x * coastQ.z + coastQ.w * coastQ.y)) +
            coastState.linearVelocityMS.y * (-2 * (coastQ.y * coastQ.z - coastQ.w * coastQ.x)) +
            coastState.linearVelocityMS.z * (-(1 - 2 * (coastQ.x * coastQ.x + coastQ.y * coastQ.y))),
          );
        }
      }

      const longestEligibleStreak = (driftAngles: number[], planarSpeeds: number[], forward: number[]): number => {
        let streak = 0;
        let longest = 0;
        for (let index = 0; index < driftAngles.length; index++) {
          if (driftAngles[index]! >= 10 * Math.PI / 180 && driftAngles[index]! <= 75 * Math.PI / 180 &&
              planarSpeeds[index]! >= 5 && planarSpeeds[index]! <= 25 && forward[index]! > 5 && contacts[index]! >= 3) {
            streak++;
            longest = Math.max(longest, streak);
          } else streak = 0;
        }
        return longest;
      };
      const longestValidStreak = longestEligibleStreak(angles, speeds, forwardSpeeds);
      const coastValidStreak = longestEligibleStreak(coastAngles, coastSpeeds, coastForwardSpeeds);
      const peakAngle = Math.max(...angles);
      const finalAngle = angles.at(-1)!;
      const finalSpeed = speeds.at(-1)!;
      const uncaughtFinalAngle = Math.abs(noCountersteer.snapshot().driftAngleRad);
      console.info('DRIFT_RECOVERY', JSON.stringify({
        peakAngleRad: Number(peakAngle.toFixed(3)),
        finalAngleRad: Number(finalAngle.toFixed(3)),
        finalSpeedMS: Number(finalSpeed.toFixed(2)),
        longestValidSeconds: Number((longestValidStreak / 60).toFixed(2)),
        coastValidSeconds: Number((coastValidStreak / 60).toFixed(2)),
        allGrounded: contacts.every((count) => count === 4),
        uncaughtFinalAngleRad: Number(uncaughtFinalAngle.toFixed(3)),
      }));
      expect(peakAngle).toBeGreaterThan(0.35);
      expect(peakAngle).toBeLessThan(75 * Math.PI / 180);
      expect(longestValidStreak).toBeGreaterThanOrEqual(60);
      expect(longestValidStreak).toBeGreaterThan(coastValidStreak + 20);
      expect(finalAngle).toBeLessThan(10 * Math.PI / 180);
      expect(finalSpeed).toBeGreaterThan(5);
      expect(contacts.every((count) => count >= 3)).toBe(true);
      expect(uncaughtFinalAngle).toBeGreaterThan(peakAngle);
    } finally {
      caught.dispose();
      coast.dispose();
      noCountersteer.dispose();
    }
  });

  it('keeps finite state through a common steering challenge for all car and tune combinations', async () => {
    const rows: Array<Record<string, string | number | boolean>> = [];
    for (const carId of ['CAR-01', 'CAR-02', 'CAR-04'] as const) {
      for (const tune of ['Grip', 'Balanced', 'Drift'] as const) {
        const sim = await createVehicleSimulation({ carId, tune });
        const uncaught = await createVehicleSimulation({ carId, tune });
        const angleSeries: number[] = [], speedSeries: number[] = [], forwardSeries: number[] = [], groundedSeries: number[] = [];
        const launchThrottle = 1;
        let finiteState = true;
        try {
          for (let tick = 1; tick <= 340; tick++) {
            const turnTick = tick - 160;
            const throttle = tick <= 160 ? launchThrottle : turnTick <= 35 ? launchThrottle : launchThrottle * 0.85;
            const handbrake = turnTick > 0 && turnTick <= 15 ? 0.7 : 0;
            const steering = turnTick <= 0 ? 0 : turnTick <= 35 ? 0.75 : slideDriverSteering({ carId, tune: sim.getTuning(), exitAfterTicks: 150 }, sim.snapshot(), turnTick);
            sim.step(frame(tick, throttle, steering, handbrake));
            uncaught.step(frame(tick, throttle, turnTick <= 0 ? 0 : 0.75, handbrake));
            const state = sim.snapshot();
            const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
            const { x, y, z, w } = state.rotation;
            const forwardSpeed = state.linearVelocityMS.x * (-2 * (x * z + w * y)) +
              state.linearVelocityMS.y * (-2 * (y * z - w * x)) +
              state.linearVelocityMS.z * (-(1 - 2 * (x * x + y * y)));
            finiteState &&= [state.position.x, state.position.y, state.position.z, speed, state.driftAngleRad, ...Object.values(state.angularVelocityRadS)].every(Number.isFinite) && speed < 70;
            if (turnTick > 0) {
              angleSeries.push(Math.abs(state.driftAngleRad));
              speedSeries.push(speed);
              forwardSeries.push(forwardSpeed);
              groundedSeries.push(state.wheels.filter((wheel) => wheel.contact).length);
            }
          }
          let streak = 0, longest = 0;
          for (let index = 0; index < angleSeries.length; index++) {
            if (angleSeries[index]! >= 10 * Math.PI / 180 && angleSeries[index]! <= 75 * Math.PI / 180 &&
                speedSeries[index]! >= 5 && speedSeries[index]! <= 25 && forwardSeries[index]! > 5 && groundedSeries[index]! >= 3) {
              streak++;
              longest = Math.max(longest, streak);
            } else streak = 0;
          }
          const result = {
            carId, tune,
            peakAngleRad: Number(Math.max(...angleSeries).toFixed(3)),
            holdSeconds: Number((longest / 60).toFixed(2)),
            finalAngleRad: Number(angleSeries.at(-1)!.toFixed(3)),
            uncaughtFinalAngleRad: Number(Math.abs(uncaught.snapshot().driftAngleRad).toFixed(3)),
            finiteState,
          };
          rows.push(result);
          expect(finiteState).toBe(true);
        } finally {
          sim.dispose(); uncaught.dispose();
        }
      }
    }
    console.info('ALL_CAR_TUNE_STEERING_STRESS', JSON.stringify(rows));
  });

  it('sustains and catches CAR-02 and CAR-04 Drift slides with matched neutral controls', async () => {
    const rows: Array<Record<string, string | number | boolean>> = [];
    for (const carId of ['CAR-02', 'CAR-04'] as const) {
      const caught = await createVehicleSimulation({ carId, tune: 'Drift' });
      const neutral = await createVehicleSimulation({ carId, tune: 'Drift' });
      const angles: number[] = [], speeds: number[] = [], forwardSpeeds: number[] = [], contacts: number[] = [];
      const neutralAngles: number[] = [], neutralSpeeds: number[] = [], neutralForward: number[] = [], neutralContacts: number[] = [];
      const launchThrottle = 1;
      const initiationSteer = 0.75;
      const handbrake = carId === 'CAR-02' ? 0.7 : 1;
      let finiteState = true;
      let transitionYawRate = 0;
      try {
        for (let tick = 1; tick <= 340; tick++) {
          const phaseTick = tick - 160;
          const throttle = tick <= 195 ? launchThrottle : launchThrottle * 0.85;
          const driver = { carId, tune: caught.getTuning(), exitAfterTicks: 150 };
          const steering = phaseTick <= 0 ? 0 : phaseTick <= 35 ? initiationSteer : slideDriverSteering(driver, caught.snapshot(), phaseTick);
          const hb = phaseTick > 0 && phaseTick <= 20 ? handbrake : 0;
          caught.step(frame(tick, throttle, steering, hb));
          neutral.step(frame(tick, throttle, phaseTick <= 35 ? initiationSteer : 0, hb));
          const state = caught.snapshot();
          if (tick === 195) transitionYawRate = state.angularVelocityRadS.y;
          const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
          const { x, y, z, w } = state.rotation;
          const forwardSpeed = state.linearVelocityMS.x * (-2 * (x * z + w * y)) +
            state.linearVelocityMS.y * (-2 * (y * z - w * x)) +
            state.linearVelocityMS.z * (-(1 - 2 * (x * x + y * y)));
          finiteState &&= [state.position.x, state.position.y, state.position.z, speed, state.driftAngleRad,
            ...Object.values(state.angularVelocityRadS)].every(Number.isFinite) && speed < 70;
          if (phaseTick > 0) {
            angles.push(Math.abs(state.driftAngleRad));
            speeds.push(speed);
            forwardSpeeds.push(forwardSpeed);
            contacts.push(state.wheels.filter((wheel) => wheel.contact).length);
            const n = neutral.snapshot(), nq = n.rotation;
            neutralAngles.push(Math.abs(n.driftAngleRad));
            neutralSpeeds.push(Math.hypot(n.linearVelocityMS.x, n.linearVelocityMS.z));
            neutralForward.push(n.linearVelocityMS.x * (-2 * (nq.x * nq.z + nq.w * nq.y)) + n.linearVelocityMS.y * (-2 * (nq.y * nq.z - nq.w * nq.x)) + n.linearVelocityMS.z * (-(1 - 2 * (nq.x * nq.x + nq.y * nq.y))));
            neutralContacts.push(n.wheels.filter((wheel) => wheel.contact).length);
          }
        }
        const longestStreak = (a: number[], sp: number[], fw: number[], ct: number[]): number => {
          let run = 0, best = 0;
          for (let index = 0; index < a.length; index++) {
            if (a[index]! >= 10 * Math.PI / 180 && a[index]! <= 75 * Math.PI / 180 && sp[index]! >= 5 && sp[index]! <= 25 && fw[index]! > 5 && ct[index]! >= 3) {
              run++;
              best = Math.max(best, run);
            } else run = 0;
          }
          return best;
        };
        const longest = longestStreak(angles, speeds, forwardSpeeds, contacts);
        const neutralLongest = longestStreak(neutralAngles, neutralSpeeds, neutralForward, neutralContacts);
        const peakAngle = Math.max(...angles);
        const finalAngle = Math.abs(caught.snapshot().driftAngleRad);
        const noCounterFinalAngle = Math.abs(neutral.snapshot().driftAngleRad);
        const result = {
          carId, launchThrottle, initiationSteer, handbrakePulse: handbrake,
          countersteer: 1, peakAngleRad: Number(peakAngle.toFixed(3)),
          holdSeconds: Number((longest / 60).toFixed(2)),
          finalAngleRad: Number(finalAngle.toFixed(3)),
          finalSpeedMS: Number(Math.hypot(caught.snapshot().linearVelocityMS.x, caught.snapshot().linearVelocityMS.z).toFixed(2)),
          neutralFinalAngleRad: Number(noCounterFinalAngle.toFixed(3)), neutralHoldSeconds: Number((neutralLongest / 60).toFixed(2)),
          transitionYawRateRadS: Number(transitionYawRate.toFixed(3)),
          recoveredYawRateRadS: Number(caught.snapshot().angularVelocityRadS.y.toFixed(3)),
          groundedAllChallenge: contacts.every((count) => count === 4), finiteState,
        };
        rows.push(result);
        expect(finiteState).toBe(true);
        expect(peakAngle).toBeGreaterThan(10 * Math.PI / 180);
        expect(peakAngle).toBeLessThan(75 * Math.PI / 180);
        expect(longest).toBeGreaterThanOrEqual(60);
        expect(finalAngle).toBeLessThan(10 * Math.PI / 180);
        expect(Math.hypot(caught.snapshot().linearVelocityMS.x, caught.snapshot().linearVelocityMS.z)).toBeGreaterThanOrEqual(5);
        // Sanity bound on runaway speed; the McLaren is deliberately far quicker (0-100 in ~2.2 s), so its bound is wider.
        expect(Math.hypot(caught.snapshot().linearVelocityMS.x, caught.snapshot().linearVelocityMS.z)).toBeLessThanOrEqual(carId === 'CAR-04' ? 32 : 25);
        expect(contacts.every((count) => count >= 3)).toBe(true);
        // Stale premise replaced: the bounded countersteer assist (spec 03) lets an unattended car self-recover, so
        // the meaningful claim is that deliberate control sustains the scored slide longer than neutral controls.
        expect(longest).toBeGreaterThan(neutralLongest + 20);
        expect(Math.abs(caught.snapshot().angularVelocityRadS.y)).toBeLessThan(Math.abs(transitionYawRate));
      } finally {
        caught.dispose();
        neutral.dispose();
      }
    }
    console.info('CAR_SPECIFIC_DRIFT_RECOVERY', JSON.stringify(rows));
  });
});
