import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AtmosphereRecipe } from './atmosphere';
import { createWindowTowerMaterial } from './coast-scenery';
import { createGlowSprites, createLightUniforms, type GlowInstance } from './light-sprites';
import { createMovingLights, type MovingLight } from './light-trails';
import { hdr, mulberry32, type DistrictScenery, type SharedWorldMaterials } from './ridge-scenery';

export const HARBOR_LIFE_VERSION = 'harbor-life-v1';

/** The authored harbour occupies this box; everything here stays outside it, so gameplay geometry is untouched. */
export const HARBOR_WORLD_BOUNDS = { minX: -300, maxX: 300, minZ: -271, maxZ: 240 } as const;

/**
 * Harbour surroundings: a city skyline at the foot of the northern hills, the open sea to the south and east
 * with ships and a breakwater lighthouse, a cable-stayed bridge across the outer harbour, cranes on the far
 * shore and traffic on the coastal highway. Purely visual and outside the authored world box.
 */
export function createHarborLife(shared: SharedWorldMaterials = {}): DistrictScenery {
  const root = new THREE.Group();
  root.name = 'district-harbor-life';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(item: T): T => { disposables.push(item); return item; };
  const rng = mulberry32(0x4a7b0);
  const B = HARBOR_WORLD_BOUNDS;
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.BufferGeometry => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
  const beam = (a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(thickness, thickness, a.distanceTo(b)).applyMatrix4(new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0)).setPosition(a.clone().add(b).multiplyScalar(0.5)));
  const plane = (x0: number, x1: number, z0: number, z1: number, y: number): THREE.BufferGeometry => {
    const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    const uv = geometry.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (x1 - x0) / 8, uv.getY(k) * (z1 - z0) / 8);
    return geometry;
  };
  const isSea = (x: number, z: number): boolean => (x > B.maxX && z > B.minZ && x < 1450) || (z > B.maxZ && x > B.minX && x < 1450);

  // ------------------------------------------------------------------ land, sea, quay faces, breakwater
  const concrete = shared.concrete ?? own(new THREE.MeshStandardMaterial({ name: 'concrete-weathered', color: '#8d8a83', roughness: 0.94 }));
  const water = shared.water ?? own(new THREE.MeshStandardMaterial({ name: 'harbor-life-sea', color: '#0e2f3a', roughness: 0.14, metalness: 0.3 }));
  const landMaterial = own(new THREE.MeshStandardMaterial({ name: 'harbor-life-land', color: '#1d2126', roughness: 0.8 }));
  const steel = own(new THREE.MeshStandardMaterial({ name: 'harbor-life-steel', color: '#2b3038', roughness: 0.55, metalness: 0.6 }));
  const landParts = [plane(-2600, 2600, -2600, B.minZ, 0), plane(-2600, B.minX, B.minZ, 2600, 0), plane(1450, 2600, B.minZ, 2600, 0)];
  const seaParts = [plane(B.maxX, 1450, B.minZ, 2600, -1.6), plane(B.minX, B.maxX, B.maxZ, 2600, -1.6)];
  const land = new THREE.Mesh(own(mergeGeometries(landParts)!), landMaterial); land.name = 'harbor-life-land';
  const sea = new THREE.Mesh(own(mergeGeometries(seaParts)!), water); sea.name = 'harbor-life-sea';
  [...landParts, ...seaParts].forEach(geometry => geometry.dispose());
  const concreteParts = [
    box(B.maxX + 0.6, -1.2, (B.minZ + B.maxZ) / 2, 1.2, 2.6, B.maxZ - B.minZ), box(0, -1.2, B.maxZ + 0.6, B.maxX - B.minX + 2.4, 2.6, 1.2),
    box(560, -0.2, 430, 420, 2.8, 9),                                                   // breakwater
    box(1450.6, -1.2, 1000, 1.2, 2.6, 3200),                                            // far shore quay
  ];
  const lighthouse = new THREE.CylinderGeometry(1.4, 2.2, 16, 10).translate(772, 8, 430);
  const concreteMesh = new THREE.Mesh(own(mergeGeometries([...concreteParts, lighthouse])!), concrete);
  [...concreteParts, lighthouse].forEach(geometry => geometry.dispose());
  concreteMesh.name = 'harbor-life-quays';
  root.add(land, sea, concreteMesh);

  // ------------------------------------------------------------------ skyline
  const hazeColor = { value: new THREE.Color() }, hazeDensity = { value: 0.0016 };
  const towerMaterial = own(createWindowTowerMaterial('harbor-life-towers', { color: hazeColor, density: hazeDensity }));
  const towers: { x: number; z: number; w: number; d: number; h: number }[] = [];
  const scatter = (x0: number, x1: number, z0: number, z1: number, step: number, density: (x: number, z: number) => number, height: (x: number, z: number) => number): void => {
    for (let gz = z0; gz < z1; gz += step) for (let gx = x0; gx < x1; gx += step) {
      const x = gx + rng() * step * 0.3, z = gz + rng() * step * 0.3;
      if (rng() > density(x, z) || isSea(x, z)) continue;
      towers.push({ x, z, w: step * (0.35 + rng() * 0.35), d: step * (0.35 + rng() * 0.35), h: height(x, z) * (0.5 + rng() * 0.7) });
    }
  };
  // City under the northern hills (behind the coastal highway), the western districts, and the far shore.
  scatter(-1500, 1500, -1350, -470, 48, (x) => 0.8 - Math.abs(x) / 2400, (x, z) => 22 + 150 * Math.exp(-Math.hypot(x + 250, z + 850) / 420));
  scatter(-1400, -470, -260, 1000, 50, () => 0.5, () => 26 + 50 * rng());
  scatter(1500, 2300, -700, 1500, 56, () => 0.7, (x, z) => 40 + 180 * Math.exp(-Math.hypot(x - 1750, z - 300) / 380));
  for (let i = towers.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [towers[i], towers[j]] = [towers[j]!, towers[i]!]; }
  const towerMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(1, 1, 1)), towerMaterial, Math.max(1, towers.length));
  towers.forEach((t, i) => towerMesh.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.h / 2 - 1, t.z), new THREE.Quaternion(), new THREE.Vector3(t.w, t.h + 2, t.d))));
  towerMesh.count = towers.length;
  towerMesh.name = 'harbor-life-skyline';
  root.add(towerMesh);

  // ------------------------------------------------------------------ bridge, cranes, lights
  const glow: GlowInstance[] = [];
  const traffic: MovingLight[] = [];
  const steelParts: THREE.BufferGeometry[] = [];
  const RED = hdr(3.2, 0.2, 0.12), WHITE = hdr(1.6, 1.6, 1.8), TAIL = hdr(2.2, 0.15, 0.1), SODIUM = hdr(1.9, 1.0, 0.4);
  for (const t of towers) if (t.h > 95) glow.push({ position: new THREE.Vector3(t.x, t.h + 2, t.z), color: RED, size: 3.5, pulseSpeed: 1.6, pulseAmount: 0.9, phase: rng() * 6 });
  // Cable-stayed bridge across the outer harbour, west shore to far shore.
  const BZ = 1150, BY = 34, BX0 = -600, BX1 = 1600;
  steelParts.push(box((BX0 + BX1) / 2, BY, BZ, BX1 - BX0, 2.2, 22));
  for (const px of [260, 940]) {
    for (const s of [-1, 1]) steelParts.push(box(px, 64, BZ + s * 12, 3.4, 134, 3.4));
    steelParts.push(box(px, 124, BZ, 3, 3, 28));
    for (const s of [-1, 1]) {
      for (let c = 1; c <= 9; c++) for (const dir of [-1, 1]) {
        const top = new THREE.Vector3(px, 128 - c * 2.4, BZ + s * 12), deck = new THREE.Vector3(px + dir * c * 32, BY + 1, BZ + s * 10.5);
        steelParts.push(beam(top, deck, 0.35));
      }
      glow.push({ position: new THREE.Vector3(px, 133, BZ + s * 12), color: RED, size: 4, pulseSpeed: 1.3, pulseAmount: 0.95, phase: s });
    }
  }
  for (let x = BX0; x <= BX1; x += 32) for (const s of [-1, 1]) glow.push({ position: new THREE.Vector3(x, BY + 4, BZ + s * 11), color: SODIUM, size: 1.8 });
  for (let k = 0; k < 50; k++) {
    traffic.push({ from: new THREE.Vector3(BX0, BY + 1.8, BZ - 4), to: new THREE.Vector3(BX1, BY + 1.8, BZ - 4), color: WHITE, size: 0.9, speed: 24 + rng() * 8, phase: rng() });
    traffic.push({ from: new THREE.Vector3(BX1, BY + 1.8, BZ + 4), to: new THREE.Vector3(BX0, BY + 1.8, BZ + 4), color: TAIL, size: 0.8, speed: 24 + rng() * 8, phase: rng() });
  }
  // Container cranes on the far shore, booms over the water.
  for (let k = 0; k < 5; k++) {
    const z = -120 + k * 70, x = 1475;
    for (const [dx, dz] of [[-8, -7], [8, -7], [-8, 7], [8, 7]] as const) steelParts.push(box(x + dx, 22, z + dz, 1.4, 44, 1.4));
    steelParts.push(box(x - 18, 46, z, 70, 3, 3.5), box(x + 4, 52, z, 2, 14, 2));
    glow.push({ position: new THREE.Vector3(x - 52, 48, z), color: RED, size: 3, pulseSpeed: 1.1, pulseAmount: 0.95, phase: k * 0.7 });
    glow.push({ position: new THREE.Vector3(x - 6, 44, z), color: SODIUM, size: 2.4 });
  }
  // Coastal highway along the foot of the city.
  const HZ = -430;
  for (let x = -1600; x <= 1600; x += 30) glow.push({ position: new THREE.Vector3(x, 9, HZ + (x % 60 === 0 ? -6 : 6)), color: SODIUM, size: 1.5 });
  for (let k = 0; k < 90; k++) {
    traffic.push({ from: new THREE.Vector3(-1600, 1.0, HZ - 3), to: new THREE.Vector3(1600, 1.0, HZ - 3), color: WHITE, size: 0.8, speed: 20 + rng() * 10, phase: rng() });
    traffic.push({ from: new THREE.Vector3(1600, 1.0, HZ + 3), to: new THREE.Vector3(-1600, 1.0, HZ + 3), color: TAIL, size: 0.7, speed: 20 + rng() * 10, phase: rng() });
  }
  // Ships: masthead and side lights travelling together.
  for (let k = 0; k < 6; k++) {
    const from = new THREE.Vector3(420 + rng() * 900, -0.4, 300 + rng() * 1800), heading = rng() * Math.PI * 2;
    const to = from.clone().add(new THREE.Vector3(Math.cos(heading) * 1200, 0, Math.sin(heading) * 1200));
    const speed = 2.5 + rng() * 2.5, phase = rng(), side = new THREE.Vector3(-Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(5);
    traffic.push({ from: from.clone().setY(14), to: to.clone().setY(14), color: WHITE, size: 1.6, speed, phase });
    traffic.push({ from: from.clone().add(side), to: to.clone().add(side), color: hdr(0.3, 2.2, 0.5), size: 1.2, speed, phase });
    traffic.push({ from: from.clone().sub(side), to: to.clone().sub(side), color: hdr(2.4, 0.25, 0.2), size: 1.2, speed, phase });
  }
  traffic.push({ from: new THREE.Vector3(-2400, 520, 1400), to: new THREE.Vector3(2400, 360, -1800), color: hdr(2.5, 2.5, 2.8), size: 3, speed: 70, phase: 0.3 });
  // The breakwater light flashes green.
  glow.push({ position: new THREE.Vector3(772, 17.2, 430), color: hdr(0.5, 3.4, 1.0), size: 5, pulseSpeed: 3.1, pulseAmount: 1, phase: 0 });
  const steelMesh = new THREE.Mesh(own(mergeGeometries(steelParts)!), steel);
  steelParts.forEach(geometry => geometry.dispose());
  steelMesh.name = 'harbor-life-bridge-cranes';
  root.add(steelMesh);

  const uniforms = createLightUniforms();
  const glowMesh = createGlowSprites('harbor-life-lights', glow, uniforms).mesh;
  const trafficMesh = createMovingLights('harbor-life-traffic', traffic, uniforms);
  root.add(glowMesh, trafficMesh);
  for (const mesh of [glowMesh, trafficMesh]) { own(mesh.geometry); own(mesh.material as THREE.Material); }

  const tmp = new THREE.Vector3();
  let disposed = false;
  return {
    district: 'harbor', root, lampPositions: [],
    setAtmosphere(recipe: AtmosphereRecipe): void {
      uniforms.scale.value = 0.6 + 0.4 * recipe.lampGlow;
      uniforms.fogDensity.value = recipe.fogDensity * 0.3;
      hazeColor.value.set(recipe.fog);
      hazeDensity.value = recipe.fogDensity * 0.35;
    },
    setQuality(preset): void {
      towerMesh.count = Math.round(towers.length * (preset === 'low' ? 0.45 : preset === 'balanced' ? 0.85 : 1));
    },
    update(elapsedSeconds, camera): void {
      uniforms.time.value = elapsedSeconds;
      camera.getWorldPosition(tmp);
      uniforms.cameraPosition.value.copy(tmp);
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
