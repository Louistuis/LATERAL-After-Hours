/** Frozen runtime world v1; authored road samples remain editable content. */
import type { Quat, RouteId, Vec3 } from './runtime-contracts';
export type DistrictId = 'harbor' | 'ridge' | 'coast';
export interface RoadPoint extends Vec3 { readonly widthM?: number; readonly bankRad?: number; }
export interface RoadDefinition {
  readonly id: string;
  readonly district: DistrictId;
  readonly points: readonly RoadPoint[];
  readonly widthM: number;
  readonly closed: boolean;
}
export interface WorldCheckpoint {
  readonly id: string;
  readonly center: Vec3;
  readonly forward: Vec3;
  readonly halfWidthM: number;
  readonly finish?: boolean;
}
export interface RouteClippingZone {
  readonly id: string;
  /** Spawn-relative distance on this route's ordered centerline. */
  readonly progressM: number;
  /** Half-length of the scoring window along the route, in metres. */
  readonly radiusM: number;
  /** Positive is route-forward right; the target car centre remains on the road. */
  readonly preferredOffsetM: number;
  readonly lateralToleranceM: number;
  /** Validated inclusive range [1, 1.5]; applies over one eligible zone passage. */
  readonly bonusFactor: number;
}
export interface RouteDefinition {
  readonly id: RouteId;
  readonly name: string;
  readonly district: DistrictId;
  readonly version: string;
  readonly roadIds: readonly string[];
  readonly centerline: readonly Vec3[];
  readonly widthM: number;
  readonly closed: boolean;
  readonly lengthM: number;
  readonly spawn: Readonly<{ position: Vec3; rotation: Quat }>;
  readonly checkpoints: readonly WorldCheckpoint[];
  /** Authored optional opportunities; omission gives neutral line scoring. */
  readonly clippingZones?: readonly RouteClippingZone[];
  /**
   * Optional medal targets the route declares itself (time trial and rival ghost in seconds, drift attack in points).
   * When absent, src/events/medal-targets.ts MEDAL_TABLE supplies calibrated targets for a matching route version.
   */
  readonly medalTargets?: Readonly<Partial<Record<'time-trial' | 'drift-attack', Readonly<{ gold: number; silver: number; bronze: number }>>>>;
}
export interface CollisionMeshData {
  readonly vertices: readonly Vec3[];
  readonly indices: readonly number[];
  readonly surfaceId: string;
  /** Surface supports wheels; obstacle contacts also invalidate wall-riding/impact chains. */
  readonly role?: 'surface' | 'obstacle';
  /** Explicit scoring classification; off-road terrain and walls must be false. */
  readonly drivableRoad?: boolean;
}
