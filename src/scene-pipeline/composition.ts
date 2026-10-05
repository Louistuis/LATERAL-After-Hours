import * as THREE from 'three';
import type {
  CarId, FrameSnapshot, LightingPreset, QualityPreset, RouteId, VehicleSnapshot,
} from '../../contracts/runtime-contracts';
import { ChaseCamera } from './chase-camera';
import { VehicleInterpolator } from './interpolate';
import type {
  CarPresentation, SceneAssetFactory, SceneCosmetics, SceneCosmeticsCatalog, WorldPresentation,
} from './ports';
import { RouteMarkers } from './route-markers';
import { createRenderStage, type SceneRenderStats } from './stage';
import { createTireEffects, type TireEffectsStats } from '../vfx';
import { applySceneMaterialProfile, createRenderPassCensus, createShadowBudgetPolicy, setCarPaintQuality, setWetSurfaceQuality, type RenderPassCensusFrame } from '../render';
import type { PostScatterInput } from '../render/post-fx';
import { mergeStaticMeshes } from '../render/static-merge';
import { createHarborDressing } from './harbor-dressing';
import { atmosphereFor } from './atmosphere';
import { createDistrictSceneries, findSharedMaterials, type DistrictScenery } from './districts';
import type { DistrictId, RouteDefinition } from '../../contracts/world-contracts';
import { createNightLights } from './night-lights';
import { collectCameraOccluders } from './camera-occluders';
import { attachContactShadow, createContactShadow } from './contact-shadow';
import { ghostPart } from './ghost-mesh';

export type { SceneCosmetics, SceneCosmeticsCatalog, WorldPresentation, CarPresentation, SceneAssetFactory } from './ports';
export type { SceneRenderStats } from './stage';
export type ScenePipelineStats = SceneRenderStats & TireEffectsStats;

export interface ScenePipelineOptions {
  readonly quality?: QualityPreset;
  readonly lighting?: LightingPreset;
  readonly carId?: CarId;
}

export interface ScenePipeline {
  readonly world: WorldPresentation;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Static, authored scenery candidates for L5 camera occlusion; visibility remains dynamic. */
  readonly cameraOccluders: readonly THREE.Object3D[];
  readonly cosmeticsCatalog: SceneCosmeticsCatalog | undefined;
  readonly lastStats: ScenePipelineStats;
  /** Last explicitly requested owner-review pass sample; never collected during ordinary frames. */
  readonly lastPassCensus: RenderPassCensusFrame | null;
  /** Live WebGL state; lastStats remains the most recent rendered-frame snapshot. */
  readonly currentContextState: SceneRenderStats['contextState'];
  render(frame: FrameSnapshot, dtSeconds: number, options?: {
    cameraManagedExternally?: boolean;
    brakePressed?: number;
    simulationActive?: boolean;
  }): ScenePipelineStats;
  /** Arms one ordinary next render in owner-review builds only. */
  requestPassCensus(): void;
  resize(widthPx: number, heightPx: number, pixelRatio?: number): void;
  resetCamera(): void;
  setLighting(preset: LightingPreset): void;
  setQuality(preset: QualityPreset): void;
  setCar(carId: CarId): Promise<void>;
  setCosmetics(cosmetics: SceneCosmetics): void;
  setRoute(routeId: RouteId | null): void;
  setGhost(snapshot: VehicleSnapshot | null): void;
  /** Loads an extra, independent car model (online players). The caller adds, removes and disposes it. */
  loadCarModel(carId: CarId): Promise<CarPresentation>;
  /** Links every scene program in the background; await before the first frame to skip the synchronous compile stall. */
  precompile?(): Promise<void>;
  /** Auto-quality dynamic resolution (0.6 to 1 of the tier's pixel ratio). */
  setResolutionScale?(scale: number): void;
  /** WebGL renderer string, for the Auto starting tier. */
  readonly gpuRenderer?: string;
  dispose(): void;
}

interface GhostVisual {
  readonly body: THREE.Object3D;
  readonly wheels: readonly THREE.Object3D[];
}

function setPosition(target: THREE.Vector3, source: Readonly<{ x: number; y: number; z: number }>): void {
  target.set(source.x, source.y, source.z);
}
function setRotation(target: THREE.Quaternion, source: Readonly<{ x: number; y: number; z: number; w: number }>): void {
  target.set(source.x, source.y, source.z, source.w).normalize();
}

/** Joins authored world, car, camera, and renderer around a read-only physics frame. */
export async function createScenePipelineWithAssets(
  canvas: HTMLCanvasElement,
  assets: SceneAssetFactory,
  options: ScenePipelineOptions = {},
): Promise<ScenePipeline> {
  const stage = createRenderStage(canvas, options.quality ?? 'balanced', options.lighting ?? 'golden-hour');
  let world: WorldPresentation | undefined;
  let car: CarPresentation | undefined;
  try {
    world = await assets.loadHeroWorld();
    car = await assets.loadCarModel(options.carId ?? 'CAR-01');
  } catch (error) {
    world?.dispose();
    stage.dispose();
    throw error;
  }
  const loadedWorld = world;
  let activeCar = car;
  applySceneMaterialProfile(loadedWorld.root);
  const harborRoute = loadedWorld.routes.find((candidate) => candidate.id === 'HW-01');
  let harborDressing: ReturnType<typeof createHarborDressing> | null = null;
  // Procedural districts (Ridge Pass, ...) share this world far from the harbour; only the active one is visible.
  let sceneries: DistrictScenery[] = [];
  try {
    harborDressing = harborRoute ? createHarborDressing(harborRoute) : null;
    if (harborDressing) applySceneMaterialProfile(harborDressing.root);
    sceneries = createDistrictSceneries(loadedWorld, findSharedMaterials(loadedWorld.root));
  } catch (error) {
    harborDressing?.dispose();
    activeCar.dispose();
    loadedWorld.dispose();
    stage.dispose();
    throw error;
  }
  applyCarMaterials(activeCar);
  const routeMarkers = new RouteMarkers();
  const tireEffects = createTireEffects(stage.scene, options.quality ?? 'balanced');
  // Real lights (nearest lamps + headlights) sit in a fixed pool so shaders never recompile mid-drive.
  const nightLights = createNightLights();
  stage.scene.add(nightLights.root);
  let clockSeconds = 0;
  let activeDistrict: DistrictId = 'harbor';
  let activeRoute: RouteDefinition | null = null;
  const applyAtmosphere = (preset: LightingPreset): void => {
    const recipe = atmosphereFor(activeDistrict, preset);
    nightLights.setAtmosphere(recipe);
    harborDressing?.setAtmosphere(atmosphereFor('harbor', preset));
    for (const scenery of sceneries) scenery.setAtmosphere(atmosphereFor(scenery.district, preset));
    tireEffects.setAtmosphere(recipe);
  };
  /** Practical lamps of the visible district feed the real-light pool and the air scatter. */
  const activeLamps = (): readonly THREE.Vector3[] => activeDistrict === 'harbor'
    ? harborDressing?.lampPositions ?? []
    : sceneries.find((scenery) => scenery.district === activeDistrict)?.lampPositions ?? [];
  nightLights.setQuality(options.quality ?? 'balanced');
  setWetSurfaceQuality(options.quality ?? 'balanced');
  setCarPaintQuality(options.quality ?? 'balanced');
  let quality: QualityPreset = options.quality ?? 'balanced';
  let lighting: LightingPreset = options.lighting ?? 'golden-hour';
  const contactShadow = createContactShadow();
  stage.scene.add(contactShadow.mesh);
  let grounded = 1;
  let environmentPending = true;
  const scatterLamps: THREE.Vector3[] = [];
  const scatterHeads = [
    { position: new THREE.Vector3(), direction: new THREE.Vector3() },
    { position: new THREE.Vector3(), direction: new THREE.Vector3() },
  ];
  const scatter: PostScatterInput & { lampColor: THREE.Color; headlightColor: THREE.Color; density: number } = {
    lamps: scatterLamps, lampColor: new THREE.Color(), headlights: scatterHeads, headlightColor: new THREE.Color(),
    headlightCos: Math.cos(0.46), density: 0,
  };
  const headlightNodes = ['headlight-left', 'headlight-right']
    .map((name) => nightLights.root.getObjectByName(name))
    .filter((node): node is THREE.SpotLight => node instanceof THREE.SpotLight);
  const lampOrder: { index: number; distance: number }[] = [];
  applyAtmosphere(options.lighting ?? 'golden-hour');
  const interpolator = new VehicleInterpolator();
  const chaseCamera = new ChaseCamera(stage.camera);
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: '#83dce1', transparent: true, opacity: 0.28, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  let ghost: GhostVisual | null = null;
  let ghostSnapshot: VehicleSnapshot | null = null;
  let cosmetics: SceneCosmetics = {};
  let currentCarId = options.carId ?? 'CAR-01';
  let requestSerial = 0;
  let disposed = false;
  const ownerReview = typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__;
  let censusPending = false;
  let lastPassCensus: RenderPassCensusFrame | null = null;
  const clearCensus = (): void => { censusPending = false; lastPassCensus = null; };
  const onContextLost = (): void => clearCensus();
  if (ownerReview) canvas.addEventListener('webglcontextlost', onContextLost);
  let lastStats: ScenePipelineStats = {
    drawCallsAllPasses: 0, trianglesAllPasses: 0, geometries: 0, textures: 0,
    quality: options.quality ?? 'balanced', lighting: options.lighting ?? 'golden-hour',
    contextState: 'ready', visibleSmoke: 0, activeSkidSegments: 0,
  };
  stage.scene.add(loadedWorld.root, routeMarkers.root);
  if (harborDressing) stage.scene.add(harborDressing.root);
  const districtRoots = sceneries.map((scenery) => scenery.root);
  if (districtRoots.length) stage.scene.add(...districtRoots);
  const staticRoots = [...(harborDressing ? [loadedWorld.root, harborDressing.root] : [loadedWorld.root]), ...districtRoots];
  const passCensus = ownerReview ? createRenderPassCensus({ info: { render: { get calls(): number { return typeof stage.scenePassDrawCalls === 'function' ? stage.scenePassDrawCalls() : stage.renderer.info.render.calls; } } } }, stage.scene, {
    staticRoots, carRoots: [activeCar.body, ...activeCar.wheels],
  }) : null;
  const cameraOccluders = collectCameraOccluders(harborDressing
    ? [loadedWorld.root, harborDressing.root] : [loadedWorld.root]);
  // Balanced/high draw-call budget: fold repeated static props into one draw per material (occluders keep identity).
  const keepForOcclusion = new Set<THREE.Object3D>();
  for (const occluder of cameraOccluders) occluder.traverse((node) => keepForOcclusion.add(node));
  mergeStaticMeshes(loadedWorld.root, keepForOcclusion);
  if (harborDressing) mergeStaticMeshes(harborDressing.root, keepForOcclusion);
  for (const root of districtRoots) mergeStaticMeshes(root, keepForOcclusion);
  const shadowBudget = createShadowBudgetPolicy(staticRoots);
  /** Show one district's world, switch the sky/fog/light palette and re-probe the environment there. */
  function applyDistrict(district: DistrictId): void {
    activeDistrict = district;
    loadedWorld.root.visible = district === 'harbor';
    if (harborDressing) harborDressing.root.visible = district === 'harbor';
    for (const scenery of sceneries) scenery.root.visible = scenery.district === district;
    // Programs are normally linked by the boot warm-up; this is a no-op then, and a background link otherwise.
    const shown = sceneries.find((scenery) => scenery.district === district && district !== 'harbor');
    if (shown) void stage.precompile(shown.root).catch(() => undefined);
    stage.setDistrict?.(district);
    applyAtmosphere(lighting);
    environmentPending = true;
  }
  applyDistrict('harbor');
  for (const scenery of sceneries) scenery.setQuality?.(options.quality ?? 'balanced');
  shadowBudget.setQuality(options.quality ?? 'balanced');
  addCar(activeCar);
  contactShadow.fit(activeCar.body, activeCar.wheels);
  stage.resize(canvas.clientWidth || 1, canvas.clientHeight || 1,
    typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

  /** One-off PMREM of the real harbour from the spawn, with cars and effects hidden (cached per lighting). */
  function captureEnvironment(): void {
    environmentPending = false;
    if (stage.contextState() !== 'ready') return;
    const spawn = (activeRoute ?? loadedWorld).spawn.position;
    const hide: THREE.Object3D[] = [activeCar.body, ...activeCar.wheels, contactShadow.mesh, routeMarkers.root];
    if (ghost) hide.push(ghost.body, ...ghost.wheels);
    try {
      stage.captureEnvironment?.(new THREE.Vector3(spawn.x, spawn.y + 1.8, spawn.z), hide);
    } catch {
      // The synthetic sky probe stays in place.
    }
  }
  /** High/Ultra: nearest lamp heads to the camera and the two headlights feed the air in-scatter pass. */
  function updateScatter(): void {
    if (!stage.setScatter) return;
    if (quality !== 'high' && quality !== 'ultra') { stage.setScatter(null); return; }
    const recipe = atmosphereFor(activeDistrict, lighting);
    const lamps = activeLamps();
    const camera = stage.camera.position;
    lampOrder.length = 0;
    for (let i = 0; i < lamps.length; i++) lampOrder.push({ index: i, distance: lamps[i]!.distanceToSquared(camera) });
    lampOrder.sort((a, b) => a.distance - b.distance);
    scatterLamps.length = 0;
    for (const entry of lampOrder.slice(0, 8)) scatterLamps.push(lamps[entry.index]!);
    // Isotropic phase 1/(4 pi) folded into the colours; lamp candela matches night-lights.ts.
    scatter.lampColor.set(recipe.lampColor).multiplyScalar(300 * recipe.lampGlow / (4 * Math.PI));
    scatter.headlightColor.set('#ffe3b8').multiplyScalar(300 * recipe.headlightIntensity / (4 * Math.PI));
    scatter.density = recipe.fogDensity * 0.9;
    headlightNodes.forEach((light, index) => {
      const head = scatterHeads[index]!;
      head.position.copy(light.position);
      head.direction.subVectors(light.target.position, light.position).normalize();
    });
    stage.setScatter(scatter);
  }

  function addCar(presentation: CarPresentation): void {
    stage.scene.add(presentation.body, ...presentation.wheels);
  }
  function applyCarMaterials(presentation: CarPresentation): void {
    applySceneMaterialProfile(presentation.body);
    for (const wheel of presentation.wheels) applySceneMaterialProfile(wheel);
  }
  function removeCar(presentation: CarPresentation): void {
    stage.scene.remove(presentation.body, ...presentation.wheels);
    presentation.dispose();
  }
  function clearGhost(): void {
    if (!ghost) return;
    stage.scene.remove(ghost.body, ...ghost.wheels);
    for (const part of [ghost.body, ...ghost.wheels]) (part as THREE.Mesh).geometry?.dispose();
    ghost = null;
  }
  function makeGhost(): void {
    clearGhost();
    // One baked, thinned mesh per part (src/scene-pipeline/ghost-mesh.ts): 5 draw calls instead of a full car clone.
    const body = ghostPart(activeCar.body, ghostMaterial, 16_000);
    const wheels = activeCar.wheels.map((wheel) => ghostPart(wheel, ghostMaterial, 1_200));
    ghost = { body, wheels };
    stage.scene.add(body, ...wheels);
  }
  function applyGhost(snapshot: VehicleSnapshot): void {
    if (!ghost) makeGhost();
    setPosition(ghost!.body.position, snapshot.position);
    setRotation(ghost!.body.quaternion, snapshot.rotation);
    snapshot.wheels.forEach((wheel, index) => {
      setPosition(ghost!.wheels[index]!.position, wheel.position);
      setRotation(ghost!.wheels[index]!.quaternion, wheel.rotation);
    });
  }

  return {
    world: loadedWorld, scene: stage.scene, camera: stage.camera, renderer: stage.renderer, cameraOccluders,
    get cosmeticsCatalog() { return activeCar.cosmeticsCatalog; },
    get lastStats() { return lastStats; },
    get lastPassCensus() { return lastPassCensus; },
    get currentContextState() { return stage.contextState(); },
    async precompile(): Promise<void> {
      if (disposed) return;
      await stage.precompile();
      // Hidden districts are skipped by the renderer's visible-only compile walk, so their programs used to link
      // lazily as each part came into view (hitches on the first Ridge Pass / Neon Bay drive). Link them in the
      // background after boot: the compile walk is synchronous, so visibility is restored before any frame renders.
      if (!disposed) {
        const hidden = sceneries.filter((scenery) => !scenery.root.visible);
        hidden.forEach((scenery) => { scenery.root.visible = true; });
        let warming: Promise<void>;
        try { warming = stage.precompile(); } finally { hidden.forEach((scenery) => { scenery.root.visible = scenery.district === activeDistrict; }); }
        void warming.catch(() => undefined);
      }
      if (!disposed && environmentPending) captureEnvironment();
    },
    setResolutionScale(scale): void { stage.setResolutionScale?.(scale); },
    get gpuRenderer() { return stage.gpuRenderer; },
    requestPassCensus(): void {
      if (!ownerReview || disposed || stage.contextState() !== 'ready') return;
      lastPassCensus = null;
      censusPending = true;
    },
    render(frame, dtSeconds, renderOptions): ScenePipelineStats {
      if (disposed) throw new Error('ScenePipeline is disposed');
      const visual = interpolator.apply(frame);
      activeCar.body.position.copy(visual.position);
      activeCar.body.quaternion.copy(visual.rotation);
      for (let i = 0; i < 4; i++) {
        const wheel = activeCar.wheels[i], rest = wheel.userData.restPosition as THREE.Vector3 | undefined;
        // Menu/garage/showcase frames carry no wheel state (zeros): fall back to the GLB anchor rest pose on the body.
        if (rest && visual.wheels[i]!.position.distanceToSquared(visual.position) > 25) {
          wheel.position.copy(rest).applyQuaternion(visual.rotation).add(visual.position);
          wheel.quaternion.copy(visual.rotation);
        } else {
          wheel.position.copy(visual.wheels[i]!.position);
          wheel.quaternion.copy(visual.wheels[i]!.rotation);
        }
      }
      activeCar.setLights?.({
        braking: Math.max(0, Math.min(1, renderOptions?.brakePressed ?? 0)),
        reversing: frame.current.gear < 0,
      });
      if (!renderOptions?.cameraManagedExternally) chaseCamera.update(visual, dtSeconds);
      stage.focusShadows(visual.position);
      // Contact shadow: rest-pose frames (menus, garage) count as grounded; airborne cars fade it out.
      const contacts = frame.current.wheels.filter((wheel) => wheel.contact).length;
      const restPose = visual.wheels.every((wheel) => wheel.position.distanceToSquared(visual.position) > 25);
      const groundTarget = restPose || contacts > 0 ? 1 : 0;
      grounded += (groundTarget - grounded) * Math.min(1, Math.max(dtSeconds, 0) * 10);
      contactShadow.place(visual.position, visual.rotation, activeCar.wheels.map((wheel) => wheel.position), grounded);
      stage.setMotionFocus?.(visual.position, 3.2);
      if (environmentPending) captureEnvironment();
      if (ghostSnapshot) applyGhost(ghostSnapshot);
      tireEffects.update(frame, visual, dtSeconds, renderOptions?.simulationActive ?? true);
      clockSeconds += Math.min(Math.max(dtSeconds, 0), 0.25);
      if (activeDistrict === 'harbor') harborDressing?.update(clockSeconds, stage.camera);
      for (const scenery of sceneries) if (scenery.district === activeDistrict) scenery.update(clockSeconds, stage.camera);
      nightLights.update(visual.position, visual.rotation, activeLamps());
      updateScatter();
      let renderStats: SceneRenderStats;
      if (censusPending && passCensus && stage.contextState() === 'ready') {
        censusPending = false;
        const diagnostic = passCensus.capture(() => stage.render());
        renderStats = diagnostic.result;
        // The context can be lost while this render is in flight. Its loss
        // event clears the sample; do not publish stale counters afterward.
        lastPassCensus = stage.contextState() === 'ready' ? diagnostic.census : null;
      } else {
        censusPending = false;
        renderStats = stage.render();
      }
      lastStats = { ...renderStats, ...tireEffects.stats() };
      return lastStats;
    },
    resize: stage.resize,
    resetCamera(): void { chaseCamera.reset(); tireEffects.reset(); },
    setLighting(preset): void {
      stage.setLighting(preset); applyAtmosphere(preset);
      lighting = preset;
      environmentPending = true;
    },
    setQuality(preset): void {
      stage.setQuality(preset); setWetSurfaceQuality(preset); tireEffects.setQuality(preset); shadowBudget.setQuality(preset); nightLights.setQuality(preset);
      for (const scenery of sceneries) scenery.setQuality?.(preset);
      setCarPaintQuality(preset);
      quality = preset;
    },
    async setCar(carId): Promise<void> {
      if (disposed) return;
      clearCensus();
      // Even a request for the already visible car supersedes an older async
      // load. Otherwise a late GLB can replace the visual after the runtime
      // has canceled that selection and kept the original physics car.
      const serial = ++requestSerial;
      if (carId === currentCarId) return;
      const nextCar = await assets.loadCarModel(carId);
      if (disposed || serial !== requestSerial) { nextCar.dispose(); return; }
      applyCarMaterials(nextCar);
      nextCar.setCosmetics(cosmetics);
      // Link the new car programs in the background so the swap frame does not stall on shader compiles.
      const warm = new THREE.Group();
      warm.add(nextCar.body, ...nextCar.wheels);
      try { await stage.precompile(warm); } catch { /* the first frame compiles synchronously instead */ }
      warm.remove(nextCar.body, ...nextCar.wheels);
      if (disposed || serial !== requestSerial) { nextCar.dispose(); return; }
      clearGhost();
      removeCar(activeCar);
      activeCar = nextCar;
      currentCarId = carId;
      addCar(activeCar);
      contactShadow.fit(activeCar.body, activeCar.wheels);
      passCensus?.setRoots({ staticRoots, carRoots: [activeCar.body, ...activeCar.wheels] });
      chaseCamera.reset();
      tireEffects.reset();
    },
    setCosmetics(value): void {
      cosmetics = value;
      activeCar.setCosmetics(value);
    },
    setRoute(routeId): void {
      if (disposed) throw new Error('ScenePipeline is disposed');
      clearCensus();
      if (!routeId) { routeMarkers.setRoute(null); tireEffects.reset(); return; }
      const route = loadedWorld.routes.find((candidate) => candidate.id === routeId);
      if (!route) throw new Error(`Route ${routeId} is not loaded in this world`);
      routeMarkers.setRoute(route);
      tireEffects.reset();
      const changed = route !== activeRoute;
      activeRoute = route;
      if (route.district !== activeDistrict) applyDistrict(route.district);
      else if (changed) environmentPending = true;
    },
    async loadCarModel(carId): Promise<CarPresentation> {
      const presentation = await assets.loadCarModel(carId);
      applyCarMaterials(presentation);
      // Online cars carry their own child contact shadow; it is disposed with the car's root.
      attachContactShadow(presentation.body, presentation.wheels);
      return presentation;
    },
    setGhost(snapshot): void {
      ghostSnapshot = snapshot;
      if (!snapshot) clearGhost();
      else applyGhost(snapshot);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearCensus();
      if (ownerReview) canvas.removeEventListener('webglcontextlost', onContextLost);
      requestSerial++;
      clearGhost();
      ghostMaterial.dispose();
      routeMarkers.dispose();
      tireEffects.dispose();
      stage.scene.remove(nightLights.root);
      nightLights.dispose();
      contactShadow.dispose();
      shadowBudget.dispose();
      removeCar(activeCar);
      for (const scenery of sceneries) { stage.scene.remove(scenery.root); scenery.dispose(); }
      if (harborDressing) {
        stage.scene.remove(harborDressing.root);
        harborDressing.dispose();
      }
      stage.scene.remove(loadedWorld.root, routeMarkers.root);
      loadedWorld.dispose();
      stage.dispose();
    },
  };
}
