import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCoastScenery } from '../../src/scene-pipeline/coast-scenery';
import { createRidgeScenery } from '../../src/scene-pipeline/ridge-scenery';
import { createHarborLife, HARBOR_WORLD_BOUNDS } from '../../src/scene-pipeline/harbor-life';
import { atmosphereFor } from '../../src/scene-pipeline/atmosphere';
import { buildCoastInterchange, COAST_ORIGIN } from '../../src/world/coast-interchange';
import { RIDGE_ORIGIN } from '../../src/world/ridge-pass';

function census(root: THREE.Object3D): { draws: number; triangles: number; finite: boolean; materials: Set<string> } {
  let draws = 0, triangles = 0, finite = true;
  const materials = new Set<string>();
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh && !(node as THREE.Points).isPoints) return;
    draws++;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count * 3; i++) if (!Number.isFinite((position.array as ArrayLike<number>)[i])) { finite = false; break; }
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    triangles += ((geometry.index?.count ?? position.count) / 3) * instances;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material.name);
  });
  return { draws, triangles, finite, materials };
}

describe('procedural district sceneries', () => {
  it.each([
    ['ridge', createRidgeScenery, RIDGE_ORIGIN],
    ['coast', createCoastScenery, COAST_ORIGIN],
  ] as const)('%s builds inside its own district within the Balanced budget and disposes cleanly', (district, create, origin) => {
    const shared = { asphalt: new THREE.MeshStandardMaterial({ name: 'road-asphalt' }), concrete: new THREE.MeshStandardMaterial({ name: 'concrete-weathered' }) };
    const scenery = create(shared);
    expect(scenery.district).toBe(district);
    scenery.setAtmosphere(atmosphereFor(district, 'blue-hour'));
    scenery.setQuality?.('balanced');
    scenery.update(1.5, new THREE.PerspectiveCamera());
    const stats = census(scenery.root);
    expect(stats.finite).toBe(true);
    // The road reuses the harbour's wet asphalt program.
    expect(stats.materials.has('road-asphalt')).toBe(true);
    expect(stats.draws).toBeLessThan(40);
    expect(stats.triangles).toBeLessThan(170_000);
    expect(scenery.lampPositions.length).toBeGreaterThan(8);
    for (const lamp of scenery.lampPositions) expect(Math.hypot(lamp.x - origin.x, lamp.z - origin.z)).toBeLessThan(600);
    scenery.setQuality?.('low');
    expect(census(scenery.root).triangles).toBeLessThanOrEqual(stats.triangles);
    scenery.dispose();
    expect(scenery.root.children).toHaveLength(0);
  });

  it('CL-01 has a lit tunnel with the plaza over it and no pier standing on the road', () => {
    const scenery = createCoastScenery();
    const coast = buildCoastInterchange();
    expect(coast.ribbon.frames.some((_, i) => coast.tunnel(i))).toBe(true);
    expect(scenery.root.getObjectByName('coast-led-strips')).toBeTruthy();
    expect(scenery.root.getObjectByName('coast-walls-decks-tunnel')).toBeTruthy();
    const piers = scenery.root.getObjectByName('coast-piers') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
    for (let k = 0; k < piers.count; k++) {
      piers.getMatrixAt(k, matrix);
      matrix.decompose(position, rotation, scale);
      const top = position.y + scale.y / 2;
      // Nothing below a pier's top may be drivable road within the column's footprint.
      for (const frame of coast.ribbon.frames) {
        const horizontal = Math.hypot(frame.p.x - position.x, frame.p.z - position.z);
        if (horizontal < 9 && frame.p.y < top - 2 && frame.p.y > position.y - scale.y / 2) {
          throw new Error(`pier ${k} at ${position.x.toFixed(1)},${position.z.toFixed(1)} stands on road at s=${frame.s.toFixed(0)}`);
        }
      }
    }
    scenery.dispose();
  });

  it('harbour surroundings stay outside the authored harbour box and add only a handful of draws', () => {
    const life = createHarborLife();
    life.setAtmosphere(atmosphereFor('harbor', 'blue-hour'));
    const B = HARBOR_WORLD_BOUNDS;
    const inside = (x: number, z: number): boolean => x > B.minX + 1 && x < B.maxX - 1 && z > B.minZ + 1 && z < B.maxZ - 1;
    const point = new THREE.Vector3(), matrix = new THREE.Matrix4();
    life.root.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || (mesh.material as THREE.Material).blending === THREE.AdditiveBlending) return;
      const position = mesh.geometry.getAttribute('position');
      const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
      for (let k = 0; k < (instanced ? instanced.count : position.count); k++) {
        if (instanced) { instanced.getMatrixAt(k, matrix); point.setFromMatrixPosition(matrix); } else point.fromBufferAttribute(position, k);
        if (inside(point.x, point.z)) throw new Error(`${mesh.name} reaches into the harbour at ${point.x.toFixed(1)},${point.z.toFixed(1)}`);
      }
    });
    const stats = census(life.root);
    expect(stats.finite).toBe(true);
    expect(stats.draws).toBeLessThanOrEqual(8);
    expect(stats.triangles).toBeLessThan(40_000);
    life.dispose();
  });
});
