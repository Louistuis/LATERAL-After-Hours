import * as THREE from 'three';

/** Stable raycast candidates from authored static scenery only. Visibility is checked at raycast time. */
export function collectCameraOccluders(roots: readonly THREE.Object3D[]): readonly THREE.Object3D[] {
  const meshes: THREE.Object3D[] = [];
  const visit = (node: THREE.Object3D, inherited: boolean): void => {
    const tagged = node.userData.cameraCollision;
    const eligible = tagged === true ? true : tagged === false ? false : inherited;
    if (eligible && node instanceof THREE.Mesh) meshes.push(node);
    for (const child of node.children) visit(child, eligible);
  };
  for (const root of roots) visit(root, false);
  return Object.freeze(meshes);
}
