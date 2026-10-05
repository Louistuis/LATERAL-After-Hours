import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';

export interface MaterialProfileReport {
  readonly matchedNames: readonly string[];
  readonly unmatchedNames: readonly string[];
  readonly matchedMaterials: number;
}

interface MaterialRecipe {
  readonly color?: string;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  readonly emissive?: string;
  readonly emissiveIntensity?: number;
}

const RECIPES: Readonly<Record<string, MaterialRecipe>> = {
  'road-asphalt': { roughness: 0.92, metalness: 0 },
  'asphalt-repair': { color: '#414546', roughness: 0.95, metalness: 0 },
  'asphalt-damp': { color: '#303a3d', roughness: 0.56, metalness: 0 },
  'harbor-water': { color: '#0e2f3a', roughness: 0.14, metalness: 0.3 },
  'curb-painted-concrete': { roughness: 0.86, metalness: 0 },
  'concrete-weathered': { roughness: 0.94, metalness: 0 },
  'steel-oxidized': { roughness: 0.68, metalness: 0.44 },
  'shed-deep-teal': { roughness: 0.76, metalness: 0.08 },
  'sodium-lamp': { color: '#ffc27a', roughness: 0.42, metalness: 0.04, emissive: '#ff9a38', emissiveIntensity: 2.6 },
  'loading-door': { roughness: 0.9, metalness: 0 },
  'road-marking-pale': { roughness: 0.82, metalness: 0 },
  'distant-ridge': { roughness: 1, metalness: 0 },
  paint: { roughness: 0.32, metalness: 0.08, clearcoat: 0.6, clearcoatRoughness: 0.3 },
  glass: { roughness: 0.24, metalness: 0.06 },
  rubber: { roughness: 0.9, metalness: 0 },
  metal: { roughness: 0.32, metalness: 0.76 },
  trim: { roughness: 0.5, metalness: 0.18 },
  interior: { roughness: 0.82, metalness: 0 },
  lamp: { roughness: 0.24, metalness: 0.08 },
  'lamp-red': { roughness: 0.28, metalness: 0 },
  'lamp-brake': { roughness: 0.24, metalness: 0 },
  'reverse-lamp': { roughness: 0.24, metalness: 0 },
  'brake-disc': { roughness: 0.48, metalness: 0.68 },
  'mesh-alloy': { roughness: 0.34, metalness: 0.76 },
  'steel-wheel': { roughness: 0.46, metalness: 0.7 },
  'brake-caliper': { roughness: 0.52, metalness: 0.34 },
};

const PROFILE_VERSION = 'l3-pbr-v3';
/**
 * Shared by every wet-surface hook: 0 = satin damp, 1 = mirror puddles. Low quality has no bloom and a single
 * lamp light, so the same mirror finish reads as plastic there; it keeps a softer sheen instead.
 */
const WET_UNIFORMS = { uL3Gloss: { value: 0.85 } };
const GLOSS_BY_QUALITY: Readonly<Record<QualityPreset, number>> = { low: 0.35, balanced: 0.8, high: 1, ultra: 1 };
export function setWetSurfaceQuality(quality: QualityPreset): void {
  WET_UNIFORMS.uL3Gloss.value = GLOSS_BY_QUALITY[quality];
}
/** Wet ground reflects a cooler, flatter sky than the raw probe: sunset orange stays in lamp highlights. */
const WET_INDIRECT_GRADE = /* glsl */`
  {
    float l3SpecLum = dot(reflectedLight.indirectSpecular, vec3(0.2126, 0.7152, 0.0722));
    reflectedLight.indirectSpecular = mix(vec3(l3SpecLum), reflectedLight.indirectSpecular, 0.52) * vec3(0.9, 0.98, 1.12);
  }
`;
const WORLD_POSITION_VARYING = /* glsl */`
  varying vec3 vL3WorldPosition;
  varying vec3 vL3WorldNormal;
`;
const WET_COMMON = /* glsl */`
  uniform float uL3Gloss;
  float l3Hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float l3Noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(l3Hash(i), l3Hash(i + vec2(1.0, 0.0)), f.x), mix(l3Hash(i + vec2(0.0, 1.0)), l3Hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float l3Fbm(vec2 p) { return 0.5 * l3Noise(p) + 0.3 * l3Noise(p * 2.13 + 7.0) + 0.2 * l3Noise(p * 4.31 + 3.0); }
`;
const WET_ROUGHNESS = /* glsl */`
  float l3MacroWave = sin(vL3WorldPosition.x * 0.065 + vL3WorldPosition.z * 0.031)
    * cos(vL3WorldPosition.z * 0.047 - vL3WorldPosition.x * 0.022);
  float l3MacroVariation = 0.5 + 0.5 * l3MacroWave;
  float l3DampPatch = smoothstep(0.62, 0.86, l3MacroVariation);
  float l3RepairPatch = smoothstep(0.48, 0.55, l3MacroVariation) * (1.0 - smoothstep(0.70, 0.78, l3MacroVariation));
  roughnessFactor = clamp(roughnessFactor - 0.30 * l3DampPatch - 0.045 * l3RepairPatch, 0.48, 1.0);
  diffuseColor.rgb *= (0.88 + 0.24 * l3MacroVariation + 0.055 * l3RepairPatch) * (1.0 - 0.09 * l3DampPatch);
`;
/**
 * Night-rain finish for the carriageway: glossy base, polished racing lines, wet gutters,
 * mirror puddles and a worn dashed centre line. Lateral/along coordinates come from the
 * road ribbon UVs (u = metres across / 3, v = metres along / 3).
 */
const WET_ASPHALT_EXTRA = /* glsl */`
  {
    float l3Fine = l3Noise(vL3WorldPosition.xz * 3.1);
    float l3Coarse = l3Noise(vL3WorldPosition.xz * 0.9 + 4.0);
  #ifdef USE_MAP
    float l3Lat = vMapUv.x / 4.5;
    float l3Along = vMapUv.y * 3.0;
  #else
    float l3Lat = 0.5;
    float l3Along = 0.0;
  #endif
    float l3C = abs(l3Lat - 0.5) * 2.0;
    float l3Track = exp(-pow((l3C - 0.34) / 0.12, 2.0)) * (0.65 + 0.35 * l3Coarse);
    float l3Gutter = smoothstep(0.80, 0.97, l3C);
    float l3Puddle = smoothstep(0.6, 0.71, l3Fbm(vL3WorldPosition.xz * 0.085)) * (1.0 - 0.45 * l3Track);
    float l3Sheen = clamp((0.2 + 0.26 * l3Track + 0.16 * l3Gutter + 0.9 * l3Puddle) * (0.5 + 0.5 * uL3Gloss), 0.0, 1.0);
    float l3DryRough = mix(0.62, 0.4, uL3Gloss);
    roughnessFactor = mix(roughnessFactor, mix(l3DryRough, mix(0.3, 0.05, uL3Gloss), l3Puddle), l3Sheen);
    // Cool, slightly desaturated tarmac: the warm dusk light supplies the colour, not the albedo.
    diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, 0.6) * vec3(0.94, 0.98, 1.06);
    roughnessFactor = clamp(roughnessFactor + (l3Fine - 0.5) * 0.14 * (1.0 - l3Puddle), 0.04, 1.0);
    diffuseColor.rgb *= 1.0 - 0.2 * l3Track - 0.22 * l3Gutter - 0.42 * l3Puddle;
    float l3Dash = step(mod(l3Along, 11.0), 4.6) * (1.0 - smoothstep(0.0055, 0.0085, abs(l3Lat - 0.5)));
    float l3Worn = 0.55 + 0.45 * smoothstep(0.25, 0.7, l3Fine);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.39, 0.31) * l3Worn, l3Dash * 0.9);
    roughnessFactor = mix(roughnessFactor, 0.5, l3Dash * 0.9);
  }
`;
/** Wet yard concrete: patchy mirror puddles, oil stains, and a damp satin finish on upward faces. */
const WET_CONCRETE_EXTRA = /* glsl */`
  {
    float l3Up = smoothstep(0.8, 0.95, vL3WorldNormal.y);
    vec2 l3P = vL3WorldPosition.xz;
    float l3Puddle = l3Up * smoothstep(0.62, 0.72, l3Fbm(l3P * 0.055 + 11.0));
    float l3Stain = l3Up * smoothstep(0.52, 0.82, l3Fbm(l3P * 0.32 + 2.0));
    float l3Grit = l3Noise(l3P * 2.7);
    roughnessFactor = mix(roughnessFactor, mix(0.8, mix(0.3, 0.07, uL3Gloss), l3Puddle), clamp(0.35 * l3Up + l3Puddle, 0.0, 1.0));
    diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, 0.7) * vec3(0.95, 0.99, 1.04);
    roughnessFactor = clamp(roughnessFactor + (l3Grit - 0.5) * 0.12 * l3Up, 0.04, 1.0);
    diffuseColor.rgb *= 1.0 - 0.3 * l3Stain - 0.42 * l3Puddle;
  }
`;

type WorldHookKind = 'asphalt' | 'concrete';

function applyWorldHook(material: THREE.MeshStandardMaterial, kind: WorldHookKind): void {
  if (material.userData.l3WetHookVersion === PROFILE_VERSION) return;
  const extra = kind === 'asphalt' ? WET_ASPHALT_EXTRA : WET_CONCRETE_EXTRA;
  const priorCompile = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer): void {
    priorCompile.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${WORLD_POSITION_VARYING}`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  vL3WorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vL3WorldNormal = normalize(mat3(modelMatrix) * normal);',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${WORLD_POSITION_VARYING}\n${WET_COMMON}`,
    );
    if (shader.uniforms) shader.uniforms.uL3Gloss = WET_UNIFORMS.uL3Gloss;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>\n${WET_INDIRECT_GRADE}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>\n${kind === 'asphalt' ? WET_ROUGHNESS : ''}${extra}`,
    );
    // Mirror mask for High/Ultra screen-space reflections: opaque scene alpha is otherwise always 1, so
    // (1 - alpha) marks smooth, upward-facing wet ground. Lower tiers never read it; the canvas has no alpha.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n  gl_FragColor.a = 1.0 - (1.0 - smoothstep(0.04, 0.42, roughnessFactor)) * smoothstep(0.85, 0.97, vL3WorldNormal.y);',
    );
  };
  const priorKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${priorKey()}|${PROFILE_VERSION}|${kind}`;
  material.userData.l3WetHookVersion = PROFILE_VERSION;
  material.needsUpdate = true;
}

function tuneMaterial(material: THREE.Material, recipe: MaterialRecipe): void {
  // Car paint presets (render/car-paint.ts) own their finish; the generic 'paint' recipe would flatten it.
  if (material.userData.l3PaintFinish !== undefined) {
    material.userData.l3MaterialProfileVersion = PROFILE_VERSION;
    return;
  }
  if (recipe.color !== undefined && material instanceof THREE.MeshStandardMaterial) {
    // The Harbor asphalt RGB maps are authored as the surface albedo. A dark
    // recipe tint would multiply them a second time and crush their value range.
    material.color.set(material.map ? '#ffffff' : recipe.color);
  }
  if ('roughness' in material && recipe.roughness !== undefined) material.roughness = recipe.roughness;
  if ('metalness' in material && recipe.metalness !== undefined) material.metalness = recipe.metalness;
  if (material instanceof THREE.MeshPhysicalMaterial) {
    if (recipe.clearcoat !== undefined) material.clearcoat = recipe.clearcoat;
    if (recipe.clearcoatRoughness !== undefined) material.clearcoatRoughness = recipe.clearcoatRoughness;
  }
  if (recipe.emissive !== undefined && material instanceof THREE.MeshStandardMaterial) {
    material.emissive.set(recipe.emissive);
    material.emissiveIntensity = recipe.emissiveIntensity ?? 1;
  }
  if (material instanceof THREE.MeshStandardMaterial) {
    if (material.name === 'road-asphalt') applyWorldHook(material, 'asphalt');
    else if (material.name === 'concrete-weathered') applyWorldHook(material, 'concrete');
  }
  material.userData.l3MaterialProfileVersion = PROFILE_VERSION;
}

/**
 * Any transmissive material makes three.js re-render the whole opaque scene into a transmission target every
 * frame (and, for double-sided glass, rebuild program parameters twice per frame). For thin, near-mirror lens
 * glass the refracted image is just the scene straight behind it, so it is folded into ordinary blending:
 * the lit surface is added at full strength and the background shows through by the share three would have
 * transmitted, T * (1 - F0) * albedo.
 */
function flattenTransmission(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshPhysicalMaterial) || material.transmission <= 0) return;
  if (material.transmissionMap || material.thicknessMap || material.thickness > 0.05 || material.roughness > 0.3) return;
  const albedo = (material.color.r + material.color.g + material.color.b) / 3;
  const dielectric = ((material.ior - 1) / (material.ior + 1)) ** 2 * material.specularIntensity;
  const f0 = dielectric + (albedo - dielectric) * material.metalness;
  const passThrough = THREE.MathUtils.clamp(material.transmission * (1 - f0) * albedo, 0, 1);
  material.userData.l3FlattenedTransmission = material.transmission;
  material.transmission = 0;
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.opacity *= 1 - passThrough;
  material.needsUpdate = true;
}

/** Applies reusable PBR values and subtle world-space damp variation to authored semantic slots. */
export function applySceneMaterialProfile(root: THREE.Object3D): MaterialProfileReport {
  const matchedNames = new Set<string>();
  const matchedMaterials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      flattenTransmission(material);
      const recipe = RECIPES[material.name];
      if (!recipe) continue;
      tuneMaterial(material, recipe);
      matchedNames.add(material.name);
      matchedMaterials.add(material);
    }
  });
  return {
    matchedNames: [...matchedNames].sort(),
    unmatchedNames: Object.keys(RECIPES).filter((name) => !matchedNames.has(name)),
    matchedMaterials: matchedMaterials.size,
  };
}
