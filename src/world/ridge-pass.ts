import type { CollisionMeshData } from '../../contracts/world-contracts';
import { buildRoadRibbon, ribbonBarrier, ribbonStrip, type RoadControl, type RoadRibbon, type RoadSpec } from './road-ribbon';
import { carveTerrain, terrainCollision, type CarvedTerrain } from './terrain';

/**
 * RP-01 "Seven Bends": a closed night touge on the north face of a ridge. The lap runs west along a
 * cliffside road (a viaduct over a ravine with the city 180 m below), climbs three switchbacks, weaves
 * through the summit esses and drops down three more hairpins on the east side. Geometry is authored
 * in district-local metres and placed at RIDGE_ORIGIN, far from the harbour, in the same world.
 */
export const RIDGE_ORIGIN = { x: 3000, y: 0, z: 0 } as const;
export const RIDGE_ROAD_WIDTH_M = 10;
export const RIDGE_SHOULDER_M = 1.2;
/** Inner face of the guardrail / wall, metres from the centreline. */
export const RIDGE_BARRIER_LAT_M = RIDGE_ROAD_WIDTH_M / 2 + RIDGE_SHOULDER_M + 0.15;
export const RIDGE_ROAD_SURFACE = 'road:ridge:rp01';

function arc(cx: number, cz: number, r: number, fromDeg: number, toDeg: number, y0: number, y1: number, steps = 6, skipEnd = false): RoadControl[] {
  const out: RoadControl[] = [];
  const last = skipEnd ? steps - 1 : steps;
  for (let k = 0; k <= last; k++) {
    const t = k / steps, a = (fromDeg + (toDeg - fromDeg) * t) * Math.PI / 180;
    out.push([cx + r * Math.cos(a), y0 + (y1 - y0) * t, cz + r * Math.sin(a)]);
  }
  return out;
}

/** Driving order (westbound start on the cliff road). Hairpin centreline radius 17 m, legs 34 m apart. */
export const RIDGE_CONTROLS: readonly RoadControl[] = [
  // Cliff road, westbound, sweeping north over the ravine viaduct.
  [170, 14, 150], [148, 13.4, 150.6], [110, 12.2, 155], [62, 10.4, 167], [12, 8.8, 177], [-38, 9.2, 172], [-88, 10.4, 158],
  [-128, 11.5, 151.2], [-153, 12, 150],
  // H1 (right), west end.
  ...arc(-170, 133, 17, 90, 270, 12.3, 15.2),
  // A2 east.
  [-153, 16.4, 116], [-120, 19.2, 116], [-88, 22, 116], [-76, 23, 116],
  // H2 (left), east end of the west climb.
  ...arc(-60, 99, 17, 90, -90, 24, 27),
  // A3 west.
  [-76, 28, 82], [-108, 31, 82], [-138, 33.8, 82], [-154, 35, 82],
  // H3 (right).
  ...arc(-170, 65, 17, 90, 270, 36, 39),
  // Summit esses, eastbound.
  [-152, 40, 48], [-124, 41.6, 46.5], [-94, 43.4, 38], [-64, 45, 27], [-34, 46.2, 30], [-4, 46.4, 41], [26, 45.8, 36],
  [56, 44.6, 23], [86, 43.2, 27], [114, 41.6, 39.5], [140, 40.4, 46.8], [154, 40, 48],
  // H4 (right), east end.
  ...arc(170, 65, 17, -90, 90, 39.4, 36.6),
  // D1 west.
  [154, 35.6, 82], [122, 33, 82], [92, 30.2, 82], [76, 29, 82],
  // H5 (left).
  ...arc(60, 99, 17, 270, 90, 28, 25),
  // D2 east.
  [76, 24, 116], [106, 21.4, 116], [138, 18.6, 116], [154, 17.3, 116],
  // H6 (right), back down onto the cliff road.
  ...arc(170, 133, 17, -90, 90, 16.4, 14.2, 6, true),
];

export const RIDGE_SPEC: RoadSpec = {
  id: 'RP-01', name: 'Seven Bends', district: 'ridge', version: 'rp01-v1', roadId: RIDGE_ROAD_SURFACE,
  widthM: RIDGE_ROAD_WIDTH_M, origin: RIDGE_ORIGIN, controls: RIDGE_CONTROLS, spacingM: 2,
  bankGain: 1.1, maxBankRad: 0.07, bankSmoothM: 20,
  spawnAt: [104, 156], gatePrefix: 'RP01',
  gateFractions: [0.11, 0.23, 0.36, 0.5, 0.63, 0.76, 0.88],
  clippingZones: [],
};

const fract = (v: number): number => v - Math.floor(v);
const hash = (x: number, z: number): number => fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) { sum += amp * valueNoise(x * f, z * f); f *= 2.03; amp *= 0.5; }
  return sum;
}
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Natural ground in district-local coordinates: mountain to the south, slope, cliff, valley floor to the north. */
export function ridgeNaturalLocal(x: number, z: number): number {
  const slope = 46 - (Math.min(z, 200) - 48) * 0.36;
  const mountain = 46 + Math.min(48 - z, 420) * 0.62 + 34 * fbm(x * 0.006 + 3.1, z * 0.006) * smooth(48, -160, z);
  let y = z < 48 ? mountain + (slope - mountain) * smooth(30, 48, z) : slope;
  // The cliff: a 175 m drop to the valley floor between z 165 and 250.
  y -= 175 * smooth(165, 252, z) * (0.85 + 0.15 * fbm(x * 0.02, 7.7));
  // Ravine under the viaduct, opening onto the cliff.
  y -= 34 * Math.exp(-(((x - 14) / 22) ** 2)) * smooth(140, 200, z);
  // Flanking spurs close the amphitheatre east and west.
  y += Math.max(0, Math.abs(x) - 230) * 0.55 * smooth(300, 120, z);
  // Rock texture and broad undulation.
  y += (fbm(x * 0.03, z * 0.03) - 0.5) * 7 * smooth(250, 200, z) + (fbm(x * 0.004 + 9, z * 0.004 + 2) - 0.5) * 22 * smooth(220, 400, z);
  return y;
}
export const ridgeNatural = (x: number, z: number): number => ridgeNaturalLocal(x - RIDGE_ORIGIN.x, z - RIDGE_ORIGIN.z);

export interface RidgePass {
  readonly ribbon: RoadRibbon;
  readonly terrain: CarvedTerrain;
  /** Frames carried by the viaduct deck (no embankment under them). */
  readonly bridge: (index: number) => boolean;
  /** +1 where the ground falls away beside the road on that side (guardrail), -1 where it rises (rock cut). */
  readonly drop: readonly { left: boolean; right: boolean }[];
  readonly collisionMeshes: readonly CollisionMeshData[];
}

let cached: RidgePass | null = null;
/** Deterministic and cached: world collision and scenery share the exact same geometry. */
export function buildRidgePass(): RidgePass {
  if (cached) return cached;
  const ribbon = buildRoadRibbon(RIDGE_SPEC);
  const frames = ribbon.frames;
  const bridge = (index: number): boolean => {
    const p = frames[index]!.p, lx = p.x - RIDGE_ORIGIN.x, lz = p.z - RIDGE_ORIGIN.z;
    return lz > 158 && lx > -26 && lx < 52;
  };
  const footprint = RIDGE_BARRIER_LAT_M + 0.6;
  const terrain = carveTerrain({
    minX: RIDGE_ORIGIN.x - 340, maxX: RIDGE_ORIGIN.x + 340, minZ: RIDGE_ORIGIN.z - 180, maxZ: RIDGE_ORIGIN.z + 300, cellM: 4,
    natural: ridgeNatural, roads: [{ frames, footprintM: footprint, bridge }], cutSlope: 1.35, fillSlope: 1.05,
    cutRelief: (x, z) => (fbm(x * 0.07, z * 0.07) - 0.35) * 9,
  });
  const drop = frames.map(frame => {
    const side = (s: -1 | 1): boolean => {
      const x = frame.p.x + frame.h.x * s * (footprint + 4), z = frame.p.z + frame.h.z * s * (footprint + 4);
      return terrain.heightAt(x, z) < frame.p.y - 0.3;
    };
    return { left: side(-1), right: side(1) };
  });
  const half = RIDGE_ROAD_WIDTH_M / 2 + RIDGE_SHOULDER_M;
  const collisionMeshes: CollisionMeshData[] = [
    // Carriageway and shoulders are one seamless drivable strip: no lip, no off-road penalty for using the edge.
    ribbonStrip(frames, -half, half, 0, RIDGE_ROAD_SURFACE, true),
    ribbonBarrier(frames, -1, RIDGE_BARRIER_LAT_M, -0.2, 0.92, 0.4, 'barrier:ridge:rp01:left'),
    ribbonBarrier(frames, 1, RIDGE_BARRIER_LAT_M, -0.2, 0.92, 0.4, 'barrier:ridge:rp01:right'),
    terrainCollision(terrain, 28, 'ground:ridge:rp01'),
  ];
  cached = { ribbon, terrain, bridge, drop, collisionMeshes };
  return cached;
}
