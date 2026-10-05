import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import { buildRidgePass, RIDGE_ROAD_SURFACE } from '../../src/world/ridge-pass.js';
import { buildCoastInterchange, COAST_ROAD_SURFACE } from '../../src/world/coast-interchange.js';
import type { CollisionMeshData } from '../../contracts/world-contracts.js';
import type { RoadRibbon } from '../../src/world/road-ribbon.js';

interface ProceduralRoute { readonly ribbon: RoadRibbon; readonly collisionMeshes: readonly CollisionMeshData[] }
const ROUTES: Readonly<Record<'RP-01' | 'CL-01', { build: () => ProceduralRoute; surface: string; barrier: string; quickMaxS: number }>> = {
  'RP-01': { build: buildRidgePass, surface: RIDGE_ROAD_SURFACE, barrier: 'barrier:ridge:', quickMaxS: 150 },
  'CL-01': { build: buildCoastInterchange, surface: COAST_ROAD_SURFACE, barrier: 'barrier:coast:', quickMaxS: 110 },
};
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Scripted pure-pursuit lap. `pace` picks the cruise driver or a curvature-aware quick driver. */
async function routeLap(routeId: keyof typeof ROUTES, carId: CarId, pace: 'cruise' | 'quick') {
  const spec = ROUTES[routeId];
  const { ribbon, collisionMeshes } = spec.build();
  const route = ribbon.route;
  const simulation = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
  for (const mesh of collisionMeshes) simulation.addStaticTriangleMesh(mesh.vertices, mesh.indices, mesh.surfaceId, 0.9, mesh.role ?? 'surface');
  const tracker = new RouteProgressTracker(route.centerline, route.widthM);
  let progress = tracker.update(simulation.snapshot().position);
  const distances = [0];
  for (let i = 1; i < route.centerline.length; i++) {
    const a = route.centerline[i - 1]!, b = route.centerline[i]!;
    distances.push(distances.at(-1)! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const pointAt = (distance: number): Vec3 => {
    const d = clamp(distance, 0, distances.at(-1)!);
    let i = 1;
    while (i < distances.length - 1 && distances[i]! < d) i++;
    const a = route.centerline[i - 1]!, b = route.centerline[i]!;
    const t = (d - distances[i - 1]!) / Math.max(1e-6, distances[i]! - distances[i - 1]!);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  // Tightest radius over the next stretch of road decides the quick driver's target speed.
  const spawnS = ribbon.frames[ribbon.spawnIndex]!.s;
  const curvatureAhead = (fromM: number, lookM: number): number => {
    let worst = 0;
    for (const frame of ribbon.frames) {
      const along = ((frame.s - spawnS) % ribbon.lengthM + ribbon.lengthM) % ribbon.lengthM;
      if (along >= fromM && along <= fromM + lookM) worst = Math.max(worst, Math.abs(frame.curvature));
    }
    return worst;
  };
  const run = createRunController({
    eventId: `${routeId}:time-trial`, routeId: route.id, mode: 'time-trial', rulesVersion: 'fixture-rules-v1',
    routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId, tuneHash: simulation.getTuneIdentity(),
    checkpoints: route.checkpoints, countdownSeconds: 0,
  }, () => `${routeId}-${pace}`);
  run.startCountdown(); run.activate();
  const accepted: string[] = [], violations: string[] = [];
  let airborneAt: Record<string, number> | null = null, firstHit: Record<string, number> | null = null;
  let result: RunResult | null = null, maxOffsetM = 0, barrierTicks = 0, airborneTicks = 0, longestAirborne = 0, maxUpwardMS = 0, offRoadWheelTicks = 0;
  const session = new DrivingSession({ simulation, run,
    scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
    routeEvidence: (_previous, current, checkpoints) => {
      progress = tracker.update(current.position);
      maxOffsetM = Math.max(maxOffsetM, progress.distanceM);
      if (simulation.collisionTelemetry().colliderIds.some(id => id.startsWith(spec.barrier))) { if (!barrierTicks) firstHit = { ...current.position, progress: progress.progressM, speed: Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z), up: 1 - 2 * (current.rotation.x ** 2 + current.rotation.z ** 2) }; barrierTicks++; }
      const contacts = current.wheels.filter(w => w.contact).length;
      if (contacts === 0) { airborneTicks++; if (airborneTicks > longestAirborne) { longestAirborne = airborneTicks; airborneAt = { ...current.position, progress: progress.progressM, speed: Math.hypot(current.linearVelocityMS.x, current.linearVelocityMS.z) }; } } else airborneTicks = 0;
      offRoadWheelTicks += current.wheels.filter(w => w.contact && w.surfaceId !== spec.surface).length;
      maxUpwardMS = Math.max(maxUpwardMS, current.linearVelocityMS.y);
      accepted.push(...(checkpoints?.acceptedIds ?? []));
      if (progress.violation) violations.push(progress.violation);
      return { routeProgressM: progress.progressM, legalCorridor: progress.legal, checkpointValid: !checkpoints?.invalidCrossing,
        runViolation: progress.violation ?? undefined, roadContact: current.wheels.filter(w => w.contact && w.surfaceId === spec.surface).length >= 3 };
    },
    onRunFinished: finished => { result = finished; },
  });
  const input = (tick: number): InputFrame => {
    const state = simulation.snapshot();
    const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
    // Longer look-ahead and softer steering at speed keep pure pursuit stable on fast sweepers.
    const target = pointAt(progress.progressM + Math.max(5, speed * 0.42 + Math.max(0, speed - 12) * 0.6));
    const q = state.rotation;
    const heading = Math.atan2(-2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
    let goal = 9;
    if (pace === 'quick') {
      const k = curvatureAhead(progress.progressM, 20 + speed * 2.4);
      goal = clamp(Math.sqrt(5.5 / Math.max(k, 1e-3)), 8, 21);
    }
    return { simulationTick: tick, throttle: speed < goal - 0.5 ? 0.85 : 0.1, brake: speed > goal + 1 ? clamp((speed - goal) * 0.25, 0.2, 1) : 0,
      steering: clamp(wrap(desired - heading) * 1.6 * Math.min(1, 15 / Math.max(speed, 1)), -1, 1), handbrake: 0, shift: 0, resetPressed: false };
  };
  try {
    for (let tick = 1; tick <= 15000 && !result; tick++) session.advance(1 / 60, input);
  } finally { session.dispose(); }
  return { firstHit, airborneAt, route, accepted, violations, result: result as RunResult | null, maxOffsetM, barrierTicks, longestAirborne, maxUpwardMS, offRoadWheelTicks, progressM: progress.progressM };
}

describe.each(['RP-01', 'CL-01'] as const)('authored %s physical lap', routeId => {
  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s drives the centreline from spawn through every gate to the finish without leaving the road', async carId => {
    const lap = await routeLap(routeId, carId, 'cruise');
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(checkpoint => checkpoint.id));
    expect(lap.violations).toEqual([]);
    expect(lap.result).toMatchObject({ valid: true, routeId, mode: 'time-trial' });
    expect(lap.progressM / lap.route.lengthM).toBeGreaterThan(0.98);
    expect(lap.maxOffsetM).toBeLessThan(lap.route.widthM / 2 + 1);
    expect(lap.barrierTicks).toBe(0);
    expect(lap.offRoadWheelTicks).toBe(0);
    // No seam or crest throws the car: never all four wheels off the ground for more than 3 ticks.
    expect(lap.longestAirborne).toBeLessThanOrEqual(3);
    expect(lap.maxUpwardMS).toBeLessThan(2.5);
  }, 60000);

  it('a quick, curvature-aware driver laps clean (medal calibration reference)', async () => {
    const lap = await routeLap(routeId, 'CAR-01', 'quick');
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(checkpoint => checkpoint.id));
    expect(lap.violations).toEqual([]);
    expect(lap.result?.valid).toBe(true);
    expect(lap.barrierTicks).toBe(0);
    expect(lap.longestAirborne).toBeLessThanOrEqual(6);
    expect(lap.result!.elapsedActiveSeconds).toBeLessThan(ROUTES[routeId].quickMaxS);
    console.info(`${routeId} quick reference lap: ${lap.result!.elapsedActiveSeconds.toFixed(2)} s, max offset ${lap.maxOffsetM.toFixed(2)} m`);
  }, 60000);
});
