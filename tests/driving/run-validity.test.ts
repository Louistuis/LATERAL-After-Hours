import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { RecoveryTracker } from '../../src/driving/recovery.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import {
  buildHarborApronCollision, buildHarborCurbCollisions, buildHarborGuardrailCollisions, buildHarborRoute, buildHarborWaterCollision,
} from '../../src/world/route-data.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

interface LapPlan {
  readonly carId?: CarId;
  /** Signed lateral offset of the driven line from the centreline (+ = right of travel), by route progress. */
  readonly lateral?: (progressM: number) => number;
  /** Press R once when route progress first passes this distance. */
  readonly recoverAtM?: number;
}

/**
 * HW-01 with the complete authored collision set (road, curbs and run-off shoulder, guardrails and curtain, apron,
 * water) and the same route evidence and recovery wiring the game runtime uses.
 */
async function harborLap(plan: LapPlan) {
  const carId = plan.carId ?? 'CAR-01';
  const { route, collision } = buildHarborRoute();
  const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
  const meshes = [collision, ...buildHarborCurbCollisions(), ...buildHarborGuardrailCollisions(), buildHarborApronCollision(), buildHarborWaterCollision()];
  for (const mesh of meshes) sim.addStaticTriangleMesh(mesh.vertices, mesh.indices, mesh.surfaceId, 0.9, mesh.role ?? 'surface');
  const roadSurfaces = new Set(meshes.filter(mesh => mesh.drivableRoad === true && mesh.role !== 'obstacle').map(mesh => mesh.surfaceId));
  const edgeSurfaces = new Set(meshes.filter(mesh => mesh.role !== 'obstacle' && mesh.surfaceId.startsWith('curb:')).map(mesh => mesh.surfaceId));
  const tracker = new RouteProgressTracker(route.centerline, route.widthM);
  let progress = tracker.update(sim.snapshot().position);
  const distances = [0];
  for (let i = 1; i < route.centerline.length; i++) {
    const a = route.centerline[i - 1]!, b = route.centerline[i]!;
    distances.push(distances.at(-1)! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const total = distances.at(-1)!;
  const pointAt = (distance: number): { p: Vec3; right: Vec3 } => {
    const d = clamp(distance, 0, total);
    let i = 1;
    while (i < distances.length - 1 && distances[i]! < d) i++;
    const a = route.centerline[i - 1]!, b = route.centerline[i]!;
    const t = (d - distances[i - 1]!) / Math.max(1e-6, distances[i]! - distances[i - 1]!);
    const fx = b.x - a.x, fz = b.z - a.z, fl = Math.hypot(fx, fz) || 1;
    return { p: { x: a.x + fx * t, y: a.y + (b.y - a.y) * t, z: a.z + fz * t }, right: { x: -fz / fl, y: 0, z: fx / fl } };
  };
  const run = createRunController({
    eventId: 'HW-01:time-trial', routeId: route.id, mode: 'time-trial', rulesVersion: 'fixture-rules-v1',
    routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId, tuneHash: sim.getTuneIdentity(),
    checkpoints: route.checkpoints, countdownSeconds: 0,
  }, () => 'harbor-validity');
  run.startCountdown(); run.activate();
  const accepted: string[] = [], violations: string[] = [];
  let result: RunResult | null = null, recovered = 0, pressed = false, offRoadTicks = 0, maxLateral = 0;
  const session = new DrivingSession({ simulation: sim, run,
    scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
    recovery: new RecoveryTracker(route, { isRoadSurface: id => roadSurfaces.has(id) }),
    onRecovered: pose => { recovered++; tracker.rebase(pose.position); },
    routeEvidence: (_previous, current, checkpoints) => {
      progress = tracker.update(current.position);
      accepted.push(...(checkpoints?.acceptedIds ?? []));
      if (progress.violation) { if (!violations.length && process.env.RV_DEBUG) console.info('first violation', JSON.stringify({ ...progress, pos: current.position, wheels: current.wheels.map(w => w.surfaceId) })); violations.push(progress.violation); }
      const roadWheels = current.wheels.filter(w => w.contact && w.surfaceId !== null && roadSurfaces.has(w.surfaceId)).length;
      const edgeWheels = current.wheels.filter(w => w.contact && w.surfaceId !== null && edgeSurfaces.has(w.surfaceId)).length;
      if (roadWheels < 3) offRoadTicks++;
      maxLateral = Math.max(maxLateral, Math.abs(progress.lateralOffsetM ?? 0));
      return { routeProgressM: progress.progressM, routeLateralOffsetM: progress.lateralOffsetM ?? undefined, legalCorridor: progress.legal,
        runViolation: progress.violation ?? undefined, checkpointValid: !checkpoints?.invalidCrossing, roadContact: roadWheels >= 3,
        surfaceContact: roadWheels + edgeWheels >= 3 };
    },
    onRunFinished: finished => { result = finished; },
  });
  const input = (tick: number): InputFrame => {
    const state = sim.snapshot();
    const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
    const along = progress.progressM + Math.max(4.5, speed * 0.45);
    const { p, right } = pointAt(along);
    const offset = plan.lateral?.(along) ?? 0;
    const target = { x: p.x + right.x * offset, z: p.z + right.z * offset };
    const q = state.rotation;
    const heading = Math.atan2(-2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
    const reset = plan.recoverAtM !== undefined && !pressed && progress.progressM >= plan.recoverAtM;
    if (reset) pressed = true;
    const goal = 9;
    return { simulationTick: tick, throttle: speed < goal - 0.5 ? 0.8 : 0.1, brake: speed > goal + 1 ? 0.4 : 0,
      steering: clamp(wrap(desired - heading) * 1.6, -1, 1), handbrake: 0, shift: 0, resetPressed: reset };
  };
  try {
    for (let tick = 1; tick <= 9000 && !result; tick++) session.advance(1 / 60, input);
  } finally { session.dispose(); }
  return { route, accepted, violations, result: result as RunResult | null, recovered, offRoadTicks, maxLateral, status: run.status() };
}

describe('run validity: normal line, run-off shoulder and crash recovery never read as a shortcut', () => {
  it('the centreline lap is valid', async () => {
    const lap = await harborLap({});
    expect(lap.violations).toEqual([]);
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(gate => gate.id));
    expect(lap.result).toMatchObject({ valid: true, routeId: 'HW-01' });
  }, 90000);

  it('running wide along the shoulder by the rail for most of the lap keeps the run valid and takes every gate', async () => {
    const edge = buildHarborRoute().route.widthM / 2;
    // Outer wheels on the curb and run-off shoulder, alternating sides, centre of the car 0.7 m past the asphalt.
    const lap = await harborLap({ lateral: along => (Math.floor(along / 160) % 2 ? -1 : 1) * (edge + 0.7) });
    expect(lap.offRoadTicks).toBeGreaterThan(600);
    expect(lap.maxLateral).toBeGreaterThan(edge);
    expect(lap.violations).toEqual([]);
    expect(lap.status.invalidReason ?? null).toBeNull();
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(gate => gate.id));
    expect(lap.result).toMatchObject({ valid: true });
  }, 90000);

  it('a recovery mid-route keeps the run valid, costs the penalty and still takes every gate', async () => {
    const plain = await harborLap({});
    const lap = await harborLap({ recoverAtM: plain.route.lengthM * 0.45 });
    expect(lap.recovered).toBe(1);
    expect(lap.violations).toEqual([]);
    expect(lap.status.invalidReason ?? null).toBeNull();
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(gate => gate.id));
    expect(lap.result).toMatchObject({ valid: true });
    expect(lap.result!.elapsedActiveSeconds).toBeGreaterThan(plain.result!.elapsedActiveSeconds + 2);
  }, 120000);

  it('a real cut across the infield is still a shortcut', () => {
    const { route } = buildHarborRoute();
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    const pts = route.centerline;
    // Drive the first stretch, then go straight from there to a point far along the route at 12 m/s.
    let violation: string | null = null;
    let i = 0, at = { ...pts[0]! };
    for (; i < pts.length / 5; i++) { at = { ...pts[i]! }; violation ??= tracker.update(at).violation; }
    expect(violation, 'clean approach').toBeNull();
    const target = pts[Math.floor(pts.length * 0.6)]!;
    const step = 12 / 60, length = Math.hypot(target.x - at.x, target.z - at.z);
    for (let d = 0; d < length && !violation; d += step) {
      violation = tracker.update({ x: at.x + (target.x - at.x) * d / length, y: at.y, z: at.z + (target.z - at.z) * d / length }).violation;
    }
    expect(violation).toBe('shortcut');
  });
});
