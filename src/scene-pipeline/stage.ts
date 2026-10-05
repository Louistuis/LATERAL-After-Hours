import * as THREE from 'three';
import type { LightingPreset, QualityPreset } from '../../contracts/runtime-contracts';
import { atmosphereFor, type AtmosphereRecipe } from './atmosphere';
import type { DistrictId } from '../../contracts/world-contracts';
import { createSkyDome, type SkyDome } from './sky-dome';
import { createPostFx, type PostFx, type PostFxStats, type PostScatterInput } from '../render/post-fx';
import { readGpuRenderer } from '../render/gpu-tier';

export interface SceneRenderStats {
  /** Three.js renderer.info, including the shadow pass where enabled. */
  readonly drawCallsAllPasses: number;
  readonly trianglesAllPasses: number;
  readonly geometries: number;
  readonly textures: number;
  readonly quality: QualityPreset;
  readonly lighting: LightingPreset;
  readonly contextState: 'ready' | 'lost' | 'failed';
  /** Full-screen post passes (bloom chain + composite) included in drawCallsAllPasses; 0 when post is off. */
  readonly postPasses?: number;
}

export interface RenderStage {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  contextState(): 'ready' | 'lost' | 'failed';
  setLighting(preset: LightingPreset): void;
  /** Switch the sky, fog, light and grade palette to another district's mood (keeps the lighting preset). */
  setDistrict?(district: DistrictId): void;
  setQuality(preset: QualityPreset): void;
  focusShadows(position: THREE.Vector3): void;
  resize(widthPx: number, heightPx: number, pixelRatio?: number): void;
  render(): SceneRenderStats;
  /** Resolves once every program under root (default: the whole scene) has finished linking in the background. */
  precompile(root?: THREE.Object3D): Promise<void>;
  /** Draw calls spent by the scene/shadow passes only, sampled before the post chain ran. */
  scenePassDrawCalls(): number;
  postStats(): PostFxStats;
  /**
   * Replace the synthetic sky probe with a PMREM of the real harbour, rendered from `position` with `hide`
   * (cars, effects) invisible. Cached per lighting preset; the synthetic probe stays as the fallback.
   */
  captureEnvironment?(position: THREE.Vector3, hide?: readonly THREE.Object3D[]): boolean;
  /** Auto-quality dynamic resolution: multiplies the tier's pixel-ratio cap (0.6 to 1). */
  setResolutionScale?(scale: number): void;
  /** High/Ultra air in-scatter sources and the object Ultra motion blur keeps sharp. */
  setScatter?(input: PostScatterInput | null): void;
  setMotionFocus?(center: THREE.Vector3 | null, radius?: number): void;
  /** WebGL renderer string (for the Auto starting tier). */
  readonly gpuRenderer?: string;
  dispose(): void;
}

/** The captured harbour is darker than the synthetic probe's idealised lamp ring; this keeps IBL level. */
const CAPTURE_INTENSITY = 1;
/** Pixel-ratio ceiling per tier (before the device cap and Auto's resolution scale). */
const PIXEL_RATIO_CAP: Readonly<Record<QualityPreset, number>> = { low: 1, balanced: 1.35, high: 1.75, ultra: 2 };
/** Sun shadow map size and PCF filter radius (texels) per tier: Ultra trades its 4096 map for wider, softer edges. */
const SHADOW: Readonly<Record<QualityPreset, Readonly<{ size: number; radius: number }>>> = {
  low: { size: 1024, radius: 1 }, balanced: { size: 2048, radius: 1 }, high: { size: 2048, radius: 2 }, ultra: { size: 4096, radius: 3 },
};

/** Deterministic scatter of practical lights seen in wet-surface reflections of the probe. */
const PROBE_LAMPS: readonly (readonly [number, number, number])[] = [
  [0.3, 0.13, 1.0], [1.1, 0.09, 0.8], [1.9, 0.16, 1.1], [2.6, 0.1, 0.9], [3.4, 0.14, 1.0],
  [4.1, 0.08, 0.8], [4.8, 0.15, 1.1], [5.5, 0.11, 0.9], [0.75, 0.22, 0.6], [3.9, 0.25, 0.6],
];

function environmentTexture(renderer: THREE.WebGLRenderer, sky: SkyDome, recipe: AtmosphereRecipe): THREE.Texture {
  const probeScene = new THREE.Scene();
  const dome = sky.createProbeMesh(40);
  probeScene.add(dome);
  const disposables: { dispose(): void }[] = [];
  const blob = (direction: THREE.Vector3, radius: number, color: THREE.Color): void => {
    const geometry = new THREE.SphereGeometry(radius, 12, 8);
    const material = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(direction).normalize().multiplyScalar(30);
    probeScene.add(mesh);
    disposables.push(geometry, material);
  };
  const lampColor = new THREE.Color(recipe.lampColor).multiplyScalar(7 * recipe.lampGlow + 0.5);
  for (const [azimuth, elevation, size] of PROBE_LAMPS) {
    const direction = new THREE.Vector3(Math.cos(azimuth), elevation, Math.sin(azimuth));
    blob(direction, size, lampColor);
  }
  // Two neon accents (cyan and magenta) mirror the signage along the quay.
  blob(new THREE.Vector3(0.9, 0.17, 0.4), 1.4, new THREE.Color('#2ff0ff').multiplyScalar(5 * recipe.lampGlow + 0.3));
  blob(new THREE.Vector3(-0.3, 0.2, 0.9), 1.3, new THREE.Color('#ff3fb0').multiplyScalar(5 * recipe.lampGlow + 0.3));
  if (recipe.sunDisc > 0) blob(new THREE.Vector3(...recipe.glowDirection), 3.2, new THREE.Color('#ff9a52').multiplyScalar(6));
  if (recipe.moonSize > 0) blob(new THREE.Vector3(...recipe.moonDirection), 2.4, new THREE.Color(recipe.moonColor).multiplyScalar(3));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(probeScene, 0.05, 0.1, 100);
  pmrem.dispose();
  for (const item of disposables) item.dispose();
  dome.geometry.dispose();
  dome.material.dispose();
  // Return the render target too, so switching presets releases its GPU storage.
  const texture = target.texture;
  texture.userData.pmremTarget = target;
  return texture;
}

export function createRenderStage(
  canvas: HTMLCanvasElement,
  initialQuality: QualityPreset,
  initialLighting: LightingPreset,
): RenderStage {
  // The scene renders into an MSAA HDR target and the composite writes the canvas, so the canvas itself
  // needs no multisampling (it would only add a resolve of a full-screen triangle).
  const context = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!context) throw new Error('WebGL2 is required. Enable hardware acceleration or use another browser.');
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1200);
  camera.position.set(0, 4, 9);
  const baseRender = renderer.render.bind(renderer) as (scene: THREE.Scene, camera: THREE.Camera) => void;
  const post: PostFx = createPostFx(renderer, scene, camera, initialQuality, baseRender);
  let sceneCalls = 0;
  let cameraOverride: { position: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  // Any top-level render of the game scene (including photo-mode capture) goes through the post chain.
  renderer.render = (target: THREE.Object3D, viewpoint: THREE.Camera): void => {
    if (target === scene && viewpoint === camera && post.active && renderer.getRenderTarget() === null) post.render();
    else baseRender(target as THREE.Scene, viewpoint);
  };
  const skyDome = createSkyDome();
  scene.add(skyDome.mesh);
  const ambient = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 190;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.025;
  scene.add(ambient, sun, sun.target);
  // Probes are cached per district and lighting preset: `${district}|${preset}`.
  const probeCache = new Map<string, THREE.Texture>();
  const captureCache = new Map<string, THREE.Texture>();
  let district: DistrictId = 'harbor';
  const cacheKey = (preset: LightingPreset): string => `${district}|${preset}`;
  let resolutionScale = 1;
  const shadowFocus = new THREE.Vector3();
  let lighting = initialLighting;
  let quality = initialQuality;
  let width = 1;
  let height = 1;
  let preferredPixelRatio = 1;
  let contextState: 'ready' | 'lost' | 'failed' = 'ready';
  let restoreError: unknown = null;
  const onContextLost = (): void => { contextState = 'lost'; };
  const onContextRestored = (): void => {
    try {
      // The lost WebGL context already destroyed its GPU objects. Disposing
      // their render targets against the new context issues INVALID_OPERATION
      // deletes; release JS references and rebuild them on the restored one.
      scene.environment = null;
      probeCache.clear();
      captureCache.clear();
      sun.shadow.map = null;
      contextState = 'ready';
      setLighting(lighting);
      setQuality(quality);
      restoreError = null;
    } catch (error) {
      contextState = 'failed';
      restoreError = error;
    }
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  function setLighting(preset: LightingPreset): void {
    lighting = preset;
    const recipe = atmosphereFor(district, preset);
    scene.background = new THREE.Color(recipe.fog);
    if (scene.fog instanceof THREE.FogExp2) { scene.fog.color.set(recipe.fog); scene.fog.density = recipe.fogDensity; }
    else scene.fog = new THREE.FogExp2(recipe.fog, recipe.fogDensity);
    skyDome.setAtmosphere(recipe);
    ambient.color.set(recipe.hemiSky);
    ambient.groundColor.set(recipe.hemiGround);
    ambient.intensity = recipe.hemiIntensity;
    sun.color.set(recipe.sun);
    sun.intensity = recipe.sunIntensity;
    sun.position.copy(shadowFocus).add(new THREE.Vector3(...recipe.sunDirection));
    renderer.toneMappingExposure = recipe.exposure;
    post.setExposure(recipe.exposure);
    post.setGrade(recipe.grade);
    if (contextState !== 'ready') {
      scene.environment = null;
      return;
    }
    let probe = captureCache.get(cacheKey(preset)) ?? probeCache.get(cacheKey(preset));
    if (!probe) {
      probe = environmentTexture(renderer, skyDome, recipe);
      probeCache.set(cacheKey(preset), probe);
    }
    scene.environment = probe;
    scene.environmentIntensity = recipe.environmentIntensity * (captureCache.has(cacheKey(preset)) ? CAPTURE_INTENSITY : 1);
  }

  function setQuality(preset: QualityPreset): void {
    quality = preset;
    if (contextState !== 'ready') return;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    post.setQuality(preset);
    const shadowSize = SHADOW[preset].size;
    sun.shadow.radius = SHADOW[preset].radius;
    if (sun.shadow.mapSize.x !== shadowSize) {
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    resize(width, height, preferredPixelRatio);
  }

  function resize(widthPx: number, heightPx: number, pixelRatio = preferredPixelRatio): void {
    width = Math.max(1, Math.floor(widthPx));
    height = Math.max(1, Math.floor(heightPx));
    preferredPixelRatio = Math.max(0.5, Math.min(2, pixelRatio));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (contextState !== 'ready') return;
    renderer.setPixelRatio(Math.min(preferredPixelRatio, PIXEL_RATIO_CAP[quality]) * resolutionScale);
    renderer.setSize(width, height, false);
    post.resize();
  }

  setQuality(initialQuality);
  setLighting(initialLighting);
  // Owner-review look-dev hook: lets a reviewer pin the camera and tune the post chain from the console.
  const ownerReviewHook = typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__ && typeof window !== 'undefined';
  if (ownerReviewHook) {
    Object.defineProperty(window, '__LATERAL_LOOK__', {
      configurable: true,
      value: {
        scene, camera, renderer, post,
        setCamera(position: [number, number, number] | null, look?: [number, number, number], fov = 58): void {
          cameraOverride = position ? { position: new THREE.Vector3(...position), look: new THREE.Vector3(...(look ?? [0, 0, 0])), fov } : null;
        },
        stats: () => post.stats(),
      },
    });
  }
  return {
    scene, camera, renderer, setLighting, setQuality, resize,
    setDistrict(next): void {
      if (next === district) return;
      district = next;
      setLighting(lighting);
    },
    contextState: () => contextState,
    focusShadows(position): void {
      shadowFocus.copy(position);
      sun.position.set(...atmosphereFor(district, lighting).sunDirection).add(shadowFocus);
      sun.target.position.copy(shadowFocus);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
    },
    render(): SceneRenderStats {
      if (contextState === 'failed') {
        throw new Error('WebGL context restoration failed', { cause: restoreError });
      }
      if (contextState === 'lost') {
        return {
          drawCallsAllPasses: 0, trianglesAllPasses: 0, geometries: 0, textures: 0,
          quality, lighting, contextState,
        };
      }
      renderer.info.reset();
      if (cameraOverride) {
        camera.position.copy(cameraOverride.position);
        camera.fov = cameraOverride.fov;
        camera.updateProjectionMatrix();
        camera.lookAt(cameraOverride.look);
        camera.updateMatrixWorld(true);
      }
      skyDome.mesh.position.copy(camera.position);
      renderer.render(scene, camera);
      const postPasses = post.stats().passes;
      sceneCalls = renderer.info.render.calls - postPasses;
      return {
        postPasses,
        drawCallsAllPasses: renderer.info.render.calls,
        trianglesAllPasses: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        quality, lighting, contextState,
      };
    },
    async precompile(root?: THREE.Object3D): Promise<void> {
      if (contextState !== 'ready') return;
      await post.precompile(root);
    },
    scenePassDrawCalls: () => sceneCalls,
    postStats: () => post.stats(),
    gpuRenderer: readGpuRenderer(context),
    setScatter: (input) => post.setScatter(input),
    setMotionFocus: (center, radius) => post.setMotionFocus(center, radius),
    setResolutionScale(scale): void {
      const next = Math.max(0.5, Math.min(1, Number.isFinite(scale) ? scale : 1));
      if (next === resolutionScale) return;
      resolutionScale = next;
      resize(width, height, preferredPixelRatio);
    },
    captureEnvironment(position, hide = []): boolean {
      if (contextState !== 'ready') return false;
      const cached = captureCache.get(cacheKey(lighting));
      if (cached) { scene.environment = cached; return true; }
      const recipe = atmosphereFor(district, lighting);
      const hidden = hide.filter((node) => node.visible);
      for (const node of hidden) node.visible = false;
      const previousDome = skyDome.mesh.position.clone();
      skyDome.mesh.position.copy(position);
      // Same 256 px cube as the synthetic probe: identical CUBEUV defines, so no program recompiles.
      const pmrem = new THREE.PMREMGenerator(renderer);
      let target: THREE.WebGLRenderTarget;
      try {
        target = pmrem.fromScene(scene, 0.04, 0.1, 900, { size: 256, position });
      } finally {
        pmrem.dispose();
        for (const node of hidden) node.visible = true;
        skyDome.mesh.position.copy(previousDome);
      }
      target.texture.userData.pmremTarget = target;
      captureCache.set(cacheKey(lighting), target.texture);
      scene.environment = target.texture;
      scene.environmentIntensity = recipe.environmentIntensity * CAPTURE_INTENSITY;
      return true;
    },
    dispose(): void {
      post.dispose();
      renderer.render = baseRender;
      if (ownerReviewHook) Reflect.deleteProperty(window, '__LATERAL_LOOK__');
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      for (const probe of [...probeCache.values(), ...captureCache.values()]) {
        const target = probe.userData.pmremTarget as THREE.WebGLRenderTarget;
        target.dispose();
      }
      probeCache.clear();
      captureCache.clear();
      sun.shadow.map?.dispose();
      scene.remove(skyDome.mesh);
      skyDome.dispose();
      renderer.dispose();
    },
  };
}
