import type * as THREE from 'three';
import type { CarId } from '../../contracts/runtime-contracts';
import type { CollisionMeshData, RouteDefinition } from '../../contracts/world-contracts';

export interface SceneCosmetics {
  readonly paint?: string;
  readonly wheelStyle?: string;
  readonly livery?: string;
}

export interface SceneCosmeticsCatalog {
  readonly paints: readonly Readonly<{ id: string; name: string }>[];
  readonly wheelStyles: readonly Readonly<{ id: string; name: string }>[];
  readonly liveries: readonly Readonly<{ id: string; name: string }>[];
}

export interface WorldPresentation {
  readonly root: THREE.Group;
  /** Every selectable route inhabits this one connected world. */
  readonly routes: readonly RouteDefinition[];
  /** world-v1: complete, immutable collision set at creation. GameRuntime registers
   * every mesh once before driving starts; visual LOD/culling does not change it.
   * Each route's roadIds resolve against eligible meshes in this fixed set. */
  readonly collisionMeshes: readonly CollisionMeshData[];
  readonly spawn: RouteDefinition['spawn'];
  dispose(): void;
}

export interface CarPresentation {
  /** Body coordinates are relative to the physics chassis origin. */
  readonly body: THREE.Group;
  /** Wheel groups have independent world transforms from WheelSnapshot. */
  readonly wheels: readonly [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
  readonly cosmeticsCatalog?: SceneCosmeticsCatalog;
  setCosmetics(cosmetics: SceneCosmetics): void;
  setLights?(state: Readonly<{ braking: number; reversing: boolean }>): void;
  dispose(): void;
}

export interface SceneAssetFactory {
  loadHeroWorld(): Promise<WorldPresentation>;
  loadCarModel(carId: CarId): Promise<CarPresentation>;
}
