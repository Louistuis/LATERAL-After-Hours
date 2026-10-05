import { describe, expect, it } from 'vitest';
import type { CollisionTelemetry } from '../../src/physics/index.js';
import type { InputFrame, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createRunController } from '../../src/events/run-controller.js';
import type { VehicleSimulationHandle } from '../../src/physics/index.js';

const wheel: WheelSnapshot = {
  contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  compressionM: 0.1, normalLoadN: 2500, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0,
  surfaceId: 'road:test',
};

const noImpact = (tick: number): CollisionTelemetry => ({
  tick, impact: false, impulseNs: 0, speedDeltaMS: 0, colliderIds: [],
});

function harness(impacts: ReadonlyMap<number, CollisionTelemetry> = new Map()) {
  let tick = 0;
  let z = 0;
  let resetCount = 0;
  const inputs: InputFrame[] = [];
  const snapshot = (): VehicleSnapshot => ({
    simulationTick: tick, carId: 'CAR-01', position: { x: 0, y: 0.5, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -10 },
    angularVelocityRadS: { x: 0, y: 0, z: 0 }, wheels: [wheel, wheel, wheel, wheel],
    engineRpm: 2000, gear: 2, driftAngleRad: 0,
  });
  const simulation = {
    snapshot,
    step(input: InputFrame) { inputs.push(input); tick = input.simulationTick; z -= 0.1; },
    resetToSafePoint() { resetCount++; z = 0; },
    collisionTelemetry() { return impacts.get(tick) ?? noImpact(tick); },
    dispose() {},
  } as unknown as VehicleSimulationHandle;
  return { simulation, inputs, getTick: () => tick, getResetCount: () => resetCount };
}

const input = (simulationTick: number, resetPressed = false): InputFrame => ({
  simulationTick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed,
});

function activeRun() {
  const run = createRunController({
    eventId: 'HW-01:impact-feedback', routeId: 'HW-01', mode: 'time-trial', rulesVersion: 'impact-test-v1',
    routeVersion: 'test-v1', physicsVersion: 'physics-test-v1', tuneHash: 'tune-test-v1', carId: 'CAR-01',
    countdownSeconds: 0,
    checkpoints: [{ id: 'finish', center: { x: 0, y: 0.5, z: -100 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 5, finish: true }],
  }, () => 'impact-run');
  run.startCountdown(); run.activate();
  return run;
}

function sessionWithRun(h: ReturnType<typeof harness>): DrivingSession {
  return new DrivingSession({ simulation: h.simulation, run: activeRun(), scorer: createDriftScorer({ rulesVersion: 'impact-test-v1', routeLengthM: 100 }) });
}

describe('DrivingSession impact feedback aggregation', () => {
  it('emits only the strongest current-step obstacle impact and keeps its tick and impulse together', () => {
    const impacts = new Map<number, CollisionTelemetry>([
      [1, { tick: 1, impact: true, speedDeltaMS: 0.8, impulseNs: 800, colliderIds: ['rail:a'] }],
      [2, { tick: 2, impact: true, speedDeltaMS: 3.2, impulseNs: 3200, colliderIds: ['wall:b'] }],
      // Larger impulse but lower severity must not displace the speed-delta winner.
      [3, { tick: 3, impact: true, speedDeltaMS: 1.7, impulseNs: 9000, colliderIds: ['rail:c'] }],
      [4, { tick: 3, impact: true, speedDeltaMS: 8, impulseNs: 8000, colliderIds: ['stale-tick'] }],
    ]);
    const h = harness(impacts);
    const session = new DrivingSession({ simulation: h.simulation });
    const frame = session.advance(4 / 60, input);
    expect(frame.current.simulationTick).toBe(4);
    expect(frame.impact).toEqual({ simulationTick: 2, speedDeltaMS: 3.2, impulseNs: 3200 });

    const repeatedReads = [session.snapshot(), session.snapshot(), session.snapshot()];
    expect(repeatedReads.every(read => read.impact?.simulationTick === frame.impact?.simulationTick)).toBe(true);
    const consumedTicks = new Set<number>();
    for (const read of [frame, ...repeatedReads]) {
      if (read.impact) consumedTicks.add(read.impact.simulationTick);
    }
    expect([...consumedTicks]).toEqual([2]);
  });

  it('omits non-contact, stale-tick, and no-impact telemetry', () => {
    const impacts = new Map<number, CollisionTelemetry>([
      [1, { tick: 1, impact: true, speedDeltaMS: 2, impulseNs: 2000, colliderIds: [] }],
      [2, { tick: 1, impact: true, speedDeltaMS: 8, impulseNs: 8000, colliderIds: ['old-contact'] }],
    ]);
    const h = harness(impacts);
    const session = new DrivingSession({ simulation: h.simulation });
    expect(session.advance(2 / 60, input).impact).toBeUndefined();
    expect(session.advance(1 / 60, input).impact).toBeUndefined();
  });

  it('clears prior feedback for zero-step and paused advances without advancing simulation', () => {
    const impacts = new Map<number, CollisionTelemetry>([[1, { tick: 1, impact: true, speedDeltaMS: 2, impulseNs: 2000, colliderIds: ['wall'] }]]);
    const h = harness(impacts);
    const session = new DrivingSession({ simulation: h.simulation });
    expect(session.advance(1 / 60, input).impact?.simulationTick).toBe(1);
    expect(session.advance(0, input).impact).toBeUndefined();
    expect(h.getTick()).toBe(1);

    impacts.set(2, { tick: 2, impact: true, speedDeltaMS: 1.5, impulseNs: 1500, colliderIds: ['rail'] });
    expect(session.advance(1 / 60, input).impact?.simulationTick).toBe(2);
    const tickBeforePause = h.getTick();
    session.pauses.add('manual');
    expect(session.advance(1, input).impact).toBeUndefined();
    expect(h.getTick()).toBe(tickBeforePause);
  });

  it('clears impact feedback on input reset and direct safe reset', () => {
    const impacts = new Map<number, CollisionTelemetry>([[1, { tick: 1, impact: true, speedDeltaMS: 2, impulseNs: 2000, colliderIds: ['wall'] }]]);
    const h = harness(impacts);
    const session = new DrivingSession({ simulation: h.simulation });
    expect(session.advance(1 / 60, input).impact).toBeDefined();
    const afterInputReset = session.advance(1 / 60, tick => input(tick, true));
    expect(afterInputReset.impact).toBeUndefined();
    expect(h.getResetCount()).toBe(1);

    impacts.set(2, { tick: 2, impact: true, speedDeltaMS: 1.5, impulseNs: 1500, colliderIds: ['rail'] });
    expect(session.advance(1 / 60, input).impact?.simulationTick).toBe(2);
    session.resetToSafePoint();
    expect(session.snapshot().impact).toBeUndefined();
    expect(h.getResetCount()).toBe(2);
  });

  it('clears an earlier tick impact when reset input occurs later in the same catch-up advance', () => {
    const h = harness(new Map([[1, { tick: 1, impact: true, speedDeltaMS: 2, impulseNs: 2000, colliderIds: ['wall'] }]]));
    const session = new DrivingSession({ simulation: h.simulation });
    const frame = session.advance(2 / 60, tick => input(tick, tick === 2));
    expect(h.getResetCount()).toBe(1);
    expect(frame.impact).toBeUndefined();
    expect(session.snapshot().impact).toBeUndefined();
  });

  it('clears impact feedback when retrying an aborted event', () => {
    const h = harness(new Map([[1, { tick: 1, impact: true, speedDeltaMS: 2, impulseNs: 2000, colliderIds: ['wall'] }]]));
    const session = sessionWithRun(h);
    expect(session.advance(1 / 60, input).impact).toBeDefined();
    session.run!.abort('test-abort');
    session.retryEvent();
    expect(session.snapshot().impact).toBeUndefined();
    expect(h.getResetCount()).toBe(1);
  });
});
