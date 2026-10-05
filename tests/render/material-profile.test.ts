import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applySceneMaterialProfile } from '../../src/render';

describe('scene material profile', () => {
  it('tunes only named shared materials and remains idempotent across asset reuse', () => {
    const root = new THREE.Group();
    const road = new THREE.MeshStandardMaterial({ name: 'road-asphalt', roughness: 0.3, metalness: 0.4 });
    const repair = new THREE.MeshStandardMaterial({ name: 'asphalt-repair', color: '#aaaaaa' });
    const dampMap = new THREE.Texture();
    const damp = new THREE.MeshStandardMaterial({ name: 'asphalt-damp', color: '#aaaaaa', map: dampMap });
    const paint = new THREE.MeshPhysicalMaterial({ name: 'paint', roughness: 0.8, metalness: 0.1, clearcoat: 0 });
    const unrecognized = new THREE.MeshStandardMaterial({ name: 'unrecognized-slot', roughness: 0.5 });
    root.add(
      new THREE.Mesh(new THREE.BoxGeometry(), road),
      new THREE.Mesh(new THREE.BoxGeometry(), road),
      new THREE.Mesh(new THREE.BoxGeometry(), repair),
      new THREE.Mesh(new THREE.BoxGeometry(), damp),
      new THREE.Mesh(new THREE.BoxGeometry(), paint),
      new THREE.Mesh(new THREE.BoxGeometry(), unrecognized),
    );

    const first = applySceneMaterialProfile(root);
    const hook = road.onBeforeCompile;
    const programKey = road.customProgramCacheKey();
    const second = applySceneMaterialProfile(root);

    expect(first.matchedNames).toEqual(['asphalt-damp', 'asphalt-repair', 'paint', 'road-asphalt']);
    expect(first.matchedMaterials).toBe(4);
    expect(first.unmatchedNames).toContain('glass');
    expect(second.matchedNames).toEqual(first.matchedNames);
    expect(second.matchedMaterials).toBe(4);
    expect(road.roughness).toBe(0.92);
    expect(road.metalness).toBe(0);
    expect(road.onBeforeCompile).toBe(hook);
    expect(road.customProgramCacheKey()).toBe(programKey);
    expect(repair.color.getHexString()).toBe('414546');
    expect(repair.roughness).toBe(0.95);
    expect(damp.color.getHexString()).toBe('ffffff');
    expect(damp.map).toBe(dampMap);
    expect(damp.roughness).toBe(0.56);
    expect(paint.roughness).toBe(0.32);
    expect(paint.metalness).toBe(0.08);
    expect(paint.clearcoat).toBe(0.6);
    expect(paint.clearcoatRoughness).toBe(0.3);
    expect(unrecognized.roughness).toBe(0.5);

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry.dispose();
      if (Array.isArray(node.material)) node.material.forEach((material) => material.dispose());
      else node.material.dispose();
    });
    dampMap.dispose();
  });

  it('adds world-position roughness modulation without allocating or replacing a road material', () => {
    const material = new THREE.MeshStandardMaterial({ name: 'road-asphalt' });
    const root = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    const original = material;
    applySceneMaterialProfile(root);
    const shader = { vertexShader: '#include <common>\n#include <project_vertex>', fragmentShader: '#include <common>\n#include <roughnessmap_fragment>' };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);

    expect(root.material).toBe(original);
    expect(shader.vertexShader).toContain('vL3WorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    expect(shader.fragmentShader).toContain('float l3DampPatch = smoothstep(0.62, 0.86, l3MacroVariation);');
    material.dispose();
    root.geometry.dispose();
  });
});
