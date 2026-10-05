import { cappedPixelRatio } from './device-profile';

export type ViewportListener = (widthPx: number, heightPx: number, pixelRatio: number) => void;

/**
 * Keeps the renderer matched to the game root through every way a mobile browser changes size:
 * element resize, window resize, orientation change (iOS reports stale sizes until the rotation
 * settles, so it re-measures afterwards), the iOS/Android URL bar collapsing (visualViewport) and
 * devicePixelRatio changes (zoom, moving to another display). Updates are coalesced to one per frame
 * and skipped when nothing changed. It also publishes the visible height as the CSS custom property
 * --lateral-viewport-height on <html> for layout that must sit above the iOS toolbar.
 */
export function watchViewport(root: HTMLElement, listener: ViewportListener): () => void {
  const win: (Window & typeof globalThis) | undefined = typeof window === 'undefined' ? undefined : window;
  const canListen = typeof win?.addEventListener === 'function';
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => clearTimeout(id);
  let frame = 0, fallback: ReturnType<typeof setTimeout> | undefined, last = '', disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const measure = (): void => {
    if (frame) caf(frame);
    clearTimeout(fallback);
    frame = 0; fallback = undefined;
    if (disposed) return;
    const width = root.clientWidth, height = root.clientHeight;
    if (width <= 0 || height <= 0) return; // hidden or mid-rotation; a later event re-measures
    const ratio = cappedPixelRatio(win?.devicePixelRatio ?? 1);
    const visibleHeight = win?.visualViewport?.height;
    if (visibleHeight && typeof document !== 'undefined') document.documentElement?.style.setProperty('--lateral-viewport-height', `${Math.round(visibleHeight)}px`);
    const key = `${width}x${height}@${ratio}`;
    if (key === last) return;
    last = key; listener(width, height, ratio);
  };
  // rAF coalesces bursts; the timer covers browsers that stop rAF for a hidden or backgrounded page.
  const schedule = (): void => { if (frame || fallback !== undefined || disposed) return; frame = raf(measure); fallback = setTimeout(measure, 100); };
  const settle = (): void => {
    schedule();
    for (const delay of [120, 360, 720]) { const timer = setTimeout(() => { timers.delete(timer); schedule(); }, delay); timers.add(timer); }
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(root);
  let dprQuery: MediaQueryList | null = null;
  const watchRatio = (): void => {
    dprQuery?.removeEventListener?.('change', onRatio);
    dprQuery = typeof win?.matchMedia === 'function' ? win.matchMedia(`(resolution: ${win.devicePixelRatio ?? 1}dppx)`) : null;
    dprQuery?.addEventListener?.('change', onRatio);
  };
  function onRatio(): void { watchRatio(); schedule(); }
  if (canListen && win) {
    win.addEventListener('resize', schedule);
    win.addEventListener('orientationchange', settle);
    win.addEventListener('pageshow', settle);
    win.visualViewport?.addEventListener('resize', schedule);
    win.screen?.orientation?.addEventListener?.('change', settle);
    watchRatio();
  }
  // Resize events and ResizeObserver run in the rendering steps, which a hidden page skips; re-measure on return
  // (an iPhone rotated while the tab was in the background comes back at the new size).
  const onVisible = (): void => { if (typeof document !== 'undefined' && !document.hidden) settle(); };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisible);
  measure();
  return () => {
    disposed = true; observer?.disconnect(); if (frame) caf(frame); clearTimeout(fallback); for (const timer of timers) clearTimeout(timer); timers.clear();
    dprQuery?.removeEventListener?.('change', onRatio);
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisible);
    if (canListen && win) {
      win.removeEventListener('resize', schedule);
      win.removeEventListener('orientationchange', settle);
      win.removeEventListener('pageshow', settle);
      win.visualViewport?.removeEventListener('resize', schedule);
      win.screen?.orientation?.removeEventListener?.('change', settle);
    }
  };
}
