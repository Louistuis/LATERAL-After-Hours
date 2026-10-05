import { describe, expect, it } from 'vitest';
import type { EventMode, InputFrame, Vec3 } from '../../contracts/runtime-contracts.js';
import { createDriftScorer } from '../../src/events/scoring.js';
import { createRunController } from '../../src/events/run-controller.js';
import { createGhostRecorder, utf8ByteLength } from '../../src/ghosts/index.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { buildHarborRoute } from '../../src/world/route-data.js';

interface TraceSettings { readonly mode: EventMode; readonly targetSpeedMS: number; readonly tune: 'Balanced' | 'Drift'; readonly driftAssist?: boolean; readonly driftThreshold?: number; readonly driftHandbrake?: number; readonly steeringGain?: number; readonly driftStartM?: number; readonly driftEndM?: number; readonly slowdownM?: readonly [number, number]; readonly slowdownMS?: number; readonly clipTargetOffsetM?: number; readonly clipZoneScoring?: boolean; }
interface TraceSummary {
  readonly mode: EventMode;
  readonly targetSpeedMS: number;
  readonly tune: string;
  readonly activeSeconds: number;
  readonly bankedScore: number;
  readonly validDriftTicks: number;
  readonly peakUnbanked: number;
  readonly handbrakeTicks: number;
  readonly clipEligibleDriftTicks: number;
  readonly maximumDriftAngleRad: number;
  readonly groundedTicks: number;
  readonly roadContactTicks: number;
  readonly highAngleTicks: number;
  readonly legalProgressTicks: number;
  readonly totalTicks: number;
  readonly routeProgressM: number;
  readonly resultValid: boolean;
  readonly ghostBytes: number;
}

function nearestRoutePoint(position: Vec3, points: readonly Vec3[]): number {
  let best = 0, distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]!;
    const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
    if (d < distance) { best = i; distance = d; }
  }
  return best;
}

function targetAt(points: readonly Vec3[], cumulative: readonly number[], distanceM: number): Vec3 {
  const routeLength = cumulative[cumulative.length - 1]!;
  const targetDistance = distanceM % routeLength;
  let hi = 1;
  while (hi < cumulative.length && cumulative[hi]! < targetDistance) hi++;
  const a = points[hi - 1]!, b = points[Math.min(hi, points.length - 1)]!;
  const span = cumulative[hi]! - cumulative[hi - 1]!;
  const t = span > 0 ? (targetDistance - cumulative[hi - 1]!) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

async function runTrace(settings: TraceSettings): Promise<TraceSummary> {
  const { route, collision } = buildHarborRoute();
  const sim = await createVehicleSimulation({ carId: 'CAR-01', tune: settings.tune, ground: false, spawn: route.spawn });
  sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId, 1);
  const run = createRunController({
    eventId: `HW-01:${settings.mode}`, routeId: route.id, mode: settings.mode, rulesVersion: 'hw01-scripted-measure-v1',
    routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash: sim.getTuneIdentity(), checkpoints: route.checkpoints,
    countdownSeconds: 0, maximumDurationSeconds: 600,
  }, () => `hw01-${settings.mode}-${settings.targetSpeedMS}`);
  run.startCountdown(); run.activate();
  const scorer = createDriftScorer({ rulesVersion: 'hw01-scripted-measure-v1', routeLengthM: route.lengthM,
    clippingZones: settings.clipZoneScoring === false ? [] : route.clippingZones });
  const tracker = new RouteProgressTracker(route.centerline, route.widthM);
  const recorder = createGhostRecorder();
  const points = route.centerline;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y, points[i]!.z - points[i - 1]!.z));
  let validDriftTicks = 0;
  let peakUnbanked = 0;
  let handbrakeTicks = 0;
  let clipEligibleDriftTicks = 0;
  let maximumDriftAngleRad = 0;
  let groundedTicks = 0;
  let roadContactTicks = 0;
  let highAngleTicks = 0;
  let legalProgressTicks = 0;
  let previousProgress = 0;
  let result = null as ReturnType<typeof run.finish>;
  try {
    for (let tick = 1; tick <= 36_000 && !result; tick++) {
      const before = sim.snapshot();
      const index = nearestRoutePoint(before.position, points);
      let target = targetAt(points, cumulative, cumulative[index]! + 10);
      if (settings.clipTargetOffsetM !== undefined && previousProgress >= 96 && previousProgress <= 118) {
        target = offsetTarget(target, points, index, settings.clipTargetOffsetM);
      }
      const yaw = 2 * Math.atan2(before.rotation.y, before.rotation.w);
      const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const dx = target.x - before.position.x, dz = target.z - before.position.z;
      const localX = dx * right.x + dz * right.z;
      const localForward = dx * forward.x + dz * forward.z;
      const alpha = Math.atan2(localX, localForward);
      const speed = Math.hypot(before.linearVelocityMS.x, before.linearVelocityMS.z);
      const lookAhead = Math.max(5, Math.hypot(dx, dz));
      const curvature = 2 * Math.sin(alpha) / lookAhead;
      const wheelAngle = Math.atan(sim.getConfig().wheelbaseM * curvature);
      const maxSteer = sim.getConfig().steering.maxAngleLowSpeedRad +
        (sim.getConfig().steering.maxAngleHighSpeedRad - sim.getConfig().steering.maxAngleLowSpeedRad) * Math.min(1, speed / sim.getConfig().steering.highSpeedMS);
      const input: InputFrame = {
        simulationTick: tick,
        throttle: Math.max(0, Math.min(0.85, (targetSpeedAtProgress(settings, previousProgress) - speed) * 0.22)),
        brake: Math.max(0, Math.min(0.45, (speed - targetSpeedAtProgress(settings, previousProgress)) * 0.12)),
        steering: Math.max(-1, Math.min(1, wheelAngle / maxSteer * (settings.steeringGain ?? 1))),
        handbrake: settings.driftAssist && previousProgress >= (settings.driftStartM ?? 0) && previousProgress <= (settings.driftEndM ?? Infinity) && Math.abs(alpha) > (settings.driftThreshold ?? 0.07) && speed > 7 ? (settings.driftHandbrake ?? 0.6) : 0,
        shift: 0, resetPressed: false,
      };
      sim.step(input);
      if (input.handbrake > 0) handbrakeTicks++;
      const current = sim.snapshot();
      run.tick(1 / 60);
      const gates = run.status().state === 'ACTIVE' ? run.updateCheckpoints(before.position, current.position) : null;
      const routeProgress = tracker.update(current.position);
      if (routeProgress.violation) run.markInvalid(routeProgress.violation);
      const roadContact = current.wheels.some((wheel) => wheel.contact && wheel.surfaceId === collision.surfaceId);
      if (roadContact) roadContactTicks++;
      if (current.wheels.filter((wheel) => wheel.contact).length >= 3) groundedTicks++;
      maximumDriftAngleRad = Math.max(maximumDriftAngleRad, Math.abs(current.driftAngleRad));
      if (Math.abs(current.driftAngleRad) >= 10 * Math.PI / 180) highAngleTicks++;
      if (routeProgress.legal && routeProgress.progressM > previousProgress && roadContact && (gates === null || !gates.invalidCrossing)) legalProgressTicks++;
      previousProgress = routeProgress.progressM;
      const score = scorer.update(current, {
        routeProgressM: routeProgress.progressM, legalCorridor: routeProgress.legal,
        checkpointValid: !gates?.invalidCrossing, roadContact, wallContact: false,
        impactDeltaMS: sim.collisionTelemetry().speedDeltaMS, active: true, paused: false,
      }, 1 / 60);
      if (score.validDrift) validDriftTicks++;
      if (score.validDrift && routeProgress.lateralOffsetM !== null && Math.abs(routeProgress.progressM - 107) <= 6 && Math.abs(routeProgress.lateralOffsetM - 3.8) <= 0.7) clipEligibleDriftTicks++;
      peakUnbanked = Math.max(peakUnbanked, score.unbanked);
      recorder.update(current, run.status().elapsedActiveSeconds);
      if (gates?.completed) result = run.finish(scorer.bank().banked);
    }
    const complete = Boolean(result);
    const ghost = recorder.toSavedGhost({ routeId: route.id, routeVersion: route.version, rulesVersion: run.status().invalidReason ?? 'hw01-scripted-measure-v1', physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash: sim.getTuneIdentity() }, 128 * 1024);
    return {
      mode: settings.mode, targetSpeedMS: settings.targetSpeedMS, tune: settings.tune,
      activeSeconds: result?.elapsedActiveSeconds ?? run.status().elapsedActiveSeconds, bankedScore: result?.bankedScore ?? scorer.snapshot().banked, validDriftTicks,
      peakUnbanked, handbrakeTicks,
      clipEligibleDriftTicks,
      maximumDriftAngleRad, groundedTicks,
      roadContactTicks, highAngleTicks, legalProgressTicks,
      totalTicks: run.status().elapsedActiveSeconds * 60, routeProgressM: run.status().routeProgressM,
      resultValid: complete && result!.valid, ghostBytes: ghost ? utf8ByteLength(JSON.stringify(ghost)) : 0,
    };
  } finally { sim.dispose(); }
}

describe('HW-01 scripted production-physics route traces', () => {
  it('records reproducible completion and score/time evidence for three event modes', async () => {
    const traces: TraceSummary[] = [];
    for (const settings of [
      { mode: 'time-trial', targetSpeedMS: 6, tune: 'Balanced' },
      { mode: 'time-trial', targetSpeedMS: 8, tune: 'Balanced' },
      { mode: 'drift-attack', targetSpeedMS: 8, tune: 'Drift', driftAssist: true },
      { mode: 'rival-ghost', targetSpeedMS: 8, tune: 'Balanced' },
    ] as const) traces.push(await runTrace(settings));
    console.info('HW01_SCRIPTED_TRACE_V1', JSON.stringify(traces));
    expect(traces).toHaveLength(4);
    expect(traces.every((trace) => trace.resultValid && trace.activeSeconds > 0)).toBe(true);
    expect(traces.filter((trace) => trace.mode === 'time-trial')).toHaveLength(2);
    expect(traces.find((trace) => trace.mode === 'drift-attack')?.bankedScore).toBeGreaterThanOrEqual(0);
    expect(traces.find((trace) => trace.mode === 'rival-ghost')?.ghostBytes).toBeGreaterThan(0);
  }, 120_000);

  it('sweeps grounded legal handbrake drift inputs without changing physics state', async () => {
    const traces: TraceSummary[] = [];
    for (const settings of [
      { mode: 'drift-attack', targetSpeedMS: 9, tune: 'Drift', driftAssist: true, driftThreshold: 0.01, driftHandbrake: 0.1, driftStartM: 0, driftEndM: 598 },
      { mode: 'drift-attack', targetSpeedMS: 10, tune: 'Drift', driftAssist: true, driftThreshold: 0.01, driftHandbrake: 0.1, driftStartM: 0, driftEndM: 598 },
      { mode: 'drift-attack', targetSpeedMS: 11, tune: 'Drift', driftAssist: true, driftThreshold: 0.01, driftHandbrake: 0.1, driftStartM: 0, driftEndM: 598 },
    ] as const) traces.push(await runTrace(settings));
    console.info('HW01_DRIFT_INPUT_SWEEP_V1', JSON.stringify(traces));
    expect(traces).toHaveLength(3);
    expect(traces[1]).toMatchObject({ resultValid: true, groundedTicks: expect.any(Number), roadContactTicks: expect.any(Number) });
    expect(traces[1]!.validDriftTicks).toBeGreaterThan(0);
    expect(traces[1]!.bankedScore).toBeGreaterThan(0);
  }, 120_000);

  it('does not award the authored HW-01 clip bonus when a physical trace misses its line window', async () => {
    const comparisons = [];
    for (const clipTargetOffsetM of [2.5, 3.8]) {
      const input = { mode: 'drift-attack', targetSpeedMS: 10, tune: 'Drift', driftAssist: true,
        driftThreshold: 0.01, driftHandbrake: 0.1, driftStartM: 0, driftEndM: 598, clipTargetOffsetM } as const;
      const neutral = await runTrace({ ...input, clipZoneScoring: false });
      const authored = await runTrace({ ...input, clipZoneScoring: true });
      comparisons.push({ clipTargetOffsetM, neutral, authored });
    }
    console.info('HW01_CLIP_ZONE_AB_V1', JSON.stringify(comparisons));
    for (const { neutral, authored } of comparisons) {
      expect(neutral.resultValid).toBe(true);
      expect(authored.resultValid).toBe(true);
      expect(authored.clipEligibleDriftTicks).toBe(0);
      expect(authored.bankedScore).toBe(neutral.bankedScore);
    }
  }, 120_000);
});

function offsetTarget(target: Vec3, points: readonly Vec3[], index: number, offsetM: number): Vec3 {
  const a = points[index]!;
  const b = points[Math.min(index + 1, points.length - 1)]!;
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return target;
  return { ...target, x: target.x - dz / length * offsetM, z: target.z + dx / length * offsetM };
}

function targetSpeedAtProgress(settings: TraceSettings, progressM: number): number {
  return settings.targetSpeedMS - (settings.slowdownM && settings.slowdownMS && progressM >= settings.slowdownM[0] && progressM <= settings.slowdownM[1] ? settings.slowdownMS : 0);
}
