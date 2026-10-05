import { describe, expect, it } from 'vitest';
import type { CarId, InputFrame, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';
import type { CollisionMeshData } from '../../contracts/world-contracts.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { RecoveryTracker, type RecoveryReason } from '../../src/driving/recovery.js';
import { DrivingSession } from '../../src/driving/session.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import { buildCoastInterchange } from '../../src/world/coast-interchange.js';
import { buildRidgePass } from '../../src/world/ridge-pass.js';
import type { RoadRibbon } from '../../src/world/road-ribbon.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

const ROUTES: Readonly<Record<'RP-01' | 'CL-01', () => { ribbon: RoadRibbon; collisionMeshes: readonly CollisionMeshData[] }>> = {
  'RP-01': buildRidgePass,
  'CL-01': buildCoastInterchange,
};

interface CrashPlan {
  readonly carId?: CarId;
  /** Route progress (fraction of the lap) where the driver steers into the wall. */
  readonly crashAt: number;
  /** +1 steers right into the first wall, -1 left. The second crash goes the other way. */
  readonly side: 1 | -1;
}

/**
 * The QA wall-crash sequence on a procedural route, with the complete collision set and the same route evidence,
 * surface classification and recovery wiring the game runtime uses: drive, steer into the barrier at full throttle
 * for 3.5 s, press R, then pin the car against the other barrier with the throttle held until the stuck
 * auto-recovery fires, then drive on to the finish.
 */
async function crashLap(routeId: keyof typeof ROUTES, plan: CrashPlan) {
  const carId = plan.carId ?? 'CAR-01';
  const { ribbon, collisionMeshes } = ROUTES[routeId]();
  const route = ribbon.route;
  const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
  for (const mesh of collisionMeshes) sim.addStaticTriangleMesh(mesh.vertices, mesh.indices, mesh.surfaceId, 0.9, mesh.role ?? 'surface');
  const roadSurfaces = new Set(collisionMeshes.filter(mesh => mesh.drivableRoad === true && mesh.role !== 'obstacle').map(mesh => mesh.surfaceId));
  const edgeSurfaces = new Set(collisionMeshes.filter(mesh => mesh.role !== 'obstacle' && mesh.surfaceId.startsWith('curb:')).map(mesh => mesh.surfaceId));
  const tracker = new RouteProgressTracker(route.centerline, route.widthM);
  let progress = tracker.update(sim.snapshot().position);
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
  const run = createRunController({
    eventId: `${routeId}:time-trial`, routeId: route.id, mode: 'time-trial', rulesVersion: 'fixture-rules-v1',
    routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId, tuneHash: sim.getTuneIdentity(),
    checkpoints: route.checkpoints, countdownSeconds: 0,
  }, () => `${routeId}-crash`);
  run.startCountdown(); run.activate();
  const accepted: string[] = [], violations: string[] = [], reasons: RecoveryReason[] = [];
  let result: RunResult | null = null, wallWheelTicks = 0;
  type Phase = 'drive' | 'wall' | 'press-r' | 'pin' | 'home';
  let phase = 'drive' as Phase, phaseTicks = 0;
  // The input callback moves 'press-r' to 'pin', which control-flow narrowing in the loop cannot see.
  const phaseNow = (): Phase => phase;
  const session = new DrivingSession({ simulation: sim, run,
    scorer: createDriftScorer({ rulesVersion: 'fixture-rules-v1', routeLengthM: route.lengthM }),
    recovery: new RecoveryTracker(route, { isRoadSurface: id => roadSurfaces.has(id) }),
    onRecovered: (pose, reason) => { reasons.push(reason); tracker.rebase(pose.position); },
    routeEvidence: (_previous, current, checkpoints) => {
      progress = tracker.update(current.position);
      accepted.push(...(checkpoints?.acceptedIds ?? []));
      if (progress.violation) violations.push(progress.violation);
      const roadWheels = current.wheels.filter(w => w.contact && w.surfaceId !== null && roadSurfaces.has(w.surfaceId)).length;
      const edgeWheels = current.wheels.filter(w => w.contact && w.surfaceId !== null && edgeSurfaces.has(w.surfaceId)).length;
      if (current.wheels.some(w => w.contact && w.surfaceId?.startsWith('barrier:'))) wallWheelTicks++;
      return { routeProgressM: progress.progressM, routeLateralOffsetM: progress.lateralOffsetM ?? undefined, legalCorridor: progress.legal,
        runViolation: progress.violation ?? undefined, checkpointValid: !checkpoints?.invalidCrossing, roadContact: roadWheels >= 3,
        surfaceContact: roadWheels + edgeWheels >= 3 };
    },
    onRunFinished: finished => { result = finished; },
  });
  const input = (tick: number): InputFrame => {
    const base = { simulationTick: tick, handbrake: 0, shift: 0, resetPressed: false } as const;
    if (phase === 'wall') return { ...base, throttle: 1, brake: 0, steering: plan.side };
    if (phase === 'press-r') { phase = 'pin'; phaseTicks = 0; return { ...base, throttle: 0, brake: 0, steering: 0, resetPressed: true }; }
    if (phase === 'pin') return { ...base, throttle: 1, brake: 0, steering: -plan.side };
    const state = sim.snapshot();
    const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
    const target = pointAt(progress.progressM + Math.max(5, speed * 0.42 + Math.max(0, speed - 12) * 0.6));
    const q = state.rotation;
    const heading = Math.atan2(-2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
    const goal = 14;
    return { ...base, throttle: speed < goal - 0.5 ? 0.85 : 0.1, brake: speed > goal + 1 ? 0.4 : 0,
      steering: clamp(wrap(desired - heading) * 1.6 * Math.min(1, 15 / Math.max(speed, 1)), -1, 1) };
  };
  try {
    for (let tick = 1; tick <= 15000 && !result; tick++) {
      phaseTicks++;
      if (phase === 'drive' && progress.progressM >= route.lengthM * plan.crashAt) { phase = 'wall'; phaseTicks = 0; }
      else if (phase === 'wall' && phaseTicks >= 210) phase = 'press-r';
      else if (phaseNow() === 'pin' && reasons.length >= 2) { phase = 'home'; phaseTicks = 0; }
      else if (phaseNow() === 'pin' && phaseTicks > 900) throw new Error('the pinned car never auto-recovered');
      session.advance(1 / 60, input);
    }
  } finally { session.dispose(); }
  return { route, accepted, violations, reasons, wallWheelTicks, result: result as RunResult | null, status: run.status() };
}

describe.each(['RP-01', 'CL-01'] as const)('%s run validity: a wall crash and its recoveries never read as a shortcut', routeId => {
  it.each([
    { crashAt: 0.22, side: 1 },
    { crashAt: 0.55, side: -1 },
  ] as const)('crash into the wall at $crashAt of the lap (side $side), R, pinned until auto recovery: the run stays valid', async plan => {
    const lap = await crashLap(routeId, plan);
    // The car really sat against the barrier on barrier-foot wheel contacts and the stuck trigger recovered it
    // (on a hairpin the first 3.5 s pin can already trip it, and R then falls inside the cooldown).
    expect(lap.reasons.length).toBeGreaterThanOrEqual(2);
    expect(lap.reasons).toContain('stuck');
    expect(lap.wallWheelTicks).toBeGreaterThan(120);
    expect(lap.violations).toEqual([]);
    expect(lap.status.invalidReason ?? null).toBeNull();
    expect(lap.accepted).toEqual(lap.route.checkpoints.map(gate => gate.id));
    expect(lap.result).toMatchObject({ valid: true, routeId });
  }, 120000);
});

describe('route progress: a stopped car outside the corridor is not cutting', () => {
  it('sitting still past the corridor for longer than the runoff limit is no shortcut, moving there still is', () => {
    const { route } = buildRidgePass().ribbon;
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    const pts = route.centerline;
    for (let i = 0; i < 6; i++) expect(tracker.update(pts[i]!).violation).toBeNull();
    const a = pts[5]!, b = pts[6]!, fl = Math.hypot(b.x - a.x, b.z - a.z);
    const out = route.widthM / 2 + 4;
    const beached = { x: a.x - (b.z - a.z) / fl * out, y: a.y, z: a.z + (b.x - a.x) / fl * out };
    // Slide out over half a second, then sit there (stuck against something) for 4 s.
    for (let k = 1; k <= 30; k++) expect(tracker.update({ x: a.x + (beached.x - a.x) * k / 30, y: a.y, z: a.z + (beached.z - a.z) * k / 30 }).violation).toBeNull();
    for (let k = 0; k < 240; k++) expect(tracker.update(beached).violation).toBeNull();
    // Driving on out there is a runoff that does gain ground: 2 s of it is still a shortcut.
    let violation: string | null = null;
    for (let k = 1; k <= 150 && !violation; k++) violation = tracker.update({ x: beached.x + (b.x - a.x) / fl * k * 0.15, y: a.y, z: beached.z + (b.z - a.z) / fl * k * 0.15 }).violation;
    expect(violation).toBe('shortcut');
  });
});
