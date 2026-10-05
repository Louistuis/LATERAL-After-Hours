import { describe, expect, it } from 'vitest';
import type { InputFrame, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import type { VehicleSimulationHandle } from '../../src/physics/index.js';

const wheel: WheelSnapshot = {
  contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  compressionM: 0.1, normalLoadN: 3000, angularVelocityRadS: 0,
  slipRatio: 0, slipAngleRad: 0, surfaceId: 'asphalt',
};

function fakeSimulation(): { simulation: VehicleSimulationHandle; inputs: InputFrame[] } {
  const inputs: InputFrame[] = [];
  let tick = 0;
  let z = 0;
  const snapshot = (): VehicleSnapshot => ({
    simulationTick: tick, carId: 'CAR-01', position: { x: 0, y: 0.5, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocityMS: { x: 0, y: 0, z: -10 }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [wheel, wheel, wheel, wheel], engineRpm: 2000, gear: 1, driftAngleRad: 0,
  });
  const simulation = {
    snapshot,
    step(input: InputFrame) { inputs.push(input); tick = input.simulationTick; z--; },
    resetToSafePoint() { z = 0; },
    collisionTelemetry() { return { speedDeltaMS: 0, tick, impact: false, impulseNs: 0, colliderIds: [] }; },
    dispose() {},
  } as unknown as VehicleSimulationHandle;
  return { simulation, inputs };
}

const input = (simulationTick: number): InputFrame => ({
  simulationTick, throttle: 1, brake: 0, steering: 1,
  handbrake: 0, shift: 1, resetPressed: false,
});

function event(countdownSeconds: number, finishZ = -2) {
  return createRunController({
    eventId: 'HW-01-TT', routeId: 'HW-01', mode: 'time-trial',
    rulesVersion: '1', routeVersion: '1', physicsVersion: 'physics-fixture-v1', tuneHash: 'test', carId: 'CAR-01',
    countdownSeconds,
    checkpoints: [{ id: 'finish', center: { x: 0, y: 0.5, z: finishZ },
      forward: { x: 0, y: 0, z: -1 }, halfWidthM: 5, finish: true }],
  }, () => 'run-1');
}

describe('DrivingSession', () => {
  it('brakes during countdown and excludes countdown and paused wall time from event time', () => {
    const { simulation, inputs } = fakeSimulation();
    const run = event(1 / 60);
    run.startCountdown();
    let routeSamples = 0;
    const session = new DrivingSession({ simulation, run, routeEvidence: () => {
      routeSamples++;
      return { routeProgressM: 0, legalCorridor: true, checkpointValid: true };
    } });
    session.advance(1 / 60, input);
    expect(inputs[0]).toMatchObject({ throttle: 0, brake: 1, steering: 0, handbrake: 1, shift: 0 });
    expect(session.lastInput()).toMatchObject({ throttle: 0, brake: 1, steering: 0, handbrake: 1, shift: 0 });
    const reported = session.lastInput();
    (reported as { brake: number }).brake = 0;
    expect(session.lastInput().brake).toBe(1);
    expect(run.status().state).toBe('ACTIVE');
    expect(run.status().elapsedActiveSeconds).toBe(0);
    expect(routeSamples).toBe(0);
    session.pauses.add('manual');
    session.advance(5, input);
    expect(inputs).toHaveLength(1);
    expect(run.status().elapsedActiveSeconds).toBe(0);
    session.pauses.remove('manual');
    session.advance(1 / 60, input);
    expect(inputs[1]?.throttle).toBe(1);
    expect(session.lastInput()).toMatchObject({ throttle: 1, brake: 0, steering: 1 });
    expect(run.status().elapsedActiveSeconds).toBeCloseTo(1 / 60);
    expect(routeSamples).toBe(1);
  });

  it('publishes a valid finish only once for a run', () => {
    const { simulation } = fakeSimulation();
    const run = event(0);
    run.startCountdown();
    run.activate();
    const results: string[] = [];
    const session = new DrivingSession({ simulation, run, onRunFinished: (result) => { results.push(result.runId); } });
    session.advance(1 / 60, input);
    session.advance(1 / 60, input);
    session.advance(1 / 60, input);
    expect(results).toEqual(['run-1']);
    expect(run.status().state).toBe('FINISHING');
    expect(session.finishedReplay()).toHaveLength(1);
    expect(session.ghostRecording().sampleCount).toBeGreaterThan(0);
  });

  it('keeps the visual replay bounded and clears it on recovery', () => {
    const { simulation } = fakeSimulation();
    const session = new DrivingSession({ simulation });
    for (let frame = 0; frame < 900; frame++) session.advance(1 / 60, input);
    expect(session.replay.size).toBe(360);
    const frozen = session.freezeReplay();
    expect(frozen).toHaveLength(360);
    expect(session.replay.size).toBe(360);
    session.pauses.add('manual');
    session.advance(10, input);
    expect(session.replay.size).toBe(360);
    session.resetToSafePoint();
    expect(session.replay.size).toBe(0);
    expect(frozen).toHaveLength(360);
  });

  it('also clears prior visual traces on the input reset edge', () => {
    const { simulation } = fakeSimulation();
    const session = new DrivingSession({ simulation });
    session.advance(1 / 60, input);
    expect(session.replay.size).toBe(1);
    session.advance(1 / 60, (tick) => ({ ...input(tick), resetPressed: true }));
    expect(session.replay.size).toBe(0);
    expect(session.lastInput()).toMatchObject({ simulationTick: 1, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false });
    expect(session.freezeReplay()).toHaveLength(0);
    expect(session.clock.tick).toBe(1);
    session.advance(1 / 60, input);
    expect(session.snapshot().current.simulationTick).toBe(2);
    expect(session.clock.tick).toBe(2);
  });

  it('stops remaining catch-up physics ticks when a finish callback pauses play', () => {
    const { simulation, inputs } = fakeSimulation();
    const run = event(0);
    run.startCountdown();
    run.activate();
    const session = new DrivingSession({ simulation, run, onRunFinished: () => { session.pauses.add('menu'); } });
    session.advance(5 / 60, input);
    expect(inputs).toHaveLength(2);
    expect(session.snapshot().current.simulationTick).toBe(2);
    expect(session.clock.tick).toBe(2);
    expect(run.status().elapsedActiveSeconds).toBeCloseTo(2 / 60);
    session.pauses.remove('menu');
    session.advance(1 / 60, input);
    expect(session.snapshot().current.simulationTick).toBe(3);
    expect(session.clock.tick).toBe(3);
  });

  it('marks an explicit route shortcut invalid even if the ordered finish is crossed', () => {
    const { simulation } = fakeSimulation();
    const run = event(0);
    run.startCountdown();
    run.activate();
    const results: boolean[] = [];
    const session = new DrivingSession({ simulation, run,
      routeEvidence: (_previous, current) => ({
        routeProgressM: Math.abs(current.position.z), legalCorridor: true,
        checkpointValid: true, runViolation: current.simulationTick === 1 ? 'shortcut' : undefined,
      }),
      onRunFinished: result => { results.push(result.valid); },
    });
    session.advance(1 / 60, input);
    expect(run.status().invalidReason).toBe('shortcut');
    session.advance(1 / 60, input);
    expect(results).toEqual([false]);
    expect(run.status().state).toBe('FINISHING');
  });

  it('invalidates sustained grounded non-road travel but allows a brief runoff', () => {
    for (const offRoadTicks of [90, 125]) {
      const { simulation } = fakeSimulation();
      const run = event(0, -200);
      run.startCountdown(); run.activate();
      const results: boolean[] = [];
      const session = new DrivingSession({ simulation, run,
        routeEvidence: (_previous, current) => ({
          routeProgressM: Math.abs(current.position.z), legalCorridor: true,
          checkpointValid: true, roadContact: current.simulationTick > offRoadTicks,
        }),
        onRunFinished: result => { results.push(result.valid); },
      });
      for (let tick = 1; tick <= 130; tick++) session.advance(1 / 60, input);
      expect(run.status().invalidReason).toBe(offRoadTicks > 120 ? 'shortcut' : null);
      for (let tick = 131; tick <= 200; tick++) session.advance(1 / 60, input);
      expect(results).toEqual([offRoadTicks <= 120]);
    }
  });

  it('does not count countdown or paused wall time toward non-road invalidation', () => {
    const { simulation } = fakeSimulation();
    const run = event(1, -200);
    run.startCountdown();
    const session = new DrivingSession({ simulation, run,
      routeEvidence: (_previous, current) => ({
        routeProgressM: Math.abs(current.position.z), legalCorridor: true,
        checkpointValid: true, roadContact: false,
      }),
    });
    for (let tick = 0; tick < 150; tick++) session.advance(1 / 60, input);
    expect(run.status().elapsedActiveSeconds).toBeCloseTo(90 / 60);
    expect(run.status().invalidReason).toBeNull();
    session.pauses.add('manual');
    session.advance(10, input);
    expect(run.status().invalidReason).toBeNull();
    session.pauses.remove('manual');
    for (let tick = 0; tick < 25; tick++) session.advance(1 / 60, input);
    expect(run.status().invalidReason).toBeNull();
    for (let tick = 0; tick < 10; tick++) session.advance(1 / 60, input);
    expect(run.status().invalidReason).toBe('shortcut');
  });
});
