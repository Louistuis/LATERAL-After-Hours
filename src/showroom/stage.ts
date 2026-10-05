/**
 * The showroom studio: a black-box stage with a turntable, a glossy reflective floor, overhead light halos,
 * a wall of light tubes, rim lights, haze shafts and dust, plus the purchase effects (scan gate, sparks,
 * shock ring, camera punch) and a live burnout for the smoke preview.
 *
 * It renders into the game's own WebGLRenderer (no second context) through its own PostFx chain, while the
 * shell pauses the harbor render. Budgets per tier are fixed up front:
 *   low       2 lights, no planar reflection, no haze, small particle pools
 *   balanced  3 lights, half-res planar reflection of the car and the light rig, haze shafts and dust
 *   high/ultra 4 lights, sharper reflection, denser dust and sparks (post chain stays at the Balanced profile)
 * Every effect is one draw call (merged or instanced). No transmission, no shadow maps. The reflection pass
 * switches itself off when a car is too heavy for the draw call budget.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QualityPreset } from '../../contracts/runtime-contracts';
import { applySceneMaterialProfile } from '../render/material-profile';
import { createPostFx, type PostFx } from '../render/post-fx';
import type { CarPresentation } from '../scene-pipeline/ports';
import type { ShotId } from './state';

interface TierSpec {
  readonly lights: 2 | 3 | 4;
  /** Planar reflection resolution scale; 0 = off. */
  readonly reflection: number;
  readonly haze: boolean;
  readonly dust: number;
  readonly sparks: number;
  readonly smoke: number;
  readonly post: QualityPreset;
  readonly texture: number;
}
export const SHOWROOM_TIERS: Readonly<Record<QualityPreset, TierSpec>> = {
  low: { lights: 2, reflection: 0, haze: false, dust: 0, sparks: 90, smoke: 36, post: 'low', texture: 512 },
  balanced: { lights: 3, reflection: 0.5, haze: true, dust: 140, sparks: 220, smoke: 72, post: 'balanced', texture: 1024 },
  high: { lights: 4, reflection: 0.65, haze: true, dust: 260, sparks: 340, smoke: 110, post: 'balanced', texture: 1024 },
  ultra: { lights: 4, reflection: 0.8, haze: true, dust: 360, sparks: 460, smoke: 140, post: 'balanced', texture: 2048 },
};
/** Draw-call ceiling for the whole showroom frame. */
export const SHOWROOM_DRAW_BUDGET = 150;

export interface ShowroomStats { readonly calls: number; readonly triangles: number; readonly reflection: boolean; readonly lights: number }

export interface ShowroomStage {
  /** Places a car on the turntable (null clears it). The caller owns and disposes the presentation. */
  /**
   * Places a car on the turntable (null clears it). With `reveal`, the current car sinks through the table
   * and the new one rises in a light burst. Every car that leaves the stage goes to the `release` callback.
   */
  setCar(car: CarPresentation | null, reveal?: boolean): void;
  setShot(shot: ShotId, immediate?: boolean): void;
  setAccent(css: string): void;
  /** 0 = full studio, 1 = lights down (underglow). */
  setMood(dark: number): void;
  /** Live burnout on the rear tyres in this colour; null stops it. */
  setSmoke(color: string | null): void;
  pulse(kind: 'horn' | 'paint'): void;
  celebrate(color: string): void;
  orbit(dx: number, dy: number): void;
  zoom(factor: number): void;
  /** Releases a drag with a flick velocity (px per ms). */
  fling(vx: number, vy: number): void;
  render(now: number): void;
  precompile(): Promise<void>;
  stats(): ShowroomStats;
  /** True while a car swap animation runs. */
  readonly revealing: boolean;
  dispose(): void;
}

const TABLE_TOP = 0.13;
const TABLE_RADIUS = 3.35;
const WHEEL_RADIUS = 0.33;
const SPIN_SPEED = 0.16;

interface Shot { readonly az: number; readonly el: number; readonly r: number; readonly ty: number; readonly tz: number; readonly fov: number; readonly spin: boolean; readonly wheel?: boolean }
const SHOTS: Readonly<Record<ShotId, Shot>> = {
  car: { az: 0.62, el: 0.17, r: 10.4, ty: 0.75, tz: 0, fov: 34, spin: true },
  paint: { az: 0.72, el: 0.13, r: 8.9, ty: 0.78, tz: 0, fov: 33, spin: true },
  wheels: { az: 1.02, el: 0.06, r: 3.0, ty: 0, tz: 0, fov: 30, spin: false, wheel: true },
  underglow: { az: 1.28, el: 0.035, r: 6.9, ty: 0.32, tz: 0, fov: 38, spin: true },
  smoke: { az: 2.5, el: 0.07, r: 6.6, ty: 0.55, tz: -0.45, fov: 40, spin: false },
  plate: { az: Math.PI - 0.16, el: 0.1, r: 4.3, ty: 0.72, tz: -0.95, fov: 30, spin: false },
  horn: { az: 0.2, el: 0.08, r: 5.6, ty: 0.7, tz: 0.55, fov: 34, spin: false },
  earn: { az: 0.45, el: 0.3, r: 11.5, ty: 0.55, tz: 0, fov: 36, spin: true },
};

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/* ------------------------------------------------------------------ textures */

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  draw(g, size);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
function tableTexture(size: number): THREE.CanvasTexture {
  return canvasTexture(size, (g, s) => {
    const c = s / 2;
    g.fillStyle = '#121618'; g.fillRect(0, 0, s, s);
    for (let r = 4; r < c; r += 3) {
      g.strokeStyle = `rgba(${150 + (r % 7) * 8},${170 + (r % 5) * 6},${170 + (r % 3) * 9},${0.035 + (r % 11) * 0.004})`;
      g.lineWidth = 1.2; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = 'rgba(216,250,114,.55)'; g.lineWidth = s * 0.004;
    g.beginPath(); g.arc(c, c, c * 0.955, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(160,220,214,.18)'; g.lineWidth = s * 0.002;
    g.beginPath(); g.arc(c, c, c * 0.78, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(200,225,220,.32)';
    g.font = `600 ${Math.round(s * 0.032)}px "Big Shoulders Stencil Display","Big Shoulders Display",sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const words = ['LATERAL', 'AFTER HOURS', 'BERTH 07', 'HARBOR WORKS'];
    for (let i = 0; i < 8; i++) {
      g.save(); g.translate(c, c); g.rotate((i / 8) * Math.PI * 2); g.fillText(words[i % 4]!, 0, -c * 0.87); g.restore();
    }
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2, long = i % 10 === 0;
      g.strokeStyle = long ? 'rgba(216,250,114,.6)' : 'rgba(170,230,222,.22)'; g.lineWidth = long ? 2 : 1;
      g.beginPath(); g.moveTo(c + Math.cos(a) * c * 0.93, c + Math.sin(a) * c * 0.93);
      g.lineTo(c + Math.cos(a) * c * (long ? 0.9 : 0.915), c + Math.sin(a) * c * (long ? 0.9 : 0.915)); g.stroke();
    }
  });
}
function blobTexture(size: number, soft: number): THREE.CanvasTexture {
  return canvasTexture(size, (g, s) => {
    const gradient = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,1)'); gradient.addColorStop(soft, 'rgba(0,0,0,.55)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, s, s);
  }, false);
}
function puffTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (g, s) => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const x = s * (0.3 + rand() * 0.4), y = s * (0.3 + rand() * 0.4), r = s * (0.12 + rand() * 0.2);
      const gradient = g.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, 'rgba(255,255,255,.22)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gradient; g.fillRect(0, 0, s, s);
    }
  }, false);
}

/** PMREM of a studio box: an overhead softbox, side strips and a warm kicker. This is what the paint reflects. */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 30), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.016, 0.018), side: THREE.BackSide }));
  box.position.y = 6; scene.add(box);
  const panel = (w: number, h: number, color: THREE.Color, position: [number, number, number], look: [number, number, number]): void => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.set(...position); mesh.lookAt(...look); scene.add(mesh);
  };
  panel(9, 4.5, new THREE.Color(7, 7.2, 7.6), [0, 11, 0], [0, 0, 0]);
  panel(1.1, 9, new THREE.Color(5, 5.3, 5.6), [-12, 5, -3], [0, 3, 0]);
  panel(1.1, 9, new THREE.Color(5, 5.3, 5.6), [12, 5, 3], [0, 3, 0]);
  panel(14, 0.6, new THREE.Color(3.2, 3.4, 3.6), [0, 4, -14], [0, 3, 0]);
  panel(14, 0.6, new THREE.Color(2.4, 2.6, 2.8), [0, 4, 14], [0, 3, 0]);
  panel(6, 2, new THREE.Color(1.2, 0.7, 0.32), [-8, 1, 10], [0, 1, 0]);
  panel(6, 2, new THREE.Color(0.25, 0.9, 0.85), [8, 1, -10], [0, 1, 0]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  scene.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); } });
  return target.texture;
}

/* ------------------------------------------------------------------ shaders */

const FLOOR_VERTEX = /* glsl */`
uniform mat4 uTexMatrix;
varying vec4 vProj;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vProj = uTexMatrix * w;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FLOOR_FRAGMENT = /* glsl */`
uniform sampler2D tReflect;
uniform float uReflect;
uniform vec2 uTexel;
uniform vec3 uBase;
uniform vec3 uPool;
uniform vec3 uAccent;
uniform float uShock;
uniform float uShockRadius;
varying vec4 vProj;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
void main() {
  float d = length(vWorld.xz);
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  float grit = hash(floor(vWorld.xz * 140.0));
  vec2 g = abs(fract(vWorld.xz * 0.25) - 0.5);
  float seam = smoothstep(0.492, 0.5, max(g.x, g.y));
  vec3 color = uBase * (0.82 + 0.36 * grit) * (1.0 - seam * 0.6);
  color += uPool * exp(-d * d * 0.05);
  color += uAccent * exp(-pow((d - 3.62) * 5.0, 2.0)) * 0.5;
  color += uAccent * uShock * exp(-pow((d - uShockRadius) * 2.2, 2.0)) * 2.5;
  if (uReflect > 0.0) {
    vec2 uv = vProj.xy / vProj.w;
    vec2 o = uTexel * (0.8 + d * 0.1);
    vec3 r = texture2D(tReflect, uv).rgb * 0.4
      + texture2D(tReflect, uv + vec2(o.x, o.y)).rgb * 0.15 + texture2D(tReflect, uv + vec2(-o.x, o.y)).rgb * 0.15
      + texture2D(tReflect, uv + vec2(o.x, -o.y)).rgb * 0.15 + texture2D(tReflect, uv + vec2(-o.x, -o.y)).rgb * 0.15;
    color += r * mix(0.32, 0.95, fres) * uReflect * (0.9 + 0.2 * grit);
  }
  color *= 1.0 - smoothstep(9.0, 25.0, d);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const HAZE_VERTEX = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;
const HAZE_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  float facing = pow(abs(dot(vN, normalize(-vView))), 2.4);
  float along = mix(0.25, 1.0, vUv.y) * smoothstep(0.0, 0.1, vUv.y) * (1.0 - 0.75 * smoothstep(0.9, 1.0, vUv.y));
  float drift = 0.8 + 0.2 * sin(uTime * 0.7 + vUv.x * 18.0 + vUv.y * 4.0) * sin(uTime * 0.31 + vUv.x * 7.0);
  gl_FragColor = vec4(uColor * facing * along * drift, 1.0);
}`;
const DUST_VERTEX = /* glsl */`
attribute float aSeed;
uniform float uTime;
uniform float uScale;
varying float vTwinkle;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.11 + aSeed * 6.28) * 0.35;
  p.z += cos(uTime * 0.09 + aSeed * 12.1) * 0.35;
  p.y = mod(p.y + uTime * (0.03 + aSeed * 0.05), 5.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vTwinkle = 0.5 + 0.5 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 40.0);
  gl_PointSize = uScale * (0.6 + aSeed) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAGMENT = /* glsl */`
uniform vec3 uColor;
varying float vTwinkle;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor * a * vTwinkle, 1.0);
}`;
const SPARK_VERTEX = /* glsl */`
attribute float aLife;
uniform float uScale;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aLife > 0.0 ? uScale * (0.4 + aLife) / -mv.z : 0.0;
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAGMENT = /* glsl */`
uniform vec3 uColor;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(mix(uColor, vec3(6.0), core * core * vLife) * core * vLife, 1.0);
}`;
const SMOKE_VERTEX = /* glsl */`
attribute vec4 aPuff;
attribute vec2 aFade;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = aFade.x;
  vec4 mv = viewMatrix * vec4(aPuff.xyz, 1.0);
  float c = cos(aFade.y), s = sin(aFade.y);
  mv.xy += mat2(c, s, -s, c) * position.xy * aPuff.w;
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FRAGMENT = /* glsl */`
uniform sampler2D tPuff;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float a = texture2D(tPuff, vUv).a * vAlpha;
  gl_FragColor = vec4(uColor, a);
}`;
const GATE_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 e = min(vUv, 1.0 - vUv);
  float frame = smoothstep(0.018, 0.0, min(e.x, e.y * 0.5));
  float scan = 0.5 + 0.5 * sin(vUv.y * 140.0 - uTime * 24.0);
  float fill = 0.07 + 0.06 * scan;
  float fadeY = smoothstep(0.0, 0.2, vUv.y);
  gl_FragColor = vec4(uColor * (frame * 1.6 + fill * fadeY) * uAlpha, 1.0);
}`;
const GATE_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/* ------------------------------------------------------------------ stage */

export function createShowroomStage(renderer: THREE.WebGLRenderer, quality: QualityPreset, release: (car: CarPresentation) => void = () => {}): ShowroomStage {
  const tier = SHOWROOM_TIERS[quality];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.006, 0.009, 0.011);
  scene.fog = new THREE.FogExp2(0x030607, 0.03);
  const environment = studioEnvironment(renderer);
  scene.environment = environment;
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 90);
  const disposables: { dispose(): void }[] = [environment];
  const own = <T extends { dispose(): void }>(value: T): T => { disposables.push(value); return value; };
  const post: PostFx = createPostFx(renderer, scene, camera, tier.post, (s, c) => renderer.render(s, c));
  post.setGrade({ shadowTint: '#d6ecf2', highlightTint: '#fff1e0', saturation: 1.12, contrast: 0.2, vignette: 0.5, bloomStrength: 0.5, bloomThreshold: 1.05 });
  post.setExposure(0.98);
  post.setScatter(null);

  let accent = new THREE.Color('#d8fa72');
  const accentHdr = (k: number): THREE.Color => accent.clone().multiplyScalar(k);

  /* ---------------------------------------------------------------- lights (fixed per tier) */
  const lights: THREE.Light[] = [];
  const key = new THREE.DirectionalLight(0xfff4e8, 2.1); key.position.set(4, 9, 6); lights.push(key);
  const rimA = new THREE.DirectionalLight(0x9fe8ff, 2.6); rimA.position.set(-7, 3.5, -8); lights.push(rimA);
  const rimB = new THREE.DirectionalLight(0xffb070, 2.2); rimB.position.set(8, 3, -6);
  const top = new THREE.SpotLight(0xffffff, 26, 14, 0.62, 0.55, 1.2); top.position.set(0, 7.5, 0.4);
  if (tier.lights >= 3) lights.push(rimB);
  if (tier.lights >= 4) { lights.push(top); scene.add(top.target); }
  const baseIntensity = lights.map(light => light.intensity);
  for (const light of lights) scene.add(light);

  /* ---------------------------------------------------------------- floor with planar reflection */
  const reflectTarget = tier.reflection > 0 ? own(new THREE.WebGLRenderTarget(2, 2, {
    type: renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, samples: 0,
  })) : null;
  const floorUniforms = {
    tReflect: { value: reflectTarget?.texture ?? null }, uReflect: { value: reflectTarget ? 1 : 0 }, uTexel: { value: new THREE.Vector2(1, 1) },
    uTexMatrix: { value: new THREE.Matrix4() }, uBase: { value: new THREE.Color(0.012, 0.015, 0.017) },
    uPool: { value: new THREE.Color(0.06, 0.065, 0.07) }, uAccent: { value: accentHdr(0.6) }, uShock: { value: 0 }, uShockRadius: { value: 0 },
  };
  const floor = new THREE.Mesh(own(new THREE.CircleGeometry(30, 72).rotateX(-Math.PI / 2)),
    own(new THREE.ShaderMaterial({ name: 'showroom-floor', uniforms: floorUniforms, vertexShader: FLOOR_VERTEX, fragmentShader: FLOOR_FRAGMENT })));
  floor.name = 'showroom-floor';
  scene.add(floor);

  /* ---------------------------------------------------------------- turntable */
  const table = new THREE.Group(); table.name = 'showroom-turntable'; scene.add(table);
  const tableTex = own(tableTexture(tier.texture));
  const tableSide = own(new THREE.MeshStandardMaterial({ color: 0x15191b, metalness: 0.85, roughness: 0.32 }));
  const tableTop = own(new THREE.MeshStandardMaterial({ color: 0xffffff, map: tableTex, metalness: 0.7, roughness: 0.38, envMapIntensity: 0.8 }));
  const plinth = new THREE.Mesh(own(new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS + 0.06, TABLE_TOP, 72, 1, false)), [tableSide, tableTop, tableSide]);
  plinth.position.y = TABLE_TOP / 2; table.add(plinth);
  const shadowTex = own(blobTexture(128, 0.55));
  const contact = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    own(new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: shadowTex, transparent: true, opacity: 0.9, depthWrite: false })));
  contact.position.y = TABLE_TOP + 0.004; contact.renderOrder = 1; table.add(contact);
  const carSlot = new THREE.Group(); table.add(carSlot);

  /* ---------------------------------------------------------------- light rig: one white mesh, one accent mesh */
  const tube = (length: number, radius: number): THREE.BufferGeometry => new THREE.CylinderGeometry(radius, radius, length, 8, 1, false);
  const whiteParts: THREE.BufferGeometry[] = [];
  const haloOuter = new THREE.TorusGeometry(1, 0.03, 6, 120); haloOuter.scale(3.9, 2.5, 1); haloOuter.rotateX(-Math.PI / 2); haloOuter.translate(0, 4.7, 0);
  whiteParts.push(haloOuter);
  for (let i = 0; i < 13; i++) {
    const a = Math.PI * (0.62 + (i / 12) * 0.76), r = 12.5;
    const part = tube(5.6, 0.045); part.translate(Math.cos(a) * r, 2.9, Math.sin(a) * r); whiteParts.push(part);
  }
  for (const side of [-1, 1]) {
    const panel = new THREE.PlaneGeometry(1.1, 4.2); panel.rotateY(side * -Math.PI / 2 + (side > 0 ? 0.35 : -0.35)); panel.translate(side * 9.5, 2.6, 1.5); whiteParts.push(panel);
  }
  const whiteMaterial = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(5.2, 5.4, 5.8), side: THREE.DoubleSide, fog: true }));
  const whiteMesh = new THREE.Mesh(own(mergeGeometries(whiteParts.map(part => part.toNonIndexed()), false)!), whiteMaterial);
  whiteParts.forEach(part => part.dispose());
  whiteMesh.name = 'showroom-rig-white'; scene.add(whiteMesh);
  const accentParts: THREE.BufferGeometry[] = [];
  const haloInner = new THREE.TorusGeometry(1, 0.022, 6, 120); haloInner.scale(3.2, 2.0, 1); haloInner.rotateX(-Math.PI / 2); haloInner.translate(0, 4.5, 0);
  accentParts.push(haloInner);
  const ring = new THREE.TorusGeometry(TABLE_RADIUS + 0.12, 0.022, 6, 160); ring.rotateX(-Math.PI / 2); ring.translate(0, 0.03, 0); accentParts.push(ring);
  for (const x of [-1.9, 1.9]) for (const dir of [-1, 1]) {
    const line = new THREE.PlaneGeometry(0.04, 11); line.rotateX(-Math.PI / 2); line.translate(x, 0.016, dir * (TABLE_RADIUS + 0.9 + 5.5)); accentParts.push(line);
  }
  const accentMaterial = own(new THREE.MeshBasicMaterial({ color: accentHdr(4), side: THREE.DoubleSide, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const accentMesh = new THREE.Mesh(own(mergeGeometries(accentParts.map(part => part.toNonIndexed()), false)!), accentMaterial);
  accentParts.forEach(part => part.dispose());
  accentMesh.name = 'showroom-rig-accent'; scene.add(accentMesh);

  /* ---------------------------------------------------------------- haze shafts and dust (balanced and up) */
  let hazeMaterial: THREE.ShaderMaterial | null = null, haze: THREE.Mesh | null = null;
  let dustMaterial: THREE.ShaderMaterial | null = null, dust: THREE.Points | null = null;
  if (tier.haze) {
    const cones: THREE.BufferGeometry[] = [];
    const main = new THREE.CylinderGeometry(1.5, 4.6, 4.7, 40, 1, true); main.translate(0, 2.35, 0); cones.push(main);
    for (const side of [-1, 1]) {
      const shaft = new THREE.CylinderGeometry(0.35, 1.6, 6.5, 24, 1, true); shaft.translate(0, -3.25, 0);
      shaft.rotateZ(side * 0.5); shaft.translate(side * 5.2, 6.4, -2.5); cones.push(shaft);
    }
    hazeMaterial = own(new THREE.ShaderMaterial({ name: 'showroom-haze', uniforms: { uColor: { value: new THREE.Color(0.075, 0.08, 0.085) }, uTime: { value: 0 } },
      vertexShader: HAZE_VERTEX, fragmentShader: HAZE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    haze = new THREE.Mesh(own(mergeGeometries(cones.map(part => part.toNonIndexed()), false)!), hazeMaterial);
    cones.forEach(part => part.dispose());
    haze.renderOrder = 3; haze.name = 'showroom-haze'; scene.add(haze);
  }
  if (tier.dust > 0) {
    const positions = new Float32Array(tier.dust * 3), seeds = new Float32Array(tier.dust);
    for (let i = 0; i < tier.dust; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 4.2;
      positions.set([Math.cos(a) * r, Math.random() * 5, Math.sin(a) * r], i * 3); seeds[i] = Math.random();
    }
    const geometry = own(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    dustMaterial = own(new THREE.ShaderMaterial({ name: 'showroom-dust', uniforms: { uTime: { value: 0 }, uScale: { value: 30 }, uColor: { value: new THREE.Color(1.4, 1.3, 1.15) } },
      vertexShader: DUST_VERTEX, fragmentShader: DUST_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    dust = new THREE.Points(geometry, dustMaterial); dust.frustumCulled = false; dust.renderOrder = 4; scene.add(dust);
  }

  /* ---------------------------------------------------------------- sparks (unlock) */
  const sparkCount = tier.sparks;
  const sparkPos = new Float32Array(sparkCount * 3), sparkVel = new Float32Array(sparkCount * 3), sparkLife = new Float32Array(sparkCount), sparkMax = new Float32Array(sparkCount);
  const sparkGeometry = own(new THREE.BufferGeometry());
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute('aLife', new THREE.BufferAttribute(sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
  const sparkMaterial = own(new THREE.ShaderMaterial({ name: 'showroom-sparks', uniforms: { uScale: { value: 60 }, uColor: { value: accentHdr(5) } },
    vertexShader: SPARK_VERTEX, fragmentShader: SPARK_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial); sparks.frustumCulled = false; sparks.visible = false; sparks.renderOrder = 5; scene.add(sparks);
  let sparksAlive = 0;

  /* ---------------------------------------------------------------- scan gate (unlock and paint) */
  const gateMaterial = own(new THREE.ShaderMaterial({ name: 'showroom-gate', uniforms: { uColor: { value: accentHdr(3) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: GATE_VERTEX, fragmentShader: GATE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const gate = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1)), gateMaterial); gate.visible = false; gate.renderOrder = 6; table.add(gate);
  let gateT = -1, gateDuration = 1, gateStrength = 1;

  /* ---------------------------------------------------------------- burnout smoke */
  const smokeCount = tier.smoke;
  const smokeGeometry = own(new THREE.InstancedBufferGeometry());
  const plane = new THREE.PlaneGeometry(1, 1);
  smokeGeometry.index = plane.index; smokeGeometry.setAttribute('position', plane.getAttribute('position')); smokeGeometry.setAttribute('uv', plane.getAttribute('uv'));
  const puffData = new Float32Array(smokeCount * 4), fadeData = new Float32Array(smokeCount * 2);
  const puffAttr = new THREE.InstancedBufferAttribute(puffData, 4).setUsage(THREE.DynamicDrawUsage);
  const fadeAttr = new THREE.InstancedBufferAttribute(fadeData, 2).setUsage(THREE.DynamicDrawUsage);
  smokeGeometry.setAttribute('aPuff', puffAttr); smokeGeometry.setAttribute('aFade', fadeAttr);
  smokeGeometry.instanceCount = 0;
  const puffTex = own(puffTexture());
  const smokeMaterial = own(new THREE.ShaderMaterial({ name: 'showroom-smoke', uniforms: { tPuff: { value: puffTex }, uColor: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: SMOKE_VERTEX, fragmentShader: SMOKE_FRAGMENT, transparent: true, depthWrite: false }));
  const smoke = new THREE.Mesh(smokeGeometry, smokeMaterial); smoke.frustumCulled = false; smoke.renderOrder = 2; scene.add(smoke);
  interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number; rot: number; spin: number }
  const puffs: Puff[] = [];
  let smokeOn = false, smokeAccumulator = 0, wheelSpin = 0;

  /* ---------------------------------------------------------------- car */
  let car: CarPresentation | null = null;
  let carFrame = { halfLength: 2.4, halfWidth: 1, height: 1.4, wheels: [] as THREE.Vector3[] };
  const REVEAL_DEPTH = 1.9;
  let revealPhase: 'idle' | 'out' | 'in' = 'idle', revealT = 0, revealDark = 0;
  let revealPending: CarPresentation | null = null;
  let carCalls = 0, carTriangles = 0;
  let reflectionAllowed = reflectTarget !== null;

  /* ---------------------------------------------------------------- camera rig */
  let shotId: ShotId = 'paint';
  const cam = { az: SHOTS.paint.az, el: SHOTS.paint.el, r: SHOTS.paint.r, fov: SHOTS.paint.fov, target: new THREE.Vector3(0, SHOTS.paint.ty, 0) };
  const from = { az: cam.az, el: cam.el, r: cam.r, fov: cam.fov, target: cam.target.clone() };
  let transition = 1, transitionDuration = 1.3;
  const user = { az: 0, el: 0, zoom: 1, vaz: 0, vel: 0, idle: 0 };
  let tableAngle = 0, tableVelocity = SPIN_SPEED, kick = 0, kickVelocity = 0, shake = 0;
  let mood = 0, moodTarget = 0, flash = 0, shock = -1;
  let lastNow = 0, elapsed = 0;
  let stats: ShowroomStats = { calls: 0, triangles: 0, reflection: false, lights: lights.length };

  const shotTarget = (shot: Shot, out: THREE.Vector3): THREE.Vector3 => {
    if (shot.wheel && carFrame.wheels.length === 4) {
      const side = Math.sin(shot.az) >= 0 ? 1 : -1;
      const front = carFrame.wheels.slice(0, 2).find(w => Math.sign(w.x) === side) ?? carFrame.wheels[0]!;
      out.set(front.x + side * 0.05, Math.max(0.3, front.y), front.z);
    } else out.set(0, TABLE_TOP + shot.ty, shot.tz * carFrame.halfLength);
    if (!shot.spin) out.applyAxisAngle(THREE.Object3D.DEFAULT_UP, tableAngle);
    return out;
  };
  const liveTarget = new THREE.Vector3();

  function placeCar(next: CarPresentation | null): void {
    carSlot.clear();
    car = next;
    carCalls = 0; carTriangles = 0;
    if (!next) return;
    const root = next.body.parent ?? next.body;
    next.body.position.set(0, 0, 0); next.body.quaternion.identity();
    for (const wheel of next.wheels) {
      const rest = wheel.userData.restPosition as THREE.Vector3 | undefined;
      if (rest) wheel.position.copy(rest);
      wheel.quaternion.identity();
    }
    // Same material pass as the harbor (flattens lens transmission), then a hard guard: no transmission in the showroom.
    applySceneMaterialProfile(root);
    root.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) { material.transmission = 0; material.needsUpdate = true; }
      }
    });
    const holder = new THREE.Group();
    holder.add(root);
    const [fl, fr, rl, rr] = next.wheels;
    const frontZ = (fl.position.z + fr.position.z) / 2, rearZ = (rl.position.z + rr.position.z) / 2;
    holder.rotation.y = frontZ >= rearZ ? 0 : Math.PI;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3();
    next.body.traverse(node => { if (node instanceof THREE.Mesh && node.visible) box.expandByObject(node); });
    const ground = Math.min(...next.wheels.map(w => w.getWorldPosition(new THREE.Vector3()).y)) - WHEEL_RADIUS;
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    holder.position.set(-center.x, TABLE_TOP - ground, -center.z);
    carSlot.add(holder);
    carSlot.updateMatrixWorld(true);
    carFrame = {
      halfLength: Math.max(1.6, size.z / 2), halfWidth: Math.max(0.8, size.x / 2), height: size.y,
      wheels: next.wheels.map(w => carSlot.worldToLocal(w.getWorldPosition(new THREE.Vector3()))),
    };
    contact.scale.set(carFrame.halfWidth * 2 + 0.9, 1, carFrame.halfLength * 2 + 1.1);
    gate.scale.set(carFrame.halfWidth * 2 + 1.0, carFrame.height + 0.9, 1);
    next.body.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      node.frustumCulled = true;
      if (!node.visible) return;
      const groups = node.geometry.groups.length || 1;
      carCalls += groups;
      const index = node.geometry.index;
      carTriangles += (index ? index.count : node.geometry.getAttribute('position').count) / 3;
    });
    for (const wheel of next.wheels) wheel.traverse(node => {
      if (node instanceof THREE.Mesh && node.visible) {
        carCalls += node.geometry.groups.length || 1;
        const index = node.geometry.index;
        carTriangles += (index ? index.count : node.geometry.getAttribute('position').count) / 3;
      }
    });
    // Rough fixed cost of everything else, measured on Balanced: rig, floor, table, effects and post passes.
    reflectionAllowed = reflectTarget !== null && carCalls * 2 + 34 <= SHOWROOM_DRAW_BUDGET && carTriangles * 2 < 260_000;
    floorUniforms.uReflect.value = reflectionAllowed ? 1 : 0;
  }
  function burst(count: number, color: THREE.Color): void {
    sparkMaterial.uniforms.uColor!.value.copy(color).multiplyScalar(5);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, r = TABLE_RADIUS + 0.1;
      const up = 3 + Math.random() * 5, out = 0.6 + Math.random() * 2.6;
      sparkPos.set([Math.cos(a) * r, 0.08 + Math.random() * 0.1, Math.sin(a) * r], i * 3);
      sparkVel.set([Math.cos(a) * out - Math.sin(a) * 1.2, up, Math.sin(a) * out + Math.cos(a) * 1.2], i * 3);
      sparkMax[i] = 1.1 + Math.random() * 1.3; sparkLife[i] = 1;
    }
    sparksAlive = Math.max(sparksAlive, count); sparks.visible = true;
  }
  function finishOut(): void {
    const old = car;
    placeCar(revealPending);
    revealPending = null;
    if (old && old !== car) release(old);
    revealPhase = 'in'; revealT = 0;
    carSlot.position.y = -REVEAL_DEPTH;
    gateT = 0; gateDuration = 1.1; gateStrength = 1.3;
    flash = Math.max(flash, 0.8); kickVelocity -= 18; tableVelocity += 4; shock = 0;
    burst(Math.floor(sparkCount * 0.6), accent);
  }
  function stepReveal(dt: number): void {
    if (revealPhase === 'out') {
      revealT = Math.min(1, revealT + dt / 0.5);
      carSlot.position.y = -REVEAL_DEPTH * ease(revealT);
      revealDark = revealT;
      if (revealT >= 1) finishOut();
    } else if (revealPhase === 'in') {
      revealT = Math.min(1, revealT + dt / 1.1);
      carSlot.position.y = -REVEAL_DEPTH * (1 - ease(revealT));
      revealDark = 1 - revealT;
      if (revealT >= 1) { revealPhase = 'idle'; carSlot.position.y = 0; revealDark = 0; }
    }
    floorUniforms.uReflect.value = reflectionAllowed && carSlot.position.y > -0.01 ? 1 : 0;
  }

  /* ---------------------------------------------------------------- per-frame helpers */
  const reflectCamera = new THREE.PerspectiveCamera();
  const bufferSize = new THREE.Vector2();
  const textureMatrix = floorUniforms.uTexMatrix.value;
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const reflectionHidden: THREE.Object3D[] = [floor, ...(haze ? [haze] : []), ...(dust ? [dust] : []), smoke, contact];

  function updateReflection(): void {
    if (!reflectTarget || !reflectionAllowed || floorUniforms.uReflect.value === 0) return;
    const w = Math.max(2, Math.floor(bufferSize.x * tier.reflection)), h = Math.max(2, Math.floor(bufferSize.y * tier.reflection));
    if (reflectTarget.width !== w || reflectTarget.height !== h) reflectTarget.setSize(w, h);
    floorUniforms.uTexel.value.set(1 / w, 1 / h);
    reflectCamera.copy(camera);
    reflectCamera.position.set(camera.position.x, -camera.position.y, camera.position.z);
    camera.getWorldDirection(tmp);
    tmp2.copy(camera.position).add(tmp); tmp2.y = -tmp2.y;
    reflectCamera.up.set(0, -1, 0);
    reflectCamera.lookAt(tmp2);
    reflectCamera.updateMatrixWorld();
    reflectCamera.projectionMatrix.copy(camera.projectionMatrix);
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(reflectCamera.projectionMatrix).multiply(reflectCamera.matrixWorldInverse);
    for (const node of reflectionHidden) { node.userData.srVisible = node.visible; node.visible = false; }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(reflectTarget);
    renderer.clear();
    renderer.render(scene, reflectCamera);
    renderer.setRenderTarget(previous);
    for (const node of reflectionHidden) node.visible = node.userData.srVisible as boolean;
  }

  function stepSmoke(dt: number): void {
    if (smokeOn && car && carFrame.wheels.length === 4) {
      smokeAccumulator += dt * (smokeCount / 2.4);
      wheelSpin += dt * 38;
      while (smokeAccumulator >= 1) {
        smokeAccumulator -= 1;
        const wheel = carFrame.wheels[2 + (puffs.length % 2)]!;
        if (puffs.length >= smokeCount) puffs.shift();
        tmp.set(wheel.x + Math.sign(wheel.x) * 0.15, TABLE_TOP + 0.12, wheel.z - 0.25).applyAxisAngle(THREE.Object3D.DEFAULT_UP, tableAngle);
        const back = tmp2.set(0, 0, -1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, tableAngle);
        puffs.push({ x: tmp.x, y: tmp.y, z: tmp.z, vx: back.x * (1.4 + Math.random()) + (Math.random() - 0.5) * 0.8, vy: 0.25 + Math.random() * 0.5,
          vz: back.z * (1.4 + Math.random()) + (Math.random() - 0.5) * 0.8, age: 0, life: 2.2 + Math.random() * 1.4, size: 0.5 + Math.random() * 0.3,
          rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.8 });
      }
    } else wheelSpin *= Math.max(0, 1 - dt * 2);
    if (car) for (const wheel of car.wheels.slice(2)) wheel.rotation.x = (wheel.rotation.x - wheelSpin * dt) % (Math.PI * 2);
    let alive = 0;
    for (const puff of puffs) {
      puff.age += dt;
      if (puff.age >= puff.life) continue;
      const drag = Math.max(0, 1 - dt * 0.9);
      puff.vx *= drag; puff.vz *= drag; puff.vy = puff.vy * drag + dt * 0.18;
      puff.x += puff.vx * dt; puff.y += puff.vy * dt; puff.z += puff.vz * dt; puff.rot += puff.spin * dt;
      const k = puff.age / puff.life;
      puffData.set([puff.x, puff.y, puff.z, puff.size * (1 + k * 4.5)], alive * 4);
      fadeData.set([Math.min(1, puff.age * 5) * (1 - k) * (1 - k) * 0.85, puff.rot], alive * 2);
      alive++;
    }
    for (let i = puffs.length - 1; i >= 0; i--) if (puffs[i]!.age >= puffs[i]!.life) puffs.splice(i, 1);
    smokeGeometry.instanceCount = alive;
    smoke.visible = alive > 0;
    if (alive) { puffAttr.needsUpdate = true; fadeAttr.needsUpdate = true; }
  }

  function stepSparks(dt: number): void {
    if (!sparksAlive) return;
    let alive = 0;
    for (let i = 0; i < sparkCount; i++) {
      if (sparkLife[i]! <= 0) continue;
      const remaining = sparkLife[i]! * sparkMax[i]! - dt;
      if (remaining <= 0) { sparkLife[i] = 0; continue; }
      sparkLife[i] = remaining / sparkMax[i]!;
      const o = i * 3;
      sparkVel[o + 1] = sparkVel[o + 1]! - 7.5 * dt;
      const drag = Math.max(0, 1 - dt * 0.8);
      sparkVel[o] = sparkVel[o]! * drag; sparkVel[o + 2] = sparkVel[o + 2]! * drag;
      sparkPos[o] = sparkPos[o]! + sparkVel[o]! * dt; sparkPos[o + 1] = sparkPos[o + 1]! + sparkVel[o + 1]! * dt; sparkPos[o + 2] = sparkPos[o + 2]! + sparkVel[o + 2]! * dt;
      if (sparkPos[o + 1]! < 0.02) { sparkPos[o + 1] = 0.02; sparkVel[o + 1] = Math.abs(sparkVel[o + 1]!) * 0.35; }
      alive++;
    }
    sparksAlive = alive;
    sparks.visible = alive > 0;
    (sparkGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (sparkGeometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;
  }

  function updateCamera(dt: number, raw: number): void {
    const shot = SHOTS[shotId];
    // Turntable: spins on hero shots, parks the car facing the lens on close-ups.
    if (shot.spin) tableVelocity += (SPIN_SPEED - tableVelocity) * Math.min(1, dt * 1.2);
    else {
      const error = wrap(0 - tableAngle);
      tableVelocity += (error * 2.4 - tableVelocity * 2.2) * Math.min(1, dt * 3);
    }
    tableAngle += tableVelocity * dt;
    table.rotation.y = tableAngle;

    transition = Math.min(1, transition + raw / transitionDuration);
    const k = ease(transition), arc = Math.sin(Math.PI * k) * (1 - k * 0.2);
    shotTarget(shot, liveTarget);
    cam.az = from.az + wrap(shot.az - from.az) * k;
    cam.el = from.el + (shot.el - from.el) * k + arc * 0.09;
    const fit = shot.wheel ? 1 : Math.max(0.85, Math.min(1.5, carFrame.halfLength / 2.2));
    const shotR = shot.r * fit;
    cam.r = from.r + (shotR - from.r) * k + arc * shotR * 0.14;
    cam.fov = from.fov + (shot.fov - from.fov) * k;
    cam.target.lerpVectors(from.target, liveTarget, k);

    // Orbit with inertia; idle drift when nobody touches it.
    user.az += user.vaz * dt; user.el += user.vel * dt;
    const damping = Math.max(0, 1 - dt * 3.2);
    user.vaz *= damping; user.vel *= damping;
    user.idle += dt;
    user.el = Math.max(-cam.el + 0.015, Math.min(1.15 - cam.el, user.el));
    const drift = Math.min(1, Math.max(0, user.idle - 3) / 3);
    const az = cam.az + user.az + Math.sin(elapsed * 0.13) * 0.05 * drift;
    const el = cam.el + user.el + Math.sin(elapsed * 0.21) * 0.012 * drift;
    const r = Math.max(2.2, Math.min(15, cam.r * user.zoom));
    kickVelocity += (-kick * 90 - kickVelocity * 12) * dt; kick += kickVelocity * dt;
    shake = Math.max(0, shake - dt * 2.2);
    camera.fov = cam.fov + kick;
    camera.position.set(
      cam.target.x + Math.sin(az) * Math.cos(el) * r * (1 + kick * 0.01),
      Math.max(0.12, cam.target.y + Math.sin(el) * r),
      cam.target.z + Math.cos(az) * Math.cos(el) * r * (1 + kick * 0.01),
    );
    if (shake > 0) {
      const s = shake * shake * 0.06;
      camera.position.x += Math.sin(elapsed * 61) * s; camera.position.y += Math.sin(elapsed * 47 + 1) * s;
    }
    camera.lookAt(cam.target);
    camera.updateProjectionMatrix();
  }

  function updateLook(dt: number, raw: number): void {
    mood += (Math.max(moodTarget, revealDark * 0.9) - mood) * Math.min(1, dt * (revealPhase === 'idle' ? 2.5 : 8));
    flash = Math.max(0, flash - raw * 1.6);
    const lit = 1 - mood * 0.82;
    lights.forEach((light, i) => { light.intensity = baseIntensity[i]! * lit * (1 + flash * 0.6); });
    scene.environmentIntensity = 1 - mood * 0.78;
    whiteMaterial.color.setRGB(5.2, 5.4, 5.8).multiplyScalar((1 - mood * 0.75) * (1 + flash * 0.8));
    accentMaterial.color.copy(accent).multiplyScalar(4 * (1 + flash * 2.5));
    floorUniforms.uAccent.value.copy(accent).multiplyScalar(0.6 * (1 + flash * 2));
    floorUniforms.uPool.value.setRGB(0.06, 0.065, 0.07).multiplyScalar(1 - mood * 0.7);
    if (hazeMaterial) { hazeMaterial.uniforms.uTime!.value = elapsed; hazeMaterial.uniforms.uColor!.value.setRGB(0.075, 0.08, 0.085).multiplyScalar((1 - mood * 0.6) * (1 + flash)); }
    if (dustMaterial) { dustMaterial.uniforms.uTime!.value = elapsed; dustMaterial.uniforms.uScale!.value = 26 * bufferSize.y / 900; }
    sparkMaterial.uniforms.uScale!.value = 60 * bufferSize.y / 900;
    if (shock >= 0) {
      shock += raw;
      floorUniforms.uShock.value = Math.max(0, 1 - shock / 1.4);
      floorUniforms.uShockRadius.value = 3.6 + shock * 9;
      if (shock > 1.4) { shock = -1; floorUniforms.uShock.value = 0; }
    }
    if (gateT >= 0) {
      gateT += raw / gateDuration;
      const t = Math.min(1, gateT);
      gate.visible = t < 1;
      gate.position.set(0, TABLE_TOP + (carFrame.height + 0.9) / 2 - 0.1, (1 - 2 * ease(t)) * (carFrame.halfLength + 0.6));
      gateMaterial.uniforms.uAlpha!.value = Math.sin(Math.PI * t) * gateStrength * 0.6;
      gateMaterial.uniforms.uTime!.value = elapsed;
      if (t >= 1) gateT = -1;
    }
  }

  return {
    setCar(next, reveal = false): void {
      if (revealPhase === 'out' && revealPending && revealPending !== next) release(revealPending);
      revealPending = null;
      if (!reveal) {
        const old = car;
        revealPhase = 'idle'; carSlot.position.y = 0; revealDark = 0;
        placeCar(next);
        if (old && old !== next) release(old);
        return;
      }
      revealPending = next;
      if (!car) finishOut();
      else if (revealPhase !== 'out') { revealPhase = 'out'; revealT = 0; }
    },
    setShot(next, immediate = false): void {
      const shot = SHOTS[next];
      if (immediate) {
        shotId = next; transition = 1;
        cam.az = shot.az; cam.el = shot.el; cam.r = shot.r; cam.fov = shot.fov;
        shotTarget(shot, cam.target); from.target.copy(cam.target);
        Object.assign(from, { az: shot.az, el: shot.el, r: shot.r, fov: shot.fov });
        user.az = user.el = 0; user.zoom = 1;
        return;
      }
      if (next === shotId && transition >= 1 && Math.abs(user.az) + Math.abs(user.el) < 0.02 && Math.abs(user.zoom - 1) < 0.02) return;
      from.az = cam.az + user.az; from.el = cam.el + user.el; from.r = Math.max(2.2, Math.min(15, cam.r * user.zoom)); from.fov = cam.fov;
      from.target.copy(cam.target);
      user.az = user.el = user.vaz = user.vel = 0; user.zoom = 1; user.idle = 0;
      // A shot that keeps the table spinning measures azimuth in world space; fold the table angle in when leaving a close-up.
      transitionDuration = next === shotId ? 0.9 : 1.35;
      shotId = next; transition = 0;
    },
    setAccent(css): void {
      accent = new THREE.Color(css);
      sparkMaterial.uniforms.uColor!.value.copy(accent).multiplyScalar(5);
      gateMaterial.uniforms.uColor!.value.copy(accent).multiplyScalar(3);
    },
    setMood(dark): void { moodTarget = Math.max(0, Math.min(1, dark)); },
    setSmoke(color): void {
      smokeOn = color !== null;
      if (color) smokeMaterial.uniforms.uColor!.value.set(color).multiplyScalar(1.15);
    },
    pulse(kind): void {
      if (kind === 'horn') { flash = Math.max(flash, 0.7); shake = Math.max(shake, 0.6); kickVelocity -= 6; }
      else { gateT = 0; gateDuration = 0.75; gateStrength = 0.55; flash = Math.max(flash, 0.25); }
    },
    celebrate(color): void {
      this.setAccent(color);
      flash = 1; shake = 1; kickVelocity -= 34; shock = 0;
      gateT = 0; gateDuration = 1.05; gateStrength = 1.4;
      tableVelocity += 7;
      burst(sparkCount, accent);
    },
    orbit(dx, dy): void {
      user.az -= dx * 0.0055; user.el += dy * 0.004; user.vaz = 0; user.vel = 0; user.idle = 0;
    },
    zoom(factor): void { user.zoom = Math.max(0.55, Math.min(1.7, user.zoom * factor)); user.idle = 0; },
    fling(vx, vy): void { user.vaz = -vx * 5.5 * 0.6; user.vel = vy * 4 * 0.6; user.idle = 0; },
    render(now): void {
      // Timelines (shot moves, reveals, unlock) run on wall-clock time so they end on time even on a slow GPU;
      // springs and particles use a clamped step for stability.
      const raw = lastNow ? Math.min(1, Math.max(0, (now - lastNow) / 1000)) : 1 / 60;
      const dt = Math.min(0.1, raw);
      lastNow = now; elapsed += dt;
      const gl = renderer.getContext();
      if (gl.isContextLost()) return;
      renderer.getDrawingBufferSize(bufferSize);
      const aspect = bufferSize.x / Math.max(1, bufferSize.y);
      if (Math.abs(camera.aspect - aspect) > 1e-4) { camera.aspect = aspect; post.resize(); }
      // Portrait screens: pull the lens back so the whole car stays in frame.
      const portrait = aspect < 1 ? Math.min(1.9, 1 / aspect * 0.95) : 1;
      updateCamera(dt, raw);
      if (portrait > 1) {
        tmp.copy(camera.position).sub(cam.target).multiplyScalar(portrait);
        camera.position.copy(cam.target).add(tmp);
        // The phone card sits low: aim under the car so it rides in the upper half.
        camera.lookAt(tmp.copy(cam.target).add(tmp2.set(0, -0.35 * portrait, 0)));
        camera.updateMatrixWorld();
      }
      // Wide screens: the detail card sits right, so the car rides left of centre.
      const offset = aspect > 1.25 ? Math.min(3.2, 1.8 + (aspect - 1.25) * 3) : 0;
      if (Math.abs(camera.filmOffset - offset) > 1e-3) { camera.filmOffset = offset; camera.updateProjectionMatrix(); }
      stepReveal(raw);
      updateLook(dt, raw);
      stepSmoke(dt);
      stepSparks(dt);
      const info = renderer.info, autoReset = info.autoReset;
      info.autoReset = false; info.reset();
      const previousExposure = renderer.toneMappingExposure;
      try {
        renderer.setRenderTarget(null);
        updateReflection();
        post.render();
      } finally {
        renderer.toneMappingExposure = previousExposure;
        stats = { calls: info.render.calls, triangles: info.render.triangles, reflection: reflectionAllowed, lights: lights.length };
        info.autoReset = autoReset;
      }
    },
    async precompile(): Promise<void> {
      renderer.getDrawingBufferSize(bufferSize);
      camera.aspect = bufferSize.x / Math.max(1, bufferSize.y); camera.updateProjectionMatrix(); post.resize();
      sparks.visible = true; gate.visible = true; smoke.visible = true;
      try { await post.precompile(scene); } catch { /* compiles on first frame instead */ }
      sparks.visible = sparksAlive > 0; gate.visible = gateT >= 0; smoke.visible = puffs.length > 0;
    },
    stats: () => stats,
    get revealing() { return revealPhase !== 'idle'; },
    dispose(): void {
      carSlot.clear();
      post.dispose();
      plane.dispose();
      for (const item of disposables) item.dispose();
      scene.clear();
    },
  };
}
