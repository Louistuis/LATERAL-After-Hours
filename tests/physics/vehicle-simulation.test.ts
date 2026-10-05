import { afterEach, describe, expect, it } from 'vitest';
import type { InputFrame } from '../../contracts/runtime-contracts';
import { createVehicleSimulation } from '../../src/physics';
import type { VehicleSimulationHandle } from '../../src/physics';

const simulations: VehicleSimulationHandle[] = [];
async function make(options: Parameters<typeof createVehicleSimulation>[0] = {}) {
  const sim = await createVehicleSimulation(options);
  simulations.push(sim);
  return sim;
}
function frame(tick: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { simulationTick: tick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false, ...patch };
}
function run(sim: VehicleSimulationHandle, n: number, patch: Partial<InputFrame> = {}, start = sim.snapshot().simulationTick) {
  for (let i = 1; i <= n; i++) sim.step(frame(start + i, patch));
  return sim.snapshot();
}
function planarSpeed(sim: VehicleSimulationHandle) {
  const v = sim.snapshot().linearVelocityMS;
  return Math.hypot(v.x, v.z);
}

afterEach(() => {
  for (const sim of simulations.splice(0)) sim.dispose();
});

describe('Rapier vehicle simulation', () => {
  it('settles onto four suspension rays, remains finite, and detects lost contact', async () => {
    const sim = await make();
    run(sim, 180);
    let state = sim.snapshot();
    expect(state.wheels.filter((w) => w.contact)).toHaveLength(4);
    expect(state.position.y).toBeGreaterThan(0.25);
    expect(state.wheels.every((w) => Number.isFinite(w.normalLoadN) && w.normalLoadN >= 0)).toBe(true);
    sim.setSpawn({ x: 0, y: 12, z: 0 });
    state = run(sim, 2);
    expect(state.wheels.every((w) => !w.contact)).toBe(true);
  });

  it('seeds a matched forward velocity with consistent wheel angular speed', async () => {
    const speedMS = 9;
    const sim = await make({ spawn: { position: { x: 0, y: 0.78, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocityMS: { x: 0, y: 0, z: -speedMS } } });
    const state = sim.snapshot();
    expect(state.linearVelocityMS).toEqual({ x: 0, y: 0, z: -speedMS });
    expect(state.wheels.every(wheel => Math.abs(wheel.angularVelocityRadS - speedMS / sim.getConfig().wheelRadiusM) < 1e-6)).toBe(true);
  });

  it('accelerates, brakes, shifts into reverse, and steers right with positive input', async () => {
    const sim = await make();
    run(sim, 30);
    const accelerating = run(sim, 180, { throttle: 0.8 });
    const forwardSpeed = planarSpeed(sim);
    expect(forwardSpeed).toBeGreaterThan(4);
    expect(accelerating.linearVelocityMS.z).toBeLessThan(0);
    run(sim, 90, { brake: 1 });
    expect(planarSpeed(sim)).toBeLessThan(forwardSpeed);
    sim.step(frame(sim.snapshot().simulationTick + 1, { shift: -1 }));
    const reverse = run(sim, 150, { throttle: 0.65 });
    expect(reverse.gear).toBe(-1);
    expect(reverse.linearVelocityMS.z).toBeGreaterThan(0.5);
    sim.resetToSafePoint();
    run(sim, 30);
    const turning = run(sim, 150, { throttle: 0.75, steering: 1 });
    expect(turning.position.x).toBeGreaterThan(0.2);
  });

  it('refuses a forward-to-reverse shift until the chassis is nearly stopped', async () => {
    const sim = await make();
    run(sim, 30);
    run(sim, 65, { throttle: 0.8 });
    expect(planarSpeed(sim)).toBeGreaterThan(1.5);
    sim.step(frame(sim.snapshot().simulationTick + 1, { shift: -1 }));
    expect(sim.snapshot().gear).toBeGreaterThan(0);
    // Brake plus handbrake parks the car: brake-to-reverse stays out, so only the manual shift engages reverse.
    run(sim, 180, { brake: 1, handbrake: 1 });
    expect(planarSpeed(sim)).toBeLessThan(1.5);
    expect(sim.snapshot().gear).toBeGreaterThan(0);
    sim.step(frame(sim.snapshot().simulationTick + 1, { shift: -1 }));
    expect(sim.snapshot().gear).toBe(-1);
  });

  it('handbrake increases rear slip and wall impacts report contact impulse', async () => {
    const sim = await make({ tune: 'Drift' });
    const control = await make({ tune: 'Drift' });
    const wall = sim.addColliderBox({ center: { x: 0, y: 0.9, z: -4 }, halfExtents: { x: 3, y: 1, z: 0.3 }, category: 'wall', surfaceId: 'test-wall', restitution: 0.15 });
    // Walls are low-friction and non-bouncy (they deflect rather than grip), so a car resting against one
    // while pushing is contact, not a fresh impact each tick: check that the strike itself was reported.
    let impactReported = false;
    for (let i = 0; i < 180; i++) { run(sim, 1, { throttle: 1 }); impactReported ||= sim.collisionTelemetry().impact; }
    const wallRun = sim.snapshot();
    expect(wallRun.position.z).toBeGreaterThan(-5.5);
    expect(impactReported).toBe(true);
    expect(sim.collisionTelemetry().colliderIds).toContain('test-wall');
    expect(sim.collisionTelemetry().impulseNs).toBeGreaterThan(0);

    sim.removeCollider(wall);
    sim.setSpawn({ x: 0, y: 0.78, z: 0 });
    control.setSpawn({ x: 0, y: 0.78, z: 0 });
    run(sim, 30); run(control, 30);
    run(sim, 150, { throttle: 0.9, steering: 0.65 });
    run(control, 150, { throttle: 0.9, steering: 0.65 });
    run(sim, 45, { throttle: 0.9, steering: 0.65, handbrake: 1 });
    run(control, 45, { throttle: 0.9, steering: 0.65 });
    expect(planarSpeed(sim)).toBeLessThan(planarSpeed(control));
    expect(Math.abs(sim.snapshot().wheels[2].angularVelocityRadS)).toBeLessThan(Math.abs(control.snapshot().wheels[2].angularVelocityRadS));
    expect(Math.abs(sim.snapshot().wheels[2].slipAngleRad - control.snapshot().wheels[2].slipAngleRad)).toBeGreaterThan(0.03);
  });

  it('uses fixed steps regardless of render grouping and keeps every reported value finite', async () => {
    const a = await make();
    const b = await make();
    for (let i = 1; i <= 240; i++) a.step(frame(i, { throttle: 0.7, steering: 0.3 }));
    for (let group = 0; group < 40; group++) for (let j = 1; j <= 6; j++) b.step(frame(group * 6 + j, { throttle: 0.7, steering: 0.3 }));
    expect(a.snapshot().position).toEqual(b.snapshot().position);
    expect(a.snapshot().rotation).toEqual(b.snapshot().rotation);
    const s = a.snapshot();
    const values = [...Object.values(s.position), ...Object.values(s.rotation), ...Object.values(s.linearVelocityMS), ...Object.values(s.angularVelocityRadS), s.engineRpm, s.driftAngleRad, ...s.wheels.flatMap((w) => [w.compressionM, w.normalLoadN, w.angularVelocityRadS, w.slipRatio, w.slipAngleRad])];
    expect(values.every(Number.isFinite)).toBe(true);
  });

  it('automatically upshifts under power and loses speed to rolling and aerodynamic drag while coasting', async () => {
    const sim = await make({ carId: 'CAR-02' });
    const powered = run(sim, 360, { throttle: 1 });
    expect(powered.gear).toBeGreaterThan(1);
    const poweredSpeed = planarSpeed(sim);
    run(sim, 180);
    expect(planarSpeed(sim)).toBeLessThan(poweredSpeed);
  });

  it('raycasts against configurable static triangle road meshes', async () => {
    const sim = await make({ ground: false });
    sim.addStaticTriangleMesh(
      [{ x: -20, y: 0, z: -20 }, { x: 20, y: 0, z: -20 }, { x: 20, y: 0, z: 20 }, { x: -20, y: 0, z: 20 }],
      [0, 1, 2, 0, 2, 3], 'mesh-asphalt', 1,
    );
    const state = run(sim, 180);
    expect(state.wheels.every((w) => w.contact)).toBe(true);
    expect(state.wheels.every((w) => w.surfaceId === 'mesh-asphalt')).toBe(true);
  });

  it('classifies authored obstacle triangle meshes as impacts while surfaces remain tire ground', async () => {
    const sim = await make();
    sim.addStaticTriangleMesh(
      [{ x: -4, y: 0, z: -6.8 }, { x: 4, y: 0, z: -6.8 }, { x: 4, y: 3, z: -6.8 }, { x: -4, y: 3, z: -6.8 },
        { x: -4, y: 0, z: -7.2 }, { x: 4, y: 0, z: -7.2 }, { x: 4, y: 3, z: -7.2 }, { x: -4, y: 3, z: -7.2 }],
      [0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2], 'tri-wall:hw01', 0.8, 'obstacle',
    );
    let telemetry = sim.collisionTelemetry();
    for (let i = 0; i < 180 && !telemetry.impact; i++) {
      run(sim, 1, { throttle: 1 });
      telemetry = sim.collisionTelemetry();
    }
    const state = sim.snapshot();
    const row = { position: state.position, speed: planarSpeed(sim), speedDeltaMS: telemetry.speedDeltaMS, impulseNs: telemetry.impulseNs,
      colliderIds: telemetry.colliderIds, roadWheels: state.wheels.filter((wheel) => wheel.contact && wheel.surfaceId === 'asphalt').length,
      obstacleWheelContacts: state.wheels.filter((wheel) => wheel.contact && wheel.surfaceId === 'tri-wall:hw01').length };
    console.info('TRIANGLE_OBSTACLE_IMPACT', JSON.stringify(row));
    expect(telemetry.impact).toBe(true);
    expect(telemetry.colliderIds).toContain('tri-wall:hw01');
    expect(telemetry.impulseNs).toBeGreaterThan(0);
    expect(telemetry.speedDeltaMS).toBeGreaterThan(0.1);
    expect(row.roadWheels).toBeGreaterThanOrEqual(3);
    expect(row.obstacleWheelContacts).toBe(0);

    const singleImpactSpeedDelta = telemetry.speedDeltaMS;
    const duplicateSim = await make();
    const wallVertices = [
      { x: -4, y: 0, z: -6.8 }, { x: 4, y: 0, z: -6.8 }, { x: 4, y: 3, z: -6.8 }, { x: -4, y: 3, z: -6.8 },
      { x: -4, y: 0, z: -7.2 }, { x: 4, y: 0, z: -7.2 }, { x: 4, y: 3, z: -7.2 }, { x: -4, y: 3, z: -7.2 },
    ];
    const wallIndices = [0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2];
    duplicateSim.addStaticTriangleMesh(wallVertices, wallIndices, 'tri-wall:duplicate-a', 0.8, 'obstacle');
    duplicateSim.addStaticTriangleMesh(wallVertices, wallIndices, 'tri-wall:duplicate-b', 0.8, 'obstacle');
    let duplicateImpact = duplicateSim.collisionTelemetry();
    for (let i = 0; i < 180 && !duplicateImpact.impact; i++) {
      run(duplicateSim, 1, { throttle: 1 });
      duplicateImpact = duplicateSim.collisionTelemetry();
    }
    console.info('DUPLICATE_TRIANGLE_OBSTACLE_IMPACT', JSON.stringify(duplicateImpact));
    expect(duplicateImpact.impact).toBe(true);
    expect(duplicateImpact.colliderIds).toContain('tri-wall:duplicate-a');
    expect(duplicateImpact.colliderIds).toContain('tri-wall:duplicate-b');
    expect(duplicateImpact.speedDeltaMS).toBeLessThan(singleImpactSpeedDelta * 1.5);

    const boxOnly = await make();
    boxOnly.addColliderBox({ center: { x: 0, y: 0.9, z: -7 }, halfExtents: { x: 4, y: 1, z: 0.2 }, category: 'wall', surfaceId: 'mixed:box' });
    let boxImpact = boxOnly.collisionTelemetry();
    for (let i = 0; i < 180 && !boxImpact.impact; i++) {
      run(boxOnly, 1, { throttle: 1 });
      boxImpact = boxOnly.collisionTelemetry();
    }
    const mixedSim = await make();
    mixedSim.addColliderBox({ center: { x: 0, y: 0.9, z: -7 }, halfExtents: { x: 4, y: 1, z: 0.2 }, category: 'wall', surfaceId: 'mixed:box' });
    mixedSim.addStaticTriangleMesh(wallVertices, wallIndices, 'mixed:triangle', 0.8, 'obstacle');
    let mixedImpact = mixedSim.collisionTelemetry();
    for (let i = 0; i < 180 && !mixedImpact.impact; i++) {
      run(mixedSim, 1, { throttle: 1 });
      mixedImpact = mixedSim.collisionTelemetry();
    }
    console.info('MIXED_TRIANGLE_BOX_OBSTACLE_IMPACT', JSON.stringify({ boxOnly: boxImpact, mixed: mixedImpact }));
    expect(boxImpact.impact).toBe(true);
    expect(mixedImpact.impact).toBe(true);
    expect(mixedImpact.colliderIds).toContain('mixed:box');
    expect(mixedImpact.colliderIds).toContain('mixed:triangle');
    expect(mixedImpact.speedDeltaMS).toBeLessThan(boxImpact.speedDeltaMS * 1.5);

    const glancingSim = await make();
    const normal = { x: Math.sin(Math.PI / 3), y: 0, z: Math.cos(Math.PI / 3) };
    const tangent = { x: normal.z, y: 0, z: -normal.x };
    const center = { x: 0, y: 1.5, z: -7 };
    const offset = (a: number, b: number) => ({ x: center.x + tangent.x * a + normal.x * b,
      y: center.y, z: center.z + tangent.z * a + normal.z * b });
    const lowerLeft = offset(-5, -0.2), lowerRight = offset(5, -0.2), upperRight = offset(5, 0.2), upperLeft = offset(-5, 0.2);
    const glancingVertices = [
      { x: lowerLeft.x, y: 0, z: lowerLeft.z }, { x: lowerRight.x, y: 0, z: lowerRight.z },
      { x: lowerRight.x, y: 3, z: lowerRight.z }, { x: lowerLeft.x, y: 3, z: lowerLeft.z },
      { x: upperLeft.x, y: 0, z: upperLeft.z }, { x: upperRight.x, y: 0, z: upperRight.z },
      { x: upperRight.x, y: 3, z: upperRight.z }, { x: upperLeft.x, y: 3, z: upperLeft.z },
    ];
    glancingSim.addStaticTriangleMesh(glancingVertices, wallIndices, 'tri-wall:glancing', 0.8, 'obstacle');
    let glancingImpact = glancingSim.collisionTelemetry();
    for (let i = 0; i < 240 && !glancingImpact.impact; i++) {
      run(glancingSim, 1, { throttle: 1 });
      glancingImpact = glancingSim.collisionTelemetry();
    }
    console.info('GLANCING_TRIANGLE_OBSTACLE_IMPACT', JSON.stringify(glancingImpact));
    expect(glancingImpact.impact).toBe(true);
    expect(glancingImpact.colliderIds).toContain('tri-wall:glancing');
    expect(glancingImpact.speedDeltaMS).toBeGreaterThan(0.1);
    expect(glancingImpact.speedDeltaMS).toBeLessThan(singleImpactSpeedDelta);
  });

  it('exposes a versioned lossless tune identity and rejects out-of-bounds custom values', async () => {
    const sim = await make({ carId: 'CAR-01', tune: 'Drift' });
    const presetIdentity = sim.getTuneIdentity();
    const presetCopy = sim.getTuning();
    expect(presetIdentity).toContain('lateral-tune-identity-v2:');
    expect(presetIdentity).toContain('lateral-force-60hz-v6');
    expect(presetCopy.rearDiffLock).toBe(0);
    expect(presetCopy.frontBrakeBias).toBe(0.5);
    expect(presetIdentity).toContain('"carId":"CAR-01"');
    expect(Object.isFrozen(presetCopy)).toBe(true);
    sim.setTune({ id: 'Custom', frontMuScale: 1.1, rearMuScale: 0.98, springScale: 1, steeringScale: 1, engineScale: 0.96, handbrakeRearMuScale: 0.3 });
    expect(sim.getTuneIdentity()).not.toBe(presetIdentity);
    expect(sim.getTuning().id).toBe('Custom');
    expect(() => sim.setTune({ id: 'Custom', frontMuScale: 1.1, rearMuScale: 0.98, springScale: 1, steeringScale: 1, engineScale: 1.4, handbrakeRearMuScale: 0.3 })).toThrow(RangeError);
    expect(() => sim.setTune({ id: 'Custom', frontMuScale: 1.1, rearMuScale: 0.98, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: 0.3, rearDiffLock: 1.01, frontBrakeBias: 0.62 })).toThrow(RangeError);
    expect(() => sim.setTune({ id: 'Custom', frontMuScale: 1.1, rearMuScale: 0.98, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: 0.3, rearDiffLock: 0.1, frontBrakeBias: Number.NaN })).toThrow(RangeError);
  });

  it('applies bounded custom steering, rear differential and front brake bias', async () => {
    const steeringLow = await make({ carId: 'CAR-01' });
    const steeringHigh = await make({ carId: 'CAR-01' });
    const withTune = (sim: VehicleSimulationHandle, values: { steeringScale?: number; rearDiffLock?: number; frontBrakeBias?: number }) => {
      sim.setTune({ ...sim.getTuning(), id: 'Custom', ...values });
    };
    withTune(steeringLow, { steeringScale: 0.75 });
    withTune(steeringHigh, { steeringScale: 1.3 });
    run(steeringLow, 30); run(steeringHigh, 30);
    run(steeringLow, 150, { throttle: 0.75, steering: 0.55 });
    run(steeringHigh, 150, { throttle: 0.75, steering: 0.55 });
    const lowSteerYaw = Math.abs(steeringLow.snapshot().angularVelocityRadS.y);
    const highSteerYaw = Math.abs(steeringHigh.snapshot().angularVelocityRadS.y);
    expect(highSteerYaw).toBeGreaterThan(lowSteerYaw * 1.2);

    const makeSplitGripRoad = (sim: VehicleSimulationHandle) => {
      sim.addStaticTriangleMesh([{ x: -20, y: 0, z: -100 }, { x: 0, y: 0, z: -100 }, { x: 0, y: 0, z: 100 }, { x: -20, y: 0, z: 100 }],
        [0, 2, 1, 0, 3, 2], 'low-grip-left', 0.2);
      sim.addStaticTriangleMesh([{ x: 0, y: 0, z: -100 }, { x: 20, y: 0, z: -100 }, { x: 20, y: 0, z: 100 }, { x: 0, y: 0, z: 100 }],
        [0, 2, 1, 0, 3, 2], 'high-grip-right', 1);
    };
    const openDiff = await make({ ground: false, carId: 'CAR-01' });
    const lockedDiff = await make({ ground: false, carId: 'CAR-01' });
    makeSplitGripRoad(openDiff); makeSplitGripRoad(lockedDiff);
    withTune(openDiff, { rearDiffLock: 0 });
    withTune(lockedDiff, { rearDiffLock: 1 });
    let openDiffSpinDifference = 0, lockedDiffSpinDifference = 0;
    for (let tick = 1; tick <= 240; tick++) {
      openDiff.step(frame(tick, { throttle: 0.9 }));
      lockedDiff.step(frame(tick, { throttle: 0.9 }));
      const openWheels = openDiff.snapshot().wheels;
      const lockedWheels = lockedDiff.snapshot().wheels;
      openDiffSpinDifference = Math.max(openDiffSpinDifference, Math.abs(Math.abs(openWheels[2]!.angularVelocityRadS) - Math.abs(openWheels[3]!.angularVelocityRadS)));
      lockedDiffSpinDifference = Math.max(lockedDiffSpinDifference, Math.abs(Math.abs(lockedWheels[2]!.angularVelocityRadS) - Math.abs(lockedWheels[3]!.angularVelocityRadS)));
    }
    expect(openDiffSpinDifference).toBeGreaterThan(5);
    expect(lockedDiffSpinDifference).toBeLessThan(openDiffSpinDifference * 0.98);

    const frontBias = await make({ carId: 'CAR-01' });
    const rearBias = await make({ carId: 'CAR-01' });
    withTune(frontBias, { frontBrakeBias: 0.75 });
    withTune(rearBias, { frontBrakeBias: 0.45 });
    run(frontBias, 30); run(rearBias, 30);
    run(frontBias, 180, { throttle: 0.9 }); run(rearBias, 180, { throttle: 0.9 });
    const brakeTrace = (sim: VehicleSimulationHandle) => {
      let firstLockTick: number | null = null;
      let firstLockAxle: 'front' | 'rear' | null = null;
      const startSpeedMS = planarSpeed(sim);
      let speedAfterFirstBrakeTick = startSpeedMS;
      let torqueAtFirstTick: { front: number; rear: number } | null = null;
      let torqueAtFirstLock: { front: number; rear: number } | null = null;
      const preLockBrakeUseRatios: number[] = [];
      const preLockRows: Array<Record<string, number | boolean>> = [];
      for (let i = 1; i <= 60; i++) {
        const before = sim.wheelDynamicsTelemetry().wheels;
        run(sim, 1, { brake: 1 });
        const wheels = sim.wheelDynamicsTelemetry().wheels;
        const frontTorque = wheels[0]!.availableBrakeTorqueNm + wheels[1]!.availableBrakeTorqueNm;
        const rearTorque = wheels[2]!.availableBrakeTorqueNm + wheels[3]!.availableBrakeTorqueNm;
        if (i === 1) {
          speedAfterFirstBrakeTick = planarSpeed(sim);
          torqueAtFirstTick = { front: frontTorque, rear: rearTorque };
        }
        if (firstLockTick === null && wheels.some((wheel) => wheel.brakeLockActive)) {
          firstLockTick = i;
          firstLockAxle = wheels.slice(0, 2).some((wheel) => wheel.brakeLockActive) ? 'front' : 'rear';
          torqueAtFirstLock = { front: frontTorque, rear: rearTorque };
        }
        if (firstLockTick === null) for (let wheelIndex = 0; wheelIndex < wheels.length; wheelIndex++) {
          const wheel = wheels[wheelIndex]!;
          const previousOmega = before[wheelIndex]!.angularVelocityRadS;
          const direction = Math.sign(previousOmega || wheel.driveTorqueNm || wheel.longitudinalVelocityMS);
          if (wheel.brakeLockActive || direction === 0 || previousOmega * wheel.angularVelocityRadS <= 0) continue;
          const brakeUsedSigned = wheel.driveTorqueNm - sim.getConfig().wheelRadiusM * wheel.appliedLongitudinalForceN
            - 1.25 * (wheel.angularVelocityRadS - previousOmega) * 60;
          const ratio = direction * brakeUsedSigned / wheel.availableBrakeTorqueNm;
          preLockBrakeUseRatios.push(ratio);
          preLockRows.push({ tick: i, wheel: wheelIndex, previousOmegaRadS: previousOmega,
            omegaRadS: wheel.angularVelocityRadS, driveTorqueNm: wheel.driveTorqueNm,
            appliedFxN: wheel.appliedLongitudinalForceN, availableBrakeTorqueNm: wheel.availableBrakeTorqueNm,
            brakeUsedSignedNm: brakeUsedSigned, brakeUseRatio: ratio, lock: wheel.brakeLockActive });
        }
      }
      const round = (value: number) => Math.round(value * 1000) / 1000;
      return { startSpeedMS: round(startSpeedMS), endSpeedMS: round(planarSpeed(sim)),
        firstTickDecelerationMS: round((startSpeedMS - speedAfterFirstBrakeTick) * 60),
        firstLockTick, firstLockAxle, torqueAtFirstTick, torqueAtFirstLock,
        preLockBrakeUseRatioMin: Math.min(...preLockBrakeUseRatios),
        preLockBrakeUseRatioMax: Math.max(...preLockBrakeUseRatios), preLockRows };
    };
    const frontBiasBrake = brakeTrace(frontBias);
    const rearBiasBrake = brakeTrace(rearBias);
    console.info('CUSTOM_TUNE_EFFECTS', JSON.stringify({ lowSteerYaw, highSteerYaw, openDiffSpinDifference,
      lockedDiffSpinDifference, frontBiasBrake, rearBiasBrake }));
    expect(Math.abs(frontBiasBrake.startSpeedMS - rearBiasBrake.startSpeedMS)).toBeLessThan(0.01);
    expect(frontBiasBrake.torqueAtFirstTick!.front).toBeCloseTo(4350, 8);
    expect(frontBiasBrake.torqueAtFirstTick!.rear).toBeCloseTo(1450, 8);
    expect(rearBiasBrake.torqueAtFirstTick!.front).toBeCloseTo(2610, 8);
    expect(rearBiasBrake.torqueAtFirstTick!.rear).toBeCloseTo(3190, 8);
    expect(frontBiasBrake.firstLockTick).not.toBeNull();
    expect(rearBiasBrake.firstLockTick).not.toBeNull();
    expect(frontBiasBrake.firstLockAxle).toBe('front');
    expect(rearBiasBrake.firstLockAxle).toBe('rear');
    expect(frontBiasBrake.preLockBrakeUseRatioMin).toBeGreaterThan(0.9);
    expect(rearBiasBrake.preLockBrakeUseRatioMin).toBeGreaterThan(0.9);
    expect(frontBiasBrake.preLockBrakeUseRatioMax).toBeLessThanOrEqual(1 + 1e-6);
    expect(rearBiasBrake.preLockBrakeUseRatioMax).toBeLessThanOrEqual(1 + 1e-6);
    expect(frontBiasBrake.endSpeedMS).toBeLessThan(frontBiasBrake.startSpeedMS);
    expect(rearBiasBrake.endSpeedMS).toBeLessThan(rearBiasBrake.startSpeedMS);
  });

  it('records a throttle initiation and countersteer recovery fixture for every car and preset', async () => {
    const rows: Array<Record<string, string | number | boolean>> = [];
    for (const carId of ['CAR-01', 'CAR-02', 'CAR-04'] as const) for (const tune of ['Grip', 'Balanced', 'Drift'] as const) {
      const sim = await make({ carId, tune });
      run(sim, 45);
      run(sim, 150, { throttle: 0.95 });
      let peakAngle = 0, peakRearSlip = 0, maxSpeed = 0, allFinite = true;
      for (let i = 0; i < 30; i++) {
        sim.step(frame(sim.snapshot().simulationTick + 1, { throttle: 0.95, steering: 0.9 }));
        const state = sim.snapshot();
        peakAngle = Math.max(peakAngle, Math.abs(state.driftAngleRad));
        peakRearSlip = Math.max(peakRearSlip, Math.abs(state.wheels[2].slipAngleRad), Math.abs(state.wheels[3].slipAngleRad));
        maxSpeed = Math.max(maxSpeed, planarSpeed(sim));
        allFinite &&= [state.position.x, state.position.y, state.position.z, state.driftAngleRad, ...Object.values(state.linearVelocityMS)].every(Number.isFinite);
      }
      for (let i = 0; i < 30; i++) {
        sim.step(frame(sim.snapshot().simulationTick + 1, { throttle: 0.6, steering: -0.9 }));
        const state = sim.snapshot();
        allFinite &&= Number.isFinite(state.driftAngleRad) && planarSpeed(sim) < 70;
      }
      const final = sim.snapshot();
      rows.push({ carId, tune, maxSpeedMS: Number(maxSpeed.toFixed(2)), peakDriftAngleRad: Number(peakAngle.toFixed(3)), peakRearSlipAngleRad: Number(peakRearSlip.toFixed(3)), recoveryDriftAngleRad: Number(Math.abs(final.driftAngleRad).toFixed(3)), finalSpeedMS: Number(planarSpeed(sim).toFixed(2)), finiteAndBounded: allFinite });
      expect(allFinite).toBe(true);
      expect(maxSpeed).toBeLessThan(70);
    }
    console.info(`HANDLING_MATRIX ${JSON.stringify(rows)}`);
  });
});

describe('arcade brake-to-reverse', () => {
  // Forward is -Z for the default spawn, so positive z velocity means rolling backwards.
  const forwardSpeed = (sim: VehicleSimulationHandle) => -sim.snapshot().linearVelocityMS.z;

  it.each(['CAR-01', 'CAR-02', 'CAR-04'] as const)('%s reverses when brake is held from a standstill for 2 s', async (carId) => {
    const sim = await make({ carId });
    run(sim, 30);
    expect(sim.snapshot().gear).toBe(1);
    const state = run(sim, 120, { brake: 1 });
    expect(state.gear).toBe(-1);
    expect(forwardSpeed(sim)).toBeLessThan(-2);
    // Reverse is governed to an arcade top speed, not gear 1 at redline.
    run(sim, 300, { brake: 1 });
    expect(forwardSpeed(sim)).toBeGreaterThan(-8.5);
    expect(forwardSpeed(sim)).toBeLessThan(-5);
  });

  it('brakes from speed to a stop before shifting into reverse', async () => {
    const sim = await make();
    run(sim, 30);
    run(sim, 150, { throttle: 0.8 });
    const startSpeed = forwardSpeed(sim);
    expect(startSpeed).toBeGreaterThan(6);
    let tick = sim.snapshot().simulationTick;
    let stoppedTick = -1, reverseTick = -1;
    for (let i = 0; i < 360; i++) {
      sim.step(frame(++tick, { brake: 1 }));
      const s = sim.snapshot();
      if (reverseTick < 0 && s.gear < 0) {
        reverseTick = tick;
        // Reverse only engages once the car has (nearly) stopped.
        expect(Math.abs(forwardSpeed(sim))).toBeLessThan(0.75);
      }
      if (stoppedTick < 0 && forwardSpeed(sim) < 0.75) stoppedTick = tick;
      if (reverseTick < 0) expect(forwardSpeed(sim)).toBeGreaterThan(-0.1);
    }
    expect(stoppedTick).toBeGreaterThan(0);
    expect(reverseTick).toBeGreaterThanOrEqual(stoppedTick);
    expect(sim.snapshot().gear).toBe(-1);
    expect(forwardSpeed(sim)).toBeLessThan(-2);
  });

  it('gas brakes a reversing car, then returns to forward drive', async () => {
    const sim = await make();
    run(sim, 30);
    run(sim, 150, { brake: 1 });
    expect(sim.snapshot().gear).toBe(-1);
    expect(forwardSpeed(sim)).toBeLessThan(-2);
    let tick = sim.snapshot().simulationTick;
    let wasReversing = true;
    for (let i = 0; i < 240; i++) {
      sim.step(frame(++tick, { throttle: 1 }));
      if (sim.snapshot().gear < 0) expect(forwardSpeed(sim)).toBeLessThan(0.1);
      else if (wasReversing) { wasReversing = false; expect(Math.abs(forwardSpeed(sim))).toBeLessThan(0.75); }
    }
    expect(wasReversing).toBe(false);
    expect(sim.snapshot().gear).toBeGreaterThan(0);
    expect(forwardSpeed(sim)).toBeGreaterThan(4);
  });

  it('keeps the car out of reverse while gas or handbrake is also held, or the brake is only tapped', async () => {
    const sim = await make();
    run(sim, 30);
    expect(run(sim, 120, { brake: 1, handbrake: 1 }).gear).toBe(1);
    expect(run(sim, 6, { brake: 1 }).gear).toBe(1);
    run(sim, 30);
    expect(run(sim, 120, { brake: 1, throttle: 1 }).gear).toBeGreaterThan(0);
  });

  it('manual reverse keeps gas as the reverse pedal', async () => {
    const sim = await make();
    run(sim, 30);
    sim.step(frame(sim.snapshot().simulationTick + 1, { shift: -1 }));
    expect(run(sim, 120, { throttle: 0.7 }).gear).toBe(-1);
    expect(forwardSpeed(sim)).toBeLessThan(-2);
  });
});
