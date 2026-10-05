import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AtmosphereRecipe } from './atmosphere';
import { neonTexture } from './harbor-dressing';
import {
  createGlowSprites, createLightUniforms, createRoadStuds, createWetStreaks, type GlowInstance, type StudInstance, type WetStreakInstance,
} from './light-sprites';
import { createMovingLights, type MovingLight } from './light-trails';
import { dataTexture, hdr, mulberry32, stripGeometry, type DistrictScenery, type SharedWorldMaterials } from './ridge-scenery';
import { framePoint, type RoadFrame } from '../world/road-ribbon';
import { buildCoastInterchange, COAST_BARRIER_LAT_M, COAST_ORIGIN, COAST_ROAD_WIDTH_M } from '../world/coast-interchange';

export const COAST_SCENERY_VERSION = 'coast-scenery-v1';

const UP = new THREE.Vector3(0, 1, 0);
/** Raised plaza deck over the tunnel, metres above street level. */
const PLAZA_Y = 4.6;
const PLAZA_HALF_M = 18;
const WALL_M = 0.5;

/** District-local water: the bay east of the seawall and the harbour mouth north of the promenade. */
function isWater(lx: number, lz: number): boolean {
  return lx < 1300 && lx > -2400 && ((lx > 200 && lz > -2000 && lz < 2000) || (lz > 150 && lz < 1300));
}

/** LED strips: a slow chase of light running along the tunnel and under the deck edges. */
const LED_VERTEX = /* glsl */`
  varying float vS;
  varying vec3 vWorld;
  void main() { vS = uv.y * 3.0; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const LED_FRAGMENT = /* glsl */`
  uniform float uTime;
  uniform float uScale;
  uniform float uFogDensity;
  uniform vec3 uFog;
  uniform vec3 uA;
  uniform vec3 uB;
  varying float vS;
  varying vec3 vWorld;
  void main() {
    float band = fract(vS / 36.0 - uTime * 0.9);
    float chase = exp(-pow((band - 0.5) * 9.0, 2.0));
    vec3 col = mix(uA, uB, 0.5 + 0.5 * sin(vS * 0.021 + uTime * 0.15)) * (0.8 + 2.2 * chase) * uScale;
    col = mix(uFog, col, exp(-distance(vWorld, cameraPosition) * uFogDensity * 0.6));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Night towers: dark boxes whose faces carry a hashed grid of lit windows (warm, cool and the odd neon floor).
 * Instanced unit boxes, axis-aligned. With `haze`, scene fog is replaced by a gentler linear haze so a distant
 * skyline keeps its windows through dense harbour fog.
 */
export function createWindowTowerMaterial(name: string, haze?: { color: THREE.IUniform<THREE.Color>; density: THREE.IUniform<number> }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ name, color: '#ffffff', fog: !haze });
  material.onBeforeCompile = shader => {
    if (haze) { shader.uniforms.uHaze = haze.color; shader.uniforms.uHazeDensity = haze.density; }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCityWorld;\nvarying vec3 vCityNormal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCityWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;\nvCityNormal = normal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vCityWorld;
varying vec3 vCityNormal;
${haze ? 'uniform vec3 uHaze;\nuniform float uHazeDensity;' : ''}
float cityHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `vec4 diffuseColor = vec4( vec3(0.02, 0.022, 0.034), opacity );
{
  float along = abs(vCityNormal.x) > 0.5 ? vCityWorld.z : vCityWorld.x;
  vec2 cell = vec2(floor(along / 3.0), floor(vCityWorld.y / 3.4));
  vec2 f = vec2(fract(along / 3.0), fract(vCityWorld.y / 3.4));
  float pane = step(0.14, f.x) * step(f.x, 0.86) * step(0.22, f.y) * step(f.y, 0.8);
  vec2 block = floor(vCityWorld.xz / 41.0);
  float lit = step(0.55, cityHash(cell + block * 7.3));
  float tone = cityHash(cell * 1.7 + block);
  vec3 warm = tone < 0.55 ? vec3(1.0, 0.66, 0.36) : tone < 0.85 ? vec3(0.72, 0.86, 1.0) : tone < 0.93 ? vec3(1.0, 0.35, 0.8) : vec3(0.35, 0.95, 1.0);
  float floorBand = step(0.92, cityHash(vec2(cell.y, block.x + block.y)));
  float roof = step(0.5, vCityNormal.y);
  diffuseColor.rgb += warm * pane * max(lit, floorBand) * (1.0 - roof) * 1.15;
}`);
    if (haze) shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>',
      '#include <fog_fragment>\n  gl_FragColor.rgb = mix(uHaze, gl_FragColor.rgb, exp(-distance(vCityWorld, cameraPosition) * uHazeDensity));');
  };
  if (haze) material.customProgramCacheKey = () => 'window-tower-haze';
  return material;
}

interface Tower { x: number; z: number; w: number; d: number; h: number; far: boolean }

/**
 * CL-01 Neon Bay: an elevated urban loop on the bay front. Wet concrete decks outlined in LED light between
 * window-lit towers and neon signs, a light-strip tunnel under a raised plaza, a cable-stayed bridge across
 * the bay and a skyline beyond. Visual only; collision comes from src/world/coast-interchange.
 */
export function createCoastScenery(shared: SharedWorldMaterials = {}): DistrictScenery {
  const coast = buildCoastInterchange();
  const { frames, lengthM } = coast.ribbon;
  const n = frames.length;
  const root = new THREE.Group();
  root.name = 'district-coast';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(item: T): T => { disposables.push(item); return item; };
  const O = COAST_ORIGIN;
  const half = COAST_ROAD_WIDTH_M / 2, lat = COAST_BARRIER_LAT_M;
  const W = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x + O.x, y, z + O.z);
  const rng = mulberry32(0xc0a57);
  const T = (i: number): boolean => coast.tunnel((i + n) % n);
  const E = (i: number): boolean => coast.elevated((i + n) % n);
  const roadY = (i: number): number => frames[(i + n) % n]!.p.y;
  const yawOf = (v: THREE.Vector3): number => Math.atan2(v.x, v.z);
  const box = (center: THREE.Vector3, yaw: number, sx: number, sy: number, sz: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(sx, sy, sz).rotateY(yaw).translate(center.x, center.y, center.z);
  const beam = (a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry => {
    const geometry = new THREE.BoxGeometry(thickness, thickness, a.distanceTo(b));
    const matrix = new THREE.Matrix4().lookAt(a, b, UP).setPosition(a.clone().add(b).multiplyScalar(0.5));
    return geometry.applyMatrix4(matrix);
  };
  /** True when (x, z) is at least `clearM` from every road frame more than `skipM` of road away from frame `index`. */
  const clearOfRoad = (x: number, z: number, clearM: number, index = -1, skipM = 0): boolean => {
    for (let i = 0; i < n; i += 2) {
      if (index >= 0) {
        const ds = Math.abs(frames[i]!.s - frames[index]!.s);
        if (Math.min(ds, lengthM - ds) < skipM) continue;
      }
      if ((frames[i]!.p.x - x) ** 2 + (frames[i]!.p.z - z) ** 2 < clearM * clearM) return false;
    }
    return true;
  };

  // ------------------------------------------------------------------ materials
  const asphalt = shared.asphalt ?? own(new THREE.MeshStandardMaterial({ name: 'road-asphalt', color: '#3a3f42', roughness: 0.85 }));
  const concrete = shared.concrete ?? own(new THREE.MeshStandardMaterial({ name: 'concrete-weathered', color: '#8d8a83', roughness: 0.94 }));
  const water = shared.water ?? own(new THREE.MeshStandardMaterial({ name: 'coast-bay-water', color: '#0b2230', roughness: 0.12, metalness: 0.4 }));
  const paint = own(new THREE.MeshStandardMaterial({ name: 'coast-road-paint', color: '#d8d6cf', roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const darkSteel = own(new THREE.MeshStandardMaterial({ name: 'coast-dark-steel', color: '#2a2f36', roughness: 0.5, metalness: 0.6 }));
  const ground = own(new THREE.MeshStandardMaterial({ name: 'coast-street', color: '#24272b', roughness: 0.62, metalness: 0.05 }));

  // ------------------------------------------------------------------ road surface (visual = collider) and paint
  const uAt = (l: number): number => (l + half) / COAST_ROAD_WIDTH_M * 4.5;
  const road = new THREE.Mesh(own(stripGeometry(frames, lengthM, frame =>
    [-lat, -half, half, lat].map(l => ({ position: framePoint(frame, l, 0.004), u: uAt(l) })), frame => frame.n)), asphalt);
  road.name = 'coast-road-surface';
  road.receiveShadow = true;
  // Four 3.5 m lanes: solid centre and edge lines, dashed lane lines.
  const line = (l0: number, l1: number, dashed: boolean): THREE.BufferGeometry => stripGeometry(frames, lengthM, frame =>
    dashed && frame.s % 12 > 5 ? null : [l0, l1].map(l => ({ position: framePoint(frame, l, 0.02), u: 0 })), frame => frame.n);
  const lineParts = [line(-0.13, 0.13, false), line(-half + 0.17, -half + 0.32, false), line(half - 0.32, half - 0.17, false),
    line(-3.58, -3.42, true), line(3.42, 3.58, true)];
  const lines = new THREE.Mesh(own(mergeGeometries(lineParts)!), paint);
  lineParts.forEach(geometry => geometry.dispose());
  lines.name = 'coast-road-lines';
  lines.receiveShadow = true;
  root.add(road, lines);

  // ------------------------------------------------------------------ walls, deck, tunnel, plaza
  const concreteParts: THREE.BufferGeometry[] = [];
  const ceilOff = (i: number): number => Math.min(5.4, PLAZA_Y - 0.4 - roadY(i));
  const topOff = (i: number): number => Math.max(1.1, 0.5 - roadY(i));
  const bottomOff = (i: number): number => E(i) ? -1.7 : Math.min(-0.6, -0.3 - roadY(i));
  const openRow = (i: number): boolean => !T(i) || !T(i - 1);
  const tunnelRow = (i: number): boolean => T(i) || T(i - 1);
  for (const side of [-1, 1] as const) {
    const at = (frame: RoadFrame, across: number, height: number): THREE.Vector3 =>
      framePoint(frame, side * lat, 0).addScaledVector(frame.h, side * across).add(new THREE.Vector3(0, height, 0));
    // Open road: barrier inner face, retaining wall in cuttings, top, outer face / deck fascia.
    const open = (i: number): (readonly [number, number])[] => [[0, -0.2], [0, 0.25], [0.08, 0.4], [0.12, topOff(i)], [WALL_M, topOff(i)], [WALL_M, bottomOff(i)]];
    const tube = (i: number): (readonly [number, number])[] => [[0, -0.2], [0, 0.25], [0.08, 0.4], [0.12, 1.1], [WALL_M, 1.1], [WALL_M, ceilOff(i)]];
    for (const [profile, include] of [[open, openRow], [tube, tunnelRow]] as const) {
      for (let k = 0; k < 5; k++) {
        concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => {
          if (!include(i)) return null;
          const pts = profile(i);
          return [pts[k]!, pts[k + 1]!].map(([across, height], c) => ({ position: at(frame, across, height), u: c * 0.5 }));
        }, undefined, side < 0));
      }
    }
    // Plaza sides over the tunnel.
    concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => tunnelRow(i)
      ? [PLAZA_Y, -0.3].map((y, c) => ({ position: frame.p.clone().addScaledVector(frame.h, side * PLAZA_HALF_M).setY(y), u: c * 1.5 })) : null,
    undefined, side < 0));
  }
  // Tunnel ceiling (faces down), plaza lid (faces up), deck underside (faces down).
  concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => tunnelRow(i)
    ? [-lat - WALL_M, lat + WALL_M].map(l => ({ position: framePoint(frame, l, 0).setY(frame.p.y + ceilOff(i)), u: l / 3 })) : null, undefined, true));
  concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => tunnelRow(i)
    ? [-PLAZA_HALF_M, PLAZA_HALF_M].map(l => ({ position: frame.p.clone().addScaledVector(frame.h, l).setY(PLAZA_Y), u: l / 3 })) : null, () => UP));
  concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => E(i) || E(i - 1)
    ? [-lat - WALL_M, lat + WALL_M].map(l => ({ position: framePoint(frame, l, 0).setY(frame.p.y - 1.7), u: l / 3 })) : null, undefined, true));
  // Portal faces at both tunnel mouths.
  let entry = -1, exit = -1;
  for (let i = 0; i < n; i++) {
    if (T(i) && !T(i - 1)) entry = i;
    if (!T(i) && T(i - 1)) exit = i;
  }
  const portals = [entry, exit].filter(i => i >= 0);
  for (const i of portals) {
    const frame = frames[i]!, yaw = yawOf(frame.t), ceil = frame.p.y + ceilOff(i), inner = lat + WALL_M;
    concreteParts.push(box(frame.p.clone().setY((ceil + PLAZA_Y) / 2), yaw, inner * 2, PLAZA_Y - ceil, 0.8));
    for (const side of [-1, 1] as const) {
      const width = PLAZA_HALF_M - inner, bottom = frame.p.y - 0.6;
      concreteParts.push(box(frame.p.clone().addScaledVector(frame.h, side * (inner + width / 2)).setY((bottom + PLAZA_Y) / 2), yaw, width, PLAZA_Y - bottom, 0.8));
    }
  }
  // Route piers: a column and a cap under the deck every ~26 m, never standing on another stretch of road.
  const pierRows: THREE.Matrix4[] = [];
  let lastPier = -Infinity;
  frames.forEach((frame, i) => {
    if (!E(i) || frame.s - lastPier < 26) return;
    if (!clearOfRoad(frame.p.x, frame.p.z, 11, i, 40)) return;
    lastPier = frame.s;
    const yaw = yawOf(frame.t), top = frame.p.y - 1.7, groundY = Math.min(0, coast.terrain.heightAt(frame.p.x, frame.p.z)) - 0.5;
    const capH = 1.2, colH = top - capH - groundY;
    if (colH < 0.8) return;
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    pierRows.push(new THREE.Matrix4().compose(frame.p.clone().setY(groundY + colH / 2), q, new THREE.Vector3(2.6, colH, 2.6)));
    pierRows.push(new THREE.Matrix4().compose(frame.p.clone().setY(top - capH / 2), q, new THREE.Vector3((lat + WALL_M) * 1.6, capH, 2.6)));
  });
  // Decorative upper expressway crossing the whole district north-south at x = 40, 36 m up.
  const UPPER_X = 40, UPPER_Y = 36, UPPER_Z0 = -900, UPPER_Z1 = 1250;
  {
    const len = UPPER_Z1 - UPPER_Z0, cz = (UPPER_Z0 + UPPER_Z1) / 2;
    concreteParts.push(box(W(UPPER_X, UPPER_Y, cz), 0, 17, 1.6, len));
    for (const s of [-1, 1]) concreteParts.push(box(W(UPPER_X + s * 8.3, UPPER_Y + 1.2, cz), 0, 0.4, 1.0, len));
    for (let z = UPPER_Z0 + 20; z < UPPER_Z1; z += 44) {
      const p = W(UPPER_X, 0, z);
      if (!clearOfRoad(p.x, p.z, 13)) continue;
      const base = isWater(UPPER_X, z) ? -4 : -0.5;
      pierRows.push(new THREE.Matrix4().compose(p.clone().setY((base + UPPER_Y - 1.6) / 2), new THREE.Quaternion(), new THREE.Vector3(3, UPPER_Y - 1.6 - base, 3)));
      pierRows.push(new THREE.Matrix4().compose(p.clone().setY(UPPER_Y - 1.4), new THREE.Quaternion(), new THREE.Vector3(14, 1.2, 3.2)));
    }
  }
  // Seawall along the bay and the harbour mouth.
  concreteParts.push(box(W(200, -1.4, -900), 0, 1.2, 3, 2100), box(W(-1100, -1.4, 150), 0, 2600, 3, 1.2));
  const concreteMesh = new THREE.Mesh(own(mergeGeometries(concreteParts)!), concrete);
  concreteParts.forEach(geometry => geometry.dispose());
  concreteMesh.name = 'coast-walls-decks-tunnel';
  concreteMesh.castShadow = true; concreteMesh.receiveShadow = true;
  const piers = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), concrete, Math.max(1, pierRows.length));
  pierRows.forEach((matrix, i) => piers.setMatrixAt(i, matrix));
  piers.count = pierRows.length;
  piers.name = 'coast-piers';
  piers.castShadow = true; piers.receiveShadow = true;
  root.add(concreteMesh, piers);

  // ------------------------------------------------------------------ ground: carved street grid, far land, bay water
  const terrain = coast.terrain;
  const near = new THREE.BufferGeometry();
  {
    const { nx, nz, heights } = terrain;
    const positions = new Float32Array(nx * nz * 3), uvs = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = terrain.x(i), z = terrain.z(j);
      positions.set([x, heights[k]!, z], k * 3);
      uvs.set([(x - O.x) / 6, (z - O.z) / 6], k * 2);
    }
    near.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    near.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const indices: number[] = [];
    // Untouched street level is flat: runs of flat cells along a row become one quad (the carved cuts and ramps
    // keep the full grid). Same surface, a fraction of the triangles.
    const flat = (k: number): boolean => Math.abs(heights[k]!) < 1e-3;
    for (let j = 0; j < nz - 1; j++) {
      let run = -1;
      const flush = (end: number): void => {
        if (run < 0) return;
        const a = j * nx + run, b = j * nx + end, c = a + nx, d = b + nx;
        indices.push(a, d, b, a, c, d);
        run = -1;
      };
      for (let i = 0; i < nx - 1; i++) {
        const cx = terrain.x(i) + terrain.spec.cellM / 2 - O.x, cz = terrain.z(j) + terrain.spec.cellM / 2 - O.z;
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        if (isWater(cx, cz)) { flush(i); continue; }
        if (flat(a) && flat(b) && flat(c) && flat(d)) { if (run < 0) run = i; continue; }
        flush(i);
        indices.push(a, d, b, a, c, d);
      }
      flush(nx - 1);
    }
    near.setIndex(indices);
    near.computeVertexNormals();
  }
  const nearMesh = new THREE.Mesh(own(near), ground);
  nearMesh.name = 'coast-ground-near';
  nearMesh.receiveShadow = true;
  const nMin = { x: terrain.spec.minX - O.x, z: terrain.spec.minZ - O.z };
  const plane = (x0: number, x1: number, z0: number, z1: number, y: number): THREE.BufferGeometry => {
    const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2 + O.x, y, (z0 + z1) / 2 + O.z);
    const uv = geometry.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (x1 - x0) / 6, uv.getY(k) * (z1 - z0) / 6);
    return geometry;
  };
  const landParts = [plane(-2400, nMin.x, -2400, 150, 0), plane(nMin.x, 200, -2400, nMin.z, 0), plane(1300, 2600, -2400, 2400, 0), plane(-2400, 1300, 1300, 2400, 0)];
  const land = new THREE.Mesh(own(mergeGeometries(landParts)!), ground);
  landParts.forEach(geometry => geometry.dispose());
  land.name = 'coast-ground-far';
  const waterParts = [plane(200, 1300, -2400, 2400, -2), plane(-2400, 200, 150, 1300, -2)];
  const bay = new THREE.Mesh(own(mergeGeometries(waterParts)!), water);
  waterParts.forEach(geometry => geometry.dispose());
  bay.name = 'coast-bay-water';
  bay.receiveShadow = true;
  root.add(nearMesh, land, bay);

  // ------------------------------------------------------------------ towers with lit windows and neon crowns
  const towerMaterial = own(createWindowTowerMaterial('coast-towers'));
  const towers: Tower[] = [];
  const nearClear = (x: number, z: number, w: number, d: number): boolean => {
    for (const [fx, fz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const lx = x + fx * w / 2, lz = z + fz * d / 2;
      if (isWater(lx, lz)) return false;
      if (Math.abs(lx - UPPER_X) < 12) return false;
      if (Math.abs(lz + 112) < 9 || Math.abs(lx + 285) < 9) return false;             // boulevards
      if (lx > -195 && lx < -70 && Math.abs(lz - 100) < 24) return false;              // plaza
      if (!clearOfRoad(lx + O.x, lz + O.z, 13)) return false;
    }
    return true;
  };
  const addTower = (x: number, z: number, w: number, d: number, h: number, far: boolean): void => { towers.push({ x, z, w, d, h, far }); };
  // Neon signs hang on the towers that frame the road, so those towers are placed first.
  interface Sign { position: THREE.Vector3; yaw: number; word: number; width: number }
  const signs: Sign[] = [];
  const WORDS: readonly (readonly [string, string])[] = [
    ['NEON BAY', '#ff3fb4'], ['AFTER HOURS', '#38e8ff'], ['KARAOKE', '#ff4fd8'], ['RAMEN', '#ff7a3a'],
    ['HOTEL', '#ffd04a'], ['OPEN 24H', '#5aff9a'], ['DRIFT', '#38e8ff'], ['NIGHT', '#b07bff'],
  ];
  const signFractions = [0.06, 0.14, 0.23, 0.31, 0.44, 0.56, 0.68, 0.79, 0.9];
  signFractions.forEach((fraction, k) => {
    const i = (coast.ribbon.spawnIndex + Math.round(fraction * n)) % n, frame = frames[i]!;
    if (T(i)) return;
    const side = k % 2 ? 1 : -1;
    const toRoad = frame.h.clone().multiplyScalar(-side);
    const axis = Math.abs(toRoad.x) > Math.abs(toRoad.z) ? new THREE.Vector3(Math.sign(toRoad.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(toRoad.z));
    const facade = framePoint(frame, side * (lat + 12), 0);
    const size = 18 + rng() * 8, h = Math.max(frame.p.y + 22, 34 + rng() * 50);
    const cx = facade.x - axis.x * size / 2 - O.x, cz = facade.z - axis.z * size / 2 - O.z;
    if (!nearClear(cx, cz, size, size)) return;
    addTower(cx, cz, size, size, h, false);
    const word = 1 + (k % (WORDS.length - 1));
    signs.push({ position: facade.clone().addScaledVector(axis, 0.45).setY(frame.p.y + 6 + rng() * 4), yaw: yawOf(axis), word, width: 0 });
  });
  for (let gz = nMin.z + 8; gz < 145; gz += 30) for (let gx = nMin.x + 8; gx < 195; gx += 30) {
    const w = 12 + rng() * 14, d = 12 + rng() * 14, x = gx + rng() * 6, z = gz + rng() * 6;
    if (rng() < 0.12 || !nearClear(x, z, w, d)) continue;
    if (towers.some(t => Math.abs(t.x - x) < (t.w + w) / 2 + 3 && Math.abs(t.z - z) < (t.d + d) / 2 + 3)) continue;
    const core = Math.exp(-Math.hypot(x + 300, z + 260) / 380);
    addTower(x, z, w, d, 14 + rng() * 26 + core * rng() * 110, false);
  }
  const nearCount = towers.length;
  const farTowers: Tower[] = [];
  const scatter = (x0: number, x1: number, z0: number, z1: number, step: number, density: (x: number, z: number) => number, height: (x: number, z: number) => number): void => {
    for (let gz = z0; gz < z1; gz += step) for (let gx = x0; gx < x1; gx += step) {
      const x = gx + rng() * step * 0.3, z = gz + rng() * step * 0.3;
      if (rng() > density(x, z) || isWater(x, z)) continue;
      const w = step * (0.35 + rng() * 0.35), d = step * (0.35 + rng() * 0.35);
      farTowers.push({ x, z, w, d, h: height(x, z) * (0.5 + rng() * 0.7), far: true });
    }
  };
  // Downtown to the south-west, the bay skyline to the east, and the far shore to the north.
  scatter(-1700, nMin.x - 10, -1700, 140, 46, (x, z) => 0.85 - Math.hypot(x + 700, z + 600) / 2600, (x, z) => 30 + 190 * Math.exp(-Math.hypot(x + 700, z + 600) / 420));
  scatter(nMin.x - 10, 190, -1700, nMin.z - 10, 46, () => 0.6, (x, z) => 30 + 90 * Math.exp(-Math.hypot(x + 100, z + 500) / 300));
  scatter(1330, 2300, -1500, 1500, 52, () => 0.75, (x, z) => 40 + 230 * Math.exp(-Math.hypot(x - 1650, z - 80) / 380));
  scatter(-1500, 1290, 1330, 2000, 58, () => 0.55, (x, z) => 25 + 120 * Math.exp(-Math.hypot(x - 300, z - 1500) / 450));
  for (let i = farTowers.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [farTowers[i], farTowers[j]] = [farTowers[j]!, farTowers[i]!]; }
  towers.push(...farTowers);
  // Tower boxes never show their underside: drop the -y face (BoxGeometry face order +x, -x, +y, -y, +z, -z).
  const towerBox = new THREE.BoxGeometry(1, 1, 1);
  towerBox.setIndex(Array.from(towerBox.index!.array).filter((_, k) => k < 18 || k >= 24));
  towerBox.clearGroups();
  const towerMesh = new THREE.InstancedMesh(own(towerBox), towerMaterial, Math.max(1, towers.length));
  towers.forEach((t, i) => towerMesh.setMatrixAt(i, new THREE.Matrix4().compose(W(t.x, t.h / 2 - 1, t.z), new THREE.Quaternion(), new THREE.Vector3(t.w, t.h + 2, t.d))));
  towerMesh.count = towers.length;
  towerMesh.name = 'coast-towers';
  root.add(towerMesh);

  // Neon crowns and bands on the taller towers, aviation beacons on the tallest.
  const NEON = [hdr(2.6, 0.35, 1.5), hdr(0.35, 1.9, 2.6), hdr(2.5, 0.6, 0.25), hdr(1.4, 0.6, 2.6), hdr(0.5, 2.4, 1.2)];
  const RED = hdr(3.2, 0.2, 0.12);
  const crowns: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
  const glow: GlowInstance[] = [];
  const cityGlow: GlowInstance[] = [];
  towers.forEach((t, k) => {
    if (t.h > 120) cityGlow.push({ position: W(t.x, t.h + 2, t.z), color: RED, size: 3.5, pulseSpeed: 1.7, pulseAmount: 0.9, phase: rng() * 6 });
    if (t.h < 55 || rng() > (t.far ? 0.3 : 0.6)) return;
    const color = NEON[k % NEON.length]!;
    const bands = !t.far && rng() < 0.3 ? [t.h - 0.6, t.h * 0.62] : [t.h - 0.6];
    for (const y of bands) {
      crowns.push({ matrix: new THREE.Matrix4().compose(W(t.x, y, t.z + t.d / 2 + 0.15), new THREE.Quaternion(), new THREE.Vector3(t.w + 0.6, 0.7, 0.3)), color });
      crowns.push({ matrix: new THREE.Matrix4().compose(W(t.x, y, t.z - t.d / 2 - 0.15), new THREE.Quaternion(), new THREE.Vector3(t.w + 0.6, 0.7, 0.3)), color });
      crowns.push({ matrix: new THREE.Matrix4().compose(W(t.x + t.w / 2 + 0.15, y, t.z), new THREE.Quaternion(), new THREE.Vector3(0.3, 0.7, t.d + 0.6)), color });
      crowns.push({ matrix: new THREE.Matrix4().compose(W(t.x - t.w / 2 - 0.15, y, t.z), new THREE.Quaternion(), new THREE.Vector3(0.3, 0.7, t.d + 0.6)), color });
    }
  });
  const crownMaterial = own(new THREE.MeshBasicMaterial({ name: 'coast-neon-crowns', color: '#ffffff', fog: true }));
  const crownMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), crownMaterial, Math.max(1, crowns.length));
  crowns.forEach((c, i) => { crownMesh.setMatrixAt(i, c.matrix); crownMesh.setColorAt(i, c.color); });
  crownMesh.count = crowns.length;
  crownMesh.name = 'coast-neon-crowns';
  root.add(crownMesh);

  // ------------------------------------------------------------------ steel: lamps, gantries, billboard poles, the bay bridge
  const steelParts: THREE.BufferGeometry[] = [];
  const studs: StudInstance[] = [];
  const streaks: WetStreakInstance[] = [];
  const lampPositions: THREE.Vector3[] = [];
  const LED = hdr(1.5, 1.7, 2.1);
  const lampRows: THREE.Matrix4[] = [], armRows: THREE.Matrix4[] = [];
  let lastLamp = -Infinity, lampSide: -1 | 1 = 1;
  frames.forEach((frame, i) => {
    if (T(i) || frame.s - lastLamp < 32) return;
    lastLamp = frame.s; lampSide = lampSide > 0 ? -1 : 1;
    const base = framePoint(frame, lampSide * (lat + 0.3), 0).setY(frame.p.y + topOff(i));
    const top = frame.p.y + 9;
    lampRows.push(new THREE.Matrix4().compose(base.clone().setY((base.y + top) / 2), new THREE.Quaternion(), new THREE.Vector3(1, top - base.y, 1)));
    const toRoad = frame.h.clone().multiplyScalar(-lampSide);
    armRows.push(new THREE.Matrix4().compose(base.clone().setY(top), new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-toRoad.z, toRoad.x)), new THREE.Vector3(1, 1, 1)));
    const lens = base.clone().setY(top - 0.25).addScaledVector(toRoad, 2.3);
    lampPositions.push(lens);
    glow.push({ position: lens.clone(), color: LED, size: 2.2, pulseSpeed: 1.2, pulseAmount: 0.02, phase: rng() * 6 });
    streaks.push({ position: lens.clone(), groundY: frame.p.y + 0.02, color: LED.clone().multiplyScalar(0.6) });
  });
  // Tunnel lights become real lights too (the strips themselves are emissive).
  frames.forEach((frame, i) => { if (T(i) && i % 12 === 0) lampPositions.push(frame.p.clone().setY(frame.p.y + ceilOff(i) - 0.4)); });
  const lampPoles = new THREE.InstancedMesh(own(new THREE.CylinderGeometry(0.08, 0.14, 1, 8)), darkSteel, Math.max(1, lampRows.length));
  const lampArms = new THREE.InstancedMesh(own(mergeGeometries([
    new THREE.BoxGeometry(2.5, 0.1, 0.1).translate(1.15, 0, 0), new THREE.BoxGeometry(1.1, 0.12, 0.36).translate(2.3, -0.1, 0),
  ])!), darkSteel, Math.max(1, armRows.length));
  lampRows.forEach((matrix, i) => lampPoles.setMatrixAt(i, matrix));
  armRows.forEach((matrix, i) => lampArms.setMatrixAt(i, matrix));
  lampPoles.count = lampRows.length; lampArms.count = armRows.length;
  lampPoles.name = 'coast-lamp-poles'; lampArms.name = 'coast-lamp-arms';
  root.add(lampPoles, lampArms);

  // Delineators on the wall tops and cat's eyes on the lane lines.
  const ICE = hdr(1.3, 1.6, 2.0), MAGENTA = hdr(1.8, 0.4, 1.4);
  frames.forEach((frame, i) => {
    if (i % 6 === 0) for (const side of [-1, 1] as const) {
      studs.push({ position: framePoint(frame, side * (lat + 0.1), 0).setY(frame.p.y + (T(i) ? 1.15 : topOff(i) + 0.05)), color: side < 0 ? MAGENTA : ICE });
    }
    if (i % 4 === 0) for (const l of [-3.5, 3.5]) studs.push({ position: framePoint(frame, l, 0.05), color: ICE.clone().multiplyScalar(0.4) });
  });

  // Overhead gantries with lit direction boards.
  const boardTexture = own(dataTexture(64, 32, (x, y) => {
    const border = x < 2 || x > 61 || y < 2 || y > 29;
    const text = (y > 8 && y < 13 && x > 8 && x < 44) || (y > 17 && y < 22 && x > 8 && x < 34) || (x > 48 && x < 56 && y > 9 && y < 22 && Math.abs(x - 52) < (22 - y) / 2 + 1);
    return border ? [235, 240, 235, 255] : text ? [240, 245, 240, 255] : [12, 92, 58, 255];
  }));
  const boardMaterial = own(new THREE.MeshStandardMaterial({ name: 'coast-gantry-board', map: boardTexture, emissiveMap: boardTexture, emissive: '#ffffff', emissiveIntensity: 0.5, roughness: 0.5 }));
  const boards: THREE.Matrix4[] = [];
  for (const offset of [36, Math.round(n * 0.36), Math.round(n * 0.9)]) {
    const i = (coast.ribbon.spawnIndex + offset) % n, frame = frames[i]!;
    if (T(i)) continue;
    const yaw = yawOf(frame.t), top = frame.p.y + 7.6;
    for (const side of [-1, 1] as const) {
      const base = framePoint(frame, side * (lat + 0.3), 0).setY(frame.p.y + topOff(i));
      steelParts.push(box(base.clone().setY((base.y + top) / 2), yaw, 0.45, top - base.y, 0.45));
    }
    steelParts.push(box(frame.p.clone().setY(top - 0.3), yaw, (lat + 0.3) * 2, 0.5, 0.5));
    for (const l of [-3.6, 3.6]) {
      const position = frame.p.clone().addScaledVector(frame.h, l).setY(frame.p.y + 6.1).addScaledVector(frame.t, -0.35);
      boards.push(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(UP, yaw + Math.PI), new THREE.Vector3(5.2, 2.3, 1)));
    }
  }
  const boardMesh = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)), boardMaterial, Math.max(1, boards.length));
  boards.forEach((matrix, i) => boardMesh.setMatrixAt(i, matrix));
  boardMesh.count = boards.length;
  boardMesh.name = 'coast-gantry-boards';
  root.add(boardMesh);

  // Billboards on poles beside the deck, facing oncoming traffic.
  const adTexture = own(dataTexture(64, 32, (x, y) => {
    if (x < 2 || x > 61 || y < 2 || y > 29) return [24, 24, 28, 255];
    if (y > 19 && y < 25 && x > 26 && x < 58) return [255, 255, 255, 255];
    if ((x - 14) ** 2 + (y - 15) ** 2 < 64) return [255, 245, 225, 255];
    if (y > 9 && y < 14 && x > 26 && x < 50) return [230, 230, 240, 255];
    const g = 70 + y * 5;
    return [Math.min(255, g * 0.45), Math.min(255, g * 0.6), Math.min(255, g), 255];
  }));
  const adMaterial = own(new THREE.MeshBasicMaterial({ name: 'coast-billboards', map: adTexture, color: '#ffffff', fog: true, side: THREE.DoubleSide }));
  const ads: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
  const AD_TINTS = [hdr(1.5, 0.6, 1.3), hdr(0.6, 1.3, 1.6), hdr(1.6, 1.1, 0.5), hdr(1.2, 0.7, 1.7)];
  [0.1, 0.19, 0.28, 0.4, 0.51, 0.64, 0.74, 0.86].forEach((fraction, k) => {
    const i = (coast.ribbon.spawnIndex + Math.round(fraction * n)) % n, frame = frames[i]!;
    if (T(i)) return;
    const side: -1 | 1 = frame.curvature > 0 ? -1 : frame.curvature < 0 ? 1 : (k % 2 ? 1 : -1);
    const foot = framePoint(frame, side * (lat + 5), 0);
    if (!clearOfRoad(foot.x, foot.z, 11, i, 20) || isWater(foot.x - O.x, foot.z - O.z)) return;
    const panelY = frame.p.y + 7.5;
    steelParts.push(box(foot.clone().setY(panelY / 2 - 1), 0, 0.7, panelY + 2, 0.7));
    const facing = frame.t.clone().negate().addScaledVector(frame.h, -side * 0.5).setY(0).normalize();
    ads.push({ matrix: new THREE.Matrix4().compose(foot.clone().setY(panelY + 2.6), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing),
      new THREE.Vector3(12, 5.2, 1)), color: AD_TINTS[k % AD_TINTS.length]! });
    steelParts.push(box(foot.clone().setY(panelY + 2.6).addScaledVector(facing, -0.25), yawOf(facing), 12.4, 5.6, 0.3));
  });
  const adMesh = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)), adMaterial, Math.max(1, ads.length));
  ads.forEach((ad, i) => { adMesh.setMatrixAt(i, ad.matrix); adMesh.setColorAt(i, ad.color); });
  adMesh.count = ads.length;
  adMesh.name = 'coast-billboards';
  root.add(adMesh);

  // Cable-stayed bridge across the bay, 30 m up, with two H pylons.
  const BRIDGE_X = 820, BRIDGE_Y = 30, BRIDGE_Z = 1350;
  steelParts.push(box(W(BRIDGE_X, BRIDGE_Y, 0), 0, 24, 2.2, BRIDGE_Z * 2));
  const traffic: MovingLight[] = [];
  const WHITE = hdr(1.6, 1.6, 1.8), TAIL = hdr(2.2, 0.15, 0.1);
  for (const pz of [-360, 360]) {
    for (const s of [-1, 1]) steelParts.push(box(W(BRIDGE_X + s * 13, 65, pz), 0, 3.4, 140, 3.4));
    steelParts.push(box(W(BRIDGE_X, 118, pz), 0, 30, 3, 3), box(W(BRIDGE_X, BRIDGE_Y - 8, pz), 0, 30, 3, 3));
    for (const s of [-1, 1]) {
      for (let c = 1; c <= 9; c++) for (const dir of [-1, 1]) {
        const topP = W(BRIDGE_X + s * 13, 128 - c * 2.5, pz), deck = W(BRIDGE_X + s * 11.5, BRIDGE_Y + 1, pz + dir * c * 30);
        steelParts.push(beam(topP, deck, 0.35));
        if (c % 3 === 0) cityGlow.push({ position: topP.clone().lerp(deck, 0.5), color: hdr(1.4, 1.5, 1.8), size: 1.6 });
      }
      cityGlow.push({ position: W(BRIDGE_X + s * 13, 136, pz), color: RED, size: 4, pulseSpeed: 1.4, pulseAmount: 0.95, phase: s });
    }
  }
  for (let z = -BRIDGE_Z; z <= BRIDGE_Z; z += 30) for (const s of [-1, 1]) {
    const position = W(BRIDGE_X + s * 12, BRIDGE_Y + 4, z);
    cityGlow.push({ position, color: hdr(1.9, 1.3, 0.7), size: 1.8 });
    if ((z / 30) % 2 === 0) streaks.push({ position, groundY: -1.95, color: hdr(1.2, 0.8, 0.4) });
  }
  for (let k = 0; k < 60; k++) {
    traffic.push({ from: W(BRIDGE_X - 4, BRIDGE_Y + 1.8, -BRIDGE_Z), to: W(BRIDGE_X - 4, BRIDGE_Y + 1.8, BRIDGE_Z), color: WHITE, size: 0.9, speed: 24 + rng() * 8, phase: rng() });
    traffic.push({ from: W(BRIDGE_X + 4, BRIDGE_Y + 1.8, BRIDGE_Z), to: W(BRIDGE_X + 4, BRIDGE_Y + 1.8, -BRIDGE_Z), color: TAIL, size: 0.8, speed: 24 + rng() * 8, phase: rng() });
  }
  // Upper expressway: parapet lights and traffic both ways.
  for (let z = UPPER_Z0; z <= UPPER_Z1; z += 24) for (const s of [-1, 1]) cityGlow.push({ position: W(UPPER_X + s * 8.3, UPPER_Y + 2, z), color: s < 0 ? hdr(0.4, 1.4, 2.2) : hdr(2.0, 0.5, 1.4), size: 0.9 });
  for (let k = 0; k < 45; k++) {
    traffic.push({ from: W(UPPER_X - 3, UPPER_Y + 1.6, UPPER_Z0), to: W(UPPER_X - 3, UPPER_Y + 1.6, UPPER_Z1), color: WHITE, size: 0.75, speed: 22 + rng() * 10, phase: rng() });
    traffic.push({ from: W(UPPER_X + 3, UPPER_Y + 1.6, UPPER_Z1), to: W(UPPER_X + 3, UPPER_Y + 1.6, UPPER_Z0), color: TAIL, size: 0.7, speed: 22 + rng() * 10, phase: rng() });
  }
  // Street-level boulevards and the city's street lights.
  const boulevards: readonly (readonly [number, number, number, number])[] = [[-1700, -112, 196, -112], [-285, -1700, -285, 145]];
  for (const [ax, az, bx, bz] of boulevards) {
    const a = W(ax, 0.7, az), b = W(bx, 0.7, bz), across = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar(2.5);
    const length = a.distanceTo(b);
    for (let k = 0; k < length / 9; k++) {
      traffic.push({ from: a.clone().add(across), to: b.clone().add(across), color: WHITE, size: 0.6, speed: 12 + rng() * 6, phase: rng() });
      if (k % 2) traffic.push({ from: b.clone().sub(across), to: a.clone().sub(across), color: TAIL, size: 0.55, speed: 12 + rng() * 6, phase: rng() });
    }
    for (let d = 0; d < length; d += 30) for (const s of [-1, 1]) cityGlow.push({ position: a.clone().lerp(b, d / length).addScaledVector(across, s * 3.6).setY(8), color: hdr(1.6, 1.2, 0.7), size: 1.3 });
  }
  for (const t of farTowers) if (rng() < 0.35) cityGlow.push({ position: W(t.x + t.w / 2 + 6, 7, t.z), color: hdr(1.6, 1.1, 0.6), size: 1.6 });
  // Boats on the bay and a late flight.
  for (let k = 0; k < 7; k++) {
    const z0 = -1500 + rng() * 3000, x0 = 260 + rng() * 950;
    traffic.push({ from: W(x0, -1.2, z0), to: W(x0 + (rng() - 0.5) * 300, -1.2, z0 + (rng() > 0.5 ? 900 : -900)), color: k % 3 ? hdr(0.3, 2.0, 0.5) : hdr(2.0, 1.8, 1.4), size: 1.4, speed: 3 + rng() * 3, phase: rng() });
  }
  traffic.push({ from: W(2400, 420, -1600), to: W(-1800, 380, 1700), color: hdr(2.5, 2.5, 2.8), size: 3, speed: 70, phase: 0.6 });
  // Seawall railing lights.
  for (let z = nMin.z; z < 150; z += 12) cityGlow.push({ position: W(201, 1.1, z), color: hdr(1.7, 1.2, 0.7), size: 0.8 });
  for (let x = nMin.x; x < 200; x += 12) cityGlow.push({ position: W(x, 1.1, 151), color: hdr(1.7, 1.2, 0.7), size: 0.8 });

  // ------------------------------------------------------------------ neon signs (one atlas, one draw) and the plaza
  const ledParts: THREE.BufferGeometry[] = [];
  let neonMaterial: THREE.MeshBasicMaterial | null = null;
  if (portals.length > 0 && entry >= 0) {
    const frame = frames[entry]!, facing = frame.t.clone().negate().setY(0).normalize();
    signs.push({ position: frame.p.clone().setY(PLAZA_Y + 5.4).addScaledVector(facing, 2), yaw: yawOf(facing), word: 0, width: 24 });
    for (const s of [-1, 1]) steelParts.push(box(frame.p.clone().addScaledVector(frame.h, s * 9).addScaledVector(facing, 2).setY(PLAZA_Y + 1.6), 0, 0.35, 3.2, 0.35));
    // Plaza lamps.
    for (const k of [6, 24, 42]) {
      const f = frames[(entry + k) % n]!;
      for (const s of [-1, 1]) {
        const p = f.p.clone().addScaledVector(f.h, s * (PLAZA_HALF_M - 1.5)).setY(PLAZA_Y);
        steelParts.push(box(p.clone().setY(PLAZA_Y + 2.2), 0, 0.16, 4.4, 0.16));
        glow.push({ position: p.clone().setY(PLAZA_Y + 4.5), color: hdr(1.9, 1.3, 0.8), size: 1.4 });
      }
    }
  }
  const atlas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const atlasCtx = atlas?.getContext('2d') ?? null;
  if (atlas && atlasCtx && signs.length > 0) {
    atlas.width = 1024; atlas.height = 1024;
    const rows = WORDS.map(([text, color], r) => {
      const neon = neonTexture(text, color, '#fff6fb');
      if (!neon) return null;
      const width = Math.min(1024, 128 * neon.aspect);
      atlasCtx.drawImage(neon.texture.image as CanvasImageSource, 0, r * 128, width, 128);
      neon.texture.dispose();
      return { u1: width / 1024, v0: 1 - (r + 1) / 8, v1: 1 - r / 8, aspect: width / 128 };
    });
    const texture = own(new THREE.CanvasTexture(atlas));
    texture.colorSpace = THREE.SRGBColorSpace;
    neonMaterial = own(new THREE.MeshBasicMaterial({ name: 'coast-neon-signs', map: texture, color: '#ffffff', transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true }));
    const parts: THREE.BufferGeometry[] = [];
    for (const sign of signs) {
      const row = rows[sign.word];
      if (!row) continue;
      const width = sign.width || THREE.MathUtils.clamp(row.aspect * 3.4, 11, 24);
      const geometry = new THREE.PlaneGeometry(width, width / row.aspect);
      const uv = geometry.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * row.u1, row.v0 + uv.getY(k) * (row.v1 - row.v0));
      parts.push(geometry.rotateY(sign.yaw).translate(sign.position.x, sign.position.y, sign.position.z));
      // A dark backing board keeps the tubes readable against lit windows and sky.
      const normal = new THREE.Vector3(Math.sin(sign.yaw), 0, Math.cos(sign.yaw));
      steelParts.push(box(sign.position.clone().addScaledVector(normal, -0.14), sign.yaw, width * 1.03, width / row.aspect * 1.08, 0.12));
      glow.push({ position: sign.position.clone(), color: new THREE.Color(WORDS[sign.word]![1]).multiplyScalar(1.4), size: Math.min(width * 0.3, 4.5) });
    }
    if (parts.length > 0) {
      const signMesh = new THREE.Mesh(own(mergeGeometries(parts)!), neonMaterial);
      parts.forEach(geometry => geometry.dispose());
      signMesh.name = 'coast-neon-signs';
      signMesh.renderOrder = 4;
      root.add(signMesh);
    }
  }

  // ------------------------------------------------------------------ LED strips: tunnel, portals, deck edges
  for (const side of [-1, 1] as const) {
    // Ceiling corners and a wall band at 2.2 m inside the tunnel.
    ledParts.push(stripGeometry(frames, lengthM, (frame, i) => T(i) || T(i - 1)
      ? [lat + 0.05, lat + 0.4].map(l => ({ position: framePoint(frame, side * l, 0).setY(frame.p.y + ceilOff(i) - 0.04), u: 0 })) : null, undefined, side > 0));
    ledParts.push(stripGeometry(frames, lengthM, (frame, i) => T(i) || T(i - 1)
      ? [2.1, 2.3].map(h => ({ position: framePoint(frame, side * (lat + WALL_M - 0.03), 0).setY(frame.p.y + h), u: 0 })) : null, undefined, side > 0));
    // Under-glow along the outer bottom edge of the elevated deck.
    ledParts.push(stripGeometry(frames, lengthM, (frame, i) => E(i) || E(i - 1)
      ? [-1.55, -1.38].map(h => ({ position: framePoint(frame, side * (lat + WALL_M + 0.03), 0).setY(frame.p.y + h), u: 0 })) : null, undefined, side > 0));
  }
  ledParts.push(stripGeometry(frames, lengthM, (frame, i) => T(i) || T(i - 1)
    ? [-0.3, 0.3].map(l => ({ position: framePoint(frame, l, 0).setY(frame.p.y + ceilOff(i) - 0.04), u: 0 })) : null, undefined, true));
  for (const i of portals) {
    const frame = frames[i]!, yaw = yawOf(frame.t), ceil = frame.p.y + ceilOff(i), inner = lat + WALL_M, outward = i === entry ? -0.45 : 0.45;
    const face = frame.p.clone().addScaledVector(frame.t, outward);
    ledParts.push(box(face.clone().setY(ceil + 0.15), yaw, inner * 2 + 0.6, 0.3, 0.12));
    for (const s of [-1, 1]) ledParts.push(box(face.clone().addScaledVector(frame.h, s * (inner + 0.15)).setY((frame.p.y + ceil) / 2), yaw, 0.3, ceil - frame.p.y, 0.12));
  }
  const ledUniforms = {
    uTime: { value: 0 }, uScale: { value: 1 }, uFogDensity: { value: 0.003 }, uFog: { value: new THREE.Color() },
    uA: { value: hdr(0.25, 1.5, 2.4) }, uB: { value: hdr(2.4, 0.3, 1.6) },
  };
  const ledMaterial = own(new THREE.ShaderMaterial({ name: 'coast-led-strips', vertexShader: LED_VERTEX, fragmentShader: LED_FRAGMENT, uniforms: ledUniforms, side: THREE.DoubleSide, fog: false }));
  const ledMesh = new THREE.Mesh(own(mergeGeometries(ledParts)!), ledMaterial);
  ledParts.forEach(geometry => geometry.dispose());
  ledMesh.name = 'coast-led-strips';
  root.add(ledMesh);

  const steelMesh = new THREE.Mesh(own(mergeGeometries(steelParts)!), darkSteel);
  steelParts.forEach(geometry => geometry.dispose());
  steelMesh.name = 'coast-steel-gantries-bridge';
  steelMesh.castShadow = true;
  root.add(steelMesh);

  const uniforms = createLightUniforms();
  const cityUniforms = createLightUniforms();
  const pixelScale = { value: 900 };
  const glowMesh = createGlowSprites('coast-glow-sprites', glow, uniforms).mesh;
  const cityGlowMesh = createGlowSprites('coast-city-lights', cityGlow, cityUniforms).mesh;
  const streakMesh = createWetStreaks('coast-wet-streaks', streaks, uniforms).mesh;
  const trafficMesh = createMovingLights('coast-traffic', traffic, cityUniforms);
  const studMesh = createRoadStuds('coast-delineators', studs, uniforms, pixelScale);
  root.add(glowMesh, cityGlowMesh, streakMesh, trafficMesh, studMesh);
  for (const mesh of [glowMesh, cityGlowMesh, streakMesh, trafficMesh, studMesh]) { own(mesh.geometry); own(mesh.material as THREE.Material); }

  // ------------------------------------------------------------------ runtime
  const tmp = new THREE.Vector3();
  let disposed = false;
  return {
    district: 'coast', root, lampPositions,
    setAtmosphere(recipe: AtmosphereRecipe): void {
      uniforms.scale.value = recipe.lampGlow;
      cityUniforms.scale.value = 0.6 + 0.4 * recipe.lampGlow;
      uniforms.fogDensity.value = recipe.fogDensity;
      cityUniforms.fogDensity.value = recipe.fogDensity * 0.3;
      ledUniforms.uScale.value = 0.55 + 0.45 * recipe.lampGlow;
      ledUniforms.uFog.value.set(recipe.fog);
      ledUniforms.uFogDensity.value = recipe.fogDensity;
      boardMaterial.emissiveIntensity = 0.35 + 0.3 * recipe.lampGlow;
      neonMaterial?.color.setScalar(1.1 + 0.6 * recipe.lampGlow);
    },
    setQuality(preset): void {
      // Phones keep every nearby tower and a thinned skyline.
      towerMesh.count = nearCount + Math.round(farTowers.length * (preset === 'low' ? 0.45 : preset === 'balanced' ? 0.85 : 1));
    },
    update(elapsedSeconds, camera): void {
      uniforms.time.value = elapsedSeconds;
      cityUniforms.time.value = elapsedSeconds;
      ledUniforms.uTime.value = elapsedSeconds;
      camera.getWorldPosition(tmp);
      uniforms.cameraPosition.value.copy(tmp);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        pixelScale.value = 1000 / (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2));
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.traverse(node => { if ((node as THREE.Mesh).isMesh) disposables.push((node as THREE.Mesh).geometry); });
      root.clear();
      new Set(disposables).forEach(item => item.dispose());
    },
  };
}
