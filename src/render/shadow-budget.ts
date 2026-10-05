import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';

export interface ShadowBudgetPolicy {
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

const IMPORTANT_ENVIRONMENT_SHADOWS = [
  /^road-hw01-guardrail-/,
  /^(loading-shed-main|loading-shed-roof|east-quay-machine-hall|east-quay-machine-hall-roof)$/,
  /^dock-crane-\d+$/,
  /^salt-tank-\d+$/,
  /^(yard-cargo-container-shells|harbor-tank-farm-bodies|harbor-tank-farm-roofs|harbor-structural-beams)$/,
  /^harbor-service-light-stems$/,
] as const;

const LOW_DETAIL_NAME = /(?:door-frame|door-rib|door-\d+$|shed-door-|safety-mark|safety-stripe|sign-rule|signboard|ladder|band-|quay-wall-|quay-lamp-pole-|machine-hall-rib-|machine-hall-bay-|crane-beacon|service-trolley|load-hook|roof-service-vents|corrugation|end-doors)/i;

const FLAT_NAME = /(?:repair-patch|safety-mark|road-mark|decal|puddle)/i;
function casterRadius(mesh: THREE.Mesh): number {
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const scale = mesh.getWorldScale(new THREE.Vector3());
  return (mesh.geometry.boundingSphere?.radius ?? 0) * Math.max(scale.x, scale.y, scale.z);
}

function hasImportantAncestor(mesh: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = mesh; node && node !== root.parent; node = node.parent) {
    if (LOW_DETAIL_NAME.test(node.name)) return false;
    if (IMPORTANT_ENVIRONMENT_SHADOWS.some((pattern) => pattern.test(node.name))) return true;
    if (node === root) break;
  }
  return IMPORTANT_ENVIRONMENT_SHADOWS.some((pattern) => pattern.test(mesh.name));
}

/**
 * Reduces only environment shadow-map submissions in Low. The scene's meshes
 * stay visible and retain their authored collision/geometry; protected hero
 * roots are never traversed. Balanced/High restore each authored castShadow.
 */
export function createShadowBudgetPolicy(environmentRoots: readonly THREE.Object3D[]): ShadowBudgetPolicy {
  const authored = new Map<THREE.Mesh, { castShadow: boolean; root: THREE.Object3D }>();
  for (const root of environmentRoots) {
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || authored.has(node)) return;
      authored.set(node, { castShadow: node.castShadow, root });
    });
  }

  let disposed = false;
  return {
    setQuality(preset): void {
      if (disposed) return;
      for (const [mesh, state] of authored) {
        // Balanced keeps the skyline-scale casters plus anything big enough to read in a 2048 map;
        // small trim (door frames, lamp heads, flat repair patches) costs a shadow draw each for no visible contact.
        mesh.castShadow = state.castShadow && !FLAT_NAME.test(mesh.name) && (preset === 'high' || preset === 'ultra'
          || hasImportantAncestor(mesh, state.root) || (preset === 'balanced' && (casterRadius(mesh) >= 3.5 || (mesh as THREE.Mesh & { isInstancedMesh?: boolean }).isInstancedMesh === true)));
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [mesh, state] of authored) mesh.castShadow = state.castShadow;
      authored.clear();
    },
  };
}
