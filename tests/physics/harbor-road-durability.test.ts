import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { InputFrame, Quat, Vec3 } from '../../contracts/runtime-contracts.js';
import { buildHarborApronCollision, buildHarborCurbCollisions, buildHarborRoute, buildHarborWaterCollision, sampleHarborRoute } from '../../src/world/route-data.js';
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import { ARC_S_PROFILE, createArcS } from '../../assets-source/3d/arc-s-source.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { createRunController } from '../../src/events/run-controller.js';

const frame = (simulationTick: number, patch: Partial<InputFrame> = {}): InputFrame => ({
  simulationTick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false, ...patch,
});
const yawFromTangent = (tangent: Vec3): Quat => {
  const yaw = Math.atan2(-tangent.x, -tangent.z);
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
};
const tangentAt = (points: THREE.Vector3[], index: number): Vec3 => {
  const delta = points[(index + 1) % points.length]!.clone().sub(points[(index - 1 + points.length) % points.length]!);
  delta.y = 0;
  delta.normalize();
  return { x: delta.x, y: 0, z: delta.z };
};
const rightFromTangent = (tangent: Vec3): Vec3 => ({ x: -tangent.z, y: 0, z: tangent.x });
const add = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x + q.x, y: p.y + q.y, z: p.z + q.z });
const scale = (v: Vec3, n: number): Vec3 => ({ x: v.x * n, y: v.y * n, z: v.z * n });
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

describe('HW-01 authored road physics durability', () => {
  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s maintains suspension/contact across authored elevation samples and triangle seams', async (carId) => {
    const { route, collision } = buildHarborRoute();
    const points = sampleHarborRoute();
    const apron = buildHarborApronCollision();
    const water = buildHarborWaterCollision();
    const curbs = buildHarborCurbCollisions();
    const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
    sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    for (const curb of curbs) sim.addStaticTriangleMesh(curb.vertices, curb.indices, curb.surfaceId);
    sim.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
    sim.addStaticTriangleMesh(water.vertices, water.indices, water.surfaceId);
    const samples = Array.from({ length: 16 }, (_, i) => Math.floor(i * points.length / 16));
    let roadContactSamples = 0;
    let fourContactSamples = 0;
    let minTotalLoadN = Number.POSITIVE_INFINITY;
    let maxTotalLoadN = 0;
    let maxCompressionM = 0;
    const loadsAtSamples: number[] = [];
    try {
      for (const index of samples) {
        const point = points[index]!;
        const tangent = tangentAt(points, index);
        sim.setSpawn({ x: point.x, y: point.y + 0.93, z: point.z }, yawFromTangent(tangent));
        let state = sim.snapshot();
        for (let localTick = 1; localTick <= 48; localTick++) {
          state = (sim.step(frame(state.simulationTick + 1)), sim.snapshot());
          const contacted = state.wheels.filter((wheel) => wheel.contact);
          const roadCount = contacted.filter((wheel) => wheel.surfaceId === collision.surfaceId).length;
          const totalLoad = state.wheels.reduce((sum, wheel) => sum + wheel.normalLoadN, 0);
          if (roadCount > 0) roadContactSamples++;
          if (contacted.length === 4 && roadCount >= 3) fourContactSamples++;
          if (localTick === 48) {
            loadsAtSamples.push(totalLoad);
            minTotalLoadN = Math.min(minTotalLoadN, totalLoad);
            maxTotalLoadN = Math.max(maxTotalLoadN, totalLoad);
          }
          maxCompressionM = Math.max(maxCompressionM, ...state.wheels.map((wheel) => wheel.compressionM));
          const finite = [state.position.x, state.position.y, state.position.z, ...Object.values(state.linearVelocityMS),
            ...state.wheels.flatMap((wheel) => [wheel.normalLoadN, wheel.compressionM, wheel.slipAngleRad, wheel.slipRatio])].every(Number.isFinite);
          expect(finite).toBe(true);
        }
      }
      const state = sim.snapshot();
      const result = {
        carId, roadSurfaceId: collision.surfaceId, samples: samples.length,
        roadContactTicks: roadContactSamples, fourWheelRoadSamples: fourContactSamples,
        finalContacts: state.wheels.filter((wheel) => wheel.contact).length,
        minSampleTotalLoadN: Math.round(minTotalLoadN), maxSampleTotalLoadN: Math.round(maxTotalLoadN),
        maxCompressionM: Number(maxCompressionM.toFixed(3)),
        sampledCenterlineHeightRangeM: Number((Math.max(...samples.map((i) => points[i]!.y)) - Math.min(...samples.map((i) => points[i]!.y))).toFixed(3)),
        sampleLoadsN: loadsAtSamples.map((v) => Math.round(v)),
      };
      console.info('HW01_ROAD_DURABILITY', JSON.stringify(result));
      expect(roadContactSamples).toBeGreaterThan(48 * 12);
      expect(fourContactSamples).toBeGreaterThan(48 * 12);
      expect(minTotalLoadN).toBeGreaterThan(0.55 * sim.getConfig().massKg * 9.81);
      expect(maxTotalLoadN).toBeLessThan(1.8 * sim.getConfig().massKg * 9.81);
      expect(maxCompressionM).toBeLessThanOrEqual(sim.getConfig().suspension.travelM);
      expect(Math.max(...loadsAtSamples) - Math.min(...loadsAtSamples)).toBeGreaterThan(50);
      expect(Math.max(...samples.map((i) => points[i]!.y)) - Math.min(...samples.map((i) => points[i]!.y))).toBeGreaterThan(2);
    } finally {
      sim.dispose();
    }
  });

  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s follows the complete authored road using measured wheel loads', async (carId) => {
    const { route, collision } = buildHarborRoute();
    const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune: 'Balanced' });
    sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    const apron = buildHarborApronCollision();
    sim.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId);
    const curbs = buildHarborCurbCollisions();
    for (const curb of curbs) sim.addStaticTriangleMesh(curb.vertices, curb.indices, curb.surfaceId);
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
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
      eventId: 'HW-01:physics-durability', routeId: route.id, mode: 'time-trial',
      rulesVersion: 'l1-road-fixture-v1', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION,
      carId, tuneHash: sim.getTuneIdentity(), countdownSeconds: 0, checkpoints: route.checkpoints,
    }, () => `l1-road-${carId}`);
    run.startCountdown(); run.activate();
    let progress = tracker.update(sim.snapshot().position);
    const accepted: string[] = [];
    let roadTicks = 0, fourWheelRoadTicks = 0, minRoadWheelContacts = 4;
    let minTotalLoadN = Number.POSITIVE_INFINITY, maxTotalLoadN = 0, maxCompressionM = 0, maxSpeedMS = 0;
    let previousTotalLoadN: number | null = null, maxPerTickLoadDeltaN = 0;
    let finishResult = null;
    try {
      for (let tick = 1; tick <= 6000 && !finishResult; tick++) {
        const previous = sim.snapshot();
        const speed = Math.hypot(previous.linearVelocityMS.x, previous.linearVelocityMS.z);
        const target = pointAt(progress.progressM + Math.max(5, speed * 0.42));
        const q = previous.rotation;
        const forwardX = -2 * (q.x * q.z + q.w * q.y);
        const forwardZ = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const heading = Math.atan2(forwardX, -forwardZ);
        const desired = Math.atan2(target.x - previous.position.x, -(target.z - previous.position.z));
        const input = frame(tick, { throttle: speed < 8 ? 0.72 : 0.08,
          brake: speed > 9.5 ? 0.35 : 0, steering: clamp(wrap(desired - heading) * 1.6, -1, 1) });
        sim.step(input);
        const current = sim.snapshot();
        const gate = run.updateCheckpoints(previous.position, current.position);
        run.tick(1 / 60);
        accepted.push(...gate.acceptedIds);
        if (gate.completed) finishResult = run.finish(0);
        progress = tracker.update(current.position);
        const contacts = current.wheels.filter((wheel) => wheel.contact);
        const roadContactCount = contacts.filter((wheel) => wheel.surfaceId === collision.surfaceId).length;
        const totalLoadN = current.wheels.reduce((sum, wheel) => sum + wheel.normalLoadN, 0);
        if (roadContactCount > 0) roadTicks++;
        if (roadContactCount === 4) fourWheelRoadTicks++;
        if (roadContactCount > 0) {
          minRoadWheelContacts = Math.min(minRoadWheelContacts, roadContactCount);
          minTotalLoadN = Math.min(minTotalLoadN, totalLoadN);
          maxTotalLoadN = Math.max(maxTotalLoadN, totalLoadN);
          maxCompressionM = Math.max(maxCompressionM, ...current.wheels.map((wheel) => wheel.compressionM));
          if (previousTotalLoadN !== null) maxPerTickLoadDeltaN = Math.max(maxPerTickLoadDeltaN, Math.abs(totalLoadN - previousTotalLoadN));
          previousTotalLoadN = totalLoadN;
        }
        maxSpeedMS = Math.max(maxSpeedMS, speed);
        expect([current.position.x, current.position.y, current.position.z, ...Object.values(current.linearVelocityMS),
          ...current.wheels.flatMap((wheel) => [wheel.normalLoadN, wheel.compressionM])].every(Number.isFinite)).toBe(true);
      }
      const result = {
        carId, acceptedGates: accepted, finish: finishResult !== null,
        roadTicks, fourWheelRoadTicks, minRoadWheelContacts, maxSpeedMS: Number(maxSpeedMS.toFixed(2)),
        totalLoadRangeN: [Math.round(minTotalLoadN), Math.round(maxTotalLoadN)],
        maxCompressionM: Number(maxCompressionM.toFixed(3)), maxPerTickLoadDeltaN: Math.round(maxPerTickLoadDeltaN),
        finalPosition: sim.snapshot().position, routeLengthM: Number(route.lengthM.toFixed(2)),
      };
      console.info('HW01_INPUT_DRIVEN_LAP', JSON.stringify(result));
      expect(accepted).toEqual(route.checkpoints.map((checkpoint) => checkpoint.id));
      expect(finishResult).toMatchObject({ valid: true, routeId: 'HW-01' });
      expect(roadTicks).toBeGreaterThan(2500);
      expect(fourWheelRoadTicks).toBeGreaterThan(2000);
      expect(minRoadWheelContacts).toBeGreaterThanOrEqual(3);
      expect(maxTotalLoadN).toBeLessThan(1.8 * sim.getConfig().massKg * 9.81);
      expect(maxCompressionM).toBeLessThanOrEqual(sim.getConfig().suspension.travelM);
    } finally {
      sim.dispose();
    }
  });

  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s lands from a road-relative drop and reset returns to the authored safe spawn', async (carId) => {
    const { route, collision } = buildHarborRoute();
    const spawn = route.spawn;
    const highSpawn = { position: { ...spawn.position, y: spawn.position.y + 10 }, rotation: spawn.rotation };
    const sim = await createVehicleSimulation({ ground: false, spawn: highSpawn, carId });
    sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
    let firstRoadContactTick = -1;
    let maximumImpactImpulse = 0;
      let maximumLoadN = 0;
      let maximumCompressionM = 0;
    const initialY = sim.snapshot().position.y;
    try {
      for (let tick = 1; tick <= 180; tick++) {
        sim.step(frame(tick));
        const state = sim.snapshot();
        if (state.wheels.some((wheel) => wheel.contact && wheel.surfaceId === collision.surfaceId) && firstRoadContactTick < 0) firstRoadContactTick = tick;
        maximumLoadN = Math.max(maximumLoadN, ...state.wheels.map((wheel) => wheel.normalLoadN));
        maximumCompressionM = Math.max(maximumCompressionM, ...state.wheels.map((wheel) => wheel.compressionM));
        maximumImpactImpulse = Math.max(maximumImpactImpulse, sim.collisionTelemetry().impulseNs);
        expect([state.position.x, state.position.y, state.position.z, ...Object.values(state.linearVelocityMS)].every(Number.isFinite)).toBe(true);
      }
      const landed = sim.snapshot();
      const fellMoreThanEightMeters = initialY - landed.position.y > 8;
      console.info('HW01_DROP', JSON.stringify({ carId, firstRoadContactTick, finalContacts: landed.wheels.filter((wheel) => wheel.contact).length,
        maximumLoadN: Math.round(maximumLoadN), maximumCompressionM: Number(maximumCompressionM.toFixed(3)),
        maximumImpactImpulseNs: Math.round(maximumImpactImpulse), finalPosition: landed.position }));
      expect(fellMoreThanEightMeters).toBe(true);
      expect(firstRoadContactTick).toBeGreaterThan(0);
      expect(landed.wheels.filter((wheel) => wheel.contact && wheel.surfaceId === collision.surfaceId).length).toBeGreaterThanOrEqual(3);
      expect(maximumLoadN).toBeLessThanOrEqual(sim.getConfig().suspension.maxForceN);
      expect(maximumCompressionM).toBeLessThanOrEqual(sim.getConfig().suspension.travelM);

      const safePosition = { ...spawn.position };
      sim.setSpawn(safePosition, spawn.rotation);
      const settleStartTick = sim.snapshot().simulationTick;
      for (let tick = settleStartTick + 1; tick <= settleStartTick + 60; tick++) {
        sim.step(frame(tick, { throttle: 0.7 }));
      }
      const beforeResetTick = sim.snapshot().simulationTick;
      sim.step(frame(beforeResetTick + 1, { resetPressed: true }));
      const resetState = sim.snapshot();
      expect(resetState.position.x).toBeCloseTo(safePosition.x, 1);
      expect(resetState.position.z).toBeCloseTo(safePosition.z, 1);
      expect(Math.hypot(resetState.linearVelocityMS.x, resetState.linearVelocityMS.z)).toBeLessThan(0.5);
      expect(resetState.gear).toBe(1);
    } finally {
      sim.dispose();
    }
  });

  it('probes both authored curb bands for all cars and confirms CAR-01 centers track ARC-S sockets', async () => {
    const { collision } = buildHarborRoute();
    const points = sampleHarborRoute();
    const curbs = buildHarborCurbCollisions();
    const chosenIndex = 28;
    const point = points[chosenIndex]!;
    const tangent = tangentAt(points, chosenIndex);
    const right = rightFromTangent(tangent);
    const car = createArcS();
    car.updateMatrixWorld(true);
    const socketPositions = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'].map((name) => {
      const socket = car.getObjectByName(name);
      if (!socket) throw new Error(`ARC-S socket missing: ${name}`);
      return socket.position.clone();
    });
    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const carId of ['CAR-01', 'CAR-02', 'CAR-04'] as const) for (const side of [-1, 1] as const) {
        const offset = 6.4 * side;
        const position = add({ x: point.x, y: point.y + 0.93, z: point.z }, scale(right, offset));
        const sim = await createVehicleSimulation({ ground: false, spawn: { position, rotation: yawFromTangent(tangent) }, carId });
        sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId);
        for (const curb of curbs) sim.addStaticTriangleMesh(curb.vertices, curb.indices, curb.surfaceId);
        try {
          let state = sim.snapshot();
          for (let tick = 1; tick <= 75; tick++) {
            sim.step(frame(tick));
            state = sim.snapshot();
          }
          const localCenters = state.wheels.map((wheel) => new THREE.Vector3(wheel.position.x - state.position.x,
            wheel.position.y - state.position.y, wheel.position.z - state.position.z).applyQuaternion(new THREE.Quaternion(
              -state.rotation.x, -state.rotation.y, -state.rotation.z, state.rotation.w)));
          const expectedSockets = carId === 'CAR-01' ? socketPositions : [
            new THREE.Vector3(-sim.getConfig().trackM / 2, -0.12, -sim.getConfig().wheelbaseM / 2),
            new THREE.Vector3(sim.getConfig().trackM / 2, -0.12, -sim.getConfig().wheelbaseM / 2),
            new THREE.Vector3(-sim.getConfig().trackM / 2, -0.12, sim.getConfig().wheelbaseM / 2),
            new THREE.Vector3(sim.getConfig().trackM / 2, -0.12, sim.getConfig().wheelbaseM / 2),
          ];
          const targetId = `curb:harbor:hw01:${side < 0 ? 'left' : 'right'}`;
          const row = {
            carId, side, targetId, contacts: state.wheels.filter((wheel) => wheel.contact).length,
            targetCurbWheels: state.wheels.filter((wheel) => wheel.contact && wheel.surfaceId === targetId).length,
            roadWheels: state.wheels.filter((wheel) => wheel.contact && wheel.surfaceId === collision.surfaceId).length,
            centerDeltaXYZ: localCenters.map((center, i) => ({
              x: Number((center.x - expectedSockets[i]!.x).toFixed(3)),
              y: Number((center.y - expectedSockets[i]!.y).toFixed(3)),
              z: Number((center.z - expectedSockets[i]!.z).toFixed(3)),
            })),
            loadsN: state.wheels.map((wheel) => Math.round(wheel.normalLoadN)),
            compressionsM: state.wheels.map((wheel) => Number(wheel.compressionM.toFixed(3))),
          };
          rows.push(row);
          expect(row.contacts).toBeGreaterThanOrEqual(3);
          expect(row.targetCurbWheels).toBeGreaterThanOrEqual(1);
          expect(row.roadWheels).toBeGreaterThanOrEqual(1);
          expect(localCenters.every((center, i) => Math.abs(center.x - expectedSockets[i]!.x) < 0.2 && Math.abs(center.z - expectedSockets[i]!.z) < 0.2)).toBe(true);
          if (carId === 'CAR-01') expect(localCenters.every((center, i) => Math.abs((center.y - expectedSockets[i]!.y) - (-sim.getConfig().suspension.restLengthM + state.wheels[i]!.compressionM)) < 0.06)).toBe(true);
          expect(state.wheels.every((wheel) => wheel.normalLoadN >= 0 && wheel.compressionM <= sim.getConfig().suspension.travelM)).toBe(true);
        } finally {
          sim.dispose();
        }
      }
      console.info('HW01_CURB_AND_ARCS_SOCKET', JSON.stringify({ profile: ARC_S_PROFILE, rows }));
    } finally {
      car.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
        }
      });
    }
  });
});

describe('vehicle brake, reverse and manual shift boundaries', () => {
  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s brakes, reaches deliberate low-speed reverse, and shifts only on edges', async (carId) => {
    const sim = await createVehicleSimulation({ carId, tune: 'Balanced' });
    try {
      for (let tick = 1; tick <= 30; tick++) sim.step(frame(tick));
      let tick = 30;
      // Run up to a moderate speed (capped at 20 m/s so the much quicker McLaren brakes from the same kind of speed).
      for (let i = 0; i < 160 && Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z) < 20; i++) sim.step(frame(++tick, { throttle: 0.8 }));
      const speedBeforeBrake = Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z);
      const brakeTrace: Array<Record<string, unknown>> = [];
      const captureBrakeState = (phase: string, appliedBrakeTorqueNmPerWheel: number) => {
        const state = sim.snapshot();
        brakeTrace.push({ phase, tick, gear: state.gear, speedMS: Math.hypot(state.linearVelocityMS.x, state.linearVelocityMS.y, state.linearVelocityMS.z),
          velocityMS: state.linearVelocityMS, wheels: sim.wheelDynamicsTelemetry().wheels.map((wheel, index) => ({ index,
            inputBrakeTorqueNmPerWheel: appliedBrakeTorqueNmPerWheel, driveTorqueNm: wheel.driveTorqueNm,
            availableBrakeTorqueNm: wheel.availableBrakeTorqueNm, brakeLockActive: wheel.brakeLockActive,
            brakeLockRequiredTorqueNm: wheel.brakeLockRequiredTorqueNm, brakeLockForceN: wheel.brakeLockForceN,
            angularVelocityRadS: wheel.angularVelocityRadS,
            slipRatio: wheel.slipRatio, appliedLongitudinalForceN: wheel.appliedLongitudinalForceN,
            frictionCapacityN: wheel.frictionCapacityN, normalLoadN: wheel.normalLoadN })) });
      };
      for (let i = 0; i < 90; i++) {
        sim.step(frame(++tick, { brake: 1 }));
        captureBrakeState('full-service-brake', 1450);
      }
      const speedAfterBrake = Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z);
      expect(speedBeforeBrake).toBeGreaterThan(4);
      expect(speedAfterBrake).toBeLessThan(speedBeforeBrake);

      sim.step(frame(++tick, { shift: -1 }));
      captureBrakeState('brake-released-shift-edge', 0);
      for (let i = 0; i < 12; i++) { sim.step(frame(++tick, { shift: -1 })); captureBrakeState('brake-released-held-shift', 0); }
      if (carId === 'CAR-04') console.info('CAR04_BRAKE_TRANSIENT', JSON.stringify({ startSpeedMS: speedBeforeBrake,
        endOfBrakeSpeedMS: speedAfterBrake, trace: brakeTrace }));
      expect(speedAfterBrake).toBeLessThan(1.5);
      expect(sim.snapshot().gear).toBe(-1);
      expect(sim.snapshot().gear).toBe(-1);
      for (let i = 0; i < 90; i++) sim.step(frame(++tick, { throttle: 0.65, shift: 0 }));
      const reverseSpeed = Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z);
      expect(sim.snapshot().linearVelocityMS.z).toBeGreaterThan(0.5);
      expect(reverseSpeed).toBeGreaterThan(1.5);
      sim.step(frame(++tick, { shift: 1 }));
      expect(sim.snapshot().gear).toBe(-1);
      for (let i = 0; i < 120; i++) sim.step(frame(++tick, { brake: 1, shift: 0 }));
      expect(Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z)).toBeLessThan(1.5);
      sim.step(frame(++tick, { shift: 1 }));
      expect(sim.snapshot().gear).toBe(1);
      for (let i = 0; i < 12; i++) sim.step(frame(++tick, { shift: 1 }));
      expect(sim.snapshot().gear).toBe(1);
      sim.step(frame(++tick, { shift: 0 }));
      for (let i = 0; i < 160; i++) sim.step(frame(++tick, { throttle: 0.8 }));
      expect(Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z)).toBeGreaterThan(1.5);
      const gearBeforeManualUp = sim.snapshot().gear;
      sim.step(frame(++tick, { shift: 1 }));
      const gearAfterManualUp = sim.snapshot().gear;
      expect(gearAfterManualUp).toBeGreaterThanOrEqual(gearBeforeManualUp);
      for (let i = 0; i < 5; i++) sim.step(frame(++tick, { shift: 1 }));
      expect(sim.snapshot().gear - gearBeforeManualUp).toBeLessThanOrEqual(1);
      console.info('BRAKE_REVERSE_SHIFT', JSON.stringify({ carId, speedBeforeBrake, speedAfterBrake, reverseSpeed,
        gearBeforeManualUp, gearAfterManualUp, heldShiftGear: sim.snapshot().gear, finalTick: sim.snapshot().simulationTick }));
    } finally {
      sim.dispose();
    }
  });
});
