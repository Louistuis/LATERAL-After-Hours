import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRenderPassCensus } from '../../src/render';

function mockRenderer(): THREE.WebGLRenderer {
  return { info: { render: { calls: 0 } } } as THREE.WebGLRenderer;
}

function invokeMain(
  mesh: THREE.Mesh,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  group: THREE.Group,
): void {
  mesh.onBeforeRender(renderer, scene, camera, mesh.geometry, mesh.material as THREE.Material, group);
}

function invokeShadow(
  mesh: THREE.Mesh,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  group: THREE.Group,
): void {
  mesh.onBeforeShadow(renderer, scene, camera, camera, mesh.geometry, mesh.material as THREE.Material, group);
}

describe('render pass census', () => {
  it('chains callbacks, splits categories and passes, counts groups and instances, then restores callbacks', () => {
    const renderer = mockRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const world = new THREE.Group();
    const car = new THREE.Group();
    scene.add(world, car);
    const material = new THREE.MeshBasicMaterial();
    const worldMesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const carInstances = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 7);
    carInstances.count = 3;
    const uiMarkers = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    world.add(worldMesh);
    car.add(carInstances);
    scene.add(uiMarkers);
    const oldWorldCallback = vi.fn();
    const oldCarShadowCallback = vi.fn();
    worldMesh.onBeforeRender = oldWorldCallback;
    carInstances.onBeforeShadow = oldCarShadowCallback;
    const originalWorldShadow = worldMesh.onBeforeShadow;
    const originalCarRender = carInstances.onBeforeRender;
    const census = createRenderPassCensus(renderer, scene, { staticRoots: [world], carRoots: [car] });

    const result = census.capture(() => {
      invokeMain(worldMesh, renderer, scene, camera, new THREE.Group());
      invokeMain(carInstances, renderer, scene, camera, new THREE.Group());
      invokeMain(carInstances, renderer, scene, camera, new THREE.Group());
      invokeMain(uiMarkers as unknown as THREE.Mesh, renderer, scene, camera, new THREE.Group());
      invokeShadow(carInstances, renderer, scene, camera, new THREE.Group());
      renderer.info.render.calls = 5;
      return 'rendered';
    });

    expect(result.result).toBe('rendered');
    expect(result.census).toEqual({
      main: {
        staticWorld: { submissions: 1, instances: 0 },
        car: { submissions: 2, instances: 6 },
        other: { submissions: 1, instances: 0 },
      },
      shadow: {
        staticWorld: { submissions: 0, instances: 0 },
        car: { submissions: 1, instances: 3 },
        other: { submissions: 0, instances: 0 },
      },
      rendererInfoCalls: 5,
      callbackAggregateDelta: 0,
    });
    expect(oldWorldCallback).toHaveBeenCalledTimes(1);
    expect(oldCarShadowCallback).toHaveBeenCalledTimes(1);
    expect(worldMesh.onBeforeRender).toBe(oldWorldCallback);
    expect(worldMesh.onBeforeShadow).toBe(originalWorldShadow);
    expect(carInstances.onBeforeRender).toBe(originalCarRender);
    expect(carInstances.onBeforeShadow).toBe(oldCarShadowCallback);
  });

  it('leaves callbacks untouched and returns no census when disabled', () => {
    const renderer = mockRenderer();
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    world.add(mesh);
    scene.add(world);
    const callback = vi.fn();
    mesh.onBeforeRender = callback;
    const census = createRenderPassCensus(renderer, scene, { staticRoots: [world], carRoots: [] });

    const result = census.capture(() => {
      renderer.info.render.calls = 2;
      return 17;
    }, false);

    expect(result).toEqual({ result: 17, census: null });
    expect(mesh.onBeforeRender).toBe(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('reports renderer aggregate mismatches and restores callbacks if rendering throws', () => {
    const renderer = mockRenderer();
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    world.add(mesh);
    scene.add(world);
    const original = mesh.onBeforeRender;
    const census = createRenderPassCensus(renderer, scene, { staticRoots: [world], carRoots: [] });

    const result = census.capture(() => {
      invokeMain(mesh, renderer, scene, new THREE.Camera(), new THREE.Group());
      renderer.info.render.calls = 3;
    });
    expect(result.census?.callbackAggregateDelta).toBe(-2);
    expect(mesh.onBeforeRender).toBe(original);

    expect(() => census.capture(() => { throw new Error('render failed'); })).toThrow('render failed');
    expect(mesh.onBeforeRender).toBe(original);
    expect(census.capture(() => 'next').result).toBe('next');
  });

  it('restores earlier hooks if installation fails partway through traversal', () => {
    const renderer = mockRenderer();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(mesh);
    const originalRender = mesh.onBeforeRender;
    const originalShadow = mesh.onBeforeShadow;
    const originalTraverse = scene.traverse;
    scene.traverse = ((callback: (object: THREE.Object3D) => void): THREE.Object3D => {
      callback(mesh);
      throw new Error('traversal failed');
    }) as THREE.Scene['traverse'];
    const census = createRenderPassCensus(renderer, scene, { staticRoots: [], carRoots: [] });

    expect(() => census.capture(() => undefined)).toThrow('traversal failed');
    expect(mesh.onBeforeRender).toBe(originalRender);
    expect(mesh.onBeforeShadow).toBe(originalShadow);

    scene.traverse = originalTraverse;
    expect(census.capture(() => 'recovered').result).toBe('recovered');
  });

  it('uses refreshed roots after an active-car replacement', () => {
    const renderer = mockRenderer();
    const scene = new THREE.Scene();
    const oldCar = new THREE.Group();
    const newCar = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    newCar.add(mesh);
    scene.add(oldCar, newCar);
    const census = createRenderPassCensus(renderer, scene, { staticRoots: [], carRoots: [oldCar] });
    census.setRoots({ staticRoots: [], carRoots: [newCar] });

    const result = census.capture(() => {
      invokeMain(mesh, renderer, scene, new THREE.Camera(), new THREE.Group());
      renderer.info.render.calls = 1;
    });
    expect(result.census?.main.car.submissions).toBe(1);
    expect(result.census?.main.other.submissions).toBe(0);
  });
});
