import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface StaticMergeReport { readonly sourceMeshes: number; readonly mergedMeshes: number }

/**
 * Collapses static, single-material world meshes that share a material and shadow flags into one draw.
 * Camera occluders and anything with custom callbacks, instancing, skinning or morphs keep their identity.
 * Call once after load, after occluders are collected; merged sources are removed and disposed.
 */
export function mergeStaticMeshes(root: THREE.Object3D, keep: ReadonlySet<THREE.Object3D>): StaticMergeReport {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; meshes: THREE.Mesh[] }>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || Array.isArray(mesh.material)) return;
    if (keep.has(mesh) || !mesh.visible || mesh.geometry.morphAttributes.position) return;
    if (mesh.material.transparent || mesh.renderOrder !== 0) return;
    const attrs = Object.keys(mesh.geometry.attributes).sort().join(',');
    const key = `${mesh.material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${attrs}|${mesh.geometry.index ? 1 : 0}`;
    let group = groups.get(key);
    if (!group) { group = { material: mesh.material, cast: mesh.castShadow, receive: mesh.receiveShadow, meshes: [] }; groups.set(key, group); }
    group.meshes.push(mesh);
  });
  let sourceMeshes = 0, mergedMeshes = 0;
  for (const group of groups.values()) {
    if (group.meshes.length < 2) continue;
    const parts = group.meshes.map((mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    const merged = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!merged) continue;
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    merged.applyMatrix4(inverse);
    const mesh = new THREE.Mesh(merged, group.material);
    mesh.name = `merged-${group.material.name || 'static'}`;
    mesh.castShadow = group.cast; mesh.receiveShadow = group.receive;
    for (const source of group.meshes) source.removeFromParent();
    root.add(mesh);
    sourceMeshes += group.meshes.length; mergedMeshes++;
  }
  return { sourceMeshes, mergedMeshes };
}
