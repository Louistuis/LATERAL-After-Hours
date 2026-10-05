import { describe, expect, it } from 'vitest';
import type { InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import { buildHarborApronCollision, buildHarborRoute } from '../../src/world/route-data.js';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const wrap = (n: number): number => Math.atan2(Math.sin(n), Math.cos(n));

describe('authored HW-01 drift scoring', () => {
  it('banks a grounded legal pulse through a continuous inside-corner projection', async () => {
    const { route, collision } = buildHarborRoute();
    const simulation = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId: 'CAR-01', tune: 'Balanced' });
    simulation.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    const apron = buildHarborApronCollision();
    simulation.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(simulation.snapshot().position);
    const cumulative = [0];
    for (let i = 1; i < route.centerline.length; i++) {
      const a = route.centerline[i - 1]!, b = route.centerline[i]!;
      cumulative.push(cumulative.at(-1)! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const pointAt = (distance: number): Vec3 => {
      const d = Math.min(cumulative.at(-1)!, distance);
      let i = 1;
      while (i < cumulative.length - 1 && cumulative[i]! < d) i++;
      const a = route.centerline[i - 1]!, b = route.centerline[i]!;
      const t = (d - cumulative[i - 1]!) / (cumulative[i]! - cumulative[i - 1]!);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    };
    const run = createRunController({
      eventId: 'HW-01:drift-attack', routeId: route.id, mode: 'drift-attack',
      rulesVersion: 'fixture-rules-v1', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION,
      carId: 'CAR-01', tuneHash: simulation.getTuneIdentity(),
      checkpoints: route.checkpoints, countdownSeconds: 0,
    }, () => 'hw01-corner-pulse');
    run.startCountdown(); run.activate();
    const accepted: string[] = [];
    let result: RunResult | null = null;
    let pulseStartTick = -1;
    let maxAngle = 0;
    let validDriftTicks = 0;
    let maxProgressStep = 0;
    let previousProgress = progress.progressM;
    const session = new DrivingSession({ simulation, run,
      scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
      routeEvidence: (_previous, current, checkpoints) => {
        progress = tracker.update(current.position);
        maxProgressStep = Math.max(maxProgressStep, progress.progressM - previousProgress);
        previousProgress = progress.progressM;
        accepted.push(...(checkpoints?.acceptedIds ?? []));
        return { routeProgressM: progress.progressM, legalCorridor: progress.legal,
          checkpointValid: !checkpoints?.invalidCrossing, runViolation: progress.violation ?? undefined,
          roadContact: current.wheels.some(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId) };
      },
      onRunFinished: finished => { result = finished; },
    });
    const input = (tick: number): InputFrame => {
      const state = simulation.snapshot();
      const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
      const target = pointAt(progress.progressM + Math.max(5, speed * .42));
      const q = state.rotation;
      const fx = -2 * (q.x * q.z + q.w * q.y);
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const heading = Math.atan2(fx, -fz);
      const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
      let steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
      if (pulseStartTick < 0 && progress.progressM >= 450) pulseStartTick = tick;
      const age = pulseStartTick < 0 ? -1 : tick - pulseStartTick;
      if (age >= 0 && age < 35) steering = .9;
      return { simulationTick: tick, throttle: speed < 9 ? .72 : .08,
        brake: speed > 10.5 ? .35 : 0, steering,
        handbrake: age >= 0 && age < 20 ? 1 : 0,
        shift: 0, resetPressed: false };
    };
    try {
      for (let tick = 1; tick <= 6000 && !result; tick++) {
        const frame = session.advance(1 / 60, input);
        maxAngle = Math.max(maxAngle, Math.abs(frame.current.driftAngleRad));
        if (frame.score.validDrift) validDriftTicks++;
      }
      expect(accepted).toEqual(route.checkpoints.map(checkpoint => checkpoint.id));
      expect(pulseStartTick).toBeGreaterThan(0);
      expect(maxAngle).toBeGreaterThan(10 * Math.PI / 180);
      expect(validDriftTicks).toBeGreaterThan(0);
      expect(maxProgressStep).toBeLessThan(.25);
      expect(result).toMatchObject({ valid: true, mode: 'drift-attack' });
      expect(result!.bankedScore).toBeGreaterThan(0);
      expect(session.clock.tick).toBe(simulation.snapshot().simulationTick);
    } finally { session.dispose(); }
  }, 30_000);
});
