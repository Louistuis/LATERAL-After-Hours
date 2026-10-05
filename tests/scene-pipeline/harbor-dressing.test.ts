import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildHarborRoute } from '../../src/world/route-data';
import {
  CONTAINER_ANCHORS, createHarborDressing, HARBOR_DRESSING_VERSION, routeClearanceXZ,
} from '../../src/scene-pipeline/harbor-dressing';

describe('original Harbor dressing', () => {
  it('keeps solid props outside the authored road and crossover sightline', () => {
    const route = buildHarborRoute().route;
    const dressing = createHarborDressing(route);
    expect(dressing.sourceVersion).toBe(HARBOR_DRESSING_VERSION);
    expect(dressing.solidAnchorClearancesM.length).toBeGreaterThan(CONTAINER_ANCHORS.length);
    for (const clearance of dressing.solidAnchorClearancesM) {
      expect(clearance).toBeGreaterThan(route.widthM / 2 + 18);
    }
    expect(routeClearanceXZ(route, route.spawn.position)).toBeLessThan(1);
    dressing.dispose();
  });

  it('places street lamps outside the carriageway and animates only through uniforms', () => {
    const route = buildHarborRoute().route;
    const dressing = createHarborDressing(route);
    expect(dressing.lampPositions.length).toBeGreaterThan(10);
    for (const lamp of dressing.lampPositions) {
      // Lens positions hang over the verge, never over the drivable width.
      expect(routeClearanceXZ(route, lamp)).toBeGreaterThan(route.widthM / 2 - 1);
    }
    const lenses = dressing.root.getObjectByName('street-lamp-lenses') as THREE.InstancedMesh;
    expect(lenses.count).toBeGreaterThan(10);
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1500);
    camera.position.set(3, 4, 5);
    const before = lenses.instanceMatrix.version;
    dressing.update(12.5, camera);
    expect(lenses.instanceMatrix.version).toBe(before);
    dressing.dispose();
  });

  it('shares instanced cargo geometry and releases owned GPU resources', () => {
    const dressing = createHarborDressing(buildHarborRoute().route);
    const cargo = dressing.root.getObjectByName('yard-cargo-container-shells');
    expect(cargo).toBeInstanceOf(THREE.InstancedMesh);
    expect((cargo as THREE.InstancedMesh).count).toBe(CONTAINER_ANCHORS.length);
    expect(cargo?.userData.cameraCollision).toBe(true);
    expect(dressing.root.getObjectByName('harbor-tank-farm-bodies')?.userData.cameraCollision).toBe(true);
    expect(dressing.root.getObjectByName('yard-expansion-joints')?.userData.cameraCollision).toBeUndefined();
    const drawBearing: THREE.Mesh[] = [];
    dressing.root.traverse((node) => { if (node instanceof THREE.Mesh) drawBearing.push(node); });
    // Lamps, lit windows, neon and glow families add a handful of single-draw instanced meshes.
    expect(drawBearing.length).toBeLessThan(52);
    const geometry = (cargo as THREE.InstancedMesh).geometry;
    const material = (cargo as THREE.InstancedMesh).material as THREE.Material;
    const onGeometryDispose = vi.fn();
    const onMaterialDispose = vi.fn();
    geometry.addEventListener('dispose', onGeometryDispose);
    material.addEventListener('dispose', onMaterialDispose);
    dressing.dispose();
    dressing.dispose();
    expect(dressing.root.children).toHaveLength(0);
    expect(onGeometryDispose).toHaveBeenCalledTimes(1);
    expect(onMaterialDispose).toHaveBeenCalledTimes(1);
  });
});
