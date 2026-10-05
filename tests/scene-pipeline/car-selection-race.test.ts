import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createScenePipelineWithAssets } from '../../src/scene-pipeline/composition';
import type { CarPresentation, SceneAssetFactory, WorldPresentation } from '../../src/scene-pipeline/ports';

const stageState = vi.hoisted(() => ({ current: 'ready' as 'ready' | 'lost' | 'failed' }));
vi.mock('../../src/scene-pipeline/stage', () => ({
  createRenderStage: () => ({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: {},
    contextState: () => stageState.current,
    setLighting: vi.fn(), setQuality: vi.fn(), focusShadows: vi.fn(), resize: vi.fn(),
    render: vi.fn(() => ({ drawCallsAllPasses: 0, trianglesAllPasses: 0, geometries: 0, textures: 0,
      quality: 'balanced', lighting: 'golden-hour', contextState: 'ready' })),
    dispose: vi.fn(),
  }),
}));

function car(): CarPresentation {
  return {
    body: new THREE.Group(),
    wheels: [new THREE.Group(), new THREE.Group(), new THREE.Group(), new THREE.Group()],
    setCosmetics: vi.fn(), dispose: vi.fn(),
  };
}

describe('async car asset selection', () => {
  it('keeps the visible car when selecting the current car cancels a pending different load', async () => {
    const first = car();
    const late = car();
    let finishLate!: (value: CarPresentation) => void;
    const world: WorldPresentation = {
      root: new THREE.Group(), routes: [], collisionMeshes: [],
      spawn: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      dispose: vi.fn(),
    };
    const assets: SceneAssetFactory = {
      loadHeroWorld: async () => world,
      loadCarModel: async id => id === 'CAR-01' ? first : new Promise(resolve => { finishLate = resolve; }),
    };
    const pipeline = await createScenePipelineWithAssets({} as HTMLCanvasElement, assets);
    const pending = pipeline.setCar('CAR-02');
    await pipeline.setCar('CAR-01');
    finishLate(late);
    await pending;
    stageState.current = 'lost';
    expect(pipeline.currentContextState).toBe('lost');
    expect(pipeline.lastStats.contextState).toBe('ready');
    expect(pipeline.scene.children).toContain(first.body);
    expect(pipeline.scene.children).not.toContain(late.body);
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(first.dispose).not.toHaveBeenCalled();
    pipeline.dispose();
    stageState.current = 'ready';
  });
});
