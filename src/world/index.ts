import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TextureLoader } from 'three';
import type { CarId } from '../../contracts/runtime-contracts';
import { buildHarborApronCollision, buildHarborCurbCollisions, buildHarborGuardrailCollisions, buildHarborRoute, buildHarborWaterCollision } from './route-data';
import { buildRidgePass } from './ridge-pass';
import { buildCoastInterchange } from './coast-interchange';
import type { CarPresentation, SceneCosmeticsCatalog, WorldPresentation } from '../scene-pipeline/ports';
import { applyCarPaint, getCarPaint, registerCarPaint, type CarPaintFinish, type CarPaintPreset } from '../render/car-paint';
import { decodeLoadout } from '../economy/catalog';
import { applyCarCosmetics, disposeCarCosmetics } from '../economy/car-cosmetics';

const loader = new GLTFLoader();
const textureLoader = new TextureLoader();
const assetBase = (): string => import.meta.env.BASE_URL;
const disposeRoot = (root: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      if (material instanceof THREE.MeshStandardMaterial && material.map) textures.add(material.map);
    }
  });
  geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose()); textures.forEach((texture)=>texture.dispose());
};

async function loadHarborTextures():Promise<Readonly<Record<string,THREE.Texture>>> {
  const names=['harbor-asphalt','harbor-concrete','harbor-curb','harbor-steel','harbor-shed-paint'] as const;
  const loaded=await Promise.allSettled(names.map(async name=>{
    const texture=await textureLoader.loadAsync(`${assetBase()}assets/materials/${name}.png`);
    texture.colorSpace=THREE.SRGBColorSpace; texture.wrapS=THREE.RepeatWrapping; texture.wrapT=THREE.RepeatWrapping;
    texture.magFilter=THREE.LinearFilter; texture.minFilter=THREE.LinearMipmapLinearFilter; texture.anisotropy=4;
    return [name,texture] as const;
  }));
  const failed=loaded.find(result=>result.status==='rejected');
  if(failed?.status==='rejected'){
    for(const result of loaded)if(result.status==='fulfilled')result.value[1].dispose();
    throw failed.reason;
  }
  return Object.fromEntries(loaded.flatMap(result=>result.status==='fulfilled'?[result.value]:[]));
}

export function applyHarborTextureMaps(root:THREE.Object3D,textures:Readonly<Record<string,THREE.Texture>>):void {
  const slots:Readonly<Record<string,string>>={
    'road-asphalt':'harbor-asphalt','asphalt-repair':'harbor-asphalt','asphalt-damp':'harbor-asphalt',
    'concrete-weathered':'harbor-concrete','curb-painted-concrete':'harbor-curb',
    'steel-oxidized':'harbor-steel','loading-door':'harbor-concrete','shed-deep-teal':'harbor-shed-paint',
  };
  root.traverse(node=>{
    if(!(node instanceof THREE.Mesh))return;
    for(const material of (Array.isArray(node.material)?node.material:[node.material])){
      const key=slots[material.name],texture=key?textures[key]:undefined;
      if(texture&&material instanceof THREE.MeshStandardMaterial){material.color.set('#ffffff');material.map=texture;material.needsUpdate=true;}
    }
  });
}

/** Neutral linear vertex modulation for the concrete albedo map on the apron. */
export function apronVertexTint(x:number,z:number):number {
  const broad=Math.sin(x*.052+Math.sin(z*.031))*Math.cos(z*.069-x*.019);
  const aggregate=Math.sin(x*.19+z*.11)*Math.cos(z*.17-x*.08);
  return .88+(broad+1)*.045+(aggregate+1)*.035;
}

/** Apply original local Harbor maps to a later-composed scene group; caller owns the disposer. */
export async function applyHarborSourceTextures(root:THREE.Object3D):Promise<()=>void> {
  const textures=await loadHarborTextures();
  applyHarborTextureMaps(root,textures);
  return ()=>Object.values(textures).forEach(texture=>texture.dispose());
}

function configureWorldShadows(root: THREE.Object3D): void {
  const cameraCollisionNames=new Set([
    'loading-shed-main','loading-shed-roof','east-quay-machine-hall','east-quay-machine-hall-roof',
    'salt-tank-0','salt-tank-1','salt-tank-2',
  ]);
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const names = (Array.isArray(node.material) ? node.material : [node.material]).map((material) => material.name);
    const water = names.includes('harbor-water');
    const road = names.includes('road-asphalt') || names.includes('asphalt-repair') || names.includes('asphalt-damp');
    node.castShadow = !water && !road;
    node.receiveShadow = !water;
    node.userData.cameraCollision=cameraCollisionNames.has(node.name);
  });
}

export function isHarborCameraCollisionProp(name:string):boolean {
  return new Set(['loading-shed-main','loading-shed-roof','east-quay-machine-hall','east-quay-machine-hall-roof','salt-tank-0','salt-tank-1','salt-tank-2']).has(name);
}

function configureCarShadows(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const glass = materials.some((material) => material.name === 'glass');
    const silhouetteCaster = node.name === 'arc-s-profile-shell' || node.name === 'vela-gt-profile-shell' || node.name === 'profile-front-closure'
      || node.name === 'profile-rear-closure' || node.name === 'liftback-roof'
      || node.name === 'vela-roof-panel'
      || node.name === 'tire-sidewall' || node.name === 'rear-bumper-fascia' || node.name === 'rear-diffuser'
      || node.name === 'front-splitter';
    // Owner-model cars: shell and tyres cast; lamps, glass and alternate wheel styles do not.
    const ownerCaster = node.name.startsWith('body-shell') || node.name.startsWith('tire-wheel-');
    node.castShadow = !glass && (silhouetteCaster || ownerCaster);
    node.receiveShadow = true;
  });
}

const PAINTS = [
  { id: 'harbor-slate', name: 'Harbor Slate', color: '#435e69' }, { id: 'oxide-copper', name: 'Oxide Copper', color: '#a85e43' },
  { id: 'salt-white', name: 'Salt White', color: '#d4d2c7' }, { id: 'deep-tide', name: 'Deep Tide', color: '#25434b' },
  { id: 'signal-amber', name: 'Signal Amber', color: '#d08a32' }, { id: 'kelp-green', name: 'Kelp Green', color: '#496750' },
  { id: 'storm-blue', name: 'Storm Blue', color: '#465a79' }, { id: 'carbon', name: 'Carbon', color: '#25292a' },
] as const;
// Stock paints are solid gloss over clearcoat (matching the economy catalogue); shop paints register their own presets.
for (const paint of PAINTS) registerCarPaint(paint.id, { color: paint.color, finish: 'gloss' }, paint.name);
/** Factory finish per car: the GLB colour is kept, the finish decides clearcoat, flake and flip. */
const FACTORY_FINISH: Readonly<Record<CarId, CarPaintFinish>> = { 'CAR-01': 'metallic', 'CAR-02': 'satin', 'CAR-04': 'gloss', 'CAR-05': 'gloss', 'CAR-06': 'gloss' };
/**
 * CAR-02's 'paint' is the stainless body (its arch and sill cladding is a separate, never painted 'cladding' slot in black
 * satin plastic). The stock paint keeps the raw stainless from the GLB: same colour, brushed metal, no clearcoat, flake or flip.
 */
const car02StockStainless = (color: string): CarPaintPreset => ({ color, secondary: color, finish: 'satin', metalness: 0.9, roughness: 0.35, clearcoat: 0, flake: 0, flip: 0 });
/** CAR-04's 'paint' carries the textured factory livery atlas, shown untinted for every paint choice. */
const CAR04_STOCK_LIVERY: CarPaintPreset = { color: '#ffffff', finish: 'gloss', roughness: 1, metalness: 1 };
/**
 * Textured livery panels (materials named paint-livery*, e.g. CAR-05's Martini stripes): the stock paint shows the
 * livery untinted; any other paint resprays them like the rest of the body (texture off, same colour and finish).
 */
function applyLiveryPanels(body: THREE.Object3D, respray: CarPaintPreset | null): void {
  body.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial) || !material.name.startsWith('paint-livery')) continue;
      const stock = (material.userData.l3LiveryStock ??= { map: material.map, color: material.color.clone(), roughness: material.roughness, metalness: material.metalness }) as
        { map: THREE.Texture | null; color: THREE.Color; roughness: number; metalness: number };
      const map = respray ? null : stock.map;
      if (material.map !== map) { material.map = map; material.needsUpdate = true; }
      if (respray) applyCarPaint(node, respray, material.name);
      else { material.color.copy(stock.color); material.roughness = stock.roughness; material.metalness = stock.metalness; }
    }
  });
}
const CATALOG: SceneCosmeticsCatalog = {
  paints: PAINTS.map(({ id, name }) => ({ id, name })),
  wheelStyles: [{ id: 'forged', name: 'Forged Five' }, { id: 'mesh', name: 'Harbor Mesh' }, { id: 'steel', name: 'Workshop Steel' }],
  liveries: [{ id: 'stock', name: 'Stock' }, { id: 'salt-line', name: 'Salt Line' }, { id: 'copper-rocker', name: 'Copper Rocker' }, { id: 'harbor-wave', name: 'Harbor Wave' }],
};

export async function loadHeroWorld(): Promise<WorldPresentation> {
  const [gltfResult,textureResult] = await Promise.allSettled([
    loader.loadAsync(`${assetBase()}assets/world/harbor-works.glb`),loadHarborTextures(),
  ]);
  if(gltfResult.status==='rejected'||textureResult.status==='rejected'){
    if(gltfResult.status==='fulfilled')disposeRoot(gltfResult.value.scene);
    if(textureResult.status==='fulfilled')Object.values(textureResult.value).forEach(texture=>texture.dispose());
    throw gltfResult.status==='rejected'?gltfResult.reason:textureResult.status==='rejected'?textureResult.reason:new Error('Harbor load failed');
  }
  const gltf=gltfResult.value,textures=textureResult.value;
  const root = gltf.scene;
  applyHarborTextureMaps(root,textures);
  configureWorldShadows(root);
  const { route, collision } = buildHarborRoute();
  const apronRoot = new THREE.Group(); apronRoot.name = 'harbor-ground'; root.add(apronRoot);
  const groundTexture=textures['harbor-concrete']!.clone(); groundTexture.repeat.set(1,1);
  const groundMaterial = new THREE.MeshStandardMaterial({ name:'concrete-weathered', color: '#ffffff', roughness: .97, vertexColors: true, map:groundTexture });
  const tiles = [
    { name:'west-yard', minX:-300, maxX:137, minZ:-240, maxZ:240, sx:58, sz:64 },
    { name:'east-yard', minX:229, maxX:300, minZ:-240, maxZ:240, sx:12, sz:64 },
    { name:'near-quay', minX:137, maxX:229, minZ:-240, maxZ:32, sx:20, sz:36 },
    { name:'far-quay', minX:137, maxX:229, minZ:104, maxZ:240, sx:20, sz:36 },
  ];
  for (const tile of tiles) {
    const width=tile.maxX-tile.minX, depth=tile.maxZ-tile.minZ, centerX=(tile.minX+tile.maxX)/2, centerZ=(tile.minZ+tile.maxZ)/2;
    const geometry = new THREE.PlaneGeometry(width, depth, tile.sx, tile.sz);
    const colors: number[] = [], positions = geometry.getAttribute('position');
    const uv=geometry.getAttribute('uv');
    for (let i=0;i<positions.count;i++) {
      const x=centerX+positions.getX(i), z=centerZ-positions.getY(i);
      uv.setXY(i,x/3,z/3);
      const tint=apronVertexTint(x,z);
      colors.push(tint,tint,tint);
    }
    uv.needsUpdate=true;
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    const mesh=new THREE.Mesh(geometry,groundMaterial); mesh.name=`apron-${tile.name}`;
    mesh.rotation.x=-Math.PI/2; mesh.position.set(centerX,-.62,centerZ); mesh.receiveShadow=true; apronRoot.add(mesh);
  }
  // Yard apron gives the car a recovery area at the start/finish crossover.
  // Other districts share this one world, far from the harbour (see ridge-pass.ts); their scenery is built by the scene pipeline.
  const ridge = buildRidgePass();
  const coast = buildCoastInterchange();
  return { root, routes: [route, ridge.ribbon.route, coast.ribbon.route], collisionMeshes: [collision, buildHarborApronCollision(), buildHarborWaterCollision(), ...buildHarborCurbCollisions(), ...buildHarborGuardrailCollisions(), ...ridge.collisionMeshes, ...coast.collisionMeshes], spawn: route.spawn, dispose: () => disposeRoot(root) };
}

/** Active car assets (owner models, built by /root/mkcar.py and /root/mkf1.py on nc2; anchors at y=-0.36). */
export const CAR_ASSETS: Readonly<Record<CarId, { file: string; fit?: { scale: number; sourceWheelY: number } }>> = {
  'CAR-01': { file: 'challenger.glb' },
  'CAR-02': { file: 'cybertruck.glb' },
  'CAR-04': { file: 'mclaren-f1.glb' },
  'CAR-05': { file: 'lancia-delta.glb' },
  'CAR-06': { file: 'agera.glb' },
};
export const WHEEL_ANCHOR_Y = -0.36;

/** Uniformly scale a car's top-level nodes and drop them so the wheel anchors land on WHEEL_ANCHOR_Y. */
export function fitCarRoot(root: THREE.Object3D, scale: number, sourceWheelY: number): void {
  const offsetY = WHEEL_ANCHOR_Y - sourceWheelY * scale;
  const top = root.getObjectByName('body')?.parent?.children ?? root.children;   // body + wheel anchors share one parent
  for (const node of [...top]) { node.position.multiplyScalar(scale); node.position.y += offsetY; node.scale.multiplyScalar(scale); }
}

/** Blender/GLTFLoader suffix duplicate names (wheel-style-forged.001 -> wheel-style-forged001); compare on the base name. */
const wheelStyleOf = (name: string): string | undefined => /^(wheel-style-(?:forged|mesh|steel))/.exec(name)?.[1];

export async function loadCarModel(carId: CarId): Promise<CarPresentation> {
  const asset = CAR_ASSETS[carId];
  const gltf = await loader.loadAsync(`${assetBase()}assets/cars/${asset.file}`);
  if (asset.fit) fitCarRoot(gltf.scene, asset.fit.scale, asset.fit.sourceWheelY);
  return createCarPresentation(gltf.scene, carId);
}

/** Bind a validated, loaded car scene to the world-v1 presentation API. */
export function createCarPresentation(root: THREE.Group, carId: CarId): CarPresentation {
  configureCarShadows(root);
  const body = root.getObjectByName('body') as THREE.Group | null;
  const wheels = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'].map((name) => root.getObjectByName(name) as THREE.Group | null);
  if (!body || wheels.some((wheel) => !wheel)) { disposeRoot(root); throw new Error(`${carId} GLB is missing body or wheel anchors`); }
  const wheelGroups = wheels as [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
  // Rest pose relative to the body (anchors and body share a parent): used until the sim drives the wheels, never (0,0,0).
  body.updateMatrix();
  for (const wheel of wheelGroups) {
    wheel.userData.restPosition = wheel.position.clone().sub(body.position).applyQuaternion(body.quaternion.clone().invert());
    wheel.position.copy(wheel.userData.restPosition as THREE.Vector3);
  }
  const brakes = body.getObjectByName('brake-lights');
  const reverse = body.getObjectByName('reverse-lights');
  const liveryGroup = body.getObjectByName('livery-panels');
  if (brakes) brakes.visible = false;
  if (reverse) reverse.visible = false;
  if (liveryGroup) for (const child of liveryGroup.children) child.visible = false;
  for (const wheel of wheels) if (wheel) for (const group of wheel.children) {
    if (wheelStyleOf(group.name)) group.visible = wheelStyleOf(group.name) === 'wheel-style-forged';
  }
  let factoryColor: string | null = null;
  body.traverse((node) => {
    if (factoryColor || !(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material.name === 'paint' && material instanceof THREE.MeshStandardMaterial) factoryColor = `#${material.color.getHexString()}`;
    }
  });
  const stainlessStock: CarPaintPreset | null = carId === 'CAR-02' && factoryColor ? car02StockStainless(factoryColor) : null;
  if (factoryColor) applyCarPaint(body, carId === 'CAR-04' ? CAR04_STOCK_LIVERY : stainlessStock ?? { color: factoryColor, finish: FACTORY_FINISH[carId] });
  let hasLiveryPanels = false;
  body.traverse((node) => {
    if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) if (m.name.startsWith('paint-livery')) hasLiveryPanels = true;
  });
  // Livery cars (paint-livery panels) keep their factory colour and livery on the stock paint.
  const liveryFactory: CarPaintPreset | null = hasLiveryPanels && factoryColor ? { color: factoryColor, finish: FACTORY_FINISH[carId] } : null;
  if (hasLiveryPanels) applyLiveryPanels(body, null);
  let paintId: string = PAINTS[0].id, liveryId = 'stock';
  return {
    body, wheels: wheelGroups, cosmeticsCatalog: CATALOG,
    setCosmetics({ paint: wirePaint, wheelStyle: baseWheelStyle, livery }): void {
      // Shop loadout ("~..." from src/economy): premium slots render in applyCarCosmetics; stock paint and wheel style stay below.
      const loadout = wirePaint?.startsWith('~') ? decodeLoadout(wirePaint) : null;
      const paint = loadout ? loadout.paint : wirePaint, wheelStyle = loadout?.wheelStyle ?? baseWheelStyle;
      applyCarCosmetics({ body, wheels: wheelGroups, carId }, loadout ?? {});
      // Any registered paint id (stock palette or a shop preset) resolves; unknown ids keep the current paint.
      if (paint !== undefined && getCarPaint(paint)) paintId = paint;
      // CAR-04 always shows its textured livery: a colour on that atlas would tint the tyres, logos and red panels too.
      const preset = carId === 'CAR-04' ? CAR04_STOCK_LIVERY
        : paintId === PAINTS[0].id && stainlessStock ? stainlessStock
        : paintId === PAINTS[0].id && liveryFactory ? liveryFactory : getCarPaint(paintId);
      if (preset) applyCarPaint(body, preset);
      if (liveryFactory && preset) applyLiveryPanels(body, preset === liveryFactory ? null : preset);
      const wheelName = wheelStyle === 'mesh' ? 'wheel-style-mesh' : wheelStyle === 'steel' ? 'wheel-style-steel' : 'wheel-style-forged';
      for (const wheel of wheelGroups) for (const group of wheel.children) if (wheelStyleOf(group.name)) group.visible = wheelStyleOf(group.name) === wheelName;
      const selectedLivery = livery && CATALOG.liveries.some((item) => item.id === livery) ? livery : liveryId;
      liveryId = selectedLivery;
      if (liveryGroup) {
        const liveryName = carId === 'CAR-01'
          ? ({ 'salt-line': 'offset-center-stripe', 'copper-rocker': 'copper-rocker-accent', 'harbor-wave': 'harbor-wave-rocker' } as Record<string, string>)[selectedLivery]
          : selectedLivery;
        for (const child of liveryGroup.children) child.visible = child.name === liveryName;
      }
    },
    setLights({ braking, reversing }): void {
      if (brakes) brakes.visible = braking > 0.05;
      if (reverse) reverse.visible = reversing;
    },
    dispose: () => { disposeCarCosmetics(body); disposeRoot(root); },
  };
}

/** Exposed for deterministic build-time export and focused source validation. */
export const source = { buildRoute: buildHarborRoute, buildApron: buildHarborApronCollision, buildWater: buildHarborWaterCollision,
  buildCurbs: buildHarborCurbCollisions, buildGuardrails: buildHarborGuardrailCollisions };
