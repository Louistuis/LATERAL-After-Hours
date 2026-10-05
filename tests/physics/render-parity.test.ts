import { describe, expect, it } from 'vitest';
import type { InputFrame, Vec3 } from '../../contracts/runtime-contracts.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import type { DriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import type { VehicleSimulationHandle } from '../../src/physics/index.js';
import { slideDriverSteering } from './fixtures/human-driver.js';

interface ParityResult {
  readonly seed: string;
  readonly renderHz: number;
  readonly simulationTicks: number;
  readonly droppedSeconds: number;
  readonly position: Vec3;
  readonly score: number;
  readonly bankedScore: number;
  readonly unbankedScore: number;
  readonly routeProgressM: number;
  readonly activeSeconds: number;
  readonly validDriftTicks: number;
  readonly scoreAfterInitialDrift: number;
  readonly groundedTicks: number;
  readonly initialDriftEndAngularVelocityY: number;
  readonly recoveryAngularVelocityY: number;
  readonly recoveryAngleRad: number;
}

// Tick-indexed input; the countersteer phase reads the simulation state at the start of each fixed tick
// (identical at every render rate), replacing a frozen -0.6 lock that spun the car before any bank.
const makeReadInput = (simulation: VehicleSimulationHandle) => (simulationTick: number): InputFrame => {
  const phase = simulationTick - 1;
  const throttle = phase < 160 ? 1 : phase < 195 ? 1 : phase < 340 ? 0.85 : phase < 360 ? 0.55 : 0.8;
  const steering = phase < 160 ? 0 : phase < 195 ? 0.75 : phase < 360
    ? slideDriverSteering({ carId: 'CAR-01', tune: simulation.getTuning(), exitAfterTicks: 270 - 160 }, simulation.snapshot(), phase - 160) : 0;
  const handbrake = phase >= 160 && phase < 175 ? 0.7 : 0;
  return { simulationTick, throttle, steering, handbrake, brake: 0, shift: 0, resetPressed: false };
};

async function runAtRenderHz(renderHz: number): Promise<ParityResult> {
  const simulation = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Drift', ground: { halfExtentsM: { x: 100000, y: 0.25, z: 100000 } } });
  const run = createRunController({
    eventId: 'PHYSICS-60S-PARITY', routeId: 'HW-01', mode: 'drift-attack',
    rulesVersion: 'fixture-rules-v1', routeVersion: 'fixture-route-v1', physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash: 'CAR-01:Drift',
    countdownSeconds: 0,
    checkpoints: [{ id: 'finish-far-away', center: { x: 0, y: 0.5, z: -50000 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 20, finish: true }],
  }, () => `parity-${renderHz}`);
  run.startCountdown();
  run.activate();
  const baseScorer = createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: 100000 });
  let routeProgressM = 0;
  let validDriftTicks = 0, groundedTicks = 0, scoreAfterInitialDrift = 0, initialDriftEndAngularVelocityY = 0;
  let recoveryAngularVelocityY = 0, recoveryAngleRad = 0;
  const scorer: DriftScorer = {
    rulesVersion: baseScorer.rulesVersion,
    update(snapshot, evidence, dtSeconds) {
      const result = baseScorer.update(snapshot, evidence, dtSeconds);
      if (result.validDrift) validDriftTicks++;
      if (snapshot.simulationTick === 340) {
        scoreAfterInitialDrift = result.banked + result.unbanked;
        initialDriftEndAngularVelocityY = snapshot.angularVelocityRadS.y;
      }
      if (snapshot.simulationTick === 400) {
        recoveryAngularVelocityY = snapshot.angularVelocityRadS.y;
        recoveryAngleRad = snapshot.driftAngleRad;
      }
      return result;
    },
    bank: () => baseScorer.bank(),
    reset: () => baseScorer.reset(),
    invalidate: (reason) => baseScorer.invalidate(reason),
    snapshot: () => baseScorer.snapshot(),
  };
  const readInput = makeReadInput(simulation);
  const session = new DrivingSession({
    simulation,
    run,
    scorer,
    routeEvidence(previous, current) {
      const distance = Math.hypot(current.position.x - previous.position.x, current.position.z - previous.position.z);
      routeProgressM += distance;
      if (current.wheels.filter((wheel) => wheel.contact).length >= 3) groundedTicks++;
      return { routeProgressM, legalCorridor: true, checkpointValid: true, roadContact: true, wallContact: false };
    },
  });
  try {
    const frames = renderHz * 60;
    for (let frame = 0; frame < frames; frame++) session.advance(1 / renderHz, readInput);
    const current = session.snapshot();
    const score = current.score.banked + current.score.unbanked;
    return {
      seed: 'physics-input-seed-2026-09-30-v1', renderHz, simulationTicks: session.clock.tick, droppedSeconds: session.clock.droppedSeconds,
      position: current.current.position, score, bankedScore: current.score.banked, unbankedScore: current.score.unbanked,
      routeProgressM: current.score.routeProgressM, activeSeconds: current.score.activeSeconds,
      validDriftTicks, scoreAfterInitialDrift, groundedTicks,
      initialDriftEndAngularVelocityY,
      recoveryAngularVelocityY, recoveryAngleRad,
    };
  } finally {
    session.dispose();
  }
}

describe('60 second physics and scoring render-rate parity', () => {
  it('runs the same tick-indexed input through FixedClock at 30, 60 and 120 render Hz', async () => {
    const results = [];
    for (const renderHz of [30, 60, 120]) results.push(await runAtRenderHz(renderHz));
    console.info('FIXED_60S_PARITY', JSON.stringify(results));
    const reference = results[1]!;
    expect(results.every((row) => row.simulationTicks === 3600 && row.droppedSeconds === 0)).toBe(true);
    expect(reference.score).toBeGreaterThan(0);
    for (const result of [results[0]!, results[2]!]) {
      const delta = Math.hypot(result.position.x - reference.position.x, result.position.y - reference.position.y, result.position.z - reference.position.z);
      const scoreDeltaPercent = Math.abs(result.score - reference.score) / reference.score * 100;
      expect(delta).toBeLessThanOrEqual(0.5);
      expect(scoreDeltaPercent).toBeLessThanOrEqual(1);
      expect(result.routeProgressM).toBeCloseTo(reference.routeProgressM, 6);
      expect(result.activeSeconds).toBeCloseTo(60, 5);
    }
  });
});
