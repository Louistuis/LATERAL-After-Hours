import { describe, expect, it } from 'vitest';
import type { InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import { buildHarborApronCollision, buildHarborGuardrailCollisions, buildHarborRoute } from '../../src/world/route-data.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

describe('authored HW-01 physical event lap', () => {
  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s finishes all eight gates from real steering, tires and collision', async carId => {
    const { route, collision } = buildHarborRoute();
    const apron = buildHarborApronCollision();
    const simulation = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
    simulation.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    simulation.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
    const barriers = buildHarborGuardrailCollisions();
    for (const barrier of barriers) {
      simulation.addStaticTriangleMesh(barrier.vertices, barrier.indices, barrier.surfaceId, 0.9, 'obstacle');
    }
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(simulation.snapshot().position);
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
      eventId: 'HW-01:time-trial', routeId: route.id, mode: 'time-trial',
      rulesVersion: 'fixture-rules-v1', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION,
      carId, tuneHash: simulation.getTuneIdentity(),
      checkpoints: route.checkpoints, countdownSeconds: 0,
    }, () => 'input-driven-hw01');
    run.startCountdown(); run.activate();
    const accepted: string[] = [];
    const violations: string[] = [];
    let result: RunResult | null = null;
    let maxOffsetM = 0;
    let barrierContactTicks = 0;
    const session = new DrivingSession({ simulation, run,
      scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
      routeEvidence: (_previous, current, checkpoints) => {
        progress = tracker.update(current.position);
        maxOffsetM = Math.max(maxOffsetM, progress.distanceM);
        if (current.wheels.some(wheel => wheel.contact && wheel.surfaceId?.startsWith('barrier:harbor:hw01:')) ||
            simulation.collisionTelemetry().colliderIds.some(id => id.startsWith('barrier:harbor:hw01:'))) barrierContactTicks++;
        accepted.push(...(checkpoints?.acceptedIds ?? []));
        if (progress.violation) violations.push(progress.violation);
        return { routeProgressM: progress.progressM, legalCorridor: progress.legal,
          checkpointValid: !checkpoints?.invalidCrossing, runViolation: progress.violation ?? undefined,
          roadContact: current.wheels.some(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId) };
      },
      onRunFinished: finished => { result = finished; },
    });
    const input = (tick: number): InputFrame => {
      const state = simulation.snapshot();
      const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
      const target = pointAt(progress.progressM + Math.max(5, speed * 0.42));
      const q = state.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y);
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
      return { simulationTick: tick, throttle: speed < 8 ? 0.72 : 0.08,
        brake: speed > 9.5 ? 0.35 : 0, steering: clamp(wrap(desired - heading) * 1.6, -1, 1),
        handbrake: 0, shift: 0, resetPressed: false };
    };
    try {
      for (let tick = 1; tick <= 6000 && !result; tick++) session.advance(1 / 60, input);
      expect(accepted).toEqual(route.checkpoints.map(checkpoint => checkpoint.id));
      expect(violations).toEqual([]);
      expect(result).toMatchObject({ valid: true, routeId: route.id, mode: 'time-trial' });
      expect(result!.routeVersion).toBe(route.version);
      expect(progress.progressM / route.lengthM).toBeGreaterThan(0.98);
      expect(result!.elapsedActiveSeconds).toBeGreaterThan(60);
      expect(result!.elapsedActiveSeconds).toBeLessThan(100);
      expect(maxOffsetM).toBeLessThan(route.widthM / 2 + 1.5);
      expect(barrierContactTicks).toBe(0);
      expect(session.clock.tick).toBe(simulation.snapshot().simulationTick);
    } finally {
      session.dispose();
    }
  });
});
