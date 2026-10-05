import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createHarborSource } from '../../assets-source/3d/harbor-source';
import { createShadowBudgetPolicy } from '../../src/render/shadow-budget';

function dispose(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  });
}

describe('Harbor static detail batches', () => {
  it('groups only repeated steel and concrete detail into spatially bounded instanced meshes', () => {
    const harbor = createHarborSource();
    const batches: THREE.InstancedMesh[] = [];
    harbor.traverse((node) => { if (node instanceof THREE.InstancedMesh) batches.push(node); });

    expect(batches).toHaveLength(24);
    const mapping = new Map<string, THREE.InstancedMesh>();
    for (const batch of batches) {
      expect(batch.userData.batchKind).toBe('static-detail');
      expect(batch.userData.sourceInstances).toHaveLength(batch.count);
      expect(batch.boundingSphere).toBeTruthy();
      const names = batch.userData.sourceInstances as string[];
      for (const name of names) {
        expect(mapping.has(name)).toBe(false);
        mapping.set(name, batch);
      }
      const materials = Array.isArray(batch.material) ? batch.material : [batch.material];
      expect(materials).toHaveLength(1);
      expect(['steel-oxidized', 'concrete-weathered']).toContain(materials[0]!.name);
    }
    expect(mapping.size).toBe(123);
    expect(mapping.get('shed-road-door-rib-0-0')?.name).toBe('shed-road-door-rib-batch-0');
    expect(mapping.get('machine-hall-bay-rib-2-4')?.name).toBe('machine-hall-bay-rib-batch-2');
    expect(mapping.get('salt-tank-2-ladder-rung-9')?.name).toBe('salt-tank-2-ladder-rungs-batch');
    expect(mapping.get('salt-tank-3-band-2')?.name).toBe('salt-tank-3-band-detail-batch');
    expect(mapping.get('quay-wall-13')?.name).toBe('quay-wall-batch-1');
    expect(mapping.get('shed-door-rib-east-3-0')?.name).toBe('shed-door-rib-east-batch-3');
    expect(mapping.get('shed-door-frame-east-2-header')?.name).toBe('shed-door-frame-east-batch-2');

    const firstRibBatch = mapping.get('shed-road-door-rib-0-0')!;
    const firstIndex = (firstRibBatch.userData.sourceInstances as string[]).indexOf('shed-road-door-rib-0-0');
    const matrix = new THREE.Matrix4();
    firstRibBatch.getMatrixAt(firstIndex, matrix);
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    expect(position.x).toBeCloseTo(-202, 5);
    expect(position.y).toBeCloseTo(1.25, 5);
    expect(scale.x).toBeCloseTo(7.8, 5);
    expect(scale.y).toBeCloseTo(.07, 5);

    // Route/road boundaries and camera-collision landmarks keep their own nodes.
    for (const name of [
      'road-hw01-asphalt', 'road-hw01-curb-left', 'road-hw01-curb-right',
      'road-hw01-guardrail-left', 'road-hw01-guardrail-right', 'loading-shed-main',
      'east-quay-machine-hall', 'salt-tank-1', 'salt-tank-2', 'salt-tank-3',
      'quay-lamp-head-0', 'shed-road-dock-lamp-0-1',
    ]) expect(harbor.getObjectByName(name)).toBeTruthy();
    expect(harbor.getObjectByName('road-hw01-asphalt')).not.toBeInstanceOf(THREE.InstancedMesh);
    expect(harbor.getObjectByName('road-hw01-guardrail-left')).not.toBeInstanceOf(THREE.InstancedMesh);
    for (const sourceName of mapping.keys()) expect(harbor.getObjectByName(sourceName)).toBeUndefined();

    const major = harbor.getObjectByName('loading-shed-main') as THREE.Mesh;
    const shadowPolicy = createShadowBudgetPolicy([harbor]);
    shadowPolicy.setQuality('low');
    for(const batch of batches)expect(batch.castShadow).toBe(false);
    expect(major.castShadow).toBe(true);
    expect((harbor.getObjectByName('shed-door-safety-mark-east-0') as THREE.Mesh).castShadow).toBe(false);
    expect((harbor.getObjectByName('shed-door-east-panel-0') as THREE.Mesh).castShadow).toBe(false);
    shadowPolicy.setQuality('balanced');
    for(const batch of batches)expect(batch.castShadow).toBe(true);
    shadowPolicy.dispose();
    dispose(harbor);
  });

  it('round-trips instancing and source mapping through the runtime GLB loader', async () => {
    const bytes = await readFile(resolve(process.cwd(), 'public/assets/world/harbor-works.glb'));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().parseAsync(buffer, '/');
    gltf.scene.updateMatrixWorld(true);
    const batches: THREE.InstancedMesh[] = [];
    gltf.scene.traverse((node) => { if (node instanceof THREE.InstancedMesh) batches.push(node); });
    expect(batches).toHaveLength(24);
    expect(batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(123);
    const shedRibs = batches.find((batch) => batch.name === 'shed-road-door-rib-batch-0');
    expect(shedRibs).toBeInstanceOf(THREE.InstancedMesh);
    expect(shedRibs?.userData.sourceInstances).toHaveLength(5);
    expect(gltf.scene.getObjectByName('road-hw01-asphalt')).toBeTruthy();
    expect(gltf.scene.getObjectByName('road-hw01-guardrail-left')).toBeTruthy();
    expect(gltf.scene.getObjectByName('loading-shed-main')).toBeTruthy();
    const eastPanel = gltf.scene.getObjectByName('shed-door-east-panel-3');
    expect(eastPanel).toBeTruthy();
    const earlyCamera = new THREE.Vector3(-65.17, 5, 44.35);
    const earlyTarget = new THREE.Vector3(eastPanel!.position.x, 4.15, eastPanel!.position.z);
    const earlyRay = new THREE.Raycaster(earlyCamera, earlyTarget.clone().sub(earlyCamera).normalize());
    expect(earlyRay.intersectObject(gltf.scene, true)[0]?.object.name).toBe('shed-door-east-panel-3');
    dispose(gltf.scene);
  });

  it('puts the loading bays on the east end visible from the early driving sightline', () => {
    const harbor = createHarborSource();
    harbor.updateMatrixWorld(true);
    const panel = harbor.getObjectByName('shed-door-east-panel-3');
    expect(panel).toBeInstanceOf(THREE.Mesh);
    if (!(panel instanceof THREE.Mesh)) throw new Error('East loading door is missing');
    const origin = new THREE.Vector3(-65.17, 5, 44.35);
    const target = new THREE.Vector3(panel.position.x, 4.15, panel.position.z);
    const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
    const hits = ray.intersectObject(harbor, true);
    expect(hits[0]?.object.name).toBe('shed-door-east-panel-3');
    expect(panel.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    dispose(harbor);
  });
});
