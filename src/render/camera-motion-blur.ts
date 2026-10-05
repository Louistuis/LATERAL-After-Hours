import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';

export type CameraMotionBlurStatus =
  | 'strength-zero'
  | 'low-quality'
  | 'reduced-motion'
  | 'context-lost'
  | 'unsupported'
  | 'external-render-target'
  | 'ready'
  | 'disposed';

export interface CameraMotionBlurStats {
  readonly status: CameraMotionBlurStatus;
  readonly requestedStrength: number;
  readonly effectiveStrength: number;
  readonly targetAllocated: boolean;
  readonly targetSamples: number;
  readonly historyValid: boolean;
  /** Camera-depth reprojection has no independently moving object vectors. */
  readonly movingGeometryVectors: false;
}

export interface CameraMotionBlurPrototype {
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void;
  setStrength(strength: number): void;
  setQuality(quality: QualityPreset): void;
  setReducedMotion(reducedMotion: boolean): void;
  resize(): void;
  resetHistory(): void;
  stats(): CameraMotionBlurStats;
  dispose(): void;
}

const VERTEX_SHADER = /* glsl */`
  varying vec2 vL3Uv;
  void main() {
    vL3Uv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const CAMERA_MOTION_BLUR_FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform mat4 uInverseViewProjection;
  uniform mat4 uPreviousViewProjection;
  uniform vec2 uResolution;
  uniform float uNear;
  uniform float uFar;
  uniform float uStrength;
  uniform float uMaxRadiusPx;
  varying vec2 vL3Uv;

  float l3LinearDepth(float depth) {
    float z = depth * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / max(uFar + uNear - z * (uFar - uNear), 0.00001);
  }

  void main() {
    vec4 centerColor = texture2D(tColor, vL3Uv);
    float centerDepth = texture2D(tDepth, vL3Uv).x;
    vec3 resultColor = centerColor.rgb;

    // Clear/background pixels have no stable world point to reproject.
    if (uStrength > 0.0 && centerDepth < 0.99999) {
      vec4 clip = vec4(vL3Uv * 2.0 - 1.0, centerDepth * 2.0 - 1.0, 1.0);
      vec4 world = uInverseViewProjection * clip;
      if (abs(world.w) > 0.00001) {
        world /= world.w;
        vec4 previousClip = uPreviousViewProjection * world;
        if (previousClip.w > 0.00001) {
          vec2 previousUv = previousClip.xy / previousClip.w * 0.5 + 0.5;
          vec2 motionPixels = (vL3Uv - previousUv) * uResolution;
          float motionLength = length(motionPixels);
          float radius = min(motionLength * uStrength, uMaxRadiusPx);
          if (radius > 0.5 && all(greaterThanEqual(previousUv, vec2(0.0))) && all(lessThanEqual(previousUv, vec2(1.0)))) {
            vec2 trailStep = normalize(motionPixels) * radius / uResolution;
            float linearCenter = l3LinearDepth(centerDepth);
            vec3 sumColor = centerColor.rgb;
            float sampleCount = 1.0;
            for (int tap = 1; tap <= 4; tap++) {
              float alongTrail = float(tap) * 0.25;
              vec2 sampleUv = vL3Uv - trailStep * alongTrail;
              if (all(greaterThanEqual(sampleUv, vec2(0.0))) && all(lessThanEqual(sampleUv, vec2(1.0)))) {
                float sampleDepth = texture2D(tDepth, sampleUv).x;
                float linearSample = l3LinearDepth(sampleDepth);
                float depthDelta = abs(linearSample - linearCenter);
                if (sampleDepth < 0.99999 && depthDelta < max(0.035, linearCenter * 0.018)) {
                  sumColor += texture2D(tColor, sampleUv).rgb;
                  sampleCount += 1.0;
                }
              }
            }
            resultColor = sumColor / sampleCount;
          }
        }
      }
    }

    gl_FragColor = vec4(resultColor, centerColor.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Reprojects one current depth sample into the previous camera view. This is
 * camera-only motion: independently moving cars and wheels have no object
 * vectors and may smear incorrectly while the chase camera follows them.
 */
export function reprojectPreviousUv(
  uvX: number,
  uvY: number,
  depth: number,
  inverseCurrentViewProjection: THREE.Matrix4,
  previousViewProjection: THREE.Matrix4,
  output: THREE.Vector2,
): boolean {
  if (!Number.isFinite(depth) || depth < 0 || depth >= 0.99999) return false;
  const x = uvX * 2 - 1;
  const y = uvY * 2 - 1;
  const z = depth * 2 - 1;
  const current = inverseCurrentViewProjection.elements;
  const worldX = current[0]! * x + current[4]! * y + current[8]! * z + current[12]!;
  const worldY = current[1]! * x + current[5]! * y + current[9]! * z + current[13]!;
  const worldZ = current[2]! * x + current[6]! * y + current[10]! * z + current[14]!;
  const worldW = current[3]! * x + current[7]! * y + current[11]! * z + current[15]!;
  if (!Number.isFinite(worldW) || Math.abs(worldW) < 1e-8) return false;
  const inverseW = 1 / worldW;
  const previous = previousViewProjection.elements;
  const previousX = previous[0]! * worldX * inverseW + previous[4]! * worldY * inverseW
    + previous[8]! * worldZ * inverseW + previous[12]!;
  const previousY = previous[1]! * worldX * inverseW + previous[5]! * worldY * inverseW
    + previous[9]! * worldZ * inverseW + previous[13]!;
  const previousW = previous[3]! * worldX * inverseW + previous[7]! * worldY * inverseW
    + previous[11]! * worldZ * inverseW + previous[15]!;
  if (!Number.isFinite(previousW) || previousW <= 1e-8) return false;
  output.set(previousX / previousW * 0.5 + 0.5, previousY / previousW * 0.5 + 0.5);
  return Number.isFinite(output.x) && Number.isFinite(output.y);
}

/**
 * Isolated postprocess prototype. It does not own a clock and does not blur
 * independently moving geometry. Stage/UI integration is intentionally left
 * to S2 after color parity, visual quality, and GPU cost review.
 */
export function createCameraMotionBlurPrototype(
  renderer: THREE.WebGLRenderer,
  canvas: HTMLCanvasElement,
): CameraMotionBlurPrototype {
  let strength = 0;
  let quality: QualityPreset = 'balanced';
  let reducedMotion = false;
  let contextLost = false;
  let disposed = false;
  let previousValid = false;
  const previousViewProjection = new THREE.Matrix4();
  const currentViewProjection = new THREE.Matrix4();
  const inverseCurrentViewProjection = new THREE.Matrix4();
  let target: THREE.WebGLRenderTarget | null = null;
  let quadGeometry: THREE.BufferGeometry | null = null;
  let quadMaterial: THREE.ShaderMaterial | null = null;
  let quadScene: THREE.Scene | null = null;
  let quadCamera: THREE.OrthographicCamera | null = null;
  const drawingSize = new THREE.Vector2(1, 1);

  const canAllocateTarget = (): boolean => renderer.capabilities.isWebGL2
    && renderer.extensions.has('EXT_color_buffer_float')
    && (renderer.getContext().getContextAttributes()?.antialias !== true || renderer.capabilities.maxSamples > 0);

  const effectEnabled = (): boolean => !disposed && !contextLost && strength > 0
    && quality !== 'low' && !reducedMotion && canAllocateTarget();

  const releaseResources = (lost = false): void => {
    if (!lost) {
      target?.dispose();
      quadGeometry?.dispose();
      quadMaterial?.dispose();
    }
    target = null;
    quadGeometry = null;
    quadMaterial = null;
    quadScene = null;
    quadCamera = null;
  };

  const abandonContextResources = (): void => {
    contextLost = true;
    previousValid = false;
    releaseResources(true);
  };

  const restoreContextResources = (): void => {
    contextLost = false;
    previousValid = false;
    // All old-context WebGLRenderTarget references were abandoned on loss.
    // Recreate lazily only if a supported, enabled frame is rendered.
  };

  const ensureResources = (width: number, height: number): boolean => {
    if (!effectEnabled()) return false;
    if (target && target.width === width && target.height === height) return true;
    releaseResources();
    const antialias = renderer.getContext().getContextAttributes()?.antialias === true;
    const targetSamples = antialias ? Math.max(0, Math.min(4, renderer.capabilities.maxSamples)) : 0;
    const colorTarget = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: targetSamples,
    });
    colorTarget.texture.generateMipmaps = false;
    colorTarget.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    colorTarget.depthTexture.minFilter = THREE.NearestFilter;
    colorTarget.depthTexture.magFilter = THREE.NearestFilter;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: colorTarget.texture },
        tDepth: { value: colorTarget.depthTexture },
        uInverseViewProjection: { value: inverseCurrentViewProjection },
        uPreviousViewProjection: { value: previousViewProjection },
        uResolution: { value: drawingSize },
        uNear: { value: 0.1 },
        uFar: { value: 1200 },
        uStrength: { value: strength },
        uMaxRadiusPx: { value: 8 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: CAMERA_MOTION_BLUR_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
      blending: THREE.NoBlending,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    target = colorTarget;
    quadMaterial = material;
    quadGeometry = geometry;
    quadScene = scene;
    quadCamera = camera;
    return true;
  };

  const status = (): CameraMotionBlurStatus => {
    if (disposed) return 'disposed';
    if (contextLost) return 'context-lost';
    if (strength === 0) return 'strength-zero';
    if (quality === 'low') return 'low-quality';
    if (reducedMotion) return 'reduced-motion';
    if (!canAllocateTarget()) return 'unsupported';
    if (renderer.getRenderTarget() !== null) return 'external-render-target';
    return 'ready';
  };

  const onContextLost = (): void => abandonContextResources();
  const onContextRestored = (): void => restoreContextResources();
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  return {
    render(scene, camera): void {
      if (disposed) throw new Error('Camera motion blur prototype is disposed');
      if (contextLost) return;
      if (!effectEnabled() || renderer.getRenderTarget() !== null) {
        previousValid = false;
        renderer.render(scene, camera);
        return;
      }
      camera.updateWorldMatrix(true, false);
      currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (!previousValid) {
        previousViewProjection.copy(currentViewProjection);
        previousValid = true;
        renderer.render(scene, camera);
        return;
      }

      renderer.getDrawingBufferSize(drawingSize);
      const width = Math.max(1, Math.floor(drawingSize.x));
      const height = Math.max(1, Math.floor(drawingSize.y));
      inverseCurrentViewProjection.copy(currentViewProjection).invert();
      if (!ensureResources(width, height) || !target || !quadScene || !quadCamera || !quadMaterial) {
        previousValid = false;
        renderer.render(scene, camera);
        return;
      }
      quadMaterial.uniforms.uInverseViewProjection!.value = inverseCurrentViewProjection;
      quadMaterial.uniforms.uPreviousViewProjection!.value = previousViewProjection;
      quadMaterial.uniforms.uNear!.value = camera.near;
      quadMaterial.uniforms.uFar!.value = camera.far;
      quadMaterial.uniforms.uStrength!.value = strength;
      const outputTarget = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        renderer.setRenderTarget(outputTarget);
        renderer.render(quadScene, quadCamera);
      } catch (error) {
        previousValid = false;
        throw error;
      } finally {
        renderer.setRenderTarget(outputTarget);
      }
      previousViewProjection.copy(currentViewProjection);
    },
    setStrength(value): void {
      const nextStrength = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
      if (strength === nextStrength) return;
      strength = nextStrength;
      previousValid = false;
      if (!effectEnabled()) releaseResources(contextLost);
    },
    setQuality(preset): void {
      if (quality === preset) return;
      quality = preset;
      previousValid = false;
      if (!effectEnabled()) releaseResources(contextLost);
    },
    setReducedMotion(value): void {
      if (reducedMotion === value) return;
      reducedMotion = value;
      previousValid = false;
      if (!effectEnabled()) releaseResources(contextLost);
    },
    resize(): void {
      previousValid = false;
      if (!contextLost) releaseResources();
    },
    resetHistory(): void {
      previousValid = false;
      previousViewProjection.identity();
      currentViewProjection.identity();
      inverseCurrentViewProjection.identity();
    },
    stats(): CameraMotionBlurStats {
      const currentStatus = status();
      return {
        status: currentStatus,
        requestedStrength: strength,
        effectiveStrength: currentStatus === 'ready' && target !== null && previousValid ? strength : 0,
        targetAllocated: target !== null,
        targetSamples: target?.samples ?? 0,
        historyValid: previousValid,
        movingGeometryVectors: false,
      };
    },
    dispose(): void {
      if (disposed) return;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      releaseResources(contextLost);
      previousValid = false;
      disposed = true;
    },
  };
}
