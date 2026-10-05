import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCanvasRecovery } from '../../src/core/canvas-recovery';
import { PauseSet } from '../../src/core/clock';

describe('canvas recovery lifecycle', () => {
  let frames: Map<number, FrameRequestCallback>;
  let next: number;
  beforeEach(() => {
    frames = new Map(); next = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  });
  afterEach(() => vi.unstubAllGlobals());
  function fixture() {
    const canvas = new EventTarget(); const pauses = new PauseSet(); const notify = vi.fn();
    const failures: Array<(error: Error) => void> = [];
    const detach = attachCanvasRecovery(canvas, {
      pause: reason => pauses.add(reason), resume: reason => pauses.remove(reason), onRenderFailure: cb => failures.push(cb),
    }, notify);
    return { canvas, pauses, notify, detach, fail: (error: Error) => failures[0](error) };
  }
  function nextFrame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); }
  it('restores only the context pause after resources have received their restore event', () => {
    const f = fixture(); f.pauses.add('menu');
    const lost = new Event('webglcontextlost', { cancelable: true }); f.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(f.pauses.reasons().has('context-lost')).toBe(true);
    f.canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(f.pauses.reasons().has('context-lost')).toBe(true);
    nextFrame();
    expect(f.pauses.reasons()).toEqual(new Set(['menu']));
    expect(f.notify).toHaveBeenLastCalledWith('ready'); f.detach();
  });
  it('a second loss cancels an old pending restore and disposal prevents future callbacks', () => {
    const f = fixture();
    f.canvas.dispatchEvent(new Event('webglcontextrestored'));
    f.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); nextFrame();
    expect(f.pauses.reasons().has('context-lost')).toBe(true);
    f.detach(); const calls = f.notify.mock.calls.length;
    f.canvas.dispatchEvent(new Event('webglcontextrestored')); f.fail(new Error('late')); nextFrame();
    expect(f.notify).toHaveBeenCalledTimes(calls);
  });
  it('turns a renderer exception into recoverable paused state without dropping unrelated pause reasons', () => {
    const f = fixture(); f.pauses.add('ad'); f.fail(new Error('shader compilation failed'));
    expect(f.pauses.reasons()).toEqual(new Set(['ad','context-lost']));
    expect(f.notify).toHaveBeenCalledWith('failed','shader compilation failed'); f.detach();
  });
});
