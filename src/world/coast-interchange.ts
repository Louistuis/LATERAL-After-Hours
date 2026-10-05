import type { CollisionMeshData } from '../../contracts/world-contracts';
import { buildRoadRibbon, ribbonBarrier, ribbonStrip, type RoadControl, type RoadRibbon, type RoadSpec } from './road-ribbon';
import { carveTerrain, terrainCollision, type CarvedTerrain } from './terrain';

/**
 * CL-01 "Neon Interchange": an urban highway loop on the bay front of Neon Bay. The lap launches off a
 * ground-level ramp onto an elevated three-lane deck between towers, weaves an S over the boulevard,
 * swings round a 90 m banked sweeper above the water, drops down the promenade into a light-strip tunnel
 * under the plaza and climbs back out through two tight right-handers. Placed at COAST_ORIGIN in the one world.
 */
export const COAST_ORIGIN = { x: -3000, y: 0, z: 0 } as const;
export const COAST_ROAD_WIDTH_M = 14;
export const COAST_SHOULDER_M = 1;
export const COAST_BARRIER_LAT_M = COAST_ROAD_WIDTH_M / 2 + COAST_SHOULDER_M + 0.1;
export const COAST_ROAD_SURFACE = 'road:coast:cl01';

function arc(cx: number, cz: number, r: number, fromDeg: number, toDeg: number, y0: number, y1: number, steps: number, skipEnd = false): RoadControl[] {
  const out: RoadControl[] = [];
  for (let k = 0; k <= (skipEnd ? steps - 1 : steps); k++) {
    const t = k / steps, a = (fromDeg + (toDeg - fromDeg) * t) * Math.PI / 180;
    out.push([cx + r * Math.cos(a), y0 + (y1 - y0) * t, cz + r * Math.sin(a)]);
  }
  return out;
}

export const COAST_CONTROLS: readonly RoadControl[] = [
  // Ramp up onto the elevated deck, eastbound, then an S over the boulevard.
  [-205, 9.5, -80], [-160, 11.6, -80], [-115, 15.2, -80], [-70, 18.6, -78], [-25, 20, -68], [20, 20, -76], [62, 20, -88],
  // The bay sweeper: 90 m radius, banked, above the water's edge.
  ...arc(100, 10, 90, -90, 90, 20, 14.6, 8),
  // Promenade, westbound, descending to street level with a kink.
  [58, 12.6, 104], [18, 8.8, 110], [-22, 5, 100], [-56, 1.8, 96],
  // The tunnel under the plaza.
  [-92, -1.8, 100], [-134, -4.6, 101],
  // Two right-handers climbing back to the ramp.
  ...arc(-180, 40, 60, 90, 180, -3.6, 1.4, 4),
  [-240, 3.4, 0], [-240, 5, -30],
  ...arc(-205, -45, 35, 180, 270, 6.4, 9.2, 4, true),
];

export const COAST_SPEC: RoadSpec = {
  id: 'CL-01', name: 'Neon Interchange', district: 'coast', version: 'cl01-v1', roadId: COAST_ROAD_SURFACE,
  widthM: COAST_ROAD_WIDTH_M, origin: COAST_ORIGIN, controls: COAST_CONTROLS, spacingM: 2,
  bankGain: 4.5, maxBankRad: 0.09, bankSmoothM: 30,
  spawnAt: [-150, -80], gatePrefix: 'CL01',
  gateFractions: [0.12, 0.25, 0.37, 0.5, 0.62, 0.74, 0.87],
  clippingZones: [],
};

/** Tunnel span (district-local x) under the plaza. */
export const COAST_TUNNEL = { minX: -184, maxX: -84, z: 100 } as const;

export interface CoastInterchange {
  readonly ribbon: RoadRibbon;
  readonly terrain: CarvedTerrain;
  /** Deck frames: elevated, no embankment under them. */
  readonly elevated: (index: number) => boolean;
  readonly tunnel: (index: number) => boolean;
  readonly collisionMeshes: readonly CollisionMeshData[];
}

let cached: CoastInterchange | null = null;
export function buildCoastInterchange(): CoastInterchange {
  if (cached) return cached;
  const ribbon = buildRoadRibbon(COAST_SPEC);
  const frames = ribbon.frames;
  const elevated = (index: number): boolean => frames[index]!.p.y > 3.2;
  const tunnel = (index: number): boolean => {
    const lx = frames[index]!.p.x - COAST_ORIGIN.x;
    return frames[index]!.p.y < -1 && lx > COAST_TUNNEL.minX && lx < COAST_TUNNEL.maxX;
  };
  const terrain = carveTerrain({
    minX: COAST_ORIGIN.x - 330, maxX: COAST_ORIGIN.x + 290, minZ: COAST_ORIGIN.z - 220, maxZ: COAST_ORIGIN.z + 160, cellM: 4,
    natural: () => 0, roads: [{ frames, footprintM: COAST_BARRIER_LAT_M + 0.6, bridge: elevated }],
    cutSlope: 3.5, fillSlope: 3.5, edgeDepthM: 0.25,
  });
  const half = COAST_ROAD_WIDTH_M / 2 + COAST_SHOULDER_M;
  const collisionMeshes: CollisionMeshData[] = [
    ribbonStrip(frames, -half, half, 0, COAST_ROAD_SURFACE, true),
    ribbonBarrier(frames, -1, COAST_BARRIER_LAT_M, -0.2, 1.1, 0.5, 'barrier:coast:cl01:left'),
    ribbonBarrier(frames, 1, COAST_BARRIER_LAT_M, -0.2, 1.1, 0.5, 'barrier:coast:cl01:right'),
    terrainCollision(terrain, 26, 'ground:coast:cl01'),
  ];
  cached = { ribbon, terrain, elevated, tunnel, collisionMeshes };
  return cached;
}
