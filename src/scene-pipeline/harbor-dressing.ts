import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RouteDefinition } from '../../contracts/world-contracts';
import type { AtmosphereRecipe } from './atmosphere';
import {
  createGlowSprites, createLightUniforms, createRoadStuds, createWetStreaks,
  type GlowInstance, type StudInstance, type WetStreakInstance,
} from './light-sprites';

/** Editable original scene source for supplemental, non-colliding Harbor dressing. */
export const HARBOR_DRESSING_VERSION = 'harbor-dressing-v3';

interface ContainerAnchor {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly level: 0 | 1;
  readonly color: string;
}

/** Storage stays well beyond the 13.5 m road corridor and the crossover sightline. */
export const CONTAINER_ANCHORS: readonly ContainerAnchor[] = [
  { x: -169, z: 82, yaw: .05, level: 0, color: '#c2432f' },
  { x: -162, z: 82, yaw: .05, level: 0, color: '#e08a2c' },
  { x: -155, z: 82, yaw: .05, level: 0, color: '#2d6fae' },
  { x: -162, z: 82, yaw: .05, level: 1, color: '#2f9a8c' },
  { x: -176, z: 91, yaw: -.07, level: 0, color: '#dcb437' },
  { x: -169, z: 91, yaw: -.07, level: 0, color: '#6f9a3a' },
  { x: -176, z: 91, yaw: -.07, level: 1, color: '#8c3f66' },
  { x: -116, z: 103, yaw: Math.PI / 2 + .06, level: 0, color: '#3f5fb0' },
  { x: -116, z: 110, yaw: Math.PI / 2 + .06, level: 0, color: '#c9ced2' },
  { x: -116, z: 110, yaw: Math.PI / 2 + .06, level: 1, color: '#d4572a' },
  { x: -58, z: 98, yaw: -.04, level: 0, color: '#c2432f' },
  { x: -51, z: 98, yaw: -.04, level: 0, color: '#e08a2c' },
  { x: -44, z: 98, yaw: -.04, level: 0, color: '#2d6fae' },
  { x: -51, z: 98, yaw: -.04, level: 1, color: '#2f9a8c' },
  // A working stack along the west apron makes HW-01's opening bend read as a yard.
  { x: -100, z: 85, yaw: .035, level: 0, color: '#dcb437' },
  { x: -93, z: 85, yaw: .035, level: 0, color: '#6f9a3a' },
  { x: -100, z: 85, yaw: .035, level: 1, color: '#8c3f66' },
  { x: -140, z: 72, yaw: -.02, level: 0, color: '#3f5fb0' },
  { x: -133, z: 72, yaw: -.02, level: 0, color: '#c9ced2' },
  { x: 45, z: 116, yaw: Math.PI / 2, level: 0, color: '#d4572a' },
  { x: 53, z: 116, yaw: Math.PI / 2, level: 0, color: '#c2432f' },
  { x: 45, z: 116, yaw: Math.PI / 2, level: 1, color: '#e08a2c' },
  { x: 99, z: 116, yaw: .12, level: 0, color: '#2d6fae' },
  { x: 106, z: 116, yaw: .12, level: 0, color: '#2f9a8c' },
];

const TANK_ANCHORS: readonly (readonly [number, number])[] = [
  [-82, 2], [-94, -1], [-106, 4],
];
const SERVICE_POLES: readonly (readonly [number, number])[] = [
  [-50, 72], [-10, 58], [15, 76], [89, 93],
];
const PIPE_RACK_X: readonly number[] = [-112, -84, -56, -28, 0, 28, 56, 84, 112];

export interface HarborDressing {
  readonly root: THREE.Group;
  readonly sourceVersion: typeof HARBOR_DRESSING_VERSION;
  /** Horizontal distance from each solid decorative anchor to route centerline. */
  readonly solidAnchorClearancesM: readonly number[];
  /** Lens-height world positions of practical lights; nearest few become real point lights. */
  readonly lampPositions: readonly THREE.Vector3[];
  setAtmosphere(recipe: AtmosphereRecipe): void;
  /** Advance shader clocks and aim streak reflections at the viewer. Cheap; call once per frame. */
  update(elapsedSeconds: number, camera: THREE.Camera): void;
  dispose(): void;
}

function segmentDistanceXZ(point: Readonly<{ x: number; z: number }>, a: Readonly<{ x: number; z: number }>, b: Readonly<{ x: number; z: number }>): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const denominator = dx * dx + dz * dz;
  const t = denominator > 0 ? THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / denominator, 0, 1) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

export function routeClearanceXZ(route: RouteDefinition, point: Readonly<{ x: number; z: number }>): number {
  let closest = Infinity;
  for (let i = 1; i < route.centerline.length; i++) {
    closest = Math.min(closest, segmentDistanceXZ(point, route.centerline[i - 1]!, route.centerline[i]!));
  }
  return closest;
}

function ridgeMesh(name: string, axis: 'x' | 'z', depth: number, baseY: number, heights: readonly number[], material: THREE.Material): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const left = -540, spacing = 1080 / (heights.length - 1);
  for (let i = 0; i < heights.length; i++) {
    const x = left + i * spacing;
    const topY = baseY + heights[i]!;
    if (axis === 'x') positions.push(depth, topY, x, depth, -32, x);
    else positions.push(x, topY, depth, x, -32, depth);
    const light = 0.86 + 0.14 * Math.sin(i * .55 + depth * .01);
    colors.push(light, light, light, .71, .74, .76);
    if (i < heights.length - 1) {
      const a = i * 2, b = a + 2;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

function smoothRidgeProfile(controls: readonly number[]): number[] {
  const heights: number[] = [];
  for (let i = 0; i < controls.length - 1; i++) {
    for (let step = 0; step < 4; step++) {
      const t = step / 4;
      heights.push(THREE.MathUtils.lerp(controls[i]!, controls[i + 1]!, t * t * (3 - 2 * t)));
    }
  }
  heights.push(controls.at(-1)!);
  return heights;
}

function beamTransform(start: THREE.Vector3, end: THREE.Vector3, thickness: number): THREE.Matrix4 {
  const length = start.distanceTo(end);
  const position = start.clone().add(end).multiplyScalar(.5);
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
  return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(thickness, length, thickness));
}

interface RidgeSpec {
  readonly name: string; readonly axis: 'x' | 'z'; readonly depth: number; readonly baseY: number;
  readonly material: THREE.Material; readonly heights: readonly number[];
}

const LAMP_SPACING_M = 38;
const STUD_SPACING_M = 5;
const POOL_RADIUS_M = 7.5;

const fract = (value: number): number => value - Math.floor(value);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RouteSample { point: THREE.Vector3; tangent: THREE.Vector3; tangent3: THREE.Vector3 }

/** Evenly spaced points along the closed route polyline with planar and 3D tangents. */
function resampleRoute(route: RouteDefinition, spacing: number): RouteSample[] {
  const points = route.centerline.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const out: RouteSample[] = [];
  let carried = spacing * .5;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const length = a.distanceTo(b);
    if (length < 1e-6) continue;
    const tangent3 = b.clone().sub(a).normalize();
    const tangent = new THREE.Vector3(tangent3.x, 0, tangent3.z).normalize();
    while (carried <= length) {
      out.push({ point: a.clone().addScaledVector(tangent3, carried), tangent, tangent3 });
      carried += spacing;
    }
    carried -= length;
  }
  return out;
}

/** Soft radial falloff used for light pools. A DataTexture, so it works without a DOM. */
function radialTexture(): THREE.DataTexture {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
    const a = Math.max(0, 1 - r);
    const v = Math.round(255 * a * a * (3 - 2 * a));
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

type Glyph = { readonly width: number; readonly strokes: readonly (readonly (readonly [number, number])[])[] };
/**
 * Single-stroke tube alphabet (cap height 1, y up). Real neon is bent from one tube, so stroking these
 * centre-lines reads as lit glass at any distance or viewing angle, where outlined system-font glyphs
 * turn into hollow double lines once the sign is foreshortened.
 */
const NEON_GLYPHS: Readonly<Record<string, Glyph>> = {
  A: { width: .6, strokes: [[[0, 0], [.3, 1], [.6, 0]], [[.12, .4], [.48, .4]]] },
  C: { width: .52, strokes: [[[.52, .88], [.4, 1], [.12, 1], [0, .88], [0, .12], [.12, 0], [.4, 0], [.52, .12]]] },
  D: { width: .52, strokes: [[[0, 0], [0, 1], [.28, 1], [.52, .8], [.52, .2], [.28, 0], [0, 0]]] },
  E: { width: .5, strokes: [[[.5, 1], [0, 1], [0, 0], [.5, 0]], [[0, .5], [.38, .5]]] },
  F: { width: .5, strokes: [[[0, 0], [0, 1], [.5, 1]], [[0, .52], [.4, .52]]] },
  G: { width: .52, strokes: [[[.52, .88], [.4, 1], [.12, 1], [0, .88], [0, .12], [.12, 0], [.4, 0], [.52, .12], [.52, .4], [.28, .4]]] },
  H: { width: .52, strokes: [[[0, 0], [0, 1]], [[.52, 0], [.52, 1]], [[0, .5], [.52, .5]]] },
  I: { width: .2, strokes: [[[.1, 0], [.1, 1]]] },
  K: { width: .54, strokes: [[[0, 0], [0, 1]], [[.5, 1], [0, .42]], [[.14, .58], [.54, 0]]] },
  N: { width: .52, strokes: [[[0, 0], [0, 1], [.52, 0], [.52, 1]]] },
  O: { width: .52, strokes: [[[.12, 0], [.4, 0], [.52, .12], [.52, .88], [.4, 1], [.12, 1], [0, .88], [0, .12], [.12, 0]]] },
  R: { width: .54, strokes: [[[0, 0], [0, 1], [.4, 1], [.52, .88], [.52, .64], [.4, .52], [0, .52]], [[.3, .52], [.54, 0]]] },
  S: { width: .52, strokes: [[[.52, .88], [.4, 1], [.12, 1], [0, .88], [0, .64], [.12, .52], [.4, .48], [.52, .36], [.52, .12], [.4, 0], [.12, 0], [0, .12]]] },
  T: { width: .6, strokes: [[[0, 1], [.6, 1]], [[.3, 1], [.3, 0]]] },
  U: { width: .52, strokes: [[[0, 1], [0, .12], [.12, 0], [.4, 0], [.52, .12], [.52, 1]]] },
  Y: { width: .56, strokes: [[[0, 1], [.28, .52], [.56, 1]], [[.28, .52], [.28, 0]]] },
  '7': { width: .52, strokes: [[[0, 1], [.52, 1], [.2, 0]]] },
  L: { width: .48, strokes: [[[0, 1], [0, 0], [.48, 0]]] },
  M: { width: .62, strokes: [[[0, 0], [0, 1], [.31, .45], [.62, 1], [.62, 0]]] },
  P: { width: .52, strokes: [[[0, 0], [0, 1], [.4, 1], [.52, .88], [.52, .64], [.4, .52], [0, .52]]] },
  B: { width: .52, strokes: [[[0, 0], [0, 1], [.38, 1], [.5, .88], [.5, .64], [.38, .52], [0, .52]], [[.38, .52], [.52, .4], [.52, .12], [.4, 0], [0, 0]]] },
  V: { width: .56, strokes: [[[0, 1], [.28, 0], [.56, 1]]] },
  W: { width: .74, strokes: [[[0, 1], [.18, 0], [.37, .6], [.56, 0], [.74, 1]]] },
  X: { width: .54, strokes: [[[0, 0], [.54, 1]], [[0, 1], [.54, 0]]] },
  '2': { width: .5, strokes: [[[0, .86], [.12, 1], [.38, 1], [.5, .86], [.5, .62], [0, 0], [.5, 0]]] },
  '4': { width: .52, strokes: [[[.38, 0], [.38, 1], [0, .32], [.52, .32]]] },
  ' ': { width: .32, strokes: [] },
};
const NEON_TRACKING = .2;

export function neonTextAspect(text: string): number {
  let width = 0;
  for (const ch of text) width += (NEON_GLYPHS[ch] ?? NEON_GLYPHS[' ']!).width + NEON_TRACKING;
  return Math.max(2, (width - NEON_TRACKING + 1) / 2);
}

/** Glowing single-stroke tube lettering with a hot core. Returns null where no canvas exists (tests, workers). */
export function neonTexture(text: string, color: string, core: string): { texture: THREE.CanvasTexture; aspect: number } | null {
  if (typeof document === 'undefined') return null;
  const aspect = neonTextAspect(text);
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = Math.round(2048 / aspect);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // Fit: glyph rows occupy the middle half of the plate height, leaving room for the tube halo to fade out.
  const capHeight = canvas.height / 2;
  const textWidth = [...text].reduce((total, ch) => total + (NEON_GLYPHS[ch] ?? NEON_GLYPHS[' ']!).width + NEON_TRACKING, -NEON_TRACKING);
  const unit = Math.min(capHeight, (canvas.width - capHeight) / textWidth);
  const x0 = (canvas.width - textWidth * unit) / 2;
  const y0 = (canvas.height + capHeight) / 2;
  const draw = (width: number, style: string, blur: number, alpha: number): void => {
    ctx.save();
    ctx.globalAlpha = alpha; ctx.strokeStyle = style; ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.lineWidth = width;
    let cursor = x0;
    for (const ch of text) {
      const glyph = NEON_GLYPHS[ch] ?? NEON_GLYPHS[' ']!;
      for (const stroke of glyph.strokes) {
        ctx.beginPath();
        stroke.forEach(([gx, gy], index) => {
          const px = cursor + gx * unit, py = y0 - gy * unit;
          if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      cursor += (glyph.width + NEON_TRACKING) * unit;
    }
    ctx.restore();
  };
  const tube = Math.max(10, unit * .085);
  draw(tube * 2.2, color, tube * 2.6, .3);
  draw(tube * 1.35, color, tube * 1.2, 1);
  draw(tube * .5, core, tube * .4, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, aspect };
}

export function createHarborDressing(route: RouteDefinition): HarborDressing {
  const root = new THREE.Group();
  root.name = `HarborDressing_${HARBOR_DRESSING_VERSION}`;
  const clearances = [
    ...CONTAINER_ANCHORS.map(anchor => routeClearanceXZ(route, anchor) - 3.3),
    ...TANK_ANCHORS.map(([x, z]) => routeClearanceXZ(route, { x, z }) - 4.1),
    ...SERVICE_POLES.map(([x, z]) => routeClearanceXZ(route, { x, z }) - .45),
    ...PIPE_RACK_X.map(x => routeClearanceXZ(route, { x, z: -115 }) - .4),
  ];
  const minimum = route.widthM * .5 + 18;
  if (clearances.some(distance => distance < minimum)) {
    throw new Error(`Harbor dressing solid anchor intrudes into the road corridor (<${minimum.toFixed(1)}m)`);
  }
  let disposed = false;

  const containerMaterial = new THREE.MeshStandardMaterial({ name: 'dressing-container-paint', color: '#ffffff', roughness: .83, metalness: .16 });
  const ribMaterial = new THREE.MeshStandardMaterial({ name: 'dressing-container-ribs', color: '#24363b', roughness: .92, metalness: .12 });
  const doorMaterial = new THREE.MeshStandardMaterial({ name: 'dressing-container-doors', color: '#c6c2ab', roughness: .79, metalness: .1 });
  const bodyGeometry = new THREE.BoxGeometry(6.05, 2.44, 2.42);
  const ribGeometry = new THREE.BoxGeometry(.07, 2.22, .035);
  const doorGeometry = new THREE.BoxGeometry(.035, 2.21, 2.20);
  const bodies = new THREE.InstancedMesh(bodyGeometry, containerMaterial, CONTAINER_ANCHORS.length);
  bodies.name = 'yard-cargo-container-shells';
  bodies.castShadow = true;
  bodies.receiveShadow = true;
  bodies.userData.cameraCollision = true;
  const ribsPerContainer = 22;
  const ribs = new THREE.InstancedMesh(ribGeometry, ribMaterial, CONTAINER_ANCHORS.length * ribsPerContainer);
  ribs.name = 'yard-cargo-corrugation';
  const doors = new THREE.InstancedMesh(doorGeometry, doorMaterial, CONTAINER_ANCHORS.length * 2);
  doors.name = 'yard-cargo-end-doors';
  const dummy = new THREE.Object3D();
  let ribIndex = 0, doorIndex = 0;
  for (let index = 0; index < CONTAINER_ANCHORS.length; index++) {
    const anchor = CONTAINER_ANCHORS[index]!;
    const baseY = .61 + anchor.level * 2.51;
    dummy.position.set(anchor.x, baseY, anchor.z);
    dummy.rotation.set(0, anchor.yaw, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    bodies.setMatrixAt(index, dummy.matrix);
    bodies.setColorAt(index, new THREE.Color(anchor.color));
    const cosine = Math.cos(anchor.yaw), sine = Math.sin(anchor.yaw);
    for (const side of [-1, 1]) {
      for (let i = 0; i < ribsPerContainer / 2; i++) {
        const localX = -2.75 + i * .55, localZ = side * 1.23;
        dummy.position.set(anchor.x + localX * cosine + localZ * sine, baseY,
          anchor.z - localX * sine + localZ * cosine);
        dummy.rotation.set(0, anchor.yaw, 0);
        dummy.updateMatrix();
        ribs.setMatrixAt(ribIndex++, dummy.matrix);
      }
      const localX = side * 3.045;
      dummy.position.set(anchor.x + localX * cosine, baseY, anchor.z - localX * sine);
      dummy.rotation.set(0, anchor.yaw + Math.PI / 2, 0);
      dummy.updateMatrix();
      doors.setMatrixAt(doorIndex++, dummy.matrix);
    }
  }
  bodies.instanceMatrix.needsUpdate = true;
  ribs.instanceMatrix.needsUpdate = true;
  doors.instanceMatrix.needsUpdate = true;
  root.add(bodies, ribs, doors);

  // A compact tank farm and amber service lights fill the near Harbor apron.
  // Footprint radii are included in the road-clearance proof above.
  const tankPaint = new THREE.MeshStandardMaterial({ name: 'dressing-tank-salt-teal', color: '#617e7e', roughness: .66, metalness: .34 });
  const tankTop = new THREE.MeshStandardMaterial({ name: 'dressing-tank-cap', color: '#9b9e8e', roughness: .79, metalness: .18 });
  const tankBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(3.65, 3.85, 9.2, 18), tankPaint, TANK_ANCHORS.length);
  tankBody.name = 'harbor-tank-farm-bodies'; tankBody.castShadow = true; tankBody.receiveShadow = true;
  tankBody.userData.cameraCollision = true;
  const tankRoofs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0, 3.7, 1.15, 18), tankTop, TANK_ANCHORS.length);
  tankRoofs.name = 'harbor-tank-farm-roofs'; tankRoofs.castShadow = true;
  for (let i = 0; i < TANK_ANCHORS.length; i++) {
    const [x, z] = TANK_ANCHORS[i]!;
    dummy.position.set(x, 3.98, z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
    tankBody.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 9.14; dummy.updateMatrix();
    tankRoofs.setMatrixAt(i, dummy.matrix);
  }
  tankBody.instanceMatrix.needsUpdate = true;
  tankRoofs.instanceMatrix.needsUpdate = true;
  root.add(tankBody, tankRoofs);
  const bandPaint = new THREE.MeshStandardMaterial({ name: 'dressing-tank-bands', color: '#314c50', roughness: .8, metalness: .25 });
  const tankBands = new THREE.InstancedMesh(new THREE.TorusGeometry(3.72, .09, 5, 24), bandPaint, TANK_ANCHORS.length * 2);
  tankBands.name = 'harbor-tank-farm-safety-bands';
  for (let i = 0; i < TANK_ANCHORS.length; i++) {
    const [x, z] = TANK_ANCHORS[i]!;
    for (let band = 0; band < 2; band++) {
      dummy.position.set(x, 1.0 + band * 5.9, z);
      dummy.rotation.set(Math.PI / 2, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      tankBands.setMatrixAt(i * 2 + band, dummy.matrix);
    }
  }
  tankBands.instanceMatrix.needsUpdate = true;
  root.add(tankBands);

  const polePaint = new THREE.MeshStandardMaterial({ name: 'dressing-service-pole', color: '#3e5457', roughness: .71, metalness: .43 });
  const poleAmber = new THREE.MeshStandardMaterial({ name: 'dressing-service-amber', color: '#e9ae66', emissive: '#9f5e25', emissiveIntensity: .55, roughness: .4 });
  const poleStems = new THREE.InstancedMesh(new THREE.CylinderGeometry(.13, .19, 10.5, 8), polePaint, SERVICE_POLES.length);
  poleStems.name = 'harbor-service-light-stems'; poleStems.castShadow = true;
  const poleHeads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.15, .27, .6), poleAmber, SERVICE_POLES.length);
  poleHeads.name = 'harbor-service-light-heads';
  for (let i = 0; i < SERVICE_POLES.length; i++) {
    const [x, z] = SERVICE_POLES[i]!;
    dummy.position.set(x, 4.63, z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
    poleStems.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 9.97; dummy.updateMatrix();
    poleHeads.setMatrixAt(i, dummy.matrix);
  }
  poleStems.instanceMatrix.needsUpdate = true;
  poleHeads.instanceMatrix.needsUpdate = true;
  root.add(poleStems, poleHeads);

  // Faded concrete joins and loading-bay footprints break up the wide apron.
  const seamMaterial = new THREE.MeshBasicMaterial({ name: 'dressing-apron-seams', color: '#35403f', transparent: true, opacity: .22, depthWrite: false });
  const seamGeometry = new THREE.PlaneGeometry(1, 1);
  const seamAnchors: readonly (readonly [number, number, number, number])[] = [
    [-196, 74, 84, .07], [-196, 98, 84, .07], [-196, 122, 84, .07],
    [-105, 84, 58, .06], [-105, 111, 58, .06], [-37, 81, 66, .07], [-37, 112, 66, .07],
    [52, 86, 89, .07], [52, 120, 89, .07], [132, 99, 72, .07],
    [-150, 64, .07, 60], [-150, 136, .07, 60], [-56, 63, .07, 67], [-56, 137, .07, 67],
    [49, 68, .07, 73], [49, 137, .07, 73],
  ];
  const seams = new THREE.InstancedMesh(seamGeometry, seamMaterial, seamAnchors.length);
  seams.name = 'yard-expansion-joints';
  for (let i = 0; i < seamAnchors.length; i++) {
    const [x, z, sx, sz] = seamAnchors[i]!;
    dummy.position.set(x, -.603, z);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.set(sx, sz, 1);
    dummy.updateMatrix();
    seams.setMatrixAt(i, dummy.matrix);
  }
  seams.instanceMatrix.needsUpdate = true;
  root.add(seams);

  // Lattice braces and roof services lend human scale to the existing loading shed.
  const steel = new THREE.MeshStandardMaterial({ name: 'dressing-weathered-steel', color: '#485c5e', roughness: .7, metalness: .47 });
  const amber = new THREE.MeshStandardMaterial({ name: 'dressing-yard-amber', color: '#ddac68', emissive: '#78451d', emissiveIntensity: .65, roughness: .4 });
  const beamSources: { name: string; transform: THREE.Matrix4 }[] = [];
  const recordBeam = (name: string, start: THREE.Vector3, end: THREE.Vector3, thickness: number): void => {
    beamSources.push({ name, transform: beamTransform(start, end, thickness) });
  };
  const shed = new THREE.Group(); shed.name = 'shed-service-detail'; root.add(shed);
  for (let i = 0; i < 4; i++) {
    const x = -202 + i * 14;
    recordBeam(`shed-canopy-${i}`, new THREE.Vector3(x, 8.8, 13.4), new THREE.Vector3(x, 10.6, 8.2), .18);
    const luminaire = new THREE.Mesh(new THREE.BoxGeometry(1.25, .15, .30), amber);
    luminaire.name = `loading-bay-lamp-${i}`;
    luminaire.position.set(x, 9.5, 9.1);
    shed.add(luminaire);
  }
  const vents = new THREE.InstancedMesh(new THREE.BoxGeometry(2.1, .75, 3.7), steel, 5);
  vents.name = 'shed-roof-service-vents';
  vents.castShadow = true;
  for (let i = 0; i < 5; i++) {
    dummy.position.set(-205 + i * 12, 15.1, 22 + (i % 2) * 6);
    dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
    vents.setMatrixAt(i, dummy.matrix);
  }
  vents.instanceMatrix.needsUpdate = true;
  shed.add(vents);

  const craneBracing = new THREE.Group(); craneBracing.name = 'crane-lattice-bracing'; root.add(craneBracing);
  for (const [index, x] of [-226, -166, 196].entries()) {
    const z = -72 + index * 8;
    for (const side of [-1, 1]) {
      recordBeam(`crane-${index}-lower-brace-${side}`,
        new THREE.Vector3(x + side * 10, 2, z), new THREE.Vector3(x - side * 2, 31, z), .22);
      recordBeam(`crane-${index}-upper-brace-${side}`,
        new THREE.Vector3(x + side * 10, 35, z), new THREE.Vector3(x, 39, z + side * 5), .16);
    }
    recordBeam(`crane-${index}-hoist-cable`,
      new THREE.Vector3(x + 6, 36.5, z), new THREE.Vector3(x + 6, 13.5, z), .065);
    const trolley = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.65, 2.7), steel);
    trolley.name = `crane-${index}-service-trolley`;
    trolley.position.set(x + 6, 36.8, z); trolley.castShadow = true; craneBracing.add(trolley);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(.65, 1.2, .75), amber);
    hook.name = `crane-${index}-load-hook`;
    hook.position.set(x + 6, 12.8, z); craneBracing.add(hook);
  }
  const structuralBeams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, beamSources.length);
  structuralBeams.name = 'harbor-structural-beams';
  structuralBeams.userData.sourceNames = beamSources.map(source => source.name);
  structuralBeams.castShadow = true;
  structuralBeams.receiveShadow = true;
  beamSources.forEach((source, index) => structuralBeams.setMatrixAt(index, source.transform));
  structuralBeams.instanceMatrix.needsUpdate = true;
  root.add(structuralBeams);

  // A far-side process pipe rack closes the empty industrial horizon without
  // entering the playable road or its crossover sightline.
  const rack = new THREE.Group(); rack.name = 'far-quay-process-pipe-rack'; root.add(rack);
  const rackPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(.36, 7.5, .36), steel, PIPE_RACK_X.length * 2);
  rackPosts.name = 'process-rack-posts';
  const rackHeaders = new THREE.InstancedMesh(new THREE.BoxGeometry(28.35, .3, .32), steel, (PIPE_RACK_X.length - 1) * 2);
  rackHeaders.name = 'process-rack-headers';
  const rackPipes = new THREE.InstancedMesh(new THREE.CylinderGeometry(.15, .15, 225, 8), steel, 3);
  rackPipes.name = 'process-rack-pipes';
  for (let i = 0; i < PIPE_RACK_X.length; i++) {
    const x = PIPE_RACK_X[i]!;
    for (const side of [-1, 1]) {
      dummy.position.set(x, 3.13, -115 + side * 1.9);
      dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      rackPosts.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), dummy.matrix);
    }
    if (i >= PIPE_RACK_X.length - 1) continue;
    const midX = (x + PIPE_RACK_X[i + 1]!) / 2;
    for (const side of [-1, 1]) {
      dummy.position.set(midX, 6.9, -115 + side * 1.9);
      dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      rackHeaders.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), dummy.matrix);
    }
  }
  for (let i = 0; i < 3; i++) {
    dummy.position.set(0, 7.22, -116.25 + i * 1.25);
    dummy.rotation.set(0, 0, Math.PI / 2); dummy.scale.setScalar(1); dummy.updateMatrix();
    rackPipes.setMatrixAt(i, dummy.matrix);
  }
  rackPosts.instanceMatrix.needsUpdate = true;
  rackHeaders.instanceMatrix.needsUpdate = true;
  rackPipes.instanceMatrix.needsUpdate = true;
  rack.add(rackPosts, rackHeaders, rackPipes);

  const ridgeFar = new THREE.MeshBasicMaterial({ name: 'dressing-ridge-far', color: '#738b92', vertexColors: true, side: THREE.DoubleSide, fog: true });
  const ridgeNear = new THREE.MeshBasicMaterial({ name: 'dressing-ridge-near', color: '#506971', vertexColors: true, side: THREE.DoubleSide, fog: true });
  // HW-01's first quarter faces west, so two extra coastal layers close its apron horizon.
  const ridgeSpecs: readonly RidgeSpec[] = [
    { name: 'layered-coastal-ridge-far', axis: 'z', depth: -390, baseY: 8, material: ridgeFar, heights: smoothRidgeProfile(
      [20, 22, 24, 27, 29, 31, 33, 32, 29, 27, 30, 34, 36, 35, 32, 28, 24, 21]) },
    { name: 'layered-coastal-ridge-near', axis: 'z', depth: -295, baseY: 4, material: ridgeNear, heights: smoothRidgeProfile(
      [12, 15, 19, 21, 24, 25, 23, 20, 22, 26, 28, 27, 25, 22, 20, 18, 15, 12]) },
    { name: 'west-coastal-ridge-far', axis: 'x', depth: -510, baseY: 8, material: ridgeFar, heights: smoothRidgeProfile(
      [18, 20, 23, 24, 27, 31, 29, 32, 35, 33, 36, 37, 34, 32, 29, 27, 25, 27, 29, 26, 23, 22, 20, 18]) },
    { name: 'west-coastal-ridge-near', axis: 'x', depth: -370, baseY: 3, material: ridgeNear, heights: smoothRidgeProfile(
      [9, 11, 14, 17, 19, 18, 21, 24, 25, 23, 26, 29, 31, 30, 27, 24, 22, 21, 23, 24, 22, 19, 15, 12]) },
  ];
  for (const spec of ridgeSpecs) root.add(ridgeMesh(spec.name, spec.axis, spec.depth, spec.baseY, spec.heights, spec.material));

  // ---------------------------------------------------------------- after-hours lighting dressing
  const lightUniforms = createLightUniforms();
  const pixelScale = { value: 900 };
  const rng = mulberry32(0x4a11);
  const hdr = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  const AMBER = hdr(2.4, 1.15, .36);
  const glowSprites: GlowInstance[] = [];
  const streaks: WetStreakInstance[] = [];
  const studs: StudInstance[] = [];
  const lampPositions: THREE.Vector3[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  // Street lamps on arms over the road, every ~36 m, alternating sides.
  const samples = resampleRoute(route, LAMP_SPACING_M);
  const lampOffset = route.widthM / 2 + 4.3;
  const lampRows: { pole: THREE.Matrix4; arm: THREE.Matrix4; lens: THREE.Matrix4; pool: THREE.Matrix4 }[] = [];
  samples.forEach((sample, index) => {
    const side = index % 2 === 0 ? 1 : -1;
    const normal = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const base = new THREE.Vector3(sample.point.x, 0, sample.point.z).addScaledVector(normal, side * lampOffset);
    if (routeClearanceXZ(route, base) < route.widthM / 2 + 3.4) return;
    const toRoad = normal.clone().multiplyScalar(-side);
    const top = sample.point.y + 9.1;
    const yaw = Math.atan2(-toRoad.z, toRoad.x);
    const groundY = -.9;
    const pole = new THREE.Matrix4().compose(new THREE.Vector3(base.x, (groundY + top) / 2, base.z),
      new THREE.Quaternion(), new THREE.Vector3(1, top - groundY, 1));
    const armQuat = new THREE.Quaternion().setFromAxisAngle(up, yaw);
    const arm = new THREE.Matrix4().compose(new THREE.Vector3(base.x, top, base.z), armQuat, new THREE.Vector3(1, 1, 1));
    const lens = base.clone().addScaledVector(toRoad, 2.15); lens.y = top - .22;
    lampRows.push({ pole, arm, lens: new THREE.Matrix4().compose(lens, armQuat, new THREE.Vector3(1, 1, 1)), pool: new THREE.Matrix4() });
    lampPositions.push(lens.clone());
    glowSprites.push({ position: lens.clone().add(new THREE.Vector3(0, -.05, 0)), color: AMBER, size: 2.3,
      pulseSpeed: 1.3 + rng() * .8, pulseAmount: .035, phase: rng() * 6.28 });
    // Pool of light on the carriageway and its wet reflection streak.
    const poolPoint = new THREE.Vector3(sample.point.x, sample.point.y, sample.point.z).addScaledVector(normal, side * 3.4);
    const right = new THREE.Vector3().crossVectors(sample.tangent3, up).normalize();
    const surfaceNormal = new THREE.Vector3().crossVectors(right, sample.tangent3).normalize();
    lampRows[lampRows.length - 1]!.pool.makeBasis(right, sample.tangent3, surfaceNormal)
      .setPosition(poolPoint.x, sample.point.y + .135, poolPoint.z);
    lampRows[lampRows.length - 1]!.pool.multiply(new THREE.Matrix4().makeScale(POOL_RADIUS_M * 2, POOL_RADIUS_M * 2, 1));
    streaks.push({ position: new THREE.Vector3(poolPoint.x, lens.y, poolPoint.z), groundY: sample.point.y + .1, color: hdr(1.5, .66, .2) });
  });
  const lampCount = lampRows.length;
  const steelDark = new THREE.MeshStandardMaterial({ name: 'dressing-street-lamp-steel', color: '#2b3437', roughness: .5, metalness: .6 });
  const armGeometry = mergeGeometries([
    new THREE.BoxGeometry(2.3, .13, .13).translate(1.05, 0, 0),
    new THREE.BoxGeometry(1.05, .17, .46).translate(2.15, -.13, 0),
    new THREE.CylinderGeometry(.1, .1, .5, 6).translate(0, -.2, 0),
  ])!;
  const lampPoles = new THREE.InstancedMesh(new THREE.CylinderGeometry(.085, .17, 1, 8), steelDark, Math.max(1, lampCount));
  lampPoles.name = 'street-lamp-poles';
  const lampArms = new THREE.InstancedMesh(armGeometry, steelDark, Math.max(1, lampCount));
  lampArms.name = 'street-lamp-arms-housings';
  const lensMaterial = new THREE.MeshBasicMaterial({ name: 'dressing-street-lamp-lens', color: '#ffffff', toneMapped: true });
  const lampLens = new THREE.InstancedMesh(new THREE.BoxGeometry(.85, .05, .34), lensMaterial, Math.max(1, lampCount));
  lampLens.name = 'street-lamp-lenses';
  const poolMaterial = new THREE.MeshBasicMaterial({
    name: 'dressing-street-lamp-pools', map: radialTexture(), color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const lampPools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMaterial, Math.max(1, lampCount));
  lampPools.name = 'street-lamp-light-pools';
  lampPools.renderOrder = 2;
  lampPools.frustumCulled = false;
  lampRows.forEach((row, index) => {
    lampPoles.setMatrixAt(index, row.pole); lampArms.setMatrixAt(index, row.arm);
    lampLens.setMatrixAt(index, row.lens); lampPools.setMatrixAt(index, row.pool);
  });
  lampPoles.count = lampArms.count = lampLens.count = lampPools.count = lampCount;
  lampPoles.frustumCulled = lampArms.frustumCulled = lampLens.frustumCulled = false;
  root.add(lampPoles, lampArms, lampLens, lampPools);

  // Yard floodlights and service poles reuse the same glow family.
  for (const [x, z] of SERVICE_POLES) {
    glowSprites.push({ position: new THREE.Vector3(x, 9.85, z), color: AMBER, size: 3.0, pulseSpeed: 1.1, pulseAmount: .04, phase: x });
    lampPositions.push(new THREE.Vector3(x, 9.85, z));
  }
  const toWorld = (cx: number, cz: number, yaw: number, lx: number, lz: number, y: number): THREE.Vector3 => new THREE.Vector3(
    cx + lx * Math.cos(yaw) + lz * Math.sin(yaw), y, cz - lx * Math.sin(yaw) + lz * Math.cos(yaw));
  const SHED = { x: -180, z: 30, yaw: -.08, hx: 29, hz: 15.5 };
  const HALL = { x: 180, z: -75, yaw: .12, hx: 23, hz: 17 };
  for (let i = 0; i < 4; i++) {
    const x = -202 + i * 14;
    glowSprites.push({ position: new THREE.Vector3(x, 9.5, 9.1), color: AMBER, size: 2.2, pulseSpeed: 0, pulseAmount: 0 });
    for (const side of [-1, 1]) {
      const p = toWorld(SHED.x, SHED.z, SHED.yaw, x + side * 5 - SHED.x, SHED.hz + .35, 9.05);
      glowSprites.push({ position: p, color: AMBER, size: 2.0 });
      if (side === 1) lampPositions.push(p.clone());
    }
  }
  for (let i = 0; i < 12; i++) glowSprites.push({ position: new THREE.Vector3(162, 10.0, -70 + i * 14), color: AMBER, size: 3.0 });
  // Aviation lights pulse on the crane gantries.
  for (const [index, x] of [-226, -166, 196].entries()) {
    const z = -72 + index * 8;
    glowSprites.push({ position: new THREE.Vector3(x, 41, z), color: hdr(3.2, .22, .14), size: 3.0, pulseSpeed: 2.4, pulseAmount: .92, phase: index * 1.7 });
    for (const side of [-1, 1]) glowSprites.push({ position: new THREE.Vector3(x + side * 12.5, 39.4, z), color: hdr(2.8, .2, .12),
      size: 1.7, pulseSpeed: 2.4, pulseAmount: .9, phase: index * 1.7 + 1.2 });
  }

  // Lit windows along the shed and machine hall (one instanced draw, per-pane colours).
  const windowSpots: { position: THREE.Vector3; yaw: number; color: THREE.Color }[] = [];
  const paneColors = [hdr(1.7, 1.15, .55), hdr(1.4, .95, .5), hdr(.55, 1.05, 1.35), hdr(1.8, 1.5, 1.0), hdr(.07, .09, .11)];
  const addWindowRow = (b: typeof SHED, face: '+z' | '-z' | '+x', y: number, from: number, to: number, step: number, skip?: (l: number) => boolean): void => {
    for (let l = from; l <= to; l += step) {
      if (skip?.(l)) continue;
      const roll = rng();
      const color = paneColors[roll < .2 ? 4 : Math.floor(rng() * 4)]!;
      if (face === '+x') windowSpots.push({ position: toWorld(b.x, b.z, b.yaw, b.hx + .08, l, y), yaw: b.yaw + Math.PI / 2, color });
      else windowSpots.push({ position: toWorld(b.x, b.z, b.yaw, l, face === '+z' ? b.hz + .08 : -b.hz - .08, y),
        yaw: b.yaw + (face === '+z' ? 0 : Math.PI), color });
    }
  };
  addWindowRow(SHED, '+z', 10.05, -26.5, 26.5, 3.4);
  addWindowRow(SHED, '-z', 10.8, -26.5, 26.5, 3.4);
  addWindowRow(SHED, '+x', 10.8, -13, 13, 3.4);
  addWindowRow(HALL, '+z', 10.9, -20, 20, 3.6, l => Math.abs(l) < 8.6);
  addWindowRow(HALL, '+z', 13.0, -20, 20, 3.6);
  const windowMaterial = new THREE.MeshBasicMaterial({ name: 'dressing-lit-windows', color: '#ffffff' });
  const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.1, .85), windowMaterial, Math.max(1, windowSpots.length));
  windows.name = 'shed-lit-windows';
  windows.frustumCulled = false;
  windowSpots.forEach((spot, index) => {
    dummy.position.copy(spot.position); dummy.rotation.set(0, spot.yaw, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
    windows.setMatrixAt(index, dummy.matrix); windows.setColorAt(index, spot.color);
    if (spot.color !== paneColors[4]) {
      glowSprites.push({ position: spot.position.clone().addScaledVector(new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw)), .5),
        color: spot.color.clone().multiplyScalar(.16), size: 1.7 });
    }
  });
  windows.count = windowSpots.length;
  root.add(windows);

  // Neon tubes and signs.
  const magenta = hdr(3.2, .25, 1.9), cyan = hdr(.3, 2.1, 3.4);
  const tubes: { position: THREE.Vector3; yaw: number; length: number; color: THREE.Color }[] = [
    { position: toWorld(SHED.x, SHED.z, SHED.yaw, 0, SHED.hz + .2, 9.62), yaw: SHED.yaw, length: 56, color: cyan },
    { position: toWorld(SHED.x, SHED.z, SHED.yaw, 0, -SHED.hz - .2, 12.6), yaw: SHED.yaw, length: 56, color: magenta },
    { position: toWorld(SHED.x, SHED.z, SHED.yaw, SHED.hx + .2, 0, 12.6), yaw: SHED.yaw + Math.PI / 2, length: 30, color: magenta },
    { position: toWorld(HALL.x, HALL.z, HALL.yaw, 0, HALL.hz + .25, 13.6), yaw: HALL.yaw, length: 44, color: magenta },
    { position: toWorld(HALL.x, HALL.z, HALL.yaw, 0, HALL.hz + .25, 9.3), yaw: HALL.yaw, length: 44, color: cyan },
  ];
  const tubeMaterial = new THREE.MeshBasicMaterial({ name: 'dressing-neon-tubes', color: '#ffffff' });
  const tubeMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, .16, .1), tubeMaterial, tubes.length);
  tubeMesh.name = 'harbor-neon-tubes';
  tubeMesh.frustumCulled = false;
  tubes.forEach((tube, index) => {
    dummy.position.copy(tube.position); dummy.rotation.set(0, tube.yaw, 0); dummy.scale.set(tube.length, 1, 1); dummy.updateMatrix();
    tubeMesh.setMatrixAt(index, dummy.matrix); tubeMesh.setColorAt(index, tube.color);
    const dir = new THREE.Vector3(Math.cos(tube.yaw), 0, -Math.sin(tube.yaw));
    const count = Math.max(2, Math.round(tube.length / 7));
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1) - .5) * tube.length * .92;
      glowSprites.push({ position: tube.position.clone().addScaledVector(dir, t), color: tube.color.clone().multiplyScalar(.22), size: 3.0 });
    }
  });
  root.add(tubeMesh);

  const signMaterials: { material: THREE.MeshBasicMaterial; flicker: number }[] = [];
  const plateMaterial = new THREE.MeshBasicMaterial({ name: 'dressing-neon-plate', color: '#05070a' });
  const addSign = (text: string, color: string, core: string, b: typeof SHED, lx: number, lz: number, y: number, width: number,
    yaw: number, flicker: number): void => {
    const neon = neonTexture(text, color, core);
    if (!neon) return;
    const slug = text.toLowerCase().replace(/\W+/g, '-');
    const material = new THREE.MeshBasicMaterial({ name: `dressing-neon-sign-${slug}`, map: neon.texture,
      color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const height = width / neon.aspect;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.name = `neon-sign-${slug}`;
    mesh.position.copy(toWorld(b.x, b.z, b.yaw, lx, lz, y)); mesh.rotation.y = yaw;
    mesh.renderOrder = 4;
    // A dark backing board stands 6 cm behind the tubes so the lettering keeps contrast against wall and sky.
    const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const plate = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, height * 1.02, .08), plateMaterial);
    plate.name = `neon-plate-${slug}`;
    plate.position.copy(mesh.position).addScaledVector(normal, -.07); plate.rotation.y = yaw;
    root.add(plate, mesh);
    signMaterials.push({ material, flicker });
    // Bloom supplies the tight glow now; these wide, faint sprites only haze the wall around the tubes.
    const tint = new THREE.Color(color).convertSRGBToLinear().multiplyScalar(.16);
    for (const k of [-.3, 0, .3]) glowSprites.push({ position: mesh.position.clone().addScaledVector(new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), k * width).addScaledVector(normal, .9),
      color: tint, size: width * .3 });
  };
  addSign('AFTER HOURS', '#ff3da6', '#ffd9f0', HALL, 0, HALL.hz + .62, 11.6, 13, HALL.yaw, 1);
  addSign('FOUNDRY EIGHT', '#2fe3ff', '#e2fdff', SHED, -9, SHED.hz + .55, 12.1, 13.5, SHED.yaw, 0);
  addSign('DOCK 7', '#b8ff3d', '#f4ffd6', SHED, SHED.hx + .75, 0, 6.4, 8, SHED.yaw + Math.PI / 2, 0);

  // Distant shore lights scattered over the ridges read as a harbour town in the haze.
  const shorePalette = [hdr(2.0, 1.0, .4), hdr(1.7, 1.45, 1.05), hdr(.55, 1.25, 1.7), hdr(2.0, .35, .3)];
  for (const spec of ridgeSpecs) {
    const count = spec.baseY > 5 ? 70 : 46;
    const clusters = Array.from({ length: 7 }, () => rng());
    const span = spec.heights.length - 1;
    for (let i = 0; i < count; i++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)]!;
      const t = THREE.MathUtils.clamp(cluster + (rng() - .5) * .16, 0, 1);
      const f = t * span, lo = Math.floor(f), hi = Math.min(span, lo + 1);
      const height = THREE.MathUtils.lerp(spec.heights[lo]!, spec.heights[hi]!, f - lo);
      const along = -540 + t * 1080;
      const y = spec.baseY + height * (.08 + rng() * .62);
      const color = shorePalette[rng() < .62 ? 0 : Math.floor(rng() * shorePalette.length)]!.clone().multiplyScalar(.6 + rng() * .5);
      const position = spec.axis === 'z' ? new THREE.Vector3(along, y, spec.depth + 5) : new THREE.Vector3(spec.depth + 5, y, along);
      glowSprites.push({ position, color, size: 1.4, pulseSpeed: rng() < .2 ? 3 + rng() * 4 : 0, pulseAmount: .25, phase: rng() * 6.28 });
    }
  }

  // Reflective studs mark both road edges.
  const ice = hdr(1.6, 1.75, 2.0);
  resampleRoute(route, STUD_SPACING_M).forEach((sample, index) => {
    const normal = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    for (const side of [-1, 1]) {
      studs.push({ position: new THREE.Vector3(sample.point.x, sample.point.y + .16, sample.point.z).addScaledVector(normal, side * 5.9),
        color: side < 0 ? AMBER.clone().multiplyScalar(.8) : ice });
    }
    if (index % 3 === 0) studs.push({ position: new THREE.Vector3(sample.point.x, sample.point.y + .14, sample.point.z), color: ice.clone().multiplyScalar(.45) });
  });

  const glow = createGlowSprites('harbor-glow-sprites', glowSprites, lightUniforms);
  const wetStreaks = createWetStreaks('harbor-wet-streaks', streaks, lightUniforms);
  const roadStuds = createRoadStuds('road-edge-studs', studs, lightUniforms, pixelScale);
  root.add(wetStreaks.mesh, glow.mesh, roadStuds);

  let glowScale = 1;
  const applyGlowScale = (): void => {
    lensMaterial.color.setScalar(1.4 * glowScale).multiply(AMBER);
    poolMaterial.color.setRGB(.26, .13, .045).multiplyScalar(glowScale);
    windowMaterial.color.setScalar(glowScale);
    tubeMaterial.color.setScalar(glowScale);
    lightUniforms.scale.value = glowScale;
  };
  applyGlowScale();
  const tmpCamera = new THREE.Vector3();

  return {
    root, sourceVersion: HARBOR_DRESSING_VERSION, solidAnchorClearancesM: clearances, lampPositions,
    setAtmosphere(recipe): void {
      glowScale = recipe.lampGlow;
      lightUniforms.fogDensity.value = recipe.fogDensity;
      ridgeFar.color.set(recipe.ridgeFar);
      ridgeNear.color.set(recipe.ridgeNear);
      applyGlowScale();
    },
    update(elapsedSeconds, camera): void {
      lightUniforms.time.value = elapsedSeconds;
      camera.getWorldPosition(tmpCamera);
      lightUniforms.cameraPosition.value.copy(tmpCamera);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        pixelScale.value = 1000 / (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2));
      }
      for (const { material, flicker } of signMaterials) {
        // A failing tube: brief, deterministic dropouts on the flickering sign only.
        const slot = Math.floor(elapsedSeconds * 7);
        const dropout = flicker > 0 && fract(Math.sin(slot * 12.9898) * 43758.5453) > .93 ? .3 : 1;
        material.color.setScalar((1.7 + .12 * Math.sin(elapsedSeconds * 3 + flicker)) * glowScale * dropout);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      root.traverse(node => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.Points)) return;
        geometries.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material);
          const map = (material as THREE.MeshBasicMaterial).map;
          if (map) textures.add(map);
        }
      });
      root.clear();
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
      textures.forEach(texture => texture.dispose());
    },
  };
}
