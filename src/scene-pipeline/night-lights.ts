import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';
import type { AtmosphereRecipe } from './atmosphere';

export interface NightLights {
  readonly root: THREE.Group;
  /** Re-point the real lights at the lamps nearest the car and aim the headlights. */
  update(position: THREE.Vector3, rotation: THREE.Quaternion, lamps: readonly THREE.Vector3[]): void;
  setAtmosphere(recipe: AtmosphereRecipe): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

const LAMP_SLOTS: Readonly<Record<QualityPreset, number>> = { low: 1, balanced: 3, high: 4, ultra: 6 };
const MAX_LAMP_SLOTS = 6;
/** Candela. Physically-based units: illuminance on the road under a 9.5 m lamp is ~I/90. */
const LAMP_CANDELA = 300;
const HEADLIGHT_CANDELA = 300;

/**
 * A fixed set of real lights (constant count, so shaders never recompile while
 * driving): the lamps nearest the car become point lights with continuous,
 * rank-based fades, and two spot headlights sweep the road ahead. Lamps farther
 * away rely on baked-in glow sprites rather than per-pixel lighting.
 */
export function createNightLights(): NightLights {
  const root = new THREE.Group();
  root.name = 'night-lights';
  const lamps: THREE.PointLight[] = [];
  for (let i = 0; i < MAX_LAMP_SLOTS; i++) {
    const light = new THREE.PointLight('#ffa648', 0, 75, 2);
    light.name = `lamp-light-${i}`;
    lamps.push(light);
    root.add(light);
  }
  const headlights: THREE.SpotLight[] = [];
  for (const side of [-1, 1]) {
    const light = new THREE.SpotLight('#ffe3b8', 0, 80, 0.46, 0.75, 2);
    light.name = `headlight-${side < 0 ? 'left' : 'right'}`;
    light.castShadow = false;
    root.add(light, light.target);
    headlights.push(light);
  }
  let slots = LAMP_SLOTS.balanced;
  let lampScale = 1;
  let headScale = 1;
  const assigned = new Int32Array(MAX_LAMP_SLOTS).fill(-1);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  // The slots+1 nearest lamps, ascending (ties keep lamp order), kept in fixed arrays: this runs every frame.
  const nearestIndex = new Int32Array(MAX_LAMP_SLOTS + 1);
  const nearestDistance = new Float64Array(MAX_LAMP_SLOTS + 1);
  const isNearest = (index: number, count: number): boolean => {
    for (let i = 0; i < count; i++) if (nearestIndex[i] === index) return true;
    return false;
  };
  const isAssigned = (index: number): boolean => {
    for (let slot = 0; slot < MAX_LAMP_SLOTS; slot++) if (assigned[slot] === index) return true;
    return false;
  };

  function applyVisibility(): void {
    lamps.forEach((light, index) => { light.visible = index < slots; });
    headlights.forEach((light, index) => { light.visible = slots > 1 || index === 0; });
  }
  applyVisibility();

  return {
    root,
    update(position, rotation, positions): void {
      forward.set(0, 0, -1).applyQuaternion(rotation);
      right.set(1, 0, 0).applyQuaternion(rotation);
      for (let i = 0; i < headlights.length; i++) {
        const side = i === 0 ? -1 : 1;
        const light = headlights[i]!;
        light.position.copy(position).addScaledVector(forward, 2.0).addScaledVector(right, side * 0.62);
        light.position.y += 0.4;
        light.target.position.copy(light.position).addScaledVector(forward, 20).addScaledVector(right, -side * 1.4);
        light.target.position.y -= 1.6;
        light.intensity = HEADLIGHT_CANDELA * headScale;
      }
      if (positions.length === 0) { for (const light of lamps) light.intensity = 0; return; }
      const keep = Math.min(slots + 1, positions.length);
      let count = 0;
      for (let i = 0; i < positions.length; i++) {
        const distance = Math.hypot(positions[i]!.x - position.x, positions[i]!.z - position.z);
        if (count === keep && distance >= nearestDistance[keep - 1]!) continue;
        let at = count < keep ? count++ : keep - 1;
        while (at > 0 && nearestDistance[at - 1]! > distance) {
          nearestDistance[at] = nearestDistance[at - 1]!;
          nearestIndex[at] = nearestIndex[at - 1]!;
          at--;
        }
        nearestDistance[at] = distance;
        nearestIndex[at] = i;
      }
      const rankLimit = nearestDistance[keep - 1]!;
      const topCount = Math.min(slots, positions.length);
      // Keep a lamp on its slot while it stays in the nearest set; hand free slots to newcomers.
      for (let slot = 0; slot < MAX_LAMP_SLOTS; slot++) {
        if (!(slot < slots && isNearest(assigned[slot]!, topCount))) assigned[slot] = -1;
      }
      for (let rank = 0; rank < topCount; rank++) {
        const index = nearestIndex[rank]!;
        if (isAssigned(index)) continue;
        for (let slot = 0; slot < slots; slot++) {
          if (assigned[slot]! < 0) { assigned[slot] = index; break; }
        }
      }
      for (let slot = 0; slot < MAX_LAMP_SLOTS; slot++) {
        const light = lamps[slot]!;
        const index = assigned[slot] ?? -1;
        if (index < 0 || slot >= slots) { light.intensity = 0; continue; }
        const lamp = positions[index]!;
        light.position.set(lamp.x, lamp.y - 0.4, lamp.z);
        const distance = Math.hypot(lamp.x - position.x, lamp.z - position.z);
        // Rank-based fade: a lamp reaching the (slots+1)th distance is already dark.
        const weight = THREE.MathUtils.clamp((rankLimit - distance) / Math.max(6, rankLimit * 0.45), 0, 1);
        light.intensity = LAMP_CANDELA * lampScale * weight * weight * (3 - 2 * weight);
      }
    },
    setAtmosphere(recipe): void {
      lampScale = recipe.lampGlow;
      headScale = recipe.headlightIntensity;
      for (const light of lamps) light.color.set(recipe.lampColor);
    },
    setQuality(preset): void {
      slots = LAMP_SLOTS[preset];
      applyVisibility();
    },
    dispose(): void {
      root.clear();
      for (const light of headlights) light.dispose();
      for (const light of lamps) light.dispose();
    },
  };
}
