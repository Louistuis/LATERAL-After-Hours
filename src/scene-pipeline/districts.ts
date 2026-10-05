import * as THREE from 'three';
import type { WorldPresentation } from './ports';
import { createCoastScenery } from './coast-scenery';
import { createHarborLife } from './harbor-life';
import { createRidgeScenery, type DistrictScenery, type SharedWorldMaterials } from './ridge-scenery';

export type { DistrictScenery, SharedWorldMaterials } from './ridge-scenery';

/** Harbour materials by name, so procedural districts reuse their programs and textures. */
export function findSharedMaterials(root: THREE.Object3D): SharedWorldMaterials {
  let asphalt: THREE.Material | undefined, concrete: THREE.Material | undefined, water: THREE.Material | undefined;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!asphalt && material.name === 'road-asphalt') asphalt = material;
      if (!concrete && material.name === 'concrete-weathered') concrete = material;
      if (!water && material.name === 'harbor-water') water = material;
    }
  });
  return { asphalt, concrete, water };
}

/** One scenery per district that has a route in this world (for the harbour: its surroundings only). */
export function createDistrictSceneries(world: WorldPresentation, shared: SharedWorldMaterials): DistrictScenery[] {
  const sceneries: DistrictScenery[] = [];
  try {
    // The harbour keeps its authored world; this only adds the skyline, sea and traffic around it.
    if (world.routes.some((route) => route.district === 'harbor')) sceneries.push(createHarborLife(shared));
    if (world.routes.some((route) => route.district === 'ridge')) sceneries.push(createRidgeScenery(shared));
    if (world.routes.some((route) => route.district === 'coast')) sceneries.push(createCoastScenery(shared));
  } catch (error) {
    sceneries.forEach((scenery) => scenery.dispose());
    throw error;
  }
  return sceneries;
}
