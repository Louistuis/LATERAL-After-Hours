import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createNightLights } from '../../src/scene-pipeline/night-lights';

/** The original allocating selection, kept as the reference for the fixed-array version. */
function referenceAssignment(previous: number[], slots: number, car: THREE.Vector3, lamps: readonly THREE.Vector3[]): { assigned: number[]; rankLimit: number } {
  const distances = lamps.map((lamp, index) => ({ index, distance: Math.hypot(lamp.x - car.x, lamp.z - car.z) }));
  distances.sort((a, b) => a.distance - b.distance);
  const rankLimit = distances[Math.min(slots, distances.length - 1)]!.distance;
  const top = new Set(distances.slice(0, slots).map((entry) => entry.index));
  const assigned = previous.map((index, slot) => (slot < slots && top.has(index) ? index : -1));
  const used = new Set(assigned.filter((index) => index >= 0));
  for (const entry of distances.slice(0, slots)) {
    if (used.has(entry.index)) continue;
    const free = assigned.findIndex((index, slot) => index < 0 && slot < slots);
    if (free >= 0) { assigned[free] = entry.index; used.add(entry.index); }
  }
  return { assigned, rankLimit };
}

describe('night lights', () => {
  it('assigns the nearest lamps to stable slots exactly like the reference selection', () => {
    let seed = 7;
    const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const lamps = Array.from({ length: 36 }, (_, i) => new THREE.Vector3(Math.round(random() * 200 - 100), 9.5, i % 5 === 0 ? 0 : Math.round(random() * 200 - 100)));
    lamps.push(lamps[3]!.clone());
    for (const quality of ['low', 'balanced', 'high'] as const) {
      const lights = createNightLights();
      lights.setQuality(quality);
      const slots = { low: 1, balanced: 3, high: 4 }[quality];
      const points = lights.root.children.filter((child): child is THREE.PointLight => child instanceof THREE.PointLight);
      let previous = [-1, -1, -1, -1];
      for (let step = 0; step < 240; step++) {
        const car = new THREE.Vector3(Math.sin(step * 0.05) * 90, 0, step * 0.8 - 96);
        lights.update(car, new THREE.Quaternion(), lamps);
        const reference = referenceAssignment(previous, slots, car, lamps);
        previous = reference.assigned;
        reference.assigned.forEach((index, slot) => {
          const light = points[slot]!;
          if (index < 0) { expect(light.intensity).toBe(0); return; }
          expect(light.position.x).toBe(lamps[index]!.x);
          expect(light.position.z).toBe(lamps[index]!.z);
        });
      }
      lights.dispose();
    }
  });
});
