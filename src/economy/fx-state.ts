/**
 * Tiny shared state between the economy and the local car's VFX. Only the player's own car reads it
 * (tyre smoke is simulated for the local car), so remote loadouts never repaint your smoke.
 */
import * as THREE from 'three';

let smoke: THREE.Color | null = null;

/** CSS colour for the local car's tyre smoke, or null for the lighting rig's own colour. */
export function setTyreSmokeColor(css: string | null): void {
  smoke = css ? new THREE.Color(css) : null;
}
export function tyreSmokeTint(): THREE.Color | null {
  return smoke;
}
