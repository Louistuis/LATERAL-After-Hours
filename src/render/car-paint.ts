import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';

/**
 * Premium car paint for every tier: clearcoat over a base layer with metallic flakes, a fresnel colour
 * flip (pearl / chameleon) and finish presets (gloss, metallic, pearl, chameleon, candy, satin, matte,
 * chrome). Every finish is the SAME shader program: switching paint only writes uniforms and scalar
 * material values, so the garage, the shop preview and a mid-drive swap never compile a shader.
 *
 * Usage for cosmetics code (economy, shop, garage):
 *   registerCarPaint('neon-pearl', paintFromSwatch('pearl', ['#e9f1ff', '#ff6bd5']));
 *   carPresentation.setCosmetics({ paint: 'neon-pearl' });
 * or apply directly to any car root: applyCarPaint(root, { finish: 'chrome', color: '#d8dde3' }).
 */
export type CarPaintFinish = 'gloss' | 'metallic' | 'pearl' | 'chameleon' | 'candy' | 'satin' | 'matte' | 'chrome';

export interface CarPaintPreset {
  /** Base colour (sRGB CSS colour). */
  readonly color: string;
  readonly finish?: CarPaintFinish;
  /** Flip colour seen at grazing angles (pearl, chameleon). Defaults to a finish-specific tint of `color`. */
  readonly secondary?: string;
  /** Third colour, reached only at the silhouette (chameleon edges, pearl rim). Defaults to `secondary`. */
  readonly tertiary?: string;
  /** Flake tint (sRGB). Defaults to a brightened base colour. */
  readonly flakeColor?: string;
  /** Overrides of the finish defaults. */
  readonly flake?: number;
  readonly flip?: number;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
}

interface FinishDefaults {
  readonly roughness: number;
  readonly metalness: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** 0..1 flake normal strength and sparkle. */
  readonly flake: number;
  /** 0..1 strength of the grazing-angle colour flip. */
  readonly flip: number;
  /** Fresnel exponent of the flip: low = broad (chameleon), high = only the silhouette (pearl). */
  readonly flipPower: number;
}

export const CAR_PAINT_FINISHES: Readonly<Record<CarPaintFinish, FinishDefaults>> = {
  gloss: { roughness: 0.3, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, flake: 0, flip: 0, flipPower: 3 },
  metallic: { roughness: 0.34, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05, flake: 0.75, flip: 0.18, flipPower: 2.2 },
  pearl: { roughness: 0.3, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, flake: 0.55, flip: 0.75, flipPower: 2.4 },
  chameleon: { roughness: 0.28, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.6, flip: 1, flipPower: 1.3 },
  candy: { roughness: 0.22, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.02, flake: 0.85, flip: 0.35, flipPower: 1.8 },
  satin: { roughness: 0.5, metalness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.42, flake: 0.25, flip: 0.1, flipPower: 2 },
  matte: { roughness: 0.68, metalness: 0.05, clearcoat: 0.02, clearcoatRoughness: 0.8, flake: 0, flip: 0, flipPower: 2 },
  chrome: { roughness: 0.05, metalness: 1, clearcoat: 0.6, clearcoatRoughness: 0.02, flake: 0, flip: 0.12, flipPower: 2 },
};

const luminance = (css: string): number => {
  const c = new THREE.Color(css);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

/**
 * Build a preset from shop swatch stops (src/economy CosmeticItem.swatch, 1 to 3 CSS colours).
 *  - chrome and candy: the brightest stop is the reflectance/face, the darkest the deep edge;
 *  - metallic: base plus flake tint from the second stop;
 *  - pearl and chameleon: base -> second stop at shallow angles -> third stop at the silhouette;
 *  - gloss, satin, matte: base colour, second stop as a soft flip.
 */
export function paintFromSwatch(finish: CarPaintFinish, swatch: readonly string[]): CarPaintPreset {
  const stops = swatch.length > 0 ? swatch : ['#8a8f96'];
  const [first, second, third] = [stops[0]!, stops[1], stops[2]];
  if (finish === 'chrome' || finish === 'candy') {
    const sorted = [...stops].sort((a, b) => luminance(b) - luminance(a));
    return { finish, color: sorted[0]!, secondary: sorted[sorted.length - 1]!, ...(sorted[1] && sorted.length > 2 ? { flakeColor: sorted[1] } : {}) };
  }
  if (finish === 'metallic') return { finish, color: first, ...(second ? { flakeColor: second } : {}) };
  return {
    finish, color: first,
    ...(second ? { secondary: second } : {}),
    ...(third ? { tertiary: third } : {}),
  };
}

const registry = new Map<string, Readonly<{ name: string; preset: CarPaintPreset }>>();
/** Make a paint id resolvable by every car's setCosmetics. Re-registering an id replaces it. */
export function registerCarPaint(id: string, preset: CarPaintPreset, name = id): void {
  registry.set(id, { name, preset });
}
export function getCarPaint(id: string | undefined): CarPaintPreset | undefined {
  return id === undefined ? undefined : registry.get(id)?.preset;
}
export function listCarPaints(): readonly Readonly<{ id: string; name: string; preset: CarPaintPreset }>[] {
  return [...registry].map(([id, entry]) => ({ id, ...entry }));
}

/** Flakes are a per-pixel effect: off on Low (same program, a uniform), full elsewhere. */
const QUALITY_UNIFORM = { value: 1 };
const FLAKE_BY_QUALITY: Readonly<Record<QualityPreset, number>> = { low: 0, balanced: 1, high: 1, ultra: 1 };
export function setCarPaintQuality(quality: QualityPreset): void {
  QUALITY_UNIFORM.value = FLAKE_BY_QUALITY[quality];
}

const PAINT_VERSION = 'l3-paint-v1';

const PAINT_VERTEX_PARS = /* glsl */`
  varying vec3 vL3PaintPos;
`;
const PAINT_FRAGMENT_PARS = /* glsl */`
  varying vec3 vL3PaintPos;
  uniform vec3 uL3PaintFlip;
  uniform vec3 uL3PaintFlip2;
  uniform vec3 uL3PaintFlake;
  uniform vec3 uL3PaintParams; // flake strength, flip strength, flip power
  uniform float uL3PaintQuality;
  vec3 l3PaintHash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
`;
/**
 * Runs after the clearcoat normal is fixed, so flakes only tilt the BASE layer under a smooth clearcoat.
 * Flake cells are ~5 mm; beyond a pixel footprint of a cell they fade to an averaged, slightly rougher
 * base so distance never shimmers.
 */
const PAINT_FRAGMENT = /* glsl */`
  {
    vec3 l3V = normalize(vViewPosition);
    float l3NdV = clamp(dot(normal, l3V), 0.0, 1.0);
    float l3Graze = pow(1.0 - l3NdV, uL3PaintParams.z);
    diffuseColor.rgb = mix(diffuseColor.rgb, uL3PaintFlip, clamp(l3Graze * uL3PaintParams.y, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, uL3PaintFlip2, clamp(l3Graze * l3Graze * uL3PaintParams.y, 0.0, 1.0));
    float l3Flake = uL3PaintParams.x * uL3PaintQuality;
    if (l3Flake > 0.0) {
      vec3 l3Cell = vL3PaintPos * 190.0;
      float l3Footprint = length(fwidth(l3Cell));
      float l3Visible = 1.0 - smoothstep(0.45, 1.6, l3Footprint);
      vec3 l3Id = floor(l3Cell);
      vec3 l3Rand = l3PaintHash3(l3Id);
      float l3IsFlake = step(0.42, l3Rand.z);
      vec3 l3Tilt = (l3PaintHash3(l3Id + 17.0) * 2.0 - 1.0);
      normal = normalize(normal + l3Tilt * (0.55 * l3Flake * l3Visible * l3IsFlake));
      // Sparkle: flakes catch light as tiny bright mirrors; far away they average into a brighter, rougher base.
      diffuseColor.rgb = mix(diffuseColor.rgb, uL3PaintFlake, l3Flake * (0.22 * l3IsFlake * l3Visible + 0.1 * (1.0 - l3Visible)));
      roughnessFactor = mix(roughnessFactor, max(roughnessFactor - 0.12, 0.08), l3Flake * l3IsFlake * l3Visible);
      roughnessFactor = mix(roughnessFactor, roughnessFactor + 0.06, l3Flake * (1.0 - l3Visible));
    }
  }
`;

interface PaintUniforms {
  readonly uL3PaintFlip: THREE.IUniform<THREE.Color>;
  readonly uL3PaintFlip2: THREE.IUniform<THREE.Color>;
  readonly uL3PaintFlake: THREE.IUniform<THREE.Color>;
  readonly uL3PaintParams: THREE.IUniform<THREE.Vector3>;
}

function paintUniforms(material: THREE.MeshPhysicalMaterial): PaintUniforms {
  const existing = material.userData.l3PaintUniforms as PaintUniforms | undefined;
  if (existing) return existing;
  const uniforms: PaintUniforms = {
    uL3PaintFlip: { value: new THREE.Color() },
    uL3PaintFlip2: { value: new THREE.Color() },
    uL3PaintFlake: { value: new THREE.Color() },
    uL3PaintParams: { value: new THREE.Vector3(0, 0, 2) },
  };
  material.userData.l3PaintUniforms = uniforms;
  const prior = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer): void {
    prior.call(this, shader, renderer);
    // The quality uniform is one object shared by every paint material, so a tier change is one write.
    Object.assign(shader.uniforms, uniforms, { uL3PaintQuality: QUALITY_UNIFORM });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PAINT_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vL3PaintPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PAINT_FRAGMENT_PARS}`)
      .replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>\n${PAINT_FRAGMENT}`);
  };
  const priorKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${priorKey()}|${PAINT_VERSION}`;
  material.needsUpdate = true;
  return uniforms;
}

const scratch = new THREE.Color();
const hsl = { h: 0, s: 0, l: 0 };

/** Apply a paint preset to one physical material (the 'paint' slot of a car). */
export function applyPaintToMaterial(material: THREE.MeshPhysicalMaterial, preset: CarPaintPreset): void {
  const finish = CAR_PAINT_FINISHES[preset.finish ?? 'gloss'];
  const uniforms = paintUniforms(material);
  material.color.set(preset.color);
  material.roughness = preset.roughness ?? finish.roughness;
  material.metalness = preset.metalness ?? finish.metalness;
  // Clearcoat never reaches 0: that would switch the program off USE_CLEARCOAT.
  material.clearcoat = Math.max(0.01, preset.clearcoat ?? finish.clearcoat);
  material.clearcoatRoughness = preset.clearcoatRoughness ?? finish.clearcoatRoughness;
  if (preset.secondary) uniforms.uL3PaintFlip.value.set(preset.secondary);
  else {
    // Default flip: a cooler, lighter shade of the base, the look of a pearl mid-coat.
    material.color.getHSL(hsl);
    uniforms.uL3PaintFlip.value.setHSL((hsl.h + 0.06) % 1, Math.min(1, hsl.s * 1.1), Math.min(0.9, hsl.l * 1.5 + 0.05));
  }
  uniforms.uL3PaintFlip2.value.copy(uniforms.uL3PaintFlip.value);
  if (preset.tertiary) uniforms.uL3PaintFlip2.value.set(preset.tertiary);
  if (preset.flakeColor) uniforms.uL3PaintFlake.value.set(preset.flakeColor);
  else uniforms.uL3PaintFlake.value.copy(scratch.copy(material.color).lerp(new THREE.Color(1, 1, 1), 0.55));
  uniforms.uL3PaintParams.value.set(preset.flake ?? finish.flake, preset.flip ?? finish.flip, finish.flipPower);
  material.userData.l3PaintFinish = preset.finish ?? 'gloss';
}

/** Apply a paint preset to every material named `slot` (default 'paint') under root. */
export function applyCarPaint(root: THREE.Object3D, preset: CarPaintPreset, slot = 'paint'): number {
  let count = 0;
  const seen = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material.name !== slot || seen.has(material) || !(material instanceof THREE.MeshStandardMaterial)) continue;
      seen.add(material);
      if (material instanceof THREE.MeshPhysicalMaterial) applyPaintToMaterial(material, preset);
      else {
        // A plain standard material (no clearcoat lobe) still takes the colour and base finish.
        const finish = CAR_PAINT_FINISHES[preset.finish ?? 'gloss'];
        material.color.set(preset.color);
        material.roughness = preset.roughness ?? finish.roughness;
        material.metalness = preset.metalness ?? finish.metalness;
      }
      count++;
    }
  });
  return count;
}
