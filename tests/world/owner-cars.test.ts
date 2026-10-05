import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';
import { CAR_ASSETS, WHEEL_ANCHOR_Y, createCarPresentation } from '../../src/world/index';

const root = process.cwd();
const load = async (path: string) => {
  const bytes = await readFile(resolve(root, path));
  return { bytes, gltf: await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '/') };
};
const triangles = (scene: THREE.Object3D, skip: (name: string) => boolean): number => {
  let total = 0;
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (let p: THREE.Object3D | null = node; p; p = p.parent) if (skip(p.name)) return;
    total += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
  });
  return total;
};
const altWheel = (name: string): boolean => /^wheel-style-(mesh|steel)/.test(name);

describe.skipIf(!existsSync('public/assets/cars/challenger.glb'))('owner-supplied car assets (CAR-01 Challenger, CAR-02 Cybertruck, CAR-04 McLaren F1, CAR-05 Lancia Delta, CAR-06 Agera)', () => {
  const cases = [
    { carId: 'CAR-01', file: 'challenger.glb', maxTris: 250_000, maxBytes: 3_500_000 },
    { carId: 'CAR-02', file: 'cybertruck.glb', maxTris: 50_000, maxBytes: 1_500_000 },
    // The Agera has no textures, so GLTFLoader can parse it under Node like the two road cars.
    { carId: 'CAR-06', file: 'agera.glb', maxTris: 120_000, maxBytes: 3_000_000 },
  ] as const;
  for (const { carId, file, maxTris, maxBytes } of cases) {
    it(`${file}: anchors, lights, materials, budget and manifest`, async () => {
      expect(CAR_ASSETS[carId].file).toBe(file);
      const path = `public/assets/cars/${file}`;
      const { bytes, gltf } = await load(path);
      expect(bytes.byteLength).toBeLessThan(maxBytes);
      const manifest = JSON.parse(await readFile(resolve(root, 'public/assets/asset-manifest.json'), 'utf8')) as { assets: { path: string; sha256: string; bytes: number }[] };
      const entry = manifest.assets.find((asset) => asset.path === path);
      expect(entry?.bytes).toBe(bytes.byteLength);
      expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

      const scene = gltf.scene;
      const body = scene.getObjectByName('body');
      expect(body).toBeTruthy();
      for (const light of ['brake-lights', 'reverse-lights']) expect(body!.getObjectByName(light)).toBeTruthy();
      const config = VEHICLE_CONFIGS[carId];
      for (const [id, sx, sz] of [['wheel-fl', -1, -1], ['wheel-fr', 1, -1], ['wheel-rl', -1, 1], ['wheel-rr', 1, 1]] as const) {
        const anchor = scene.getObjectByName(id)!;
        expect(anchor).toBeTruthy();
        expect(anchor.position.x).toBeCloseTo(sx * config.trackM / 2, 3);
        expect(anchor.position.y).toBeCloseTo(WHEEL_ANCHOR_Y, 3);
        expect(anchor.position.z).toBeCloseTo(sz * config.wheelbaseM / 2, 3);
        const tyre = new THREE.Box3().setFromObject(anchor.getObjectByName(`tire-${id}`)!);
        const size = tyre.getSize(new THREE.Vector3());
        expect(size.y / 2).toBeCloseTo(config.wheelRadiusM, 1);
      }
      const materials = new Map<string, THREE.MeshStandardMaterial>();
      scene.traverse((node) => { if (node instanceof THREE.Mesh) for (const m of [node.material].flat()) materials.set(m.name, m as THREE.MeshStandardMaterial); });
      for (const name of ['paint', 'glass', 'rubber', 'rubber-sidewall', 'rim', 'brake-emissive', 'reverse-emissive']) expect(materials.has(name)).toBe(true);
      expect(materials.get('glass')!.transparent).toBe(true);
      expect(materials.get('glass')!.opacity).toBeGreaterThan(.3);
      expect(materials.get('reverse-emissive')!.emissive.getHex()).toBe(0xffffff);
      const tris = triangles(scene, altWheel);
      expect(tris).toBeLessThan(maxTris);

      const car = createCarPresentation(scene, carId);
      expect(car.body.getObjectByName('brake-lights')!.visible).toBe(false);
      car.setLights?.({ braking: 1, reversing: true });
      expect(car.body.getObjectByName('brake-lights')!.visible).toBe(true);
      expect(car.body.getObjectByName('reverse-lights')!.visible).toBe(true);
      car.setCosmetics({ paint: 'signal-amber', wheelStyle: 'steel', livery: 'stock' });
      expect(materials.get('paint')!.color.getHexString()).toBe('d08a32');
      for (const wheel of car.wheels) {
        const visible = wheel.children.filter((child) => child.name.startsWith('wheel-style-') && child.visible).map((child) => child.name);
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatch(/^wheel-style-steel/);
      }
      car.dispose();
    });
  }

  // The McLaren ships WebP textures (EXT_texture_webp), which GLTFLoader cannot decode under Node, so this checks the GLB
  // structure directly: anchors on the physics dimensions, separate tyre nodes, lights, the textured 'paint' slot and budgets.
  it('mclaren-f1.glb (CAR-04): anchors, separate wheels, lights, textured paint, budget and manifest', async () => {
    expect(CAR_ASSETS['CAR-04'].file).toBe('mclaren-f1.glb');
    const path = 'public/assets/cars/mclaren-f1.glb';
    const bytes = await readFile(resolve(root, path));
    expect(bytes.byteLength).toBeLessThan(6_000_000);
    const manifest = JSON.parse(await readFile(resolve(root, 'public/assets/asset-manifest.json'), 'utf8')) as { assets: { path: string; sha256: string; bytes: number }[] };
    const entry = manifest.assets.find((asset) => asset.path === path);
    expect(entry?.bytes).toBe(bytes.byteLength);
    expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; mesh?: number; children?: number[]; translation?: number[] }[];
      meshes: { primitives: { indices?: number; attributes: Record<string, number>; material?: number }[] }[];
      accessors: { count: number }[]; materials: { name: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
      images: { mimeType: string }[];
    };
    const node = (name: string) => json.nodes.find((n) => n.name === name);
    const config = VEHICLE_CONFIGS['CAR-04'];
    const body = node('body')!;
    for (const light of ['brake-lights', 'reverse-lights']) expect(body.children!.map((i) => json.nodes[i]!.name)).toContain(light);
    for (const [id, sx, sz] of [['wheel-fl', -1, -1], ['wheel-fr', 1, -1], ['wheel-rl', -1, 1], ['wheel-rr', 1, 1]] as const) {
      const anchor = node(id)!;
      const [x, y, z] = anchor.translation!;
      expect(x).toBeCloseTo(sx * config.trackM / 2, 3);
      expect(y).toBeCloseTo(WHEEL_ANCHOR_Y, 3);
      expect(z).toBeCloseTo(sz * config.wheelbaseM / 2, 3);
      expect(anchor.children!.map((i) => json.nodes[i]!.name)).toContain(`tire-${id}`);
    }
    const paint = json.materials.find((m) => m.name === 'paint');
    expect(paint?.pbrMetallicRoughness?.baseColorTexture).toBeTruthy();
    expect(json.materials.map((m) => m.name)).toContain('f1-wheel');
    expect(json.images.every((image) => image.mimeType === 'image/webp')).toBe(true);
    let tris = 0;
    for (const n of json.nodes) if (n.mesh !== undefined) for (const p of json.meshes[n.mesh]!.primitives) tris += json.accessors[p.indices ?? p.attributes.POSITION!]!.count / 3;
    expect(tris).toBeLessThan(120_000);
  });

  // Like the McLaren, the Lancia ships WebP textures (its Martini livery), so the GLB structure is checked directly.
  it('lancia-delta.glb (CAR-05): anchors, separate wheels, lights, flat paint plus textured livery panels, budget and manifest', async () => {
    expect(CAR_ASSETS['CAR-05'].file).toBe('lancia-delta.glb');
    const path = 'public/assets/cars/lancia-delta.glb';
    const bytes = await readFile(resolve(root, path));
    expect(bytes.byteLength).toBeLessThan(4_000_000);
    const manifest = JSON.parse(await readFile(resolve(root, 'public/assets/asset-manifest.json'), 'utf8')) as { assets: { path: string; sha256: string; bytes: number }[] };
    const entry = manifest.assets.find((asset) => asset.path === path);
    expect(entry?.bytes).toBe(bytes.byteLength);
    expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; mesh?: number; children?: number[]; translation?: number[] }[];
      meshes: { primitives: { indices?: number; attributes: Record<string, number>; material?: number }[] }[];
      accessors: { count: number }[]; materials: { name: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
      images: { mimeType: string }[];
    };
    const node = (name: string) => json.nodes.find((n) => n.name === name);
    const config = VEHICLE_CONFIGS['CAR-05'];
    const body = node('body')!;
    for (const light of ['brake-lights', 'reverse-lights']) expect(body.children!.map((i) => json.nodes[i]!.name)).toContain(light);
    for (const [id, sx, sz] of [['wheel-fl', -1, -1], ['wheel-fr', 1, -1], ['wheel-rl', -1, 1], ['wheel-rr', 1, 1]] as const) {
      const anchor = node(id)!;
      const [x, y, z] = anchor.translation!;
      expect(x).toBeCloseTo(sx * config.trackM / 2, 3);
      expect(y).toBeCloseTo(WHEEL_ANCHOR_Y, 3);
      expect(z).toBeCloseTo(sz * config.wheelbaseM / 2, 3);
      expect(anchor.children!.map((i) => json.nodes[i]!.name)).toContain(`tire-${id}`);
    }
    // 'paint' is a flat colour (the respray slot); the livery lives on textured paint-livery* panels that carry UVs.
    expect(json.materials.find((m) => m.name === 'paint')?.pbrMetallicRoughness?.baseColorTexture).toBeFalsy();
    const livery = json.materials.map((m, i) => ({ m, i })).filter(({ m }) => m.name.startsWith('paint-livery'));
    expect(livery.length).toBeGreaterThanOrEqual(3);
    for (const { m } of livery) expect(m.pbrMetallicRoughness?.baseColorTexture).toBeTruthy();
    const liveryPrims = json.meshes.flatMap((mesh) => mesh.primitives).filter((p) => livery.some(({ i }) => i === p.material));
    expect(liveryPrims.length).toBeGreaterThan(0);
    for (const p of liveryPrims) expect(p.attributes.TEXCOORD_0).toBeDefined();
    expect(json.images.every((image) => image.mimeType === 'image/webp')).toBe(true);
    let tris = 0;
    for (const n of json.nodes) if (n.mesh !== undefined && !altWheel(n.name)) for (const p of json.meshes[n.mesh]!.primitives) tris += json.accessors[p.indices ?? p.attributes.POSITION!]!.count / 3;
    expect(tris).toBeLessThan(120_000);
  });

  it('livery panels: the stock paint shows the factory livery, any other paint resprays the panels, and stock brings it back', () => {
    const map = new THREE.Texture();
    const paint = new THREE.MeshStandardMaterial({ name: 'paint', color: '#f0f0ea' });
    const panel = new THREE.MeshStandardMaterial({ name: 'paint-livery-pintu', map, color: '#ffffff' });
    const root = new THREE.Group();
    const body = new THREE.Group(); body.name = 'body'; root.add(body);
    body.add(new THREE.Mesh(new THREE.BoxGeometry(), [paint, panel]));
    for (const id of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) { const wheel = new THREE.Group(); wheel.name = id; root.add(wheel); }
    const car = createCarPresentation(root, 'CAR-05');
    expect(panel.map).toBe(map);
    expect(paint.color.getHexString()).toBe('f0f0ea');
    car.setCosmetics({ paint: 'signal-amber', wheelStyle: 'forged', livery: 'stock' });
    expect(panel.map).toBeNull();
    expect(panel.color.getHexString()).toBe('d08a32');
    expect(paint.color.getHexString()).toBe('d08a32');
    car.setCosmetics({ paint: 'harbor-slate', wheelStyle: 'forged', livery: 'stock' });
    expect(panel.map).toBe(map);
    expect(panel.color.getHexString()).toBe('ffffff');
    expect(paint.color.getHexString()).toBe('f0f0ea');
    car.dispose();
  });

  it('CAR-01 stays near the 100k triangle performance target; every car id has an asset', async () => {
    const { gltf } = await load('public/assets/cars/challenger.glb');
    expect(triangles(gltf.scene, altWheel)).toBeLessThan(120_000);
    expect(Object.keys(CAR_ASSETS).sort()).toEqual(['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06']);
  });
});
