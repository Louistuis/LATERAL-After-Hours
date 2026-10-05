import type { LightingPreset } from '../../contracts/runtime-contracts';
import type { PostGrade } from '../render/post-fx';
import type { DistrictId } from '../../contracts/world-contracts';

/**
 * One palette drives every part of the "after hours" look: sky shader, fog,
 * key/fill lights, environment probe, lamp glows and effect tinting. Colours are
 * sRGB hex strings; directions point from the origin TOWARD the light/glow.
 */
export interface AtmosphereRecipe {
  readonly label: string;
  // Sky gradient, horizon to zenith.
  readonly zenith: string;
  readonly upper: string;
  readonly mid: string;
  readonly horizon: string;
  /** Fog and the colour the sky settles to at the horizon line. */
  readonly fog: string;
  readonly fogDensity: number;
  // Sunset / afterglow.
  readonly glow: string;
  readonly glowDirection: readonly [number, number, number];
  readonly glowStrength: number;
  readonly sunDisc: number;
  // Night sky extras.
  readonly city: string;
  readonly cityStrength: number;
  readonly stars: number;
  readonly clouds: number;
  readonly cloudLit: string;
  readonly cloudDark: string;
  readonly moonDirection: readonly [number, number, number];
  readonly moonColor: string;
  readonly moonSize: number;
  // Lights.
  readonly sun: string;
  readonly sunIntensity: number;
  /** Offset from the shadow focus to the directional light. */
  readonly sunDirection: readonly [number, number, number];
  readonly hemiSky: string;
  readonly hemiGround: string;
  readonly hemiIntensity: number;
  readonly exposure: number;
  readonly environmentIntensity: number;
  // Practical lights and dressing.
  /** 0..1 multiplier for lamp glows, light pools and emissive signage. */
  readonly lampGlow: number;
  readonly lampColor: string;
  readonly headlightIntensity: number;
  readonly ridgeFar: string;
  readonly ridgeNear: string;
  /** Colour multiplied into smoke so puffs sit in the scene's light. */
  readonly smokeLight: string;
  readonly smokeWarm: string;
  /** Final-composite colour grade, vignette and bloom energy for this presentation. */
  readonly grade: PostGrade;
}

export const ATMOSPHERES: Readonly<Record<LightingPreset, AtmosphereRecipe>> = {
  // "golden-hour": the sun has just gone down behind the west ridge; lamps are on.
  'golden-hour': {
    label: 'Dusk',
    zenith: '#0d1233', upper: '#2a2a66', mid: '#7a4a86', horizon: '#ff8a52',
    fog: '#5e5578', fogDensity: 0.0042,
    glow: '#ff7a3a', glowDirection: [-0.78, 0.085, -0.62], glowStrength: 1.0, sunDisc: 1,
    city: '#ff9c58', cityStrength: 0.42, stars: 0.35, clouds: 0.62,
    cloudLit: '#ff9a6a', cloudDark: '#2c2452',
    moonDirection: [0.5, 0.45, 0.7], moonColor: '#dfe8ff', moonSize: 0,
    sun: '#ffa070', sunIntensity: 1.55, sunDirection: [-52, 20, -34],
    hemiSky: '#5f72c8', hemiGround: '#1c2232', hemiIntensity: 1.15,
    exposure: 1.1, environmentIntensity: 0.72,
    lampGlow: 0.8, lampColor: '#ffab55', headlightIntensity: 0.7,
    ridgeFar: '#5e4468', ridgeNear: '#2d2440',
    smokeLight: '#a493ae', smokeWarm: '#ffb37a',
    grade: { shadowTint: '#dcf0f6', highlightTint: '#fff0dc', saturation: 1.08, contrast: 0.18, vignette: 0.38, bloomStrength: 0.3, bloomThreshold: 1.1 },
  },
  // "blue-hour": deep night over the harbour; moon, city glow and neon carry the scene.
  'blue-hour': {
    label: 'Night',
    zenith: '#010309', upper: '#050a20', mid: '#0b1946', horizon: '#24508c',
    fog: '#0f1d3c', fogDensity: 0.0046,
    glow: '#3a78d8', glowDirection: [0.52, 0.1, -0.85], glowStrength: 0.22, sunDisc: 0,
    city: '#ff8f45', cityStrength: 0.26, stars: 1, clouds: 0.3,
    cloudLit: '#4a6aa8', cloudDark: '#0a1330',
    moonDirection: [-0.42, 0.52, -0.74], moonColor: '#e6efff', moonSize: 1,
    sun: '#8fb0ff', sunIntensity: 1.25, sunDirection: [-30, 42, -36],
    hemiSky: '#2c4a98', hemiGround: '#0c1020', hemiIntensity: 0.7,
    exposure: 1.12, environmentIntensity: 0.8,
    lampGlow: 1, lampColor: '#ffa648', headlightIntensity: 1,
    ridgeFar: '#16264a', ridgeNear: '#0a1226',
    smokeLight: '#6f86b8', smokeWarm: '#ffb070',
    grade: { shadowTint: '#d2e8f6', highlightTint: '#ffeedd', saturation: 1.05, contrast: 0.2, vignette: 0.42, bloomStrength: 0.42, bloomThreshold: 0.8 },
  },
};

/**
 * Ridge Pass mood: thinner, colder mountain air, a long view north over a city glowing 180 m below,
 * sodium lamps only at the hairpins. Dusk keeps an ember afterglow over the city; night is starlit.
 */
const RIDGE_ATMOSPHERES: Readonly<Record<LightingPreset, AtmosphereRecipe>> = {
  'golden-hour': {
    ...ATMOSPHERES['golden-hour'], label: 'Ridge dusk',
    zenith: '#090f2e', upper: '#20275c', mid: '#5a3d7a', horizon: '#ff7a46',
    fog: '#3a3c60', fogDensity: 0.0024,
    glow: '#ff6630', glowDirection: [-0.52, 0.06, 0.85], glowStrength: 1.15, sunDisc: 0.7,
    city: '#ffa45e', cityStrength: 0.75, stars: 0.55, clouds: 0.5, cloudLit: '#ff9468', cloudDark: '#221c46',
    sun: '#ff9868', sunIntensity: 1.25, sunDirection: [-34, 24, 42],
    hemiSky: '#4b5db4', hemiGround: '#141726', hemiIntensity: 1.0, exposure: 1.12, environmentIntensity: 0.62,
    lampGlow: 0.85, lampColor: '#ffb05a', headlightIntensity: 0.8,
    ridgeFar: '#3b2f5c', ridgeNear: '#1c1932',
    grade: { ...ATMOSPHERES['golden-hour'].grade, saturation: 1.12, bloomStrength: 0.36 },
  },
  'blue-hour': {
    ...ATMOSPHERES['blue-hour'], label: 'Ridge night',
    zenith: '#010207', upper: '#03091b', mid: '#091535', horizon: '#253a68',
    fog: '#0a1327', fogDensity: 0.0026,
    glow: '#ff8a3c', glowDirection: [0.05, 0.03, 1], glowStrength: 0.42, sunDisc: 0,
    city: '#ff8a3c', cityStrength: 0.62, stars: 1.25, clouds: 0.22, cloudLit: '#5c5c8c', cloudDark: '#060b1c',
    moonDirection: [0.46, 0.42, 0.78], moonColor: '#e8eeff', moonSize: 1.15,
    sun: '#a9c0ff', sunIntensity: 1.35, sunDirection: [24, 46, 34],
    hemiSky: '#2a4a8c', hemiGround: '#0b0f1c', hemiIntensity: 0.8, exposure: 1.16, environmentIntensity: 0.75,
    lampGlow: 1, lampColor: '#ffa040', headlightIntensity: 1,
    ridgeFar: '#0f1b37', ridgeNear: '#070c1b',
    grade: { ...ATMOSPHERES['blue-hour'].grade, bloomStrength: 0.46 },
  },
};

/**
 * Neon Bay mood: humid, hazier air over the water, a magenta and cyan city glow instead of sodium,
 * cool LED street lights. Dusk keeps a rose afterglow over the bay; night is wet neon.
 */
const COAST_ATMOSPHERES: Readonly<Record<LightingPreset, AtmosphereRecipe>> = {
  'golden-hour': {
    ...ATMOSPHERES['golden-hour'], label: 'Bay dusk',
    zenith: '#0b1030', upper: '#2a2366', mid: '#7a3d7e', horizon: '#ff6f6a',
    fog: '#4a3c66', fogDensity: 0.003,
    glow: '#ff5e7a', glowDirection: [-0.85, 0.08, -0.5], glowStrength: 1.05, sunDisc: 0.6,
    city: '#ff5fa8', cityStrength: 0.6, stars: 0.2, clouds: 0.55, cloudLit: '#ff86a6', cloudDark: '#26204e',
    sun: '#ff8a8a', sunIntensity: 1.3, sunDirection: [-40, 22, -30],
    hemiSky: '#5a5cc0', hemiGround: '#1a1830', hemiIntensity: 1.05, exposure: 1.1, environmentIntensity: 0.75,
    lampGlow: 0.9, lampColor: '#cfe4ff', headlightIntensity: 0.8,
    ridgeFar: '#4b3366', ridgeNear: '#251c3c',
    grade: { ...ATMOSPHERES['golden-hour'].grade, saturation: 1.14, bloomStrength: 0.38 },
  },
  'blue-hour': {
    ...ATMOSPHERES['blue-hour'], label: 'Bay night',
    zenith: '#02020a', upper: '#070726', mid: '#1b1046', horizon: '#5a2a7a',
    fog: '#1a1236', fogDensity: 0.0034,
    glow: '#ff3fa0', glowDirection: [0.9, 0.06, 0.2], glowStrength: 0.35, sunDisc: 0,
    city: '#ff4fb0', cityStrength: 0.55, stars: 0.45, clouds: 0.45, cloudLit: '#7a3c8c', cloudDark: '#0c0820',
    moonDirection: [-0.5, 0.5, -0.7], moonColor: '#e6efff', moonSize: 0.9,
    sun: '#9fb4ff', sunIntensity: 1.15, sunDirection: [-30, 40, -30],
    hemiSky: '#3b3a9c', hemiGround: '#120c22', hemiIntensity: 0.8, exposure: 1.14, environmentIntensity: 0.85,
    lampGlow: 1, lampColor: '#d8ecff', headlightIntensity: 1,
    ridgeFar: '#22164a', ridgeNear: '#0e0a22',
    grade: { ...ATMOSPHERES['blue-hour'].grade, saturation: 1.12, bloomStrength: 0.5, bloomThreshold: 0.75 },
  },
};

const DISTRICT_ATMOSPHERES: Partial<Record<DistrictId, Readonly<Record<LightingPreset, AtmosphereRecipe>>>> = {
  ridge: RIDGE_ATMOSPHERES,
  coast: COAST_ATMOSPHERES,
};

/** The palette for a district under a lighting preset; the harbour (and any unstyled district) uses ATMOSPHERES. */
export function atmosphereFor(district: DistrictId, preset: LightingPreset): AtmosphereRecipe {
  return DISTRICT_ATMOSPHERES[district]?.[preset] ?? ATMOSPHERES[preset];
}
