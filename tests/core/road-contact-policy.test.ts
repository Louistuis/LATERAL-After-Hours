import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { InputFrame, VehicleSnapshot } from '../../contracts/runtime-contracts';
import type { CollisionMeshData, RouteDefinition } from '../../contracts/world-contracts';
import { GameRuntime, type GameScene } from '../../src/core/game-runtime';

const mockState = vi.hoisted(() => ({ tick: 0, z: 2, active: false, roadWheelCount: 4 }));
vi.mock('../../src/physics', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/physics')>();
  const simulation = {
    step() { mockState.tick++; if (mockState.active) mockState.z -= 0.2; },
    snapshot() {
      const wheel = (index: number) => ({ contact: true, position: { x: 0, y: 0, z: mockState.z },
        rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0.1, normalLoadN: 2500,
        angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0,
        surfaceId: index < mockState.roadWheelCount ? 'road:test' : 'obstacle:test' });
      return { simulationTick: mockState.tick, carId: 'CAR-01' as const,
        position: { x: 0, y: 1, z: mockState.z }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        linearVelocityMS: { x: 0, y: 0, z: mockState.active ? -12 : 0 }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
        wheels: [0, 1, 2, 3].map(wheel) as unknown as VehicleSnapshot['wheels'],
        engineRpm: 3000, gear: 2, driftAngleRad: mockState.active ? 0.4 : 0 } satisfies VehicleSnapshot;
    },
    resetToSafePoint() { mockState.z = 2; }, dispose() {}, setCar() {}, setTune() {},
    setSpawn(position: { z: number }) { mockState.z = position.z; }, addStaticTriangleMesh() { return { handle: 1 }; },
    removeCollider() {}, getConfig() { return {} as never; }, getTuning() { return {} as never; },
    getTuneIdentity() { return 'mock-tune-identity'; }, collisionTelemetry() { return { tick: mockState.tick, impact: false, impulseNs: 0, speedDeltaMS: 0, colliderIds: [] }; },
    wheelDynamicsTelemetry() { return { simulationTick: mockState.tick, wheels: [] }; }, snapshots() {
      const snapshot = this.snapshot(); return { previous: snapshot, current: snapshot, interpolationAlpha: 0 };
    },
  };
  return { ...actual, createVehicleSimulation: vi.fn(async () => simulation as unknown as Awaited<ReturnType<typeof actual.createVehicleSimulation>>) };
});

const route: RouteDefinition = {
  id: 'HW-01', name: 'contact-policy', district: 'harbor', version: 'test-v1', roadIds: ['road:test'],
  widthM: 8, closed: false, lengthM: 60,
  centerline: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -60 }],
  spawn: { position: { x: 0, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'start', center: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 4 },
    { id: 'finish', center: { x: 0, y: 0, z: -60 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 4, finish: true },
  ],
};

const road: CollisionMeshData = {
  vertices: [{ x: -10, y: 0, z: -70 }, { x: 10, y: 0, z: -70 }, { x: 10, y: 0, z: 10 }, { x: -10, y: 0, z: 10 }],
  indices: [0, 2, 1, 0, 3, 2], surfaceId: 'road:test', drivableRoad: true,
};
// Deliberately contradictory metadata: `role: obstacle` must keep this surface
// out of GameRuntime's road-contact classification even if marked drivable.
const obstacle: CollisionMeshData = {
  vertices: [{ x: 10, y: 0, z: -70 }, { x: 12, y: 0, z: -70 }, { x: 12, y: 2, z: 10 }, { x: 10, y: 2, z: 10 }],
  indices: [0, 1, 2, 0, 2, 3], surfaceId: 'obstacle:test', drivableRoad: true, role: 'obstacle',
};

function scene(): GameScene {
  return {
    renderer: {} as THREE.WebGLRenderer, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    world: { routes: [route], spawn: route.spawn, collisionMeshes: [road, obstacle] },
    render: vi.fn(), resize: vi.fn(), resetCamera: vi.fn(), setLighting: vi.fn(), setQuality: vi.fn(),
    setCar: vi.fn(), setCosmetics: vi.fn(), setRoute: vi.fn(), setGhost: vi.fn(), dispose: vi.fn(),
  };
}

describe('GameRuntime mixed-surface drift road-contact policy', () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let frameId: number;
  let now: number;
  let runtime: GameRuntime | undefined;
  beforeEach(() => {
    mockState.tick = 0; mockState.z = 2; mockState.active = false; mockState.roadWheelCount = 4;
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    callbacks = new Map(); frameId = 0; now = performance.now();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
  });
  afterEach(() => { runtime?.dispose(); runtime = undefined; vi.unstubAllGlobals(); });

  async function startWithRoadContactCount(roadWheelCount: number): Promise<GameRuntime> {
    mockState.roadWheelCount = roadWheelCount;
    const input = { read: (simulationTick: number): InputFrame => ({
      simulationTick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false,
    }), clear: vi.fn() };
    const game = await GameRuntime.create(scene(), input);
    runtime = game;
    game.beginEvent({ mode: 'drift-attack', rulesVersion: 'road-contact-test-v1' });
    game.start();
    advance(182);
    expect(game.view().run?.state).toBe('ACTIVE');
    mockState.active = true;
    advance(20);
    return game;
  }

  function advance(frames: number, intervalMs = 1000 / 60): void {
    for (let index = 0; index < frames; index++) {
      now += intervalMs;
      const pending = [...callbacks.values()]; callbacks.clear();
      for (const callback of pending) callback(now);
    }
  }

  it.each([1, 2])('does not score drift when only %i wheel(s) contact drivable road and the rest contact obstacles', async roadWheelCount => {
    const game = await startWithRoadContactCount(roadWheelCount);
    expect(game.view().frame.score.validDrift).toBe(false);
    expect(game.view().frame.score.unbanked).toBe(0);
    expect(game.view().run?.invalidReason).toBeNull();
  });

  it.each([3, 4])('keeps the legal scoring case eligible with %i road wheel contacts', async roadWheelCount => {
    const game = await startWithRoadContactCount(roadWheelCount);
    expect(game.view().frame.score.validDrift).toBe(true);
    expect(game.view().frame.score.unbanked).toBeGreaterThan(0);
    expect(game.view().frame.current.driftAngleRad).toBe(0.4);
    expect(Math.hypot(game.view().frame.current.linearVelocityMS.x, game.view().frame.current.linearVelocityMS.z)).toBe(12);
  });
});
