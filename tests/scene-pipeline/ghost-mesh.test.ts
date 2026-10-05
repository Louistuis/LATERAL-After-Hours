import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildGhostGeometry, clusterTriangles, collectTriangles, ghostPart } from '../../src/scene-pipeline/ghost-mesh';

function car(): THREE.Group {
  const root = new THREE.Group();
  root.position.set(100, 0, -50); root.scale.setScalar(1.2);
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120));
  body.position.set(0, 0.6, 0); body.scale.set(2, 0.6, 1);
  const detail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
  detail.position.set(1.5, 1, 0);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5)); hidden.visible = false;
  root.add(body, detail, hidden);
  return root;
}

describe('ghost mesh', () => {
  it('collects visible triangles in root-local space', () => {
    const root = car();
    const soup = collectTriangles(root);
    expect(soup.length % 9).toBe(0);
    let maxX = -Infinity;
    for (let i = 0; i < soup.length; i += 3) maxX = Math.max(maxX, soup[i]!);
    expect(maxX).toBeCloseTo(2, 1); // body radius 1 x scale 2, root transform excluded
  });
  it('thins a dense part under the triangle target and keeps its size', () => {
    const root = car();
    const dense = collectTriangles(root).length / 9;
    expect(dense).toBeGreaterThan(30_000);
    const geometry = buildGhostGeometry(root, 8_000);
    expect(geometry.index!.count / 3).toBeLessThanOrEqual(8_000);
    expect(geometry.index!.count / 3).toBeGreaterThan(500);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.x).toBeGreaterThan(1.8);
    expect(Object.keys(geometry.attributes)).toEqual(['position']);
  });
  it('drops degenerate triangles and welds shared corners', () => {
    const soup = new Float32Array([0, 0, 0, 0.001, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const out = clusterTriangles(soup, 0.01);
    expect(out.indices.length).toBe(3);
    expect(out.positions.length).toBe(12); // 4 cells: the two near-origin corners weld
  });
  it('is one mesh with the part scale', () => {
    const material = new THREE.MeshBasicMaterial();
    const mesh = ghostPart(car(), material, 4_000);
    expect(mesh.scale.x).toBeCloseTo(1.2);
    expect(mesh.material).toBe(material);
  });
});
