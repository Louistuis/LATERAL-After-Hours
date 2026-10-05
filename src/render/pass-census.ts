import * as THREE from 'three';

export type RenderCensusCategory = 'staticWorld' | 'car' | 'other';
export type RenderCensusPass = 'main' | 'shadow';

export interface RenderCensusRoots {
  readonly staticRoots: readonly THREE.Object3D[];
  readonly carRoots: readonly THREE.Object3D[];
}

export interface RenderCensusBucket {
  /** Object callback invocations; multi-material geometry can invoke once per group. */
  readonly submissions: number;
  /** Submitted instance count, summed per invocation; zero for ordinary objects. */
  readonly instances: number;
}

export type RenderCensusCategories = Readonly<Record<RenderCensusCategory, RenderCensusBucket>>;

export interface RenderPassCensusFrame {
  readonly main: RenderCensusCategories;
  readonly shadow: RenderCensusCategories;
  /** `renderer.info.render.calls` at the end of the captured renderer invocation. */
  readonly rendererInfoCalls: number;
  /** Main plus shadow callback invocations minus the renderer aggregate. */
  readonly callbackAggregateDelta: number;
}

export interface RenderPassCensus {
  /** Refresh category roots after a car or static-root replacement. Must be outside capture(). */
  setRoots(roots: RenderCensusRoots): void;
  /** Temporarily chains Three callbacks for this render only; no persistent disposer is needed. */
  /** Disabled mode is a direct pass-through with no callback changes. */
  capture<T>(render: () => T, enabled?: boolean): { readonly result: T; readonly census: RenderPassCensusFrame | null };
}

/** Structural so a stage can report scene-pass-only calls once full-screen post passes are added to the aggregate. */
type RendererCounters = { readonly info: { readonly render: { readonly calls: number } } };
type RenderCallback = THREE.Object3D['onBeforeRender'];
type ShadowCallback = THREE.Object3D['onBeforeShadow'];
type RenderableObject = THREE.Object3D & {
  isMesh?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  isSprite?: boolean;
};

const categories: readonly RenderCensusCategory[] = ['staticWorld', 'car', 'other'];

function isRenderable(object: THREE.Object3D): object is RenderableObject {
  const candidate = object as RenderableObject;
  return candidate.isMesh === true || candidate.isLine === true
    || candidate.isPoints === true || candidate.isSprite === true;
}

function emptyCounts(): Record<RenderCensusCategory, { submissions: number; instances: number }> {
  return {
    staticWorld: { submissions: 0, instances: 0 },
    car: { submissions: 0, instances: 0 },
    other: { submissions: 0, instances: 0 },
  };
}

function bucketSnapshot(
  counts: Record<RenderCensusCategory, { submissions: number; instances: number }>,
): RenderCensusCategories {
  return {
    staticWorld: { ...counts.staticWorld },
    car: { ...counts.car },
    other: { ...counts.other },
  };
}

/**
 * Counts renderable-object callbacks for one explicitly requested diagnostic render.
 * This does not patch WebGLRenderer internals and does not affect frames outside capture().
 */
export function createRenderPassCensus(
  renderer: RendererCounters,
  sceneRoot: THREE.Object3D,
  initialRoots: RenderCensusRoots,
): RenderPassCensus {
  let roots = initialRoots;
  let capturing = false;

  function capture<T>(render: () => T, enabled = true): { readonly result: T; readonly census: RenderPassCensusFrame | null } {
    if (!enabled) return { result: render(), census: null };
    if (capturing) throw new Error('Render pass census capture is already active');
    capturing = true;

    const mainCounts = emptyCounts();
    const shadowCounts = emptyCounts();
    const restores: Array<() => void> = [];
    let result!: T;
    try {
      const staticSet = new Set<THREE.Object3D>();
      const carSet = new Set<THREE.Object3D>();
      for (const root of roots.staticRoots) root.traverse((node) => staticSet.add(node));
      for (const root of roots.carRoots) root.traverse((node) => carSet.add(node));
      const count = (
        target: Record<RenderCensusCategory, { submissions: number; instances: number }>,
        object: THREE.Object3D,
      ): void => {
        const category: RenderCensusCategory = carSet.has(object) ? 'car' : staticSet.has(object) ? 'staticWorld' : 'other';
        const bucket = target[category];
        bucket.submissions++;
        const mesh = object as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
        if (mesh.isInstancedMesh === true) bucket.instances += Math.max(0, mesh.count ?? 0);
      };

      sceneRoot.traverse((node) => {
        if (!isRenderable(node)) return;
        const previousRender: RenderCallback = node.onBeforeRender;
        const previousShadow: ShadowCallback = node.onBeforeShadow;
        const renderWrapper: RenderCallback = function (this: THREE.Object3D, ...args): void {
          previousRender.apply(this, args);
          count(mainCounts, this);
        };
        const shadowWrapper: ShadowCallback = function (this: THREE.Object3D, ...args): void {
          previousShadow.apply(this, args);
          count(shadowCounts, this);
        };
        restores.push(() => {
          if (node.onBeforeRender === renderWrapper) node.onBeforeRender = previousRender;
          if (node.onBeforeShadow === shadowWrapper) node.onBeforeShadow = previousShadow;
        });
        node.onBeforeRender = renderWrapper;
        node.onBeforeShadow = shadowWrapper;
      });
      result = render();
    } finally {
      for (let index = restores.length - 1; index >= 0; index--) restores[index]!();
      capturing = false;
    }

    const main = bucketSnapshot(mainCounts);
    const shadow = bucketSnapshot(shadowCounts);
    const callbackTotal = categories.reduce((total, category) =>
      total + main[category].submissions + shadow[category].submissions, 0);
    const rendererInfoCalls = renderer.info.render.calls;
    return {
      result,
      census: {
        main,
        shadow,
        rendererInfoCalls,
        callbackAggregateDelta: callbackTotal - rendererInfoCalls,
      },
    };
  }

  return {
    setRoots(nextRoots): void {
      if (capturing) throw new Error('Render pass census roots cannot change during capture()');
      roots = nextRoots;
    },
    capture,
  };
}
