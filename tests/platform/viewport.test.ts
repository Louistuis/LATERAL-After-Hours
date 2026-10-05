import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchViewport } from '../../src/platform/viewport';

describe('viewport watcher', () => {
  let observed: (() => void) | null;
  let listeners: Map<string, () => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    observed = null; listeners = new Map();
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observed = cb; } observe() {} disconnect() { observed = null; } });
    vi.stubGlobal('requestAnimationFrame', () => 1); // a hidden page never runs rAF; the timer must still resize
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', {
      devicePixelRatio: 3,
      addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
      removeEventListener: (type: string) => listeners.delete(type),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('sizes immediately, follows rotation, skips no-op updates and caps the ratio', () => {
    const root = { clientWidth: 375, clientHeight: 812 } as HTMLElement;
    const resize = vi.fn();
    const stop = watchViewport(root, resize);
    expect(resize).toHaveBeenLastCalledWith(375, 812, 2);
    Object.assign(root, { clientWidth: 812, clientHeight: 375 });
    listeners.get('orientationchange')!();
    vi.advanceTimersByTime(1000);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith(812, 375, 2);
    observed!();
    vi.advanceTimersByTime(200);
    expect(resize).toHaveBeenCalledTimes(2);
    Object.assign(root, { clientWidth: 0, clientHeight: 0 });
    listeners.get('resize')!();
    vi.advanceTimersByTime(200);
    expect(resize).toHaveBeenCalledTimes(2);
    stop();
    expect(listeners.size).toBe(0);
    Object.assign(root, { clientWidth: 1024, clientHeight: 768 });
    vi.advanceTimersByTime(1000);
    expect(resize).toHaveBeenCalledTimes(2);
  });
});
