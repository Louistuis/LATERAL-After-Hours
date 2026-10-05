import { describe, expect, it } from 'vitest';
import type { InputFrame, RunResult, Vec3, VehicleSnapshot } from '../../contracts/runtime-contracts.js';
import { buildHarborApronCollision, buildHarborGuardrailCollisions, buildHarborRoute } from '../../src/world/route-data.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { DrivingSession } from '../../src/driving/session.js';
import { RecoveryTracker, uprightness, RECOVERY_PENALTY_SECONDS } from '../../src/driving/recovery.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

async function harborWorld(spawn = buildHarborRoute().route.spawn) {
  const { route, collision } = buildHarborRoute();
  const simulation = await createVehicleSimulation({ ground: false, spawn, carId: 'CAR-01', tune: 'Balanced' });
  simulation.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
  const apron = buildHarborApronCollision();
  simulation.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
  for (const barrier of buildHarborGuardrailCollisions()) simulation.addStaticTriangleMesh(barrier.vertices, barrier.indices, barrier.surfaceId, 0.9, 'obstacle');
  const recovery = new RecoveryTracker(route, { isRoadSurface: id => id === collision.surfaceId });
  return { route, collision, simulation, recovery };
}

/** Pure-pursuit centerline driver (same as the physical lap test). */
function centerlineDriver(route: ReturnType<typeof buildHarborRoute>['route'], progressOf: () => number) {
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
  return (state: VehicleSnapshot, tick: number, extra: Partial<InputFrame> = {}): InputFrame => {
    const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
    const target = pointAt(progressOf() + Math.max(5, speed * 0.42));
    const q = state.rotation;
    const heading = Math.atan2(-2 * (q.x * q.z + q.w * q.y), (1 - 2 * (q.x * q.x + q.y * q.y)));
    const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
    return { simulationTick: tick, throttle: speed < 8 ? 0.72 : 0.08, brake: speed > 9.5 ? 0.35 : 0,
      steering: clamp(wrap(desired - heading) * 1.6, -1, 1), handbrake: 0, shift: 0, resetPressed: false, ...extra };
  };
}

describe('crash recovery near the crash', () => {
  it('R mid-run recovers behind the car, keeps the run alive with a time penalty, and the lap still finishes valid', async () => {
    const { route, collision, simulation, recovery } = await harborWorld();
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(simulation.snapshot().position);
    const run = createRunController({
      eventId: 'HW-01:time-trial', routeId: route.id, mode: 'time-trial', rulesVersion: 'fixture-rules-v1',
      routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash: simulation.getTuneIdentity(),
      checkpoints: route.checkpoints, countdownSeconds: 0,
    }, () => 'recovery-run');
    run.startCountdown(); run.activate();
    const accepted: string[] = [], violations: string[] = [];
    let result: RunResult | null = null;
    const session = new DrivingSession({ simulation, run, recovery,
      scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
      onRecovered: pose => tracker.rebase(pose.position),
      routeEvidence: (_previous, current, checkpoints) => {
        progress = tracker.update(current.position);
        accepted.push(...(checkpoints?.acceptedIds ?? []));
        if (progress.violation) violations.push(progress.violation);
        return { routeProgressM: progress.progressM, legalCorridor: progress.legal, checkpointValid: !checkpoints?.invalidCrossing,
          runViolation: progress.violation ?? undefined, roadContact: current.wheels.some(w => w.contact && w.surfaceId === collision.surfaceId) };
      },
      onRunFinished: finished => { result = finished; },
    });
    const drive = centerlineDriver(route, () => progress.progressM);
    try {
      let tick = 1;
      for (; tick <= 1500; tick++) session.advance(1 / 60, t => drive(simulation.snapshot(), t));
      const before = simulation.snapshot().position, progressBefore = recovery.project(before).progressM;
      const elapsedBefore = run.status().elapsedActiveSeconds, gatesBefore = run.status().checkpointIndex;
      // Two presses in a row: the cooldown swallows the second.
      session.advance(1 / 60, t => ({ ...drive(simulation.snapshot(), t), resetPressed: true }));
      session.advance(1 / 60, t => ({ ...drive(simulation.snapshot(), t), resetPressed: true }));
      const after = simulation.snapshot();
      expect(session.recoveryState()).toMatchObject({ count: 1, reason: 'manual', penaltySeconds: RECOVERY_PENALTY_SECONDS });
      expect(run.status().state).toBe('ACTIVE');
      expect(run.status().checkpointIndex).toBe(gatesBefore);
      expect(run.status().elapsedActiveSeconds - elapsedBefore).toBeGreaterThanOrEqual(RECOVERY_PENALTY_SECONDS);
      expect(run.status().elapsedActiveSeconds - elapsedBefore).toBeLessThan(RECOVERY_PENALTY_SECONDS + 0.1);
      // Near the crash, never ahead of it, far from the spawn, at rest and upright.
      const distance = Math.hypot(after.position.x - before.x, after.position.z - before.z);
      expect(distance).toBeLessThan(12);
      expect(recovery.project(after.position).progressM).toBeLessThanOrEqual(progressBefore);
      expect(Math.hypot(after.position.x - route.spawn.position.x, after.position.z - route.spawn.position.z)).toBeGreaterThan(60);
      expect(Math.hypot(after.linearVelocityMS.x, after.linearVelocityMS.y, after.linearVelocityMS.z)).toBeLessThan(0.5);
      expect(uprightness(after.rotation)).toBeGreaterThan(0.99);
      for (; tick <= 9000 && !result; tick++) session.advance(1 / 60, t => drive(simulation.snapshot(), t));
      expect(accepted).toEqual(route.checkpoints.map(checkpoint => checkpoint.id));
      expect(violations).toEqual([]);
      expect(result).toMatchObject({ valid: true, routeId: route.id });
    } finally { session.dispose(); }
  });

  it('recovers automatically when the car is pinned against the fence with the throttle held', async () => {
    const { route, collision, simulation, recovery } = await harborWorld();
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(simulation.snapshot().position);
    const session = new DrivingSession({ simulation, recovery });
    const drive = centerlineDriver(route, () => progress.progressM);
    try {
      let tick = 1;
      for (; tick <= 600; tick++) { session.advance(1 / 60, t => drive(simulation.snapshot(), t)); progress = tracker.update(simulation.snapshot().position); }
      // Turn hard into the fence and keep the gas pinned.
      let stuckAt: Vec3 | null = null;
      for (let k = 0; k < 900 && session.recoveryState().count === 0; k++, tick++) {
        session.advance(1 / 60, t => ({ simulationTick: t, throttle: 1, brake: 0, steering: 1, handbrake: 0, shift: 0, resetPressed: false }));
        stuckAt = simulation.snapshot().position;
      }
      expect(session.recoveryState().reason).toMatch(/stuck|flipped/);
      const after = simulation.snapshot();
      expect(after.wheels.length).toBe(4);
      expect(Math.hypot(after.position.x - stuckAt!.x, after.position.z - stuckAt!.z)).toBeLessThan(25);
      // The recovered car sits on the carriageway, inside the barriers.
      for (let k = 0; k < 60; k++) session.advance(1 / 60, t => ({ simulationTick: t, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false }));
      expect(simulation.snapshot().wheels.filter(w => w.contact && w.surfaceId === collision.surfaceId).length).toBeGreaterThanOrEqual(3);
    } finally { session.dispose(); }
  });

  it('rights a flipped car and catches a car that falls out of the world', async () => {
    const { route } = buildHarborRoute();
    const flippedSpawn = { position: { ...route.spawn.position, y: route.spawn.position.y + 0.6 }, rotation: { x: 0, y: 0, z: 1, w: 0 } };
    const { simulation, recovery } = await harborWorld(flippedSpawn);
    const session = new DrivingSession({ simulation, recovery });
    const idle = (t: number): InputFrame => ({ simulationTick: t, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false });
    try {
      for (let k = 0; k < 240 && session.recoveryState().count === 0; k++) session.advance(1 / 60, idle);
      expect(session.recoveryState().reason).toBe('flipped');
      expect(uprightness(simulation.snapshot().rotation)).toBeGreaterThan(0.99);
      // Settle on the road so a safe point exists, then drop the car far below it.
      for (let k = 0; k < 180; k++) session.advance(1 / 60, idle);
      expect(recovery.hasSafePoint).toBe(true);
      const settled = simulation.snapshot().position;
      simulation.recoverTo!({ x: settled.x + 400, y: settled.y - 40, z: settled.z }, { x: 0, y: 0, z: 0, w: 1 });
      session.advance(1 / 60, idle);
      expect(session.recoveryState()).toMatchObject({ count: 2, reason: 'fallen', penaltySeconds: 0 });
      expect(Math.hypot(simulation.snapshot().position.x - settled.x, simulation.snapshot().position.z - settled.z)).toBeLessThan(8);
    } finally { session.dispose(); }
  });
});
