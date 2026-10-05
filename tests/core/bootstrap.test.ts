import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../src/core/bootstrap';

const f = vi.hoisted(() => ({
  scene: { resize: vi.fn(), dispose: vi.fn() },
  input: { dispose: vi.fn() },
  runtime: { dispose: vi.fn(), selectCar: vi.fn(async () => {}) },
  boot: {
    canvas: { parentElement: null as HTMLElement | null }, overlay: {},
    progress: vi.fn(), ready: vi.fn(), fail: vi.fn(), graphics: vi.fn(), dispose: vi.fn(),
  },
  services: {
    profiles: { load: vi.fn() }, platform: { handle: vi.fn() }, dispose: vi.fn(),
  },
  shell: vi.fn(),
  experience: { dispose: vi.fn() },
}));
vi.mock('../../src/scene-pipeline', () => ({ createScenePipeline: vi.fn(async () => f.scene) }));
vi.mock('../../src/input', () => ({ createPlayerInput: vi.fn(() => f.input) }));
vi.mock('../../src/core/game-runtime', () => ({ GameRuntime: { create: vi.fn(async () => f.runtime) } }));
vi.mock('../../src/core/boot-shell', () => ({ createBootShell: vi.fn(() => f.boot) }));
vi.mock('../../src/core/canvas-recovery', () => ({ attachCanvasRecovery: vi.fn(() => vi.fn()) }));
vi.mock('../../src/experience', () => ({
  createExperienceServices: vi.fn(async () => f.services),
  createExperienceShell: f.shell,
}));

describe('bootstrap readiness boundary', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.clearAllMocks();
    root = { clientWidth: 1280, clientHeight: 720 } as HTMLElement;
    f.boot.canvas.parentElement = root;
    f.services.profiles.load.mockResolvedValue({});
    f.services.dispose.mockResolvedValue(undefined);
    f.shell.mockResolvedValue(f.experience);
    vi.stubGlobal('__OWNER_REVIEW__', false);
    vi.stubGlobal('__BUILD__', { target: 'poki' });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('waits for a usable experience, uncovers it, then reports readiness once with unknown transfer size', async () => {
    let release!: () => void;
    let shellEntered!: () => void;
    const entered = new Promise<void>(resolve => { shellEntered = resolve; });
    f.shell.mockImplementationOnce(() => {
      shellEntered();
      return new Promise(resolve => { release = () => resolve(f.experience); });
    });
    const order: string[] = [];
    f.boot.ready.mockImplementationOnce(() => { order.push('uncovered'); });
    f.services.platform.handle.mockImplementationOnce(() => { order.push('ready'); });
    const pending = bootstrap(root);
    await entered;
    expect(f.boot.ready).not.toHaveBeenCalled();
    expect(f.services.platform.handle).not.toHaveBeenCalled();
    release();
    const dispose = await pending;
    expect(order).toEqual(['uncovered', 'ready']);
    expect(f.services.platform.handle).toHaveBeenCalledExactlyOnceWith({
      type: 'first-playable', firstPlayableTransferBytes: null,
    });
    expect(Reflect.has(window, '__LATERAL_BENCH__')).toBe(false);
    dispose(); dispose();
    expect(f.services.platform.handle).toHaveBeenCalledTimes(1);
    expect(f.experience.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the owner measurement boundary pending until uncover and removes it on disposal', async () => {
    vi.stubGlobal('__OWNER_REVIEW__', true);
    let release!: () => void;
    let shellEntered!: () => void;
    const entered = new Promise<void>(resolve => { shellEntered = resolve; });
    f.shell.mockImplementationOnce(() => {
      shellEntered();
      return new Promise(resolve => { release = () => resolve(f.experience); });
    });
    const pending = bootstrap(root);
    await entered;
    const bridge = Reflect.get(window, '__LATERAL_BENCH__') as { readonly firstPlayableAtMs: number | null };
    expect(bridge.firstPlayableAtMs).toBeNull();
    const beforeUncover = performance.now();
    release();
    const dispose = await pending;
    expect(bridge.firstPlayableAtMs).toBeGreaterThanOrEqual(beforeUncover);
    expect(bridge.firstPlayableAtMs).toBeLessThanOrEqual(performance.now());
    dispose();
    expect(Reflect.has(window, '__LATERAL_BENCH__')).toBe(false);
    expect(Reflect.has(window, '__LATERAL_QA__')).toBe(false);
  });

  it.each([false, true])('does not report a failed experience as playable (owner mode %s)', async ownerReview => {
    vi.stubGlobal('__OWNER_REVIEW__', ownerReview);
    f.shell.mockRejectedValueOnce(new Error('experience unavailable'));
    const dispose = await bootstrap(root);
    expect(f.boot.fail).toHaveBeenCalled();
    expect(f.boot.ready).not.toHaveBeenCalled();
    expect(f.services.platform.handle).not.toHaveBeenCalled();
    expect(Reflect.has(window, '__LATERAL_BENCH__')).toBe(false);
    dispose();
  });

  it.each([false, true])('does not report a replaced boot after its pending shell resolves (owner mode %s)', async ownerReview => {
    vi.stubGlobal('__OWNER_REVIEW__', ownerReview);
    const abort = new AbortController();
    f.shell.mockImplementationOnce(async () => { abort.abort(); return f.experience; });
    const dispose = await bootstrap(root, abort.signal);
    expect(f.boot.ready).not.toHaveBeenCalled();
    expect(f.services.platform.handle).not.toHaveBeenCalled();
    expect(Reflect.has(window, '__LATERAL_BENCH__')).toBe(false);
    expect(f.experience.dispose).toHaveBeenCalledTimes(1);
    dispose();
  });
});
