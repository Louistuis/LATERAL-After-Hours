import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FrameSnapshot, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import { createTireEffects } from '../../src/vfx';
import type { VisualVehicleState } from '../../src/scene-pipeline/interpolate';

function makeWheel(x: number, z: number, options: Partial<WheelSnapshot> = {}): WheelSnapshot {
  return {
    contact: true,
    position: { x, y: 0.31, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    compressionM: 0.08,
    normalLoadN: 2800,
    angularVelocityRadS: 0,
    slipRatio: 0,
    slipAngleRad: 0,
    surfaceId: 'asphalt',
    ...options,
  };
}

function makeSnapshot(tick: number, rearLeft: WheelSnapshot, rearRight: WheelSnapshot): VehicleSnapshot {
  return {
    simulationTick: tick,
    carId: 'CAR-01',
    position: { x: 0, y: 0.7, z: -tick / 60 * 8 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocityMS: { x: 0, y: 0, z: -8 },
    angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [
      makeWheel(-0.78, 0.9), makeWheel(0.78, 0.9), rearLeft, rearRight,
    ],
    engineRpm: 3000,
    gear: 2,
    driftAngleRad: 0.2,
  };
}

function makeVisual(snapshot: VehicleSnapshot): VisualVehicleState {
  return {
    position: new THREE.Vector3(snapshot.position.x, snapshot.position.y, snapshot.position.z),
    rotation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, -8),
    wheels: snapshot.wheels.map((wheel) => ({
      position: new THREE.Vector3(wheel.position.x, wheel.position.y, wheel.position.z),
      rotation: new THREE.Quaternion(),
      source: wheel,
    })),
    source: snapshot,
  } as VisualVehicleState;
}

function makeFrame(snapshot: VehicleSnapshot): FrameSnapshot {
  return {
    previous: snapshot,
    current: snapshot,
    interpolationAlpha: 1,
    score: { banked: 0, unbanked: 0, multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: 0 },
  };
}

describe('pooled tire effects', () => {
  it('emits only from an individually contacting and slipping rear tire', () => {
    const scene = new THREE.Scene();
    const effects = createTireEffects(scene, 'low');
    try {
      for (let tick = 1; tick <= 24; tick++) {
        const snapshot = makeSnapshot(tick,
          makeWheel(-0.78, -0.3, { slipAngleRad: 0.34, slipRatio: 0.32 }),
          makeWheel(0.78, -0.3, { slipAngleRad: 0, slipRatio: 0 }));
        effects.update(makeFrame(snapshot), makeVisual(snapshot), 1 / 60, true);
      }
      const stats = effects.stats();
      expect(stats.visibleSmoke).toBeGreaterThan(0);
      expect(stats.visibleSmoke).toBeLessThanOrEqual(100);
      const smoke = scene.children.find((child) => child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) as THREE.Mesh;
      const positions = smoke.geometry.getAttribute('position');
      for (let i = 0; i < smoke.geometry.drawRange.count; i++) expect(positions.getX(i)).toBeLessThan(0);

      const airborne = makeSnapshot(25,
        makeWheel(-0.78, -0.3, { contact: false, normalLoadN: 0, slipAngleRad: 0.4 }),
        makeWheel(0.78, -0.3, { contact: false, normalLoadN: 0, slipAngleRad: 0.4 }));
      effects.reset();
      expect(smoke.geometry.drawRange.count).toBe(0);
      for (let tick = 25; tick < 40; tick++) {
        const frame = makeSnapshot(tick,
          airborne.wheels[2], airborne.wheels[3]);
        effects.update(makeFrame(frame), makeVisual(frame), 1 / 60, true);
      }
      expect(effects.stats().visibleSmoke).toBe(0);
    } finally { effects.dispose(); }
  });

  it('suppresses smoke for loaded tires with only small road-following slip', () => {
    const scene = new THREE.Scene();
    const effects = createTireEffects(scene, 'balanced');
    try {
      for (let tick = 1; tick <= 60; tick++) {
        const snapshot = makeSnapshot(tick,
          makeWheel(-0.78, -tick / 60, { slipAngleRad: -0.02, slipRatio: 0.08 }),
          makeWheel(0.78, -tick / 60, { slipAngleRad: -0.01, slipRatio: 0.06 }));
        effects.update(makeFrame(snapshot), makeVisual(snapshot), 1 / 60, true);
      }
      expect(effects.stats().visibleSmoke).toBe(0);
    } finally { effects.dispose(); }
  });

  it('keeps trails within the selected budget and clears them on reset and quality change', () => {
    const scene = new THREE.Scene();
    const effects = createTireEffects(scene, 'low');
    try {
      for (let tick = 1; tick <= 60; tick++) {
        const z = -tick / 60 * 8;
        const snapshot = makeSnapshot(tick,
          makeWheel(-0.78, z, { slipAngleRad: 0.3 }),
          makeWheel(0.78, z, { slipAngleRad: 0.3 }));
        effects.update(makeFrame(snapshot), makeVisual(snapshot), 1 / 60, true);
      }
      expect(effects.stats().activeSkidSegments).toBeGreaterThan(0);
      expect(effects.stats().activeSkidSegments).toBeLessThanOrEqual(144);
      effects.setQuality('high');
      expect(effects.stats()).toEqual({ visibleSmoke: 0, activeSkidSegments: 0 });
      for (let tick = 61; tick <= 180; tick++) {
        const snapshot = makeSnapshot(tick,
          makeWheel(-0.78, -tick / 60 * 8, { slipAngleRad: 0.3 }),
          makeWheel(0.78, -tick / 60 * 8, { slipAngleRad: 0.3 }));
        effects.update(makeFrame(snapshot), makeVisual(snapshot), 1 / 60, true);
      }
      expect(effects.stats().activeSkidSegments).toBeLessThanOrEqual(768);
      effects.reset();
      expect(effects.stats()).toEqual({ visibleSmoke: 0, activeSkidSegments: 0 });
    } finally { effects.dispose(); }
  });

  it('freezes effect aging and emission when simulation is inactive', () => {
    const scene = new THREE.Scene();
    const effects = createTireEffects(scene, 'balanced');
    try {
      for (let tick = 1; tick <= 30; tick++) {
        const snapshot = makeSnapshot(tick,
          makeWheel(-0.78, 0, { slipAngleRad: 0.35 }),
          makeWheel(0.78, 0, { slipAngleRad: 0.35 }));
        effects.update(makeFrame(snapshot), makeVisual(snapshot), 1 / 60, false);
      }
      expect(effects.stats()).toEqual({ visibleSmoke: 0, activeSkidSegments: 0 });
    } finally { effects.dispose(); }
  });
});
