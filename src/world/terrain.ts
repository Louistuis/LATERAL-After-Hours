import type { Vec3 } from '../../contracts/runtime-contracts';
import type { CollisionMeshData } from '../../contracts/world-contracts';
import type { RoadFrame } from './road-ribbon';

/**
 * Heightfield terrain carved around one or more roads. Each road frame imposes two cones on the
 * natural ground: an upper bound (cut slope) that keeps the ground below the carriageway and a lower
 * bound (fill slope / embankment). Upper bounds always win, so ground can never cover a road.
 *
 * Inside a road's footprint the ground is pushed `deepM` down; this keeps every grid triangle that
 * touches the footprint below the surface even with coarse cells (proof in tests/world/ridge-pass).
 */
export interface CarveRoad {
  readonly frames: readonly RoadFrame[];
  /** Half width of the footprint the ground must stay under (road + shoulder + barrier). */
  readonly footprintM: number;
  /** Frames with no embankment (bridges): the ground keeps its natural depth below them. */
  readonly bridge?: (index: number) => boolean;
}

export interface TerrainSpec {
  readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number;
  readonly cellM: number;
  readonly natural: (x: number, z: number) => number;
  readonly roads: readonly CarveRoad[];
  /** Ground under the edge of the footprint sits this far below the road (default 0.7). */
  readonly edgeDepthM?: number;
  /** Ground inside the footprint sits this far below the road (default 9). */
  readonly deepM?: number;
  readonly cutSlope?: number;
  readonly fillSlope?: number;
  /** Cone influence radius (default 110 m). */
  readonly reachM?: number;
  /** Extra height (>= 0) the cut cone may carry here: breaks planar cut faces into rock buttresses. */
  readonly cutRelief?: (x: number, z: number) => number;
}

export interface CarvedTerrain {
  readonly spec: TerrainSpec;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  /** Horizontal distance from each vertex to the nearest road frame (capped at reach). */
  readonly roadDistance: Float32Array;
  x(i: number): number;
  z(j: number): number;
  /** Height of the rendered triangle surface (same split as the mesh). */
  heightAt(x: number, z: number): number;
}

export function carveTerrain(spec: TerrainSpec): CarvedTerrain {
  const { minX, maxX, minZ, maxZ, cellM } = spec;
  const nx = Math.round((maxX - minX) / cellM) + 1, nz = Math.round((maxZ - minZ) / cellM) + 1;
  const edgeDepth = spec.edgeDepthM ?? 0.7, deep = spec.deepM ?? 9;
  const cut = spec.cutSlope ?? 1.4, fill = spec.fillSlope ?? 1.0, reach = spec.reachM ?? 110;
  const hi = new Float32Array(nx * nz).fill(Infinity);
  const lo = new Float32Array(nx * nz).fill(-Infinity);
  const roadDistance = new Float32Array(nx * nz).fill(reach);
  const span = Math.ceil(reach / cellM);
  for (const road of spec.roads) {
    road.frames.forEach((frame, index) => {
      const bridge = road.bridge?.(index) ?? false;
      const ci = Math.round((frame.p.x - minX) / cellM), cj = Math.round((frame.p.z - minZ) / cellM);
      for (let j = Math.max(0, cj - span); j <= Math.min(nz - 1, cj + span); j++) {
        const z = minZ + j * cellM, dz = z - frame.p.z;
        for (let i = Math.max(0, ci - span); i <= Math.min(nx - 1, ci + span); i++) {
          const x = minX + i * cellM, dx = x - frame.p.x;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > reach) continue;
          const k = j * nx + i;
          if (d < roadDistance[k]!) roadDistance[k] = d;
          const y = frame.p.y;
          if (d < road.footprintM) { hi[k] = Math.min(hi[k]!, y - deep); continue; }
          const beyond = d - road.footprintM;
          const relief = spec.cutRelief ? Math.max(0, spec.cutRelief(x, z)) * Math.min(1, beyond / 6) : 0;
          hi[k] = Math.min(hi[k]!, y - edgeDepth + cut * beyond + relief);
          if (!bridge) lo[k] = Math.max(lo[k]!, y - edgeDepth - fill * beyond);
        }
      }
    });
  }
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    const natural = spec.natural(minX + i * cellM, minZ + j * cellM);
    heights[k] = Math.min(hi[k]!, Math.max(lo[k]!, natural));
  }
  const terrain: CarvedTerrain = {
    spec, nx, nz, heights, roadDistance,
    x: (i) => minX + i * cellM,
    z: (j) => minZ + j * cellM,
    heightAt(x, z): number {
      const fx = Math.min(nx - 1.000001, Math.max(0, (x - minX) / cellM)), fz = Math.min(nz - 1.000001, Math.max(0, (z - minZ) / cellM));
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
      const h00 = heights[j * nx + i]!, h10 = heights[j * nx + i + 1]!, h01 = heights[(j + 1) * nx + i]!, h11 = heights[(j + 1) * nx + i + 1]!;
      // Same diagonal as the mesh: (i,j)-(i+1,j+1).
      return u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h01 - h00) * v + (h11 - h01) * u;
    },
  };
  return terrain;
}

/** Triangle indices for the grid, optionally only cells accepted by `keep(i, j)`. Diagonal (i,j)-(i+1,j+1). */
export function terrainIndices(terrain: CarvedTerrain, keep: (i: number, j: number) => boolean = () => true): number[] {
  const { nx, nz } = terrain, indices: number[] = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (!keep(i, j)) continue;
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    // Counter-clockwise seen from above (+Y): a(i,j) -> d(i+1,j+1) -> b(i+1,j), then a -> c -> d.
    indices.push(a, d, b, a, c, d);
  }
  return indices;
}

/** Collision for the ground near the roads only: cars that clear a barrier tumble down real slopes. */
export function terrainCollision(terrain: CarvedTerrain, nearM: number, surfaceId: string): CollisionMeshData {
  const { nx } = terrain;
  const near = (i: number, j: number): boolean => {
    const k = j * nx + i;
    return Math.min(terrain.roadDistance[k]!, terrain.roadDistance[k + 1]!, terrain.roadDistance[k + nx]!, terrain.roadDistance[k + nx + 1]!) < nearM;
  };
  const indices = terrainIndices(terrain, near);
  const used = new Map<number, number>(), vertices: Vec3[] = [], remapped: number[] = [];
  for (const index of indices) {
    let mapped = used.get(index);
    if (mapped === undefined) {
      mapped = vertices.length; used.set(index, mapped);
      const i = index % nx, j = Math.floor(index / nx);
      vertices.push({ x: terrain.x(i), y: terrain.heights[index]!, z: terrain.z(j) });
    }
    remapped.push(mapped);
  }
  return { vertices, indices: remapped, surfaceId, drivableRoad: false };
}
