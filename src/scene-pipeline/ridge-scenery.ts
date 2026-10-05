import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DistrictId } from '../../contracts/world-contracts';
import type { QualityPreset } from '../../contracts/runtime-contracts';
import type { AtmosphereRecipe } from './atmosphere';
import { createGlowSprites, createLightUniforms, createRoadStuds, type GlowInstance, type StudInstance } from './light-sprites';
import { createMovingLights, type MovingLight } from './light-trails';
import { framePoint, type RoadFrame } from '../world/road-ribbon';
import {
  buildRidgePass, fbm, RIDGE_BARRIER_LAT_M, RIDGE_ORIGIN, RIDGE_ROAD_WIDTH_M, RIDGE_SHOULDER_M, ridgeNaturalLocal,
} from '../world/ridge-pass';

/** A procedural district's visual layer. Collision lives in src/world; this only draws. */
export interface DistrictScenery {
  readonly district: DistrictId;
  readonly root: THREE.Group;
  /** Lens positions of practical lights; the nearest become real lights. */
  readonly lampPositions: readonly THREE.Vector3[];
  setAtmosphere(recipe: AtmosphereRecipe): void;
  update(elapsedSeconds: number, camera: THREE.Camera): void;
  /** Thin out the heaviest layers (forest, cloud sheets) on lower tiers; never changes collision. */
  setQuality?(preset: QualityPreset): void;
  dispose(): void;
}

/** Harbour materials reused so the districts share shader programs and textures. */
export interface SharedWorldMaterials {
  readonly asphalt?: THREE.Material;
  readonly concrete?: THREE.Material;
  readonly water?: THREE.Material;
}

export const RIDGE_SCENERY_VERSION = 'ridge-scenery-v1';

const UP = new THREE.Vector3(0, 1, 0);
export const hdr = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StripColumn { readonly position: THREE.Vector3; readonly u: number }
/**
 * A strip along the road: each frame contributes a row of columns, consecutive rows are joined by quads.
 * The loop is closed by repeating the first row at s = length, so v never wraps mid-quad.
 */
export function stripGeometry(frames: readonly RoadFrame[], lengthM: number, row: (frame: RoadFrame, index: number) => StripColumn[] | null,
  normal?: (frame: RoadFrame) => THREE.Vector3, flip = false, vScale = 1 / 3): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], normals: number[] = [], indices: number[] = [];
  let previous: { base: number; count: number } | null = null;
  const n = frames.length;
  for (let k = 0; k <= n; k++) {
    const index = k % n, frame = frames[index]!;
    const columns = row(frame, index);
    if (!columns) { previous = null; continue; }
    const base = positions.length / 3, s = k === n ? lengthM : frame.s;
    for (const column of columns) {
      positions.push(column.position.x, column.position.y, column.position.z);
      uvs.push(column.u, s * vScale);
      const nn = normal?.(frame) ?? UP;
      normals.push(nn.x, nn.y, nn.z);
    }
    if (previous && previous.count === columns.length) {
      for (let c = 0; c < columns.length - 1; c++) {
        const a = previous.base + c, b = previous.base + c + 1, d = base + c, e = base + c + 1;
        // Faces point along (next column - column) x (road forward); `flip` reverses them.
        if (flip) indices.push(a, d, b, b, d, e); else indices.push(a, b, d, b, e, d);
      }
    }
    previous = { base, count: columns.length };
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  if (!normal) geometry.computeVertexNormals();
  return geometry;
}

export function dataTexture(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Fog sheets drifting over the valley: the "sea of clouds" below the pass, lit from beneath by the city. */
const CLOUD_VERTEX = /* glsl */`
  varying vec3 vWorld;
  void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const CLOUD_FRAGMENT = /* glsl */`
  uniform float uTime;
  uniform vec3 uFog;
  uniform vec3 uGlow;
  uniform vec3 uOrigin;
  uniform float uOpacity;
  varying vec3 vWorld;
  float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.07 + 11.3; a *= .5; } return s; }
  void main() {
    vec2 local = vWorld.xz - uOrigin.xz;
    vec2 q = local * 0.0042 + vec2(uTime * 0.006, uTime * 0.0025) + vWorld.y * 0.01;
    float n = fbm(q + fbm(q * 1.7 - uTime * 0.004) * 0.8);
    float cover = smoothstep(0.46, 0.86, n);
    // Fade in from the foot of the cliff and toward the far rim.
    cover *= smoothstep(205.0, 330.0, local.y) * (1.0 - smoothstep(1350.0, 1650.0, local.y)) * (1.0 - smoothstep(1100.0, 1500.0, abs(local.x)));
    float lit = fbm(local * 0.0019 + 3.0);
    vec3 col = mix(uFog * 1.25, uGlow, smoothstep(0.35, 0.8, lit) * 0.55 * (1.0 - cover * 0.5));
    gl_FragColor = vec4(col, cover * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createRidgeScenery(shared: SharedWorldMaterials = {}): DistrictScenery {
  const ridge = buildRidgePass();
  const { frames, lengthM } = ridge.ribbon;
  const root = new THREE.Group();
  root.name = 'district-ridge';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(item: T): T => { disposables.push(item); return item; };
  const half = RIDGE_ROAD_WIDTH_M / 2, edge = half + RIDGE_SHOULDER_M, lat = RIDGE_BARRIER_LAT_M;
  const O = RIDGE_ORIGIN;
  const local = (x: number, z: number, y = ridgeNaturalLocal(x, z)): THREE.Vector3 => new THREE.Vector3(x + O.x, y, z + O.z);
  const rng = mulberry32(0x71d6e);

  // ------------------------------------------------------------------ materials
  const asphalt = shared.asphalt ?? own(new THREE.MeshStandardMaterial({ name: 'road-asphalt', color: '#3a3f42', roughness: 0.85 }));
  const concrete = shared.concrete ?? own(new THREE.MeshStandardMaterial({ name: 'concrete-weathered', color: '#8d8a83', roughness: 0.94 }));
  const paint = own(new THREE.MeshStandardMaterial({ name: 'ridge-road-paint', color: '#dcd8cc', roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const steel = own(new THREE.MeshStandardMaterial({ name: 'ridge-guardrail-steel', color: '#b9c0c4', roughness: 0.38, metalness: 0.75, side: THREE.DoubleSide }));
  const darkSteel = own(new THREE.MeshStandardMaterial({ name: 'ridge-dark-steel', color: '#2c3236', roughness: 0.55, metalness: 0.55 }));
  const terrainMaterial = own(new THREE.MeshStandardMaterial({ name: 'ridge-terrain', color: '#ffffff', vertexColors: true, roughness: 0.96, metalness: 0 }));
  const foliage = own(new THREE.MeshStandardMaterial({ name: 'ridge-conifer', color: '#ffffff', roughness: 0.92, metalness: 0, flatShading: true }));

  // ------------------------------------------------------------------ road surface (visual = collider)
  // Carriageway plus shoulders, the same plane the collider uses. u: 4.5 across the carriageway (wet shader convention).
  const uAt = (l: number): number => (l + half) / RIDGE_ROAD_WIDTH_M * 4.5;
  const road = new THREE.Mesh(stripGeometry(frames, lengthM, frame =>
    [-edge, -half, half, edge].map(l => ({ position: framePoint(frame, l, 0.004), u: uAt(l) })), frame => frame.n), asphalt);
  road.name = 'ridge-road-surface';
  road.receiveShadow = true;
  own(road.geometry);
  // Edge lines (solid white) a hand's width inside the carriageway edge.
  const lineGeometries = ([-1, 1] as const).map(side => stripGeometry(frames, lengthM, frame =>
    [side * (half - 0.32), side * (half - 0.17)].map(l => ({ position: framePoint(frame, l, 0.02), u: 0 })), frame => frame.n));
  const lines = new THREE.Mesh(own(mergeGeometries(lineGeometries)!), paint);
  lines.name = 'ridge-road-edge-lines';
  lines.receiveShadow = true;
  lineGeometries.forEach(geometry => geometry.dispose());
  root.add(road, lines);

  // ------------------------------------------------------------------ barriers, skirts and the viaduct
  const concreteParts: THREE.BufferGeometry[] = [];
  const drop = ridge.drop;
  for (const side of [-1, 1] as const) {
    const isRail = (i: number): boolean => !ridge.bridge(i) && (side < 0 ? drop[i]!.left : drop[i]!.right);
    const isWall = (i: number): boolean => !isRail(i);
    const at = (frame: RoadFrame, across: number, height: number): THREE.Vector3 =>
      framePoint(frame, side * lat, 0).addScaledVector(frame.h, side * across).add(new THREE.Vector3(0, height, 0));
    // Concrete wall (rock-cut side and viaduct parapets): inner face, top, outer face.
    const wall = (i: number): boolean => isWall(i) && isWall((i + 1) % frames.length);
    const wallTop = (i: number): number => ridge.bridge(i) ? 1.05 : 0.9;
    for (const [a, b] of [[[0, -0.6], [0, 1]], [[0, 1], [0.4, 1]], [[0.4, 1], [0.4, -0.6]]] as const) {
      // Column order bottom->top, inner->outer, top->bottom makes every face point away from the wall on the right side.
      concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => wall(i) || wall((i - 1 + frames.length) % frames.length)
        ? [a, b].map(([across, height]) => ({ position: at(frame, across, height > 0 ? wallTop(i) : -0.6), u: height / 3 }))
        : null, undefined, side < 0));
    }
    // Skirt: hides the gap between the road slab edge and the ground.
    concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => [
      { position: framePoint(frame, side * edge, 0), u: 0 },
      { position: framePoint(frame, side * edge, 0).add(new THREE.Vector3(0, ridge.bridge(i) ? -1.5 : -1.8, 0)), u: 0.5 },
    ], undefined, side < 0));
    // W-beam guardrail on the drop side: a folded steel ribbon with posts.
    const beamProfile: readonly (readonly [number, number])[] = [[0.02, 0.5], [0.09, 0.58], [0.0, 0.68], [0.09, 0.78], [0.02, 0.86]];
    const beam = (i: number): boolean => isRail(i) && isRail((i + 1) % frames.length);
    const rail = stripGeometry(frames, lengthM, (frame, i) => beam(i) || beam((i - 1 + frames.length) % frames.length)
      ? beamProfile.map(([across, height], k) => ({ position: at(frame, across, height), u: k / 4 })) : null);
    const railMesh = new THREE.Mesh(own(rail), steel);
    railMesh.name = `ridge-guardrail-beam-${side < 0 ? 'left' : 'right'}`;
    railMesh.castShadow = true; railMesh.receiveShadow = true;
    root.add(railMesh);
  }
  // Viaduct: deck underside, then piers down into the ravine.
  concreteParts.push(stripGeometry(frames, lengthM, (frame, i) => ridge.bridge(i)
    ? [-edge - 0.2, edge + 0.2].map(l => ({ position: framePoint(frame, l, -1.5), u: l / 3 })) : null, frame => frame.n.clone().negate(), true));
  const piers: THREE.Matrix4[] = [];
  let lastPier = -Infinity;
  frames.forEach((frame, i) => {
    if (!ridge.bridge(i) || frame.s - lastPier < 22) return;
    lastPier = frame.s;
    const ground = ridge.terrain.heightAt(frame.p.x, frame.p.z) - 2;
    const top = frame.p.y - 1.5, height = Math.max(2, top - ground);
    const yaw = Math.atan2(frame.t.x, frame.t.z);
    piers.push(new THREE.Matrix4().compose(new THREE.Vector3(frame.p.x, top - height / 2, frame.p.z),
      new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(edge * 1.3, height, 2.4)));
  });
  const concreteMesh = new THREE.Mesh(own(mergeGeometries(concreteParts)!), concrete);
  concreteParts.forEach(geometry => geometry.dispose());
  concreteMesh.name = 'ridge-walls-skirts-deck';
  concreteMesh.castShadow = true; concreteMesh.receiveShadow = true;
  const pierMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), concrete, Math.max(1, piers.length));
  piers.forEach((matrix, i) => pierMesh.setMatrixAt(i, matrix));
  pierMesh.count = piers.length;
  pierMesh.name = 'ridge-viaduct-piers';
  pierMesh.castShadow = true; pierMesh.receiveShadow = true;
  root.add(concreteMesh, pierMesh);

  // Guardrail posts every 4 m on rail runs.
  const posts: THREE.Matrix4[] = [];
  for (const side of [-1, 1] as const) {
    let last = -Infinity;
    frames.forEach((frame, i) => {
      const rail = !ridge.bridge(i) && (side < 0 ? drop[i]!.left : drop[i]!.right);
      if (!rail || frame.s - last < 4) return;
      last = frame.s;
      const base = framePoint(frame, side * lat, 0).addScaledVector(frame.h, side * 0.2);
      posts.push(new THREE.Matrix4().compose(base.add(new THREE.Vector3(0, 0.3, 0)), new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(frame.t.x, frame.t.z)),
        new THREE.Vector3(0.1, 1.2, 0.14)));
    });
  }
  const postMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), darkSteel, Math.max(1, posts.length));
  posts.forEach((matrix, i) => postMesh.setMatrixAt(i, matrix));
  postMesh.count = posts.length;
  postMesh.name = 'ridge-guardrail-posts';
  postMesh.castShadow = false;
  root.add(postMesh);

  // ------------------------------------------------------------------ ground: carved near grid + distant ring
  const terrain = ridge.terrain;
  const near = new THREE.BufferGeometry();
  {
    const { nx, nz, heights } = terrain;
    const positions = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      positions.set([terrain.x(i), heights[k]!, terrain.z(j)], k * 3);
    }
    near.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const indices: number[] = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices.push(a, d, b, a, c, d);
    }
    near.setIndex(indices);
  }
  const ringCell = 64, nearMin = { x: terrain.spec.minX, z: terrain.spec.minZ }, nearMax = { x: terrain.spec.maxX, z: terrain.spec.maxZ };
  const farHeight = (lx: number, lz: number): number => {
    let y = ridgeNaturalLocal(lx, lz);
    // Valley walls and the far rim: a bowl of mountains around the city.
    const rim = Math.max(smoothstep(1050, 1600, lz), smoothstep(780, 1450, Math.abs(lx)) * smoothstep(150, 400, lz));
    y += rim * (230 + 140 * fbm(lx * 0.0025 + 5, lz * 0.0025)) * (0.6 + 0.4 * fbm(lx * 0.006, lz * 0.006 + 3));
    return y;
  };
  const far = new THREE.BufferGeometry();
  {
    const minX = -1700, maxX = 1700, minZ = -1300, maxZ = 1900;
    const nx = Math.round((maxX - minX) / ringCell) + 1, nz = Math.round((maxZ - minZ) / ringCell) + 1;
    const positions = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const lx = minX + i * ringCell, lz = minZ + j * ringCell, wx = lx + O.x, wz = lz + O.z;
      const inside = wx > nearMin.x - 90 && wx < nearMax.x + 90 && wz > nearMin.z - 90 && wz < nearMax.z + 90;
      positions.set([wx, farHeight(lx, lz) - (inside ? 6 : 0), wz], (j * nx + i) * 3);
    }
    far.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const indices: number[] = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const x0 = minX + i * ringCell + O.x, z0 = minZ + j * ringCell + O.z;
      // Skip cells wholly covered by the detailed grid.
      if (x0 >= nearMin.x && x0 + ringCell <= nearMax.x && z0 >= nearMin.z && z0 + ringCell <= nearMax.z) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices.push(a, d, b, a, c, d);
    }
    far.setIndex(indices);
  }
  for (const geometry of [near, far]) {
    geometry.computeVertexNormals();
    const pos = geometry.getAttribute('position'), nor = geometry.getAttribute('normal');
    const colors = new Float32Array(pos.count * 3);
    const rock = new THREE.Color('#6a645a'), rockDark = new THREE.Color('#403c36'), forest = new THREE.Color('#26361f'), scrub = new THREE.Color('#3f4630');
    const valley = new THREE.Color('#252b22'), tmp = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k), ny = nor.getY(k);
      const n = fbm(x * 0.05, z * 0.05);
      const steep = smoothstep(0.82, 0.55, ny);
      tmp.copy(forest).lerp(scrub, smoothstep(0.35, 0.7, n));
      tmp.lerp(valley, smoothstep(-120, -160, y));
      tmp.lerp(rock.clone().lerp(rockDark, n), steep);
      // Scuffed verge right beside the road.
      const k2 = terrain.roadDistance.length === pos.count && geometry === near ? terrain.roadDistance[k]! : 99;
      tmp.lerp(rockDark, smoothstep(12, 8, k2) * 0.6);
      colors.set([tmp.r, tmp.g, tmp.b], k * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    own(geometry);
  }
  const nearMesh = new THREE.Mesh(near, terrainMaterial); nearMesh.name = 'ridge-terrain-near'; nearMesh.receiveShadow = true;
  const farMesh = new THREE.Mesh(far, terrainMaterial); farMesh.name = 'ridge-terrain-far'; farMesh.receiveShadow = false;
  root.add(nearMesh, farMesh);

  // ------------------------------------------------------------------ conifer forest
  const nearestRoadY = (x: number, z: number): number => {
    let best = Infinity, y = 0;
    for (let i = 0; i < frames.length; i += 3) {
      const d = (frames[i]!.p.x - x) ** 2 + (frames[i]!.p.z - z) ** 2;
      if (d < best) { best = d; y = frames[i]!.p.y; }
    }
    return y;
  };
  const treeGeometry = own(mergeGeometries([
    new THREE.CylinderGeometry(0, 1.35, 5.6, 5, 1, true).translate(0, 4.4, 0),
    new THREE.CylinderGeometry(0, 0.95, 4.4, 5, 1, true).translate(0, 7.9, 0),
    new THREE.CylinderGeometry(0.14, 0.2, 2.2, 3, 1, true).translate(0, 1.1, 0),
  ])!);
  const trees: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
  const treeColor = [new THREE.Color('#1c2e22'), new THREE.Color('#243826'), new THREE.Color('#2b3a23'), new THREE.Color('#1e3020')];
  for (let gz = terrain.spec.minZ + 4; gz < terrain.spec.maxZ - 4 && trees.length < 1900; gz += 6.5) {
    for (let gx = terrain.spec.minX + 4; gx < terrain.spec.maxX - 4 && trees.length < 1900; gx += 6.5) {
      const x = gx + (rng() - 0.5) * 5, z = gz + (rng() - 0.5) * 5;
      const i = Math.round((x - terrain.spec.minX) / terrain.spec.cellM), j = Math.round((z - terrain.spec.minZ) / terrain.spec.cellM);
      const distance = terrain.roadDistance[j * terrain.nx + i] ?? 0;
      if (distance < 11.5) continue;
      const y = terrain.heightAt(x, z);
      // Keep the downhill side of the roads open: the view over the drop to the city is the point.
      if (distance < 45 && y < nearestRoadY(x, z) - 2) continue;
      const slope = Math.abs(terrain.heightAt(x + 2, z) - terrain.heightAt(x - 2, z)) + Math.abs(terrain.heightAt(x, z + 2) - terrain.heightAt(x, z - 2));
      if (slope > 5.2) continue;
      const density = fbm(x * 0.012 + 4, z * 0.012);
      if (density < 0.42 || rng() > 0.35 + density) continue;
      const scale = 0.75 + rng() * 0.75 + (density - 0.4) * 0.6;
      trees.push({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.4, z), new THREE.Quaternion().setFromAxisAngle(UP, rng() * 6.28),
        new THREE.Vector3(scale, scale * (0.85 + rng() * 0.4), scale)), color: treeColor[Math.floor(rng() * treeColor.length)]! });
    }
  }
  // Shuffle so any prefix is an even thinning of the whole forest (lower tiers draw a prefix).
  for (let i = trees.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [trees[i], trees[j]] = [trees[j]!, trees[i]!]; }
  const forest = new THREE.InstancedMesh(treeGeometry, foliage, Math.max(1, trees.length));
  trees.forEach((tree, i) => { forest.setMatrixAt(i, tree.matrix); forest.setColorAt(i, tree.color); });
  forest.count = trees.length;
  forest.name = 'ridge-conifers';
  forest.castShadow = false; forest.receiveShadow = true;
  root.add(forest);

  // ------------------------------------------------------------------ lights: lamps, reflectors, beacons
  const uniforms = createLightUniforms();
  const cityUniforms = createLightUniforms();
  const pixelScale = { value: 900 };
  const glow: GlowInstance[] = [];
  const studs: StudInstance[] = [];
  const lampPositions: THREE.Vector3[] = [];
  const SODIUM = hdr(2.4, 1.1, 0.32);
  const lampRows: THREE.Matrix4[] = [], armRows: THREE.Matrix4[] = [];
  const addLamp = (frame: RoadFrame, side: -1 | 1): void => {
    const base = framePoint(frame, side * (lat + 1.1), 0);
    base.y = frame.p.y - 0.4;
    const top = frame.p.y + 8.6;
    lampRows.push(new THREE.Matrix4().compose(new THREE.Vector3(base.x, (base.y + top) / 2, base.z), new THREE.Quaternion(), new THREE.Vector3(1, top - base.y, 1)));
    const toRoad = frame.h.clone().multiplyScalar(-side);
    const yaw = Math.atan2(-toRoad.z, toRoad.x);
    armRows.push(new THREE.Matrix4().compose(new THREE.Vector3(base.x, top, base.z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1)));
    const lens = new THREE.Vector3(base.x, top - 0.25, base.z).addScaledVector(toRoad, 2.3);
    lampPositions.push(lens);
    glow.push({ position: lens.clone(), color: SODIUM, size: 2.4, pulseSpeed: 1.4 + rng(), pulseAmount: 0.03, phase: rng() * 6.28 });
  };
  // Hairpins: one lamp on the outside of each apex.
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 6) {
      const apex = run[Math.floor(run.length / 2)]!, frame = frames[apex]!;
      addLamp(frame, frame.curvature > 0 ? -1 : 1);
    }
    run = [];
  };
  frames.forEach((frame, i) => { if (Math.abs(frame.curvature) > 0.04) run.push(i); else flush(); });
  flush();
  // The start straight and the viaduct.
  const spawnIndex = ridge.ribbon.spawnIndex;
  for (const offset of [-10, 12, 34]) addLamp(frames[(spawnIndex + offset + frames.length) % frames.length]!, 1);
  frames.forEach((frame, i) => { if (ridge.bridge(i) && i % 14 === 0) addLamp(frame, -1); });
  const lampPoles = new THREE.InstancedMesh(own(new THREE.CylinderGeometry(0.09, 0.16, 1, 8)), darkSteel, lampRows.length);
  const lampArms = new THREE.InstancedMesh(own(mergeGeometries([
    new THREE.BoxGeometry(2.5, 0.12, 0.12).translate(1.15, 0, 0), new THREE.BoxGeometry(1.0, 0.16, 0.42).translate(2.3, -0.12, 0),
  ])!), darkSteel, armRows.length);
  lampRows.forEach((matrix, i) => lampPoles.setMatrixAt(i, matrix));
  armRows.forEach((matrix, i) => lampArms.setMatrixAt(i, matrix));
  lampPoles.name = 'ridge-lamp-poles'; lampArms.name = 'ridge-lamp-arms';
  lampPoles.castShadow = lampArms.castShadow = false;
  root.add(lampPoles, lampArms);

  // Delineators on the barrier tops (amber left, white right) and cat's eyes on the centre line.
  const AMBER = hdr(1.9, 0.9, 0.25), ICE = hdr(1.5, 1.65, 1.9);
  frames.forEach((frame, i) => {
    if (i % 5 === 0) for (const side of [-1, 1] as const) {
      studs.push({ position: framePoint(frame, side * (lat + 0.2), 0).add(new THREE.Vector3(0, ridge.bridge(i) ? 1.1 : 0.95, 0)), color: side < 0 ? AMBER : ICE });
    }
    if (i % 4 === 0) studs.push({ position: framePoint(frame, 0, 0.05), color: ICE.clone().multiplyScalar(0.4) });
  });

  // Chevron boards on the outside of every hairpin, facing the approaching car.
  const chevronTexture = own(dataTexture(64, 32, (x, y) => {
    const stripe = ((x + Math.abs(y - 16) * 1.2) % 22) < 10;
    const border = y < 2 || y > 29 || x < 2 || x > 61;
    return border ? [16, 16, 16, 255] : stripe ? [255, 196, 32, 255] : [18, 18, 18, 255];
  }));
  const chevronMaterial = own(new THREE.MeshStandardMaterial({ name: 'ridge-chevron-board', map: chevronTexture, emissiveMap: chevronTexture,
    emissive: '#ffffff', emissiveIntensity: 0.32, roughness: 0.4, side: THREE.DoubleSide }));
  const chevrons: THREE.Matrix4[] = [];
  let lastChevron = -Infinity;
  frames.forEach((frame) => {
    if (Math.abs(frame.curvature) < 0.045 || frame.s - lastChevron < 7) return;
    lastChevron = frame.s;
    const outside: -1 | 1 = frame.curvature > 0 ? -1 : 1;
    const base = framePoint(frame, outside * (lat + 0.55), 0).add(new THREE.Vector3(0, 1.75, 0));
    // Board normal faces back down the road and in; arrows point the way the road turns.
    const facing = frame.t.clone().negate().addScaledVector(frame.h, -outside * 0.6).setY(0).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
    chevrons.push(new THREE.Matrix4().compose(base, quaternion, new THREE.Vector3(outside > 0 ? 1.7 : -1.7, 0.85, 1)));
  });
  const chevronMesh = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)), chevronMaterial, Math.max(1, chevrons.length));
  chevrons.forEach((matrix, i) => chevronMesh.setMatrixAt(i, matrix));
  chevronMesh.count = chevrons.length;
  chevronMesh.name = 'ridge-hairpin-chevrons';
  root.add(chevronMesh);

  // A pair of vending machines glowing against the rock cut just past the start: the touge landmark.
  const vendTexture = own(dataTexture(32, 64, (x, y) => {
    const window = x > 3 && x < 28 && y > 26 && y < 60;
    const row = Math.floor((y - 26) / 8), slot = Math.floor((x - 4) / 4);
    const can = window && (y - 26) % 8 > 2 && (x - 4) % 4 > 0;
    const hues: readonly (readonly [number, number, number])[] = [[230, 60, 50], [40, 140, 230], [250, 200, 40], [60, 200, 120], [240, 240, 240]];
    if (can) { const c = hues[(row * 3 + slot) % hues.length]!; return [c[0], c[1], c[2], 255]; }
    if (window) return [235, 245, 255, 255];
    if (y > 8 && y < 20 && x > 4 && x < 27) return [40, 70, 160, 255];
    return [200, 205, 210, 255];
  }));
  const vendMaterial = own(new THREE.MeshStandardMaterial({ name: 'ridge-vending-front', map: vendTexture, emissiveMap: vendTexture, emissive: '#ffffff', emissiveIntensity: 1.6, roughness: 0.3 }));
  const vendBody = own(new THREE.MeshStandardMaterial({ name: 'ridge-vending-body', color: '#c9ccd0', roughness: 0.5, metalness: 0.3 }));
  {
    const frame = frames[(spawnIndex + 22) % frames.length]!;
    for (const k of [0, 1]) {
      const center = framePoint(frame, lat + 1.3, 0).addScaledVector(frame.t, k * 1.15);
      center.y = frame.p.y + 0.95;
      const yaw = Math.atan2(-frame.h.x, -frame.h.z);
      const body = new THREE.Mesh(own(new THREE.BoxGeometry(1.05, 1.9, 0.8)), [vendBody, vendBody, vendBody, vendBody, vendMaterial, vendBody]);
      body.position.copy(center); body.rotation.y = yaw; body.name = `ridge-vending-machine-${k}`;
      body.castShadow = true;
      root.add(body);
      glow.push({ position: center.clone().addScaledVector(frame.h, -0.7).add(new THREE.Vector3(0, 0.2, 0)), color: hdr(0.9, 1.1, 1.4), size: 1.6 });
    }
    lampPositions.push(framePoint(frame, lat + 0.4, 0).add(new THREE.Vector3(0, 1.6, 0)));
  }

  // Summit radio mast and distant wind turbines: blinking red beacons over the ridge line.
  const mastBase = local(-70, -340);
  const mast = new THREE.Mesh(own(new THREE.CylinderGeometry(0.4, 2.6, 64, 4, 1).translate(0, 32, 0)), darkSteel);
  mast.position.copy(mastBase); mast.name = 'ridge-summit-mast';
  root.add(mast);
  const RED = hdr(3.4, 0.2, 0.12);
  for (const [k, h] of [20, 42, 64].entries()) glow.push({ position: mastBase.clone().add(new THREE.Vector3(0, h, 0)), color: RED, size: 3.2 + k, pulseSpeed: 2.2, pulseAmount: 0.95, phase: k * 0.4 });
  const turbines: { hub: THREE.Vector3; yaw: number; phase: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const lx = 920 + k * 95, lz = 260 + k * 110 + Math.sin(k * 1.7) * 40;
    const hub = new THREE.Vector3(lx + O.x, farHeight(lx, lz) + 72, lz + O.z);
    turbines.push({ hub, yaw: -0.9 + k * 0.05, phase: k * 1.3 });
    glow.push({ position: hub.clone().add(new THREE.Vector3(0, 2.5, 0)), color: RED, size: 4.5, pulseSpeed: 1.6, pulseAmount: 0.98, phase: k * 0.2 });
  }
  const towerGeometry = own(new THREE.CylinderGeometry(1.1, 2.4, 72, 8).translate(0, -36, 0));
  const towers = new THREE.InstancedMesh(towerGeometry, vendBody, turbines.length);
  const bladeGeometry = own(mergeGeometries([0, 1, 2].map(b => new THREE.BoxGeometry(1.4, 34, 0.4).translate(0, 17, 0).rotateZ(b * Math.PI * 2 / 3)))!);
  const blades = new THREE.InstancedMesh(bladeGeometry, vendBody, turbines.length);
  turbines.forEach((turbine, i) => towers.setMatrixAt(i, new THREE.Matrix4().makeTranslation(turbine.hub.x, turbine.hub.y, turbine.hub.z)));
  towers.name = 'ridge-turbine-towers'; blades.name = 'ridge-turbine-blades';
  blades.frustumCulled = false;
  root.add(towers, blades);

  // ------------------------------------------------------------------ the city 180 m below
  const cityMaterial = own(new THREE.MeshBasicMaterial({ name: 'ridge-city-blocks', color: '#ffffff', fog: true }));
  cityMaterial.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCityWorld;\nvarying vec3 vCityNormal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCityWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;\nvCityNormal = normal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vCityWorld;
varying vec3 vCityNormal;
float cityHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `vec4 diffuseColor = vec4( vec3(0.018, 0.022, 0.03), opacity );
{
  float along = abs(vCityNormal.x) > 0.5 ? vCityWorld.z : vCityWorld.x;
  vec2 cell = vec2(floor(along / 3.2), floor(vCityWorld.y / 3.6));
  vec2 f = vec2(fract(along / 3.2), fract(vCityWorld.y / 3.6));
  float pane = step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.78);
  float lit = step(0.62, cityHash(cell + floor(vCityWorld.xz / 37.0)));
  vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(0.75, 0.85, 1.0), step(0.7, cityHash(cell * 1.7)));
  float roof = step(0.5, vCityNormal.y);
  diffuseColor.rgb += warm * pane * lit * (1.0 - roof) * 1.6;
}`);
  };
  const cityBlocks: THREE.Matrix4[] = [];
  const cityLights: GlowInstance[] = [];
  const STREET = hdr(1.8, 0.95, 0.35), WHITE = hdr(1.3, 1.35, 1.5), NEON = [hdr(2.2, 0.3, 1.1), hdr(0.3, 1.4, 2.2), hdr(2.2, 0.5, 0.2)];
  const downtown = new THREE.Vector2(60, 760);
  for (let gz = 320; gz <= 1180; gz += 58) for (let gx = -1150; gx <= 1150; gx += 58) {
    const center = new THREE.Vector2(gx, gz);
    const core = Math.exp(-center.distanceTo(downtown) / 260);
    const valleyY = ridgeNaturalLocal(gx, gz);
    if (farHeight(gx, gz) > valleyY + 25) continue;   // valley walls
    // Street lights along the block edges.
    for (let s = 0; s < 58; s += 19) {
      cityLights.push({ position: local(gx + s, gz - 4, valleyY + 6), color: STREET, size: 1.3 });
      if (rng() < 0.6) cityLights.push({ position: local(gx - 4, gz + s, valleyY + 6), color: STREET, size: 1.3 });
    }
    const towersHere = 1 + Math.floor(rng() * 3);
    for (let t = 0; t < towersHere; t++) {
      if (rng() > 0.35 + core) continue;
      const w = 12 + rng() * 20, d = 12 + rng() * 20, h = 8 + rng() * 18 + core * (40 + rng() * 150);
      const x = gx + 10 + rng() * 28, z = gz + 10 + rng() * 28;
      cityBlocks.push(new THREE.Matrix4().compose(local(x, z, valleyY + h / 2 - 2), new THREE.Quaternion(), new THREE.Vector3(w, h, d)));
      if (h > 90) cityLights.push({ position: local(x, z, valleyY + h + 2), color: RED, size: 3, pulseSpeed: 1.8, pulseAmount: 0.9, phase: rng() * 6 });
      if (rng() < 0.12) cityLights.push({ position: local(x + w / 2, z, valleyY + h * (0.4 + rng() * 0.5)), color: NEON[Math.floor(rng() * 3)]!, size: 4 + rng() * 4 });
    }
  }
  const city = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), cityMaterial, Math.max(1, cityBlocks.length));
  cityBlocks.forEach((matrix, i) => city.setMatrixAt(i, matrix));
  city.count = cityBlocks.length;
  city.name = 'ridge-valley-city';
  root.add(city);
  // Highways across the valley: rivers of head and tail lights.
  const traffic: MovingLight[] = [];
  const highways: readonly (readonly [number, number, number, number])[] = [[-1300, 360, 1300, 520], [-1250, 1000, 1250, 860], [-200, 300, 380, 1250], [700, 300, 520, 1200]];
  for (const [ax, az, bx, bz] of highways) {
    const a = local(ax, az, ridgeNaturalLocal(ax, az) + 4), b = local(bx, bz, ridgeNaturalLocal(bx, bz) + 4);
    const across = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar(5);
    for (let k = 0; k < 70; k++) {
      cityLights.push({ position: a.clone().lerp(b, k / 70).add(new THREE.Vector3(0, 6, 0)), color: STREET, size: 1.4 });
      traffic.push({ from: a.clone().add(across), to: b.clone().add(across), color: WHITE, size: 1.0, speed: 22 + rng() * 10, phase: rng() });
      traffic.push({ from: b.clone().sub(across), to: a.clone().sub(across), color: hdr(2.2, 0.15, 0.1), size: 0.9, speed: 22 + rng() * 10, phase: rng() });
    }
  }
  // A late flight crossing the valley.
  traffic.push({ from: local(-1600, 1200, 420), to: local(1600, 200, 380), color: hdr(2.5, 2.5, 2.8), size: 3, speed: 70, phase: 0.2 });

  const glowMesh = createGlowSprites('ridge-glow-sprites', glow, uniforms).mesh;
  const cityGlow = createGlowSprites('ridge-city-lights', cityLights, cityUniforms).mesh;
  const trafficMesh = createMovingLights('ridge-valley-traffic', traffic, cityUniforms);
  const studMesh = createRoadStuds('ridge-delineators', studs, uniforms, pixelScale);
  root.add(glowMesh, cityGlow, trafficMesh, studMesh);
  for (const mesh of [glowMesh, cityGlow, trafficMesh, studMesh]) { own(mesh.geometry); own(mesh.material as THREE.Material); }

  // ------------------------------------------------------------------ the sea of clouds
  const cloudUniforms = {
    uTime: { value: 0 }, uFog: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
    uOrigin: { value: new THREE.Vector3(O.x, O.y, O.z) }, uOpacity: { value: 0.6 },
  };
  const cloudMaterial = own(new THREE.ShaderMaterial({ name: 'ridge-valley-cloud-sea', vertexShader: CLOUD_VERTEX, fragmentShader: CLOUD_FRAGMENT,
    uniforms: cloudUniforms, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  const cloudLayers = mergeGeometries([-96, -118, -140].map((y, k) =>
    new THREE.PlaneGeometry(3400, 1500, 1, 1).rotateX(-Math.PI / 2).translate(O.x + k * 30, y, O.z + 980)))!;
  const clouds = new THREE.Mesh(own(cloudLayers), cloudMaterial);
  clouds.name = 'ridge-valley-cloud-sea';
  clouds.renderOrder = 4;
  root.add(clouds);

  // ------------------------------------------------------------------ runtime
  let glowScale = 1;
  const tmp = new THREE.Vector3();
  const bladeMatrix = new THREE.Matrix4(), bladeQuat = new THREE.Quaternion(), bladeEuler = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const spin = (elapsed: number): void => {
    turbines.forEach((turbine, i) => {
      bladeEuler.set(0, turbine.yaw, elapsed * 1.6 + turbine.phase, 'YXZ');
      bladeQuat.setFromEuler(bladeEuler);
      blades.setMatrixAt(i, bladeMatrix.compose(turbine.hub, bladeQuat, one));
    });
    blades.instanceMatrix.needsUpdate = true;
  };
  spin(0);
  let disposed = false;
  return {
    district: 'ridge', root, lampPositions,
    setAtmosphere(recipe): void {
      glowScale = recipe.lampGlow;
      uniforms.scale.value = glowScale;
      cityUniforms.scale.value = 0.6 + 0.4 * glowScale;
      uniforms.fogDensity.value = recipe.fogDensity;
      cityUniforms.fogDensity.value = recipe.fogDensity * 0.32;
      cloudUniforms.uFog.value.set(recipe.fog);
      cloudUniforms.uGlow.value.set(recipe.city).multiplyScalar(0.55 + recipe.cityStrength * 0.5);
      chevronMaterial.emissiveIntensity = 0.3 + 0.35 * glowScale;
      vendMaterial.emissiveIntensity = 1.2 + 0.6 * glowScale;
    },
    setQuality(preset): void {
      forest.count = Math.round(trees.length * (preset === 'low' ? 0.35 : preset === 'balanced' ? 0.8 : 1));
      // Each sheet is one quad (6 indices): phones get a single sheet of overdraw.
      cloudLayers.setDrawRange(0, preset === 'low' ? 6 : Infinity);
    },
    update(elapsedSeconds, camera): void {
      uniforms.time.value = elapsedSeconds;
      cityUniforms.time.value = elapsedSeconds;
      cloudUniforms.uTime.value = elapsedSeconds;
      camera.getWorldPosition(tmp);
      uniforms.cameraPosition.value.copy(tmp);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        pixelScale.value = 1000 / (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2));
      }
      spin(elapsedSeconds);
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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
