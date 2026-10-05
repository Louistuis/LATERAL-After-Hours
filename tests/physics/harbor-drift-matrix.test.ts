import { describe, expect, it } from 'vitest';
import type { InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import { slideDriverSteering } from './fixtures/human-driver.js';
import { buildHarborApronCollision, buildHarborRoute } from '../../src/world/route-data.js';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const ENTRY_SPEED_MS = Number(process.env.HW_V ?? 12), DRIFT_THROTTLE = Number(process.env.HW_T ?? .8), DRIFT_HOLD_TICKS = Number(process.env.HW_H ?? 90);
const HB_TICKS = Number(process.env.HW_HT ?? 25), HB_PULL = Number(process.env.HW_HP ?? .9), FLICK = Number(process.env.HW_F ?? 2);
const HOLD_ANGLE = Number(process.env.HW_A ?? .3), HOLD_BLEND = Number(process.env.HW_B ?? 0);
const COUNTER_BIAS = Number(process.env.HW_C ?? .12);
const wrap = (n: number): number => Math.atan2(Math.sin(n), Math.cos(n));

describe('HW-01 authored road drift recovery matrix', () => {
  // CAR-04 (McLaren F1) is a grip car: this scripted handbrake corner keeps it under 10 degrees, so its slide and
  // catch behaviour is covered by drift-dynamics (sustain + catch) and mclaren-handling instead.
  it.each(['CAR-01', 'CAR-02'] as const)('%s initiates, scores and recovers a grounded Drift-preset corner', async carId => {
    const { route, collision } = buildHarborRoute();
    const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Drift' });
    sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    const apron = buildHarborApronCollision();
    sim.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(sim.snapshot().position);
    const distances = [0];
    for (let i = 1; i < route.centerline.length; i++) {
      const a = route.centerline[i - 1]!, b = route.centerline[i]!;
      distances.push(distances.at(-1)! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const pointAt = (distance: number): Vec3 => {
      const d = Math.min(distances.at(-1)!, distance);
      let i = 1;
      while (i < distances.length - 1 && distances[i]! < d) i++;
      const a = route.centerline[i - 1]!, b = route.centerline[i]!;
      const t = (d - distances[i - 1]!) / (distances[i]! - distances[i - 1]!);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    };
    const run = createRunController({
      eventId: `HW-01:l1-drift:${carId}`, routeId: route.id, mode: 'drift-attack',
      rulesVersion: 'l1-r03-v1', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId,
      tuneHash: sim.getTuneIdentity(), checkpoints: route.checkpoints, countdownSeconds: 0,
    }, () => `l1-hw01-drift-${carId}`);
    run.startCountdown(); run.activate();
    const accepted: string[] = [], violations: string[] = [];
    let result: RunResult | null = null;
    let pulseStartTick = -1, peakAnySpeedAngleRad = 0, peakQualifiedRoadAngleRad = 0, eligibleTicks = 0, roadTicks = 0, peakSpeedMS = 0;
    let currentEligibleStreak = 0, longestEligibleStreak = 0, recoveryAngleRad = Number.POSITIVE_INFINITY, recoveryTick = -1;
    const currentInput: { value: InputFrame | null } = { value: null };
    const driftSamples: Array<Record<string, number>> = [];
    let legalRouteTick = false, checkpointValidTick = true, roadContactTick = false, routeProgressDelta = 0;
    const eligibility = { driftAngle: 0, speedForward: 0, grounded: 0, route: 0, credibleProgress: 0, angleSpeed: 0, angleSpeedGrounded: 0, angleSpeedGroundedRoute: 0, all: 0 };
    let minSpeedDuringDrift = Number.POSITIVE_INFINITY, minForwardDuringDrift = Number.POSITIVE_INFINITY;
    let maxSpeedDuringDrift = 0, maxForwardDuringDrift = -Number.POSITIVE_INFINITY;
    const session = new DrivingSession({ simulation: sim, run,
      scorer: createDriftScorer({ rulesVersion: 'l1-r03-v1', routeLengthM: route.lengthM }),
      routeEvidence: (_previous, current, checkpoints) => {
        const priorProgress = progress.progressM;
        progress = tracker.update(current.position);
        legalRouteTick = progress.legal;
        checkpointValidTick = !checkpoints?.invalidCrossing;
        routeProgressDelta = progress.progressM - priorProgress;
        accepted.push(...(checkpoints?.acceptedIds ?? []));
        if (progress.violation) violations.push(progress.violation);
        roadContactTick = current.wheels.some(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId);
        if (roadContactTick) roadTicks++;
        return { routeProgressM: progress.progressM, routeLateralOffsetM: progress.lateralOffsetM ?? undefined,
          legalCorridor: progress.legal, checkpointValid: !checkpoints?.invalidCrossing,
          runViolation: progress.violation ?? undefined,
          roadContact: current.wheels.some(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId) };
      }, onRunFinished: finished => { result = finished; },
    });
    const input = (tick: number): InputFrame => {
      const state = sim.snapshot();
      const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
      const target = pointAt(progress.progressM + Math.max(5, speed * .42));
      const q = state.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
      let steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
      if (pulseStartTick < 0 && progress.progressM >= 107) pulseStartTick = tick;
      const age = pulseStartTick < 0 ? -1 : tick - pulseStartTick;
      if (age >= 0 && age < HB_TICKS) steering = clamp(steering * FLICK, -1, 1);
      if (age >= 10 && age < 50 && Math.abs(state.driftAngleRad) >= 4 * Math.PI / 180) {
        steering = clamp(steering - Math.sign(state.driftAngleRad) * COUNTER_BIAS, -1, 1);
      }
      if (age >= HB_TICKS && age < DRIFT_HOLD_TICKS && Math.abs(state.driftAngleRad) >= 4 * Math.PI / 180) {
        // Hold phase: blend line-following with a driver that holds a modest slide angle instead of catching it at once.
        const side = Math.sign(state.driftAngleRad);
        const hold = side * slideDriverSteering({ carId, tune: sim.getTuning(), targetAngleRad: HOLD_ANGLE, exitAfterTicks: DRIFT_HOLD_TICKS },
          { ...state, driftAngleRad: Math.abs(state.driftAngleRad) }, age);
        steering = clamp((1 - HOLD_BLEND) * steering + HOLD_BLEND * hold, -1, 1);
      }
      peakSpeedMS = Math.max(peakSpeedMS, speed);
      // State-aware driver for the authored corner: carry entry speed, pulse the handbrake, then stay on the
      // throttle while the pursuit steering (which already countersteers as the body yaws) holds the line.
      // The previous stimulus braked to under 9.5 m/s with 0.08 throttle mid-slide, which no driver does.
      const approach = progress.progressM > 80 && pulseStartTick < 0;
      const sliding = age >= 0 && age < DRIFT_HOLD_TICKS;
      const cruise = approach || sliding ? ENTRY_SPEED_MS : 8;
      currentInput.value = { simulationTick: tick,
        throttle: sliding ? (speed < cruise ? DRIFT_THROTTLE : .35) : speed < cruise ? .72 : .08,
        brake: !sliding && speed > cruise + 1.5 ? .35 : 0, steering,
        handbrake: age >= 0 && age < HB_TICKS ? HB_PULL : 0,
        shift: 0, resetPressed: false };
      return currentInput.value;
    };
    try {
      for (let tick = 1; tick <= 6000 && !result; tick++) {
        const frame = session.advance(1 / 60, input);
        peakAnySpeedAngleRad = Math.max(peakAnySpeedAngleRad, Math.abs(frame.current.driftAngleRad));
        if (frame.score.validDrift) {
          eligibleTicks++;
          currentEligibleStreak++;
          longestEligibleStreak = Math.max(longestEligibleStreak, currentEligibleStreak);
        } else currentEligibleStreak = 0;
        const state = frame.current;
        const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
        const q = state.rotation;
        const forwardX = -2 * (q.x * q.z + q.w * q.y), forwardY = -2 * (q.y * q.z - q.w * q.x), forwardZ = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const forwardSpeed = state.linearVelocityMS.x * forwardX + state.linearVelocityMS.y * forwardY + state.linearVelocityMS.z * forwardZ;
        const driftWindow = Math.abs(state.driftAngleRad) >= 10 * Math.PI / 180 && Math.abs(state.driftAngleRad) <= 75 * Math.PI / 180;
        if (driftWindow) {
          minSpeedDuringDrift = Math.min(minSpeedDuringDrift, speed);
          minForwardDuringDrift = Math.min(minForwardDuringDrift, forwardSpeed);
          maxSpeedDuringDrift = Math.max(maxSpeedDuringDrift, speed);
          maxForwardDuringDrift = Math.max(maxForwardDuringDrift, forwardSpeed);
          if (tick >= pulseStartTick && tick < pulseStartTick + 100 && driftSamples.length < 12) driftSamples.push({
            tick, age: tick - pulseStartTick, speedMS: Number(speed.toFixed(2)), forwardMS: Number(forwardSpeed.toFixed(2)),
            angleRad: Number(state.driftAngleRad.toFixed(3)), throttle: currentInput.value?.throttle ?? -1,
            brake: currentInput.value?.brake ?? -1, handbrake: currentInput.value?.handbrake ?? -1,
          });
        }
        const speedForward = speed > 5 && forwardSpeed > 5;
        const grounded = state.wheels.filter(wheel => wheel.contact).length >= 3;
        const routeOk = legalRouteTick && checkpointValidTick && roadContactTick;
        const credibleProgress = routeProgressDelta > 0 && routeProgressDelta <= Math.max(.25, speed / 60 * 1.25);
        if (speedForward && grounded && routeOk) peakQualifiedRoadAngleRad = Math.max(peakQualifiedRoadAngleRad, Math.abs(state.driftAngleRad));
        eligibility.driftAngle += Number(driftWindow);
        eligibility.speedForward += Number(speedForward);
        eligibility.grounded += Number(grounded);
        eligibility.route += Number(routeOk);
        eligibility.credibleProgress += Number(credibleProgress);
        eligibility.angleSpeed += Number(driftWindow && speedForward);
        eligibility.angleSpeedGrounded += Number(driftWindow && speedForward && grounded);
        eligibility.angleSpeedGroundedRoute += Number(driftWindow && speedForward && grounded && routeOk);
        eligibility.all += Number(driftWindow && speedForward && grounded && routeOk && credibleProgress);
        if (longestEligibleStreak >= 60 && tick > pulseStartTick + 60 && recoveryTick < 0 && Math.abs(frame.current.driftAngleRad) < 10 * Math.PI / 180) {
          recoveryAngleRad = Math.abs(frame.current.driftAngleRad);
          recoveryTick = tick;
        }
      }
      const snapshot = session.snapshot();
      const completedRun = (): RunResult | null => result;
      const finished = completedRun();
      const data = {
        carId, tune: 'Drift', pulseStartTick,
        elapsedSeconds: Number((snapshot.score.activeSeconds).toFixed(2)),
        progressM: Number(progress.progressM.toFixed(2)), acceptedGates: accepted,
        legalViolationCount: violations.length, firstViolations: violations.slice(0, 3), roadTicks,
        peakAnySpeedAngleRad: Number(peakAnySpeedAngleRad.toFixed(3)), peakQualifiedRoadAngleRad: Number(peakQualifiedRoadAngleRad.toFixed(3)),
        eligibleScoreTicks: eligibleTicks, unbankedScore: snapshot.score.unbanked,
        bankedScore: snapshot.score.banked, recoveryTick, recoveryAngleRad: Number(recoveryAngleRad.toFixed(3)),
        eligibility,
        driftSamples,
        driftWindowSpeedRangeMS: [Number(minSpeedDuringDrift.toFixed(2)), Number(maxSpeedDuringDrift.toFixed(2))],
        driftWindowForwardRangeMS: [Number(minForwardDuringDrift.toFixed(2)), Number(maxForwardDuringDrift.toFixed(2))],
        peakSpeedMS: Number(peakSpeedMS.toFixed(2)), result: finished && { valid: finished.valid, bankedScore: finished.bankedScore },
      };
      console.info('HW01_DRIFT_RECOVERY', JSON.stringify(data));
        expect(pulseStartTick).toBeGreaterThan(0);
        expect(pulseStartTick).toBeLessThan(3600);
      expect(peakQualifiedRoadAngleRad).toBeGreaterThan(10 * Math.PI / 180);
      expect(longestEligibleStreak).toBeGreaterThanOrEqual(60);
      expect(roadTicks).toBeGreaterThan(1200);
      expect(violations).toEqual([]);
      expect(accepted.length).toBeGreaterThan(0);
      expect(recoveryTick).toBeGreaterThan(pulseStartTick);
      expect(recoveryAngleRad).toBeLessThan(10 * Math.PI / 180);
    } finally { session.dispose(); }
  }, 90_000);
});
