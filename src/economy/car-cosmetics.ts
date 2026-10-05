/**
 * Renders premium cosmetics on any car presentation (local or remote): paint finishes, rim finishes,
 * underglow and a neon rear plate. Everything is additive and reversible: original materials are kept
 * and restored when a slot goes back to stock. Cheap by design: one extra material per car, two small
 * canvas textures, no extra lights and no transmission.
 */
import * as THREE from 'three';
import { catalogItem } from './catalog';
import { cleanPlateText, CUSTOM_PLATE_ID, DEFAULT_PLATE_TEXT } from './plate';
import type { CosmeticItem, Loadout } from './types';

export interface CosmeticTarget {
  readonly body: THREE.Object3D;
  readonly wheels: readonly THREE.Object3D[];
  readonly carId: string;
}

interface SwapRecord { readonly mesh: THREE.Mesh; readonly index: number; readonly original: THREE.Material }
interface CarState {
  paintId: string | null;
  paintMaterial: THREE.MeshPhysicalMaterial | null;
  paintSwaps: SwapRecord[];
  rimId: string | null;
  rimMaterials: Map<string, THREE.MeshPhysicalMaterial>;
  rimSwaps: SwapRecord[];
  glowId: string | null;
  glow: THREE.Mesh | null;
  plateId: string | null;
  plate: THREE.Mesh | null;
  frame: { ground: number; box: THREE.Box3; rearSign: number } | null;
}

const STATE_KEY = 'lateralCosmetics';
const PAINT_MATERIALS = new Set(['paint']);
const RIM_MATERIAL = /^(rim|wheel-(forged|mesh|steel)|mesh-alloy|steel-wheel)/;
const WHEEL_RADIUS = 0.33;

function stateOf(target: CosmeticTarget): CarState {
  const existing = target.body.userData[STATE_KEY] as CarState | undefined;
  if (existing) return existing;
  const created: CarState = {
    paintId: null, paintMaterial: null, paintSwaps: [], rimId: null, rimMaterials: new Map(), rimSwaps: [],
    glowId: null, glow: null, plateId: null, plate: null, frame: null,
  };
  target.body.userData[STATE_KEY] = created;
  return created;
}

/** Apply the premium slots of `loadout`. Stock (or missing) slots restore the car's own look. */
export function applyCarCosmetics(target: CosmeticTarget, loadout: Loadout): void {
  const state = stateOf(target);
  try {
    applyPaint(target, state, premium(loadout.paint));
    applyRims(target, state, premium(loadout.rim));
    applyUnderglow(target, state, premium(loadout.underglow));
    applyPlate(target, state, premium(loadout.plate), loadout.plateText);
  } catch (error) {
    // Cosmetics must never break a car: fall back to stock silently.
    console.warn('LATERAL cosmetics failed', error);
  }
}

export function disposeCarCosmetics(body: THREE.Object3D): void {
  const state = body.userData[STATE_KEY] as CarState | undefined;
  if (!state) return;
  state.paintMaterial?.dispose();
  for (const material of state.rimMaterials.values()) material.dispose();
  for (const swap of [...state.paintSwaps, ...state.rimSwaps]) swap.original.dispose();
  disposeMesh(state.glow);
  disposeMesh(state.plate);
  delete body.userData[STATE_KEY];
}

function premium(id: string | undefined): CosmeticItem | null {
  const entry = catalogItem(id);
  return entry && entry.price > 0 ? entry : null;
}

/* ------------------------------------------------------------------ material swapping */

function swapMaterials(root: THREE.Object3D, match: (material: THREE.Material) => boolean, replacement: (original: THREE.Material) => THREE.Material, records: SwapRecord[]): void {
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const list = Array.isArray(node.material) ? node.material as THREE.Material[] : [node.material as THREE.Material];
    list.forEach((material, index) => {
      if (!match(material)) return;
      records.push({ mesh: node, index, original: material });
      const next = replacement(material);
      // Owner car GLBs are exported double sided (source meshes have mixed winding); a FrontSide replacement culled one
      // side of the Cybertruck (hollow rims, missing cladding), so a replacement keeps the side of the material it replaces.
      if (next.side !== material.side) { next.side = material.side; next.needsUpdate = true; }
      if (Array.isArray(node.material)) (node.material as THREE.Material[])[index] = next;
      else node.material = next;
    });
  });
}
function restore(records: SwapRecord[]): void {
  for (const { mesh, index, original } of records) {
    if (Array.isArray(mesh.material)) (mesh.material as THREE.Material[])[index] = original;
    else mesh.material = original;
  }
  records.length = 0;
}

/* ------------------------------------------------------------------ paint */

function applyPaint(target: CosmeticTarget, state: CarState, item: CosmeticItem | null): void {
  if ((item?.id ?? null) === state.paintId) return;
  restore(state.paintSwaps);
  state.paintMaterial?.dispose();
  state.paintMaterial = null;
  state.paintId = item?.id ?? null;
  if (!item) return;
  const material = createPaintMaterial(item);
  if (target.carId === 'CAR-02') toneDownForFlatPanels(material, item);
  state.paintMaterial = material;
  // CAR-02's 'paint' is the stainless body; its arch and sill cladding is a separate 'cladding' slot that is never painted.
  // CAR-04's 'paint' is the textured factory livery atlas: replacing it would erase the livery, so it is never swapped.
  if (target.carId === 'CAR-04') return;
  const names = PAINT_MATERIALS;
  // paint-livery* panels (textured factory livery, e.g. CAR-05) are part of the body: a premium paint covers them too.
  swapMaterials(target.body, entry => names.has(entry.name) || entry.name.startsWith('paint-livery'), () => material, state.paintSwaps);
}

const FLAKE_VERTEX_HEAD = 'varying vec3 vLatFlake;\nuniform float uLatFlakeScale;\n';
const FLAKE_FRAGMENT_HEAD = 'varying vec3 vLatFlake;\nuniform float uLatFlake;\nuniform vec3 uLatShiftA;\nuniform vec3 uLatShiftB;\nuniform vec3 uLatShiftC;\nuniform float uLatShift;\n';
const FLAKE_FRAGMENT = `
{
  vec3 latCell = floor(vLatFlake);
  vec3 latHash = fract(sin(vec3(dot(latCell, vec3(127.1, 311.7, 74.7)), dot(latCell, vec3(269.5, 183.3, 246.1)), dot(latCell, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  normal = normalize(normal + (latHash - 0.5) * uLatFlake);
  if (uLatShift > 0.5) {
    float latFacing = clamp(dot(nonPerturbedNormal, normalize(vViewPosition)), 0.0, 1.0);
    vec3 latEdge = mix(uLatShiftC, uLatShiftB, smoothstep(0.08, 0.55, latFacing));
    diffuseColor.rgb = mix(latEdge, uLatShiftA, smoothstep(0.5, 0.96, latFacing));
  }
}
`;

/**
 * CAR-02's body is a few large flat-shaded panels: a near-perfect mirror shows each panel as one solid reflection (a light
 * column, the lime floor ring). Blur the reflection a little so chrome still reads as chrome but no panel turns into a flat
 * block of one reflected colour. Chrome takes the swatch's bright shade: a dark-gold mirror on flat panels in a dark room
 * reflects almost nothing and reads as black.
 */
function toneDownForFlatPanels(material: THREE.MeshPhysicalMaterial, item: CosmeticItem): void {
  if (item.finish === 'chrome' && item.swatch[1]) material.color.lerp(new THREE.Color(item.swatch[1]), 0.6);
  material.roughness = Math.max(material.roughness, 0.24);
  material.clearcoatRoughness = Math.max(material.clearcoatRoughness, 0.12);
  material.envMapIntensity = Math.min(material.envMapIntensity, 1);
}

/** Paint shader: flake normals under the clearcoat for metallic/candy/pearl, view-angle colour shift for chameleon. */
function createPaintMaterial(item: CosmeticItem): THREE.MeshPhysicalMaterial {
  const [a = '#888888', b = a, c = b] = item.swatch;
  const material = new THREE.MeshPhysicalMaterial({ name: 'paint-premium', color: a });
  let flake = 0, flakeScale = 900, shift = 0;
  switch (item.finish) {
    case 'metallic':
      Object.assign(material, { metalness: 0.62, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.03 });
      flake = 0.22; break;
    case 'candy':
      Object.assign(material, { metalness: 0.45, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.02, sheen: 0.6, sheenRoughness: 0.4 });
      material.sheenColor.set(b);
      flake = 0.12; flakeScale = 1400; break;
    case 'pearl':
      Object.assign(material, { metalness: 0.25, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 1, iridescenceIOR: 1.45, iridescenceThicknessRange: [180, 520], sheen: 1, sheenRoughness: 0.35 });
      material.sheenColor.set(b);
      flake = 0.08; flakeScale = 1600; break;
    case 'chameleon':
      Object.assign(material, { metalness: 0.55, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.55, iridescenceIOR: 1.6, iridescenceThicknessRange: [250, 700] });
      flake = 0.14; flakeScale = 1200; shift = 1; break;
    case 'matte':
      Object.assign(material, { metalness: 0.08, roughness: 0.86, clearcoat: 0 }); break;
    case 'satin':
      Object.assign(material, { metalness: 0.3, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.45 }); break;
    case 'chrome':
      Object.assign(material, { metalness: 1, roughness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.02, envMapIntensity: 1.25 }); break;
    default:
      Object.assign(material, { metalness: 0.1, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  }
  if (flake > 0 || shift > 0) {
    const shiftA = new THREE.Color(a), shiftB = new THREE.Color(b), shiftC = new THREE.Color(c);
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, {
        uLatFlake: { value: flake }, uLatFlakeScale: { value: flakeScale }, uLatShift: { value: shift },
        uLatShiftA: { value: shiftA }, uLatShiftB: { value: shiftB }, uLatShiftC: { value: shiftC },
      });
      shader.vertexShader = FLAKE_VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLatFlake = position * uLatFlakeScale;');
      shader.fragmentShader = FLAKE_FRAGMENT_HEAD + shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FLAKE_FRAGMENT}`);
    };
    material.customProgramCacheKey = () => `lateral-paint-${flake > 0 ? 1 : 0}${shift}`;
  }
  return material;
}

/* ------------------------------------------------------------------ rims */

const RIM_FINISH: Readonly<Record<string, Partial<THREE.MeshPhysicalMaterialParameters>>> = {
  'rim-gloss-black': { color: '#0d0f10', metalness: 0.35, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.04 },
  'rim-gunmetal': { color: '#4a5056', metalness: 0.9, roughness: 0.32 },
  'rim-bronze': { color: '#8a6338', metalness: 1, roughness: 0.3 },
  'rim-lime': { color: '#c4ee3e', metalness: 0.25, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 },
  'rim-chrome': { color: '#eef1f4', metalness: 1, roughness: 0.04 },
  'rim-gold': { color: '#e3b25a', metalness: 1, roughness: 0.14 },
};

function applyRims(target: CosmeticTarget, state: CarState, item: CosmeticItem | null): void {
  if ((item?.id ?? null) === state.rimId) return;
  restore(state.rimSwaps);
  for (const material of state.rimMaterials.values()) material.dispose();
  state.rimMaterials.clear();
  state.rimId = item?.id ?? null;
  const finish = item ? RIM_FINISH[item.id] : undefined;
  if (!finish) return;
  for (const wheel of target.wheels) {
    swapMaterials(wheel, entry => RIM_MATERIAL.test(entry.name), original => {
      let material = state.rimMaterials.get(original.name);
      if (!material) {
        material = new THREE.MeshPhysicalMaterial({ name: `${original.name}-premium`, ...finish });
        state.rimMaterials.set(original.name, material);
      }
      return material;
    }, state.rimSwaps);
  }
}

/* ------------------------------------------------------------------ car frame (ground height, footprint, rear) */

function frameOf(target: CosmeticTarget, state: CarState): NonNullable<CarState['frame']> {
  if (state.frame) return state.frame;
  const body = target.body;
  body.updateMatrixWorld(true);
  const toBody = body.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const temp = new THREE.Box3();
  body.traverse(node => {
    if (!(node instanceof THREE.Mesh) || !node.visible || node.userData.lateralCosmetic) return;
    node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    temp.copy(node.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toBody, node.matrixWorld));
    box.union(temp);
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.9, -0.3, -2.1), new THREE.Vector3(0.9, 0.9, 2.1));
  const restYs = target.wheels.map(wheel => (wheel.userData.restPosition as THREE.Vector3 | undefined)?.y).filter((y): y is number => typeof y === 'number');
  const ground = (restYs.length ? Math.min(...restYs) : box.min.y + 0.1) - WHEEL_RADIUS;
  // Rear = the side where the brake lights sit; z+ is assumed when the car has none.
  let rearSign = 1;
  const brakes = body.getObjectByName('brake-lights') ?? body.getObjectByName('rear-registration-plate');
  if (brakes) {
    const brakeBox = new THREE.Box3().setFromObject(brakes).applyMatrix4(toBody);
    if (!brakeBox.isEmpty()) rearSign = brakeBox.getCenter(new THREE.Vector3()).z >= box.getCenter(new THREE.Vector3()).z ? 1 : -1;
  } else {
    const front = target.wheels[0]?.userData.restPosition as THREE.Vector3 | undefined;
    if (front) rearSign = front.z > 0 ? -1 : 1;
  }
  state.frame = { ground, box, rearSign };
  return state.frame;
}

/* ------------------------------------------------------------------ underglow */

let glowTexture: THREE.CanvasTexture | null = null;
function underglowTexture(): THREE.CanvasTexture | null {
  if (glowTexture) return glowTexture;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(64, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
    // Rounded-rectangle falloff: bright under the sills, fading out past the bumpers.
    const dx = Math.max(0, Math.abs((x + 0.5) / 32 - 1) - 0.45) / 0.55;
    const dy = Math.max(0, Math.abs((y + 0.5) / 64 - 1) - 0.6) / 0.4;
    const d = Math.min(1, Math.hypot(dx, dy));
    const v = Math.pow(1 - d, 2.2);
    const i = (y * 64 + x) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
    image.data[i + 3] = Math.round(v * 255);
  }
  context.putImageData(image, 0, 0);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

function applyUnderglow(target: CosmeticTarget, state: CarState, item: CosmeticItem | null): void {
  if ((item?.id ?? null) === state.glowId) return;
  disposeMesh(state.glow);
  state.glow = null;
  state.glowId = item?.id ?? null;
  if (!item) return;
  const texture = underglowTexture();
  if (!texture) return;
  const { ground, box } = frameOf(target, state);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const material = new THREE.MeshBasicMaterial({
    name: 'underglow', map: texture, color: item.swatch[0] ?? '#d8fa72', transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x * 1.7, size.z * 1.3), material);
  mesh.name = 'underglow';
  mesh.userData.lateralCosmetic = true;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(center.x, ground + 0.025, center.z);
  mesh.renderOrder = 2;
  mesh.castShadow = false; mesh.receiveShadow = false;
  if (item.id === 'glow-cycle') {
    mesh.onBeforeRender = () => { material.color.setHSL(((performance.now() / 6000) % 1), 0.95, 0.55); };
  } else if (item.swatch.length > 1) {
    const from = new THREE.Color(item.swatch[0]), to = new THREE.Color(item.swatch[1]);
    mesh.onBeforeRender = () => { material.color.copy(from).lerp(to, 0.5 + 0.5 * Math.sin(performance.now() / 700)); };
  }
  target.body.add(mesh);
  state.glow = mesh;
}

/* ------------------------------------------------------------------ neon plate */

const PLATE_TEXT: Readonly<Record<string, string>> = {
  'plate-dock7': 'DOCK 07', 'plate-afterhours': 'AFTR HRS', 'plate-lateral': 'LATERAL', 'plate-berth': 'BERTH 9',
};

/** Text drawn on a plate: the fixed text of a catalog plate, or the (validated) text of the custom plate. */
function plateWords(item: CosmeticItem, customText: string | undefined): string {
  if (item.id === CUSTOM_PLATE_ID) return cleanPlateText(customText) ?? DEFAULT_PLATE_TEXT;
  return PLATE_TEXT[item.id] ?? DEFAULT_PLATE_TEXT;
}

/** Draws one neon plate face on a 512x112 canvas context. Text is drawn with fillText only, never as markup. */
export function drawPlateFace(context: CanvasRenderingContext2D, text: string, color: string): void {
  context.clearRect(0, 0, 512, 112);
  context.fillStyle = '#07090a';
  context.fillRect(0, 0, 512, 112);
  context.strokeStyle = color; context.lineWidth = 6; context.shadowColor = color; context.shadowBlur = 18;
  context.strokeRect(10, 10, 492, 92);
  const family = '"Big Shoulders Display", "Chakra Petch", "Arial Narrow", sans-serif';
  // Longest text (8 wide characters) must fit inside the frame: shrink the font until it does.
  let size = 70;
  context.font = `700 ${size}px ${family}`;
  const width = context.measureText(text).width;
  if (width > 440) { size = Math.max(36, Math.floor(size * 440 / width)); context.font = `700 ${size}px ${family}`; }
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, 256, 60);
  context.shadowBlur = 0; context.fillStyle = '#ffffff'; context.globalAlpha = 0.55;
  context.fillText(text, 256, 60);
  context.globalAlpha = 1;
}

function plateTexture(item: CosmeticItem, words: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 112;
  const context = canvas.getContext('2d');
  if (!context) return null;
  drawPlateFace(context, words, item.swatch[1] ?? item.swatch[0] ?? '#d8fa72');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function applyPlate(target: CosmeticTarget, state: CarState, item: CosmeticItem | null, customText?: string): void {
  const words = item ? plateWords(item, customText) : '';
  const key = item ? `${item.id}|${words}` : null;
  if (key === state.plateId) return;
  disposeMesh(state.plate);
  state.plate = null;
  state.plateId = key;
  if (!item || target.carId === 'CAR-04') return;   // a Formula 1 car carries no registration plate
  const texture = plateTexture(item, words);
  if (!texture) return;
  const material = new THREE.MeshBasicMaterial({ name: 'neon-plate', map: texture, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.114), material);
  mesh.name = 'neon-plate';
  mesh.userData.lateralCosmetic = true;
  if (!placePlate(target, state, mesh)) { disposeMesh(mesh); return; }
  if (item.id === 'plate-berth') {
    // Old harbor sign: a slow breath with the odd stutter.
    mesh.onBeforeRender = () => {
      const t = performance.now() / 1000;
      const stutter = Math.sin(t * 23) > 0.93 && Math.sin(t * 0.7) > 0.6 ? 0.35 : 1;
      material.color.setScalar((0.82 + 0.18 * Math.sin(t * 2.2)) * stutter);
    };
  }
  state.plate = mesh;
}

/** Put the plate on the authored rear plate node when the car has one, else ray-cast the rear bodywork. */
function placePlate(target: CosmeticTarget, state: CarState, mesh: THREE.Mesh): boolean {
  const { box, rearSign, ground } = frameOf(target, state);
  const body = target.body;
  const toBody = body.matrixWorld.clone().invert();
  const authored = body.getObjectByName('rear-registration-plate');
  const facing = new THREE.Vector3(0, 0, rearSign);
  if (authored) {
    const plateBox = new THREE.Box3().setFromObject(authored).applyMatrix4(toBody);
    if (!plateBox.isEmpty()) {
      const center = plateBox.getCenter(new THREE.Vector3());
      mesh.position.set(center.x, center.y, rearSign > 0 ? plateBox.max.z + 0.006 : plateBox.min.z - 0.006);
      mesh.lookAt(mesh.position.clone().add(facing));
      body.add(mesh);
      return true;
    }
  }
  const meshes: THREE.Object3D[] = [];
  body.traverse(node => { if (node instanceof THREE.Mesh && node.visible && !node.userData.lateralCosmetic) meshes.push(node); });
  const y = Math.min(box.max.y - 0.1, Math.max(ground + 0.45, box.min.y + (box.max.y - box.min.y) * 0.32));
  const startZ = rearSign > 0 ? box.max.z + 1 : box.min.z - 1;
  const originBody = new THREE.Vector3(box.getCenter(new THREE.Vector3()).x, y, startZ);
  const ray = new THREE.Raycaster(originBody.clone().applyMatrix4(body.matrixWorld), new THREE.Vector3(0, 0, -rearSign).transformDirection(body.matrixWorld), 0, (box.max.z - box.min.z) + 2);
  const hit = ray.intersectObjects(meshes, false)[0];
  const point = hit ? hit.point.clone().applyMatrix4(toBody) : new THREE.Vector3(originBody.x, y, rearSign > 0 ? box.max.z : box.min.z);
  mesh.position.copy(point).add(facing.clone().multiplyScalar(0.012));
  mesh.lookAt(mesh.position.clone().add(facing));
  body.add(mesh);
  return true;
}

function disposeMesh(mesh: THREE.Mesh | null): void {
  if (!mesh) return;
  mesh.removeFromParent();
  mesh.geometry.dispose();
  const material = mesh.material as THREE.MeshBasicMaterial;
  if (material.map && material.map !== glowTexture) material.map.dispose();
  material.dispose();
}
