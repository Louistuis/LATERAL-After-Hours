import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameSnapshot, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import { createScenePipelineWithAssets } from '../../src/scene-pipeline/composition';
import type { CarPresentation, SceneAssetFactory, WorldPresentation } from '../../src/scene-pipeline/ports';

const stageState = vi.hoisted(() => ({ context: 'ready' as 'ready' | 'lost', stage: null as unknown }));
vi.mock('../../src/scene-pipeline/stage', () => ({
  createRenderStage: () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = { info: { render: { calls: 0 } } } as THREE.WebGLRenderer;
    const stage = {
      scene, camera, renderer,
      contextState: () => stageState.context,
      setLighting: vi.fn(), setQuality: vi.fn(), focusShadows: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
      render: vi.fn(() => {
        let calls = 0;
        scene.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          node.onBeforeRender(renderer, scene, camera, node.geometry, node.material as THREE.Material, new THREE.Group());
          calls++;
        });
        renderer.info.render.calls = calls;
        return { drawCallsAllPasses: calls, trianglesAllPasses: 0, geometries: 0, textures: 0,
          quality: 'balanced', lighting: 'golden-hour', contextState: stageState.context };
      }),
    };
    stageState.stage = stage;
    return stage;
  },
}));

function model(): CarPresentation {
  const body = new THREE.Group();
  body.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  return {
    body, wheels: [new THREE.Group(), new THREE.Group(), new THREE.Group(), new THREE.Group()],
    setCosmetics: vi.fn(), dispose: vi.fn(),
  };
}

function frame(): FrameSnapshot {
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  const wheel: WheelSnapshot = { contact: true, position: { x: 0, y: 0, z: 0 }, rotation,
    compressionM: 0, normalLoadN: 1000, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0,
    surfaceId: 'road:harbor:hw01' };
  const car: VehicleSnapshot = { simulationTick: 1, carId: 'CAR-01', position: { x: 0, y: 0, z: 0 }, rotation,
    linearVelocityMS: { x: 0, y: 0, z: 0 }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [wheel, wheel, wheel, wheel], engineRpm: 900, gear: 1, driftAngleRad: 0 };
  return { previous: car, current: car, interpolationAlpha: 0, score: { banked: 0, unbanked: 0,
    multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: 0 } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  stageState.context = 'ready';
  stageState.stage = null;
});

describe('owner-review scene pass census seam', () => {
  it('samples one ordinary render and clears on context loss and car replacement', async () => {
    vi.stubGlobal('__OWNER_REVIEW__', true);
    const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 450 }) as HTMLCanvasElement;
    const worldRoot = new THREE.Group();
    worldRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const world: WorldPresentation = { root: worldRoot, routes: [], collisionMeshes: [],
      spawn: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, dispose: vi.fn() };
    const assets: SceneAssetFactory = { loadHeroWorld: async () => world, loadCarModel: async () => model() };
    const pipeline = await createScenePipelineWithAssets(canvas, assets);
    const liveStage = stageState.stage as { render: ReturnType<typeof vi.fn> };

    pipeline.render(frame(), 1 / 60);
    expect(pipeline.lastPassCensus).toBeNull();
    pipeline.requestPassCensus();
    pipeline.render(frame(), 1 / 60);
    expect(pipeline.lastPassCensus?.main.staticWorld.submissions).toBe(1);
    expect(pipeline.lastPassCensus?.main.car.submissions).toBe(1);
    expect(pipeline.lastPassCensus?.callbackAggregateDelta).toBe(0);
    expect(liveStage.render).toHaveBeenCalledTimes(2);
    pipeline.render(frame(), 1 / 60);
    expect(liveStage.render).toHaveBeenCalledTimes(3);
    expect(pipeline.lastPassCensus?.main.car.submissions).toBe(1);

    pipeline.requestPassCensus();
    stageState.context = 'lost';
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(pipeline.lastPassCensus).toBeNull();
    stageState.context = 'ready';
    await pipeline.setCar('CAR-02');
    pipeline.requestPassCensus();
    pipeline.render(frame(), 1 / 60);
    expect(pipeline.lastPassCensus?.main.car.submissions).toBe(1);
    expect(pipeline.lastPassCensus?.main.staticWorld.submissions).toBe(1);

    pipeline.requestPassCensus();
    liveStage.render.mockImplementationOnce(() => {
      stageState.context = 'lost';
      canvas.dispatchEvent(new Event('webglcontextlost'));
      return { drawCallsAllPasses: 0, trianglesAllPasses: 0, geometries: 0, textures: 0,
        quality: 'balanced', lighting: 'golden-hour', contextState: 'lost' };
    });
    pipeline.render(frame(), 1 / 60);
    expect(pipeline.lastPassCensus).toBeNull();
    pipeline.dispose();
    expect(pipeline.lastPassCensus).toBeNull();
  });

  it('never arms a capture in a non-owner build', async () => {
    vi.stubGlobal('__OWNER_REVIEW__', false);
    const world: WorldPresentation = { root: new THREE.Group(), routes: [], collisionMeshes: [],
      spawn: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, dispose: vi.fn() };
    const pipeline = await createScenePipelineWithAssets({ clientWidth: 800, clientHeight: 450 } as HTMLCanvasElement,
      { loadHeroWorld: async () => world, loadCarModel: async () => model() });
    pipeline.requestPassCensus();
    pipeline.render(frame(), 1 / 60);
    expect(pipeline.lastPassCensus).toBeNull();
    pipeline.dispose();
  });
});
