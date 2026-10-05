import { describe, expect, it } from 'vitest';
import type { InputFrame, Quat, Vec3 } from '../../contracts/runtime-contracts.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import type { VehicleDynamicsTelemetry, VehicleSimulationHandle } from '../../src/physics/index.js';
import { buildHarborRoute, sampleHarborRoute } from '../../src/world/route-data.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const yawFromTangent = (tangent: Vec3): Quat => {
  const yaw = Math.atan2(-tangent.x, -tangent.z);
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
};
const forwardFromRotation = ({ x, y, z, w }: Quat): Vec3 => ({
  x: -2 * (x * z + w * y), y: -2 * (y * z - w * x), z: -(1 - 2 * (x * x + y * y)),
});
const normalize = (value: Vec3): Vec3 => {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('matched flat and authored-road tire-force diagnostics', () => {
  it('replays the same seeded state and controller inputs on flat ground and HW-01', async () => {
    const { route, collision } = buildHarborRoute();
    const points = route.centerline;
    const distances = [0];
    for (let index = 1; index < points.length; index++) distances.push(distances.at(-1)! + distance(points[index - 1]!, points[index]!));
    const pointAt = (distanceM: number): Vec3 => {
      const d = Math.min(distances.at(-1)!, Math.max(0, distanceM));
      let index = 1;
      while (index < distances.length - 1 && distances[index]! < d) index++;
      const a = points[index - 1]!, b = points[index]!;
      const fraction = (d - distances[index - 1]!) / (distances[index]! - distances[index - 1]!);
      return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, z: a.z + (b.z - a.z) * fraction };
    };
    const projectRoute = (position: Vec3, expectedProgressM: number) => {
      let best = { progressM: expectedProgressM, lateralOffsetM: 0, distanceM: Number.POSITIVE_INFINITY, score: Number.POSITIVE_INFINITY };
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index]!, b = points[index + 1]!;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const lengthSquared = dx * dx + dy * dy + dz * dz;
        const t = lengthSquared ? clamp(((position.x - a.x) * dx + (position.y - a.y) * dy + (position.z - a.z) * dz) / lengthSquared, 0, 1) : 0;
        const projected = { x: a.x + t * dx, y: a.y + t * dy, z: a.z + t * dz };
        const distanceM = distance(position, projected);
        const rawProgressM = distances[index]! + t * Math.sqrt(lengthSquared);
        const progressM = rawProgressM + Math.round((expectedProgressM - rawProgressM) / route.lengthM) * route.lengthM;
        const score = distanceM + Math.abs(progressM - expectedProgressM) * 0.002;
        if (score < best.score) {
          const horizontalLength = Math.hypot(dx, dz);
          const lateralOffsetM = horizontalLength > 1e-6 ? ((position.x - projected.x) * -dz + (position.z - projected.z) * dx) / horizontalLength : 0;
          best = { progressM, lateralOffsetM, distanceM, score };
        }
      }
      return best;
    };
    const tangentAt = (distanceM: number): Vec3 => normalize({
      x: pointAt(distanceM + 1).x - pointAt(distanceM - 1).x,
      y: pointAt(distanceM + 1).y - pointAt(distanceM - 1).y,
      z: pointAt(distanceM + 1).z - pointAt(distanceM - 1).z,
    });
    const sampled = sampleHarborRoute().map(point => ({ x: point.x, y: point.y, z: point.z }));
    const routeNormalAt = (position: Vec3): Vec3 => {
      let nearest = 0, nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < sampled.length; index++) {
        const d = distance(position, sampled[index]!);
        if (d < nearestDistance) { nearest = index; nearestDistance = d; }
      }
      const before = sampled[(nearest - 1 + sampled.length) % sampled.length]!;
      const after = sampled[(nearest + 1) % sampled.length]!;
      const tangent = normalize({ x: after.x - before.x, y: after.y - before.y, z: after.z - before.z });
      const right = normalize({ x: -tangent.z, y: 0, z: tangent.x });
      const normal = normalize(cross(right, tangent));
      return normal.y >= 0 ? normal : { x: -normal.x, y: -normal.y, z: -normal.z };
    };

    for (const carId of ['CAR-01', 'CAR-02', 'CAR-04'] as const) {
      const entryProgressM = 96;
      const entry = pointAt(entryProgressM);
      const rotation = yawFromTangent(tangentAt(entryProgressM));
      const forward = forwardFromRotation(rotation);
      const initialVelocityMS = { x: forward.x * 9, y: 0, z: forward.z * 9 };
      const spawn = { position: { x: entry.x, y: entry.y + 0.93, z: entry.z }, rotation, linearVelocityMS: initialVelocityMS };
      const reference = await createVehicleSimulation({ carId, tune: 'Drift', ground: false, spawn });
      const roadReplay = await createVehicleSimulation({ carId, tune: 'Drift', ground: false, spawn });
      // Match the authored mesh material exactly. The synthetic plane also carries
      // the route surface ID so its virtual-corridor eligibility is comparable;
      // its normal remains explicitly reported as flat.
      const flatGround = { heightM: entry.y + 0.08, halfExtentsM: { x: 1000, y: 0.25, z: 1000 }, friction: 0.9, surfaceId: collision.surfaceId };
      const flat = await createVehicleSimulation({ carId, tune: 'Drift', ground: flatGround, spawn });
      const flatRepeat = await createVehicleSimulation({ carId, tune: 'Drift', ground: flatGround, spawn });
      for (const sim of [reference, roadReplay]) sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
      let referenceProgressM = entryProgressM;
      let pulseStartTick = -1;
      const inputs: InputFrame[] = [];
      const referencePoses: Array<{ position: Vec3; velocity: Vec3; beta: number; wheels: readonly number[] }> = [];
      try {
        // Record a route-controller input stream from the fixed entry state.
        for (let tick = 1; tick <= 240; tick++) {
          const state = reference.snapshot();
          const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.z);
          const target = pointAt(referenceProgressM + Math.max(5, speed * 0.42));
          const bodyForward = forwardFromRotation(state.rotation);
          const heading = Math.atan2(bodyForward.x, -bodyForward.z);
          const desired = Math.atan2(target.x - state.position.x, -(target.z - state.position.z));
          let steering = clamp(wrap(desired - heading) * 1.6, -1, 1);
          if (pulseStartTick < 0 && referenceProgressM >= 107) pulseStartTick = tick;
          const age = pulseStartTick < 0 ? -1 : tick - pulseStartTick;
          if (age >= 10 && age < 50 && Math.abs(state.driftAngleRad) >= 4 * Math.PI / 180) {
            steering = clamp(steering - Math.sign(state.driftAngleRad) * 0.12, -1, 1);
          }
          const input: InputFrame = { simulationTick: tick, throttle: speed < 8 ? 0.72 : 0.08,
            brake: speed > 9.5 ? 0.35 : 0, steering, handbrake: age >= 0 && age < 15 ? 0.75 : 0,
            shift: 0, resetPressed: false };
          inputs.push(input);
          reference.step(input);
          const after = reference.snapshot();
          referenceProgressM = projectRoute(after.position, referenceProgressM + speed / 60).progressM;
          referencePoses.push({ position: after.position, velocity: after.linearVelocityMS, beta: after.driftAngleRad,
            wheels: after.wheels.map(wheel => wheel.angularVelocityRadS) });
        }

        const trace = (sim: VehicleSimulationHandle, name: string) => {
          let expectedProgressM = entryProgressM;
          let eligibleTicks = 0, longestEligibleStreak = 0, streak = 0;
          let routeContactTicks = 0, peakQualifiedBetaRad = 0, maxCorridorErrorM = 0;
          const rows: Array<Record<string, unknown>> = [];
          for (const input of inputs) {
            sim.step(input);
            const state = sim.snapshot();
            const progress = projectRoute(state.position, expectedProgressM + Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.y, state.linearVelocityMS.z) / 60);
            const deltaProgressM = progress.progressM - expectedProgressM;
            expectedProgressM = progress.progressM;
            const telemetry: VehicleDynamicsTelemetry = sim.wheelDynamicsTelemetry();
            const contacts = telemetry.wheels.filter(wheel => wheel.contact).length;
            const roadContacts = telemetry.wheels.filter(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId).length;
            const forward = forwardFromRotation(state.rotation);
            const speed = Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.y, state.linearVelocityMS.z);
            const forwardSpeed = state.linearVelocityMS.x * forward.x + state.linearVelocityMS.y * forward.y + state.linearVelocityMS.z * forward.z;
            const beta = Math.abs(state.driftAngleRad);
            const angleValid = beta >= 10 * Math.PI / 180 && beta <= 75 * Math.PI / 180;
            const corridorLegal = progress.distanceM <= route.widthM * 0.5 + 1.5;
            const routeValid = corridorLegal && roadContacts >= 3 && deltaProgressM > 0 && deltaProgressM <= Math.max(0.25, speed / 60 * 1.25);
            const eligible = angleValid && speed > 5 && forwardSpeed > 5 && contacts >= 3 && routeValid;
            if (eligible) { eligibleTicks++; streak++; longestEligibleStreak = Math.max(longestEligibleStreak, streak); }
            else streak = 0;
            if (eligible) peakQualifiedBetaRad = Math.max(peakQualifiedBetaRad, beta);
            if (roadContacts >= 3) routeContactTicks++;
            maxCorridorErrorM = Math.max(maxCorridorErrorM, Math.abs(progress.lateralOffsetM));
            const roadNormal = routeNormalAt(state.position);
            const flatNormal = { x: 0, y: 1, z: 0 };
            rows.push({ input, state: { position: state.position, velocityMS: state.linearVelocityMS, yawRateRadS: state.angularVelocityRadS.y,
              betaRad: state.driftAngleRad, speedMS: speed, forwardSpeedMS: forwardSpeed },
              route: { progressM: progress.progressM, progressDeltaM: deltaProgressM, lateralOffsetM: progress.lateralOffsetM,
                corridorDistanceM: progress.distanceM, legalCorridor: corridorLegal, roadContactCount: roadContacts, eligible },
              road: { normal: name === 'flat' ? flatNormal : roadNormal,
                slopeRad: Math.acos(clamp(name === 'flat' ? flatNormal.y : roadNormal.y, -1, 1)) },
              wheels: telemetry.wheels.map((wheel, index) => ({ index, contact: wheel.contact, surfaceId: wheel.surfaceId,
                contactPoint: wheel.contactPoint, contactNormal: wheel.surfaceNormal, normalLoadN: wheel.normalLoadN,
                wheelOmegaRadS: wheel.angularVelocityRadS, longitudinalVelocityMS: wheel.longitudinalVelocityMS,
                lateralVelocityMS: wheel.lateralVelocityMS, slipRatio: wheel.slipRatio, slipAngleRad: wheel.slipAngleRad,
                handbrakeGripScale: wheel.handbrakeGripScale, frictionCapacityN: wheel.frictionCapacityN,
                longitudinalForceDemandN: wheel.longitudinalForceDemandN,
                rawLongitudinalForceN: wheel.rawLongitudinalForceN, rawLateralForceN: wheel.rawLateralForceN,
                appliedLongitudinalForceN: wheel.appliedLongitudinalForceN, appliedLateralForceN: wheel.appliedLateralForceN })) });
          }
          const summary = { name, carId, tune: sim.getTuning(), tuneIdentity: sim.getTuneIdentity(), initialPosition: spawn.position,
            initialVelocityMS, initialSpeedMS: 9, initialRotation: rotation, pulseStartTick, inputTicks: inputs.length,
            eligibleTicks, longestEligibleSeconds: Number((longestEligibleStreak / 60).toFixed(3)),
            peakQualifiedBetaRad: Number(peakQualifiedBetaRad.toFixed(4)), routeContactTicks,
            maxCorridorErrorM: Number(maxCorridorErrorM.toFixed(3)), finalPosition: sim.snapshot().position,
            finalBetaRad: sim.snapshot().driftAngleRad };
          return { summary, rows };
        };

        const roadResult = trace(roadReplay, 'hw01');
        const flatResult = trace(flat, 'flat');
        const flatRepeatResult = trace(flatRepeat, 'flat-repeat');
        let maxRoadRepeatPositionDeltaM = 0, maxFlatRepeatPositionDeltaM = 0, maxRoadRepeatOmegaDeltaRadS = 0, maxFlatRepeatOmegaDeltaRadS = 0;
        for (let i = 0; i < inputs.length; i++) {
          for (const [a, b, road] of [[roadResult.rows[i]!, referencePoses[i]!, true], [flatResult.rows[i]!, flatRepeatResult.rows[i]!, false]] as const) {
            const aRow = a as { state: { position: Vec3; velocityMS: Vec3; betaRad: number }; wheels?: readonly { wheelOmegaRadS: number }[] };
            if (road) {
              const pose = b as (typeof referencePoses)[number];
              maxRoadRepeatPositionDeltaM = Math.max(maxRoadRepeatPositionDeltaM, distance(aRow.state.position, pose.position));
              if (aRow.wheels) for (let wheel = 0; wheel < 4; wheel++) maxRoadRepeatOmegaDeltaRadS = Math.max(maxRoadRepeatOmegaDeltaRadS,
                Math.abs(aRow.wheels[wheel]!.wheelOmegaRadS - pose.wheels[wheel]!));
            } else {
              const repeat = b as (typeof flatRepeatResult.rows)[number];
              const repeatRow = repeat as { state: { position: Vec3 }; wheels: readonly { wheelOmegaRadS: number }[] };
              maxFlatRepeatPositionDeltaM = Math.max(maxFlatRepeatPositionDeltaM, distance(aRow.state.position, repeatRow.state.position));
              const primary = aRow as typeof repeatRow;
              for (let wheel = 0; wheel < 4; wheel++) maxFlatRepeatOmegaDeltaRadS = Math.max(maxFlatRepeatOmegaDeltaRadS,
                Math.abs(primary.wheels[wheel]!.wheelOmegaRadS - repeatRow.wheels[wheel]!.wheelOmegaRadS));
            }
          }
        }
        const result = { physicsVersion: VEHICLE_PHYSICS_VERSION, dtSeconds: 1 / 60, inputPolicy: 'recorded closed-loop HW01 input, then exact open-loop replay',
          materialControl: { authoredRoadFriction: 0.9, syntheticFlatFriction: 0.9, syntheticFlatSurfaceId: collision.surfaceId, eligibilityLabel: 'virtual corridor proxy; not a physical road result' },
          handbrakePolicy: '0.75 for 15 ticks after progress 107m; same consumed frames replayed on both surfaces',
          entry: { progressM: entryProgressM, position: spawn.position, rotation, velocityMS: initialVelocityMS,
            speedMS: 9, flatNormal: { x: 0, y: 1, z: 0 }, authoredRoadNormal: routeNormalAt(entry),
            authoredSlopeRad: Math.acos(clamp(routeNormalAt(entry).y, -1, 1)) },
          repeatability: { maxRoadReplayPositionDeltaM: maxRoadRepeatPositionDeltaM, maxRoadReplayWheelOmegaDeltaRadS: maxRoadRepeatOmegaDeltaRadS,
            maxFlatRepeatPositionDeltaM, maxFlatRepeatWheelOmegaDeltaRadS: maxFlatRepeatOmegaDeltaRadS },
          flat: flatResult, flatRepeat: flatRepeatResult, hw01: roadResult };
        console.info('MATCHED_TERRAIN_DIAGNOSTICS', JSON.stringify(result));
        expect(inputs.length).toBe(240);
        expect(pulseStartTick).toBeGreaterThan(0);
        expect(maxRoadRepeatPositionDeltaM).toBeLessThan(1e-5);
        expect(maxRoadRepeatOmegaDeltaRadS).toBeLessThan(1e-5);
        expect(maxFlatRepeatPositionDeltaM).toBeLessThan(1e-5);
        expect(maxFlatRepeatOmegaDeltaRadS).toBeLessThan(1e-5);
        expect([...roadResult.rows, ...flatResult.rows, ...flatRepeatResult.rows].every(row => {
          const r = row as { state: { position: Vec3; velocityMS: Vec3; betaRad: number }; wheels: readonly Record<string, number | null>[] };
          return [r.state.position.x, r.state.position.y, r.state.position.z, r.state.velocityMS.x, r.state.velocityMS.y,
            r.state.velocityMS.z, r.state.betaRad, ...r.wheels.flatMap(wheel => Object.values(wheel).filter((v): v is number => typeof v === 'number'))].every(Number.isFinite);
        })).toBe(true);
      } finally {
        reference.dispose(); roadReplay.dispose(); flat.dispose(); flatRepeat.dispose();
      }
    }
  }, 90_000);
});
