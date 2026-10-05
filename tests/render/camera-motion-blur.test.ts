import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createCameraMotionBlurPrototype, reprojectPreviousUv } from '../../src/render';
import { CAMERA_MOTION_BLUR_FRAGMENT_SHADER } from '../../src/render/camera-motion-blur';

function viewProjection(camera: THREE.PerspectiveCamera): THREE.Matrix4 {
  camera.updateWorldMatrix(true, false);
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

function mockRenderer(options: { floatColorTarget?: boolean; antialias?: boolean; maxSamples?: number } = {}) {
  let currentTarget: THREE.WebGLRenderTarget | null = null;
  let renderCount = 0;
  let throwOnScreenRender = false;
  return {
    renderer: {
      capabilities: { isWebGL2: true, maxSamples: options.maxSamples ?? 4 },
      extensions: { has: (name: string) => name === 'EXT_color_buffer_float' && options.floatColorTarget !== false },
      getContext: () => ({ getContextAttributes: () => ({ antialias: options.antialias !== false }) }),
      getRenderTarget: () => currentTarget,
      setRenderTarget: (target: THREE.WebGLRenderTarget | null) => { currentTarget = target; },
      getDrawingBufferSize: (output: THREE.Vector2) => output.set(640, 360),
      clear: () => undefined,
      render: () => {
        renderCount++;
        if (throwOnScreenRender && currentTarget === null) throw new Error('mock composite failure');
      },
    } as unknown as THREE.WebGLRenderer,
    renderCount: () => renderCount,
    currentTarget: () => currentTarget,
    setThrowOnScreenRender: (value: boolean) => { throwOnScreenRender = value; },
  };
}

function mockCanvas(): HTMLCanvasElement {
  return new EventTarget() as HTMLCanvasElement;
}

describe('camera-only motion blur prototype', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reprojects static camera geometry to the same UV and responds to camera translation', () => {
    const previousCamera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
    previousCamera.position.set(0, 4, 9);
    const previousViewProjection = viewProjection(previousCamera);
    const currentCamera = previousCamera.clone();
    currentCamera.position.x += 1;
    const currentProjection = viewProjection(currentCamera);
    const inverseCurrent = currentProjection.clone().invert();
    const output = new THREE.Vector2();

    expect(reprojectPreviousUv(.5, .5, .5, inverseCurrent, currentProjection, output)).toBe(true);
    expect(output.x).toBeCloseTo(.5, 8);
    expect(output.y).toBeCloseTo(.5, 8);

    expect(reprojectPreviousUv(.5, .5, .5, inverseCurrent, previousViewProjection, output)).toBe(true);
    expect(Math.abs(output.x - .5)).toBeGreaterThan(.001);
  });

  it('keeps the bounded depth-aware taps and defers ACES/sRGB conversion to output', () => {
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('uniform sampler2D tDepth;');
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('for (int tap = 1; tap <= 4; tap++)');
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('uMaxRadiusPx');
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('#include <tonemapping_fragment>');
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('#include <colorspace_fragment>');
    expect(CAMERA_MOTION_BLUR_FRAGMENT_SHADER).toContain('float depthDelta = abs(linearSample - linearCenter);');
  });

  it('allocates no effect target or pass at zero strength, Low, or reduced motion', () => {
    const { renderer, renderCount } = mockRenderer();
    const canvas = mockCanvas();
    const prototype = createCameraMotionBlurPrototype(renderer, canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);

    prototype.render(scene, camera);
    expect(renderCount()).toBe(1);
    expect(prototype.stats()).toMatchObject({ status: 'strength-zero', targetAllocated: false });

    prototype.setStrength(.75);
    prototype.setQuality('low');
    prototype.render(scene, camera);
    expect(renderCount()).toBe(2);
    expect(prototype.stats()).toMatchObject({ status: 'low-quality', targetAllocated: false });

    prototype.setQuality('balanced');
    prototype.setReducedMotion(true);
    prototype.render(scene, camera);
    expect(renderCount()).toBe(3);
    expect(prototype.stats()).toMatchObject({ status: 'reduced-motion', targetAllocated: false });
    prototype.dispose();
    expect(prototype.stats().status).toBe('disposed');
  });

  it('keeps unsupported half-float targets disabled and resets its camera history explicitly', () => {
    const { renderer } = mockRenderer({ floatColorTarget: false });
    const prototype = createCameraMotionBlurPrototype(renderer, mockCanvas());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    prototype.setStrength(1);
    prototype.render(scene, camera);
    expect(prototype.stats()).toMatchObject({ status: 'unsupported', targetAllocated: false, historyValid: false });
    prototype.resetHistory();
    expect(prototype.stats().historyValid).toBe(false);
    prototype.dispose();

    const noMsaa = createCameraMotionBlurPrototype(mockRenderer({ maxSamples: 0 }).renderer, mockCanvas());
    noMsaa.setStrength(.7);
    noMsaa.render(scene, camera);
    expect(noMsaa.stats()).toMatchObject({ status: 'unsupported', targetAllocated: false, targetSamples: 0 });
    noMsaa.dispose();
  });

  it('uses bounded MSAA when the source context is antialiased and a single sample otherwise', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    const antialiased = createCameraMotionBlurPrototype(mockRenderer({ maxSamples: 16 }).renderer, mockCanvas());
    antialiased.setStrength(.5);
    antialiased.render(scene, camera);
    antialiased.render(scene, camera);
    expect(antialiased.stats().targetSamples).toBe(4);
    antialiased.dispose();

    const singleSample = createCameraMotionBlurPrototype(mockRenderer({ antialias: false }).renderer, mockCanvas());
    singleSample.setStrength(.5);
    singleSample.render(scene, camera);
    singleSample.render(scene, camera);
    expect(singleSample.stats().targetSamples).toBe(0);
    singleSample.dispose();
  });

  it('releases resources at zero strength or Low, and resize clears camera history', () => {
    const disposeTarget = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    const { renderer, renderCount } = mockRenderer();
    const prototype = createCameraMotionBlurPrototype(renderer, mockCanvas());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    prototype.setStrength(.7);
    prototype.render(scene, camera);
    prototype.render(scene, camera);
    expect(prototype.stats()).toMatchObject({ targetAllocated: true, targetSamples: 4, historyValid: true });
    expect(renderCount()).toBe(3);

    prototype.resetHistory(); // stage invokes for pause/resume, reset, and camera cuts
    expect(prototype.stats().historyValid).toBe(false);
    prototype.render(scene, camera); // first resumed frame seeds history without blur
    expect(renderCount()).toBe(4);
    expect(prototype.stats().historyValid).toBe(true);
    prototype.render(scene, camera);
    expect(renderCount()).toBe(6);

    prototype.resize();
    expect(prototype.stats()).toMatchObject({ targetAllocated: false, historyValid: false });
    expect(disposeTarget).toHaveBeenCalledTimes(1);
    prototype.render(scene, camera);
    prototype.render(scene, camera);
    prototype.setReducedMotion(true);
    expect(prototype.stats()).toMatchObject({ status: 'reduced-motion', targetAllocated: false, effectiveStrength: 0 });
    expect(disposeTarget).toHaveBeenCalledTimes(2);
    prototype.setReducedMotion(false);
    prototype.render(scene, camera);
    prototype.render(scene, camera);
    prototype.setQuality('low');
    expect(prototype.stats()).toMatchObject({ status: 'low-quality', targetAllocated: false, effectiveStrength: 0 });
    expect(disposeTarget).toHaveBeenCalledTimes(3);
    prototype.setQuality('balanced');
    prototype.render(scene, camera);
    prototype.render(scene, camera);
    prototype.setStrength(0);
    expect(prototype.stats()).toMatchObject({ status: 'strength-zero', targetAllocated: false, effectiveStrength: 0 });
    expect(disposeTarget).toHaveBeenCalledTimes(4);
    prototype.dispose();
  });

  it('does not invalidate history when callers repeat unchanged settings', () => {
    const { renderer, renderCount } = mockRenderer();
    const prototype = createCameraMotionBlurPrototype(renderer, mockCanvas());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    prototype.setStrength(.5);
    prototype.render(scene, camera);
    prototype.render(scene, camera);
    expect(prototype.stats()).toMatchObject({ targetAllocated: true, historyValid: true });
    prototype.setStrength(.5);
    prototype.setQuality('balanced');
    prototype.setReducedMotion(false);
    expect(prototype.stats()).toMatchObject({ targetAllocated: true, historyValid: true });
    prototype.render(scene, camera);
    expect(renderCount()).toBe(5); // scene + composite; history was not reseeded
    expect(prototype.stats().historyValid).toBe(true);
    prototype.dispose();
  });

  it('restores the renderer target and invalidates history when a pass throws', () => {
    const { renderer, currentTarget, setThrowOnScreenRender } = mockRenderer();
    const prototype = createCameraMotionBlurPrototype(renderer, mockCanvas());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    prototype.setStrength(.5);
    prototype.render(scene, camera);
    setThrowOnScreenRender(true);
    expect(() => prototype.render(scene, camera)).toThrow('mock composite failure');
    expect(currentTarget()).toBeNull();
    expect(prototype.stats().historyValid).toBe(false);
    setThrowOnScreenRender(false);
    prototype.render(scene, camera); // re-seed after the failed frame
    prototype.render(scene, camera);
    expect(prototype.stats().historyValid).toBe(true);
    prototype.dispose();
  });

  it('abandons pre-loss targets without deleting into the restored context and recreates lazily', () => {
    const disposeTarget = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    const { renderer } = mockRenderer();
    const canvas = mockCanvas();
    const prototype = createCameraMotionBlurPrototype(renderer, canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .1, 1200);
    prototype.setStrength(1);

    prototype.render(scene, camera); // seeds the previous camera transform without allocating
    prototype.render(scene, camera); // allocates the color/depth target and performs the composite
    expect(prototype.stats().targetAllocated).toBe(true);

    canvas.dispatchEvent(new Event('webglcontextlost'));
    prototype.setQuality('low');
    expect(prototype.stats()).toMatchObject({ status: 'context-lost', targetAllocated: false, historyValid: false });
    expect(disposeTarget).not.toHaveBeenCalled();

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    prototype.setQuality('balanced');
    expect(prototype.stats()).toMatchObject({ status: 'ready', targetAllocated: false, historyValid: false });
    prototype.render(scene, camera); // seed after restoration
    prototype.render(scene, camera); // lazily creates a fresh target
    expect(prototype.stats()).toMatchObject({ targetAllocated: true, targetSamples: 4, historyValid: true });
    prototype.dispose();
    expect(disposeTarget).toHaveBeenCalledTimes(1);
  });
});
