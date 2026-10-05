import { describe, expect, it } from 'vitest';
import { OWNER_TOOLBAR_CSS, ownerToolbarRect } from '../../src/owner-tools';

interface Rect { left: number; top: number; right: number; bottom: number; }
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('private owner toggle safe-space layout', () => {
  it.each([
    { width: 1280, height: 720, hudRight: 306, rightControlLeft: 1230 },
    { width: 640, height: 360, hudRight: 246, rightControlLeft: 592 },
  ])('keeps the owner toggle clear of driving UI at $width×$height', ({ width, height, hudRight, rightControlLeft }) => {
    const toggle = ownerToolbarRect(width, height);
    const hud: Rect = { left: 12, top: 12, right: hudRight, bottom: 66 };
    const pauseCamera: Rect = { left: rightControlLeft, top: 12, right: width - 12, bottom: 104 };
    const playerActions: Rect = { left: width - 190, top: height - 56, right: width - 12, bottom: height - 8 };
    const touchPedals: Rect = { left: width - 210, top: height - 92, right: width - 12, bottom: height - 12 };

    expect(overlaps(toggle, hud)).toBe(false);
    expect(overlaps(toggle, pauseCamera)).toBe(false);
    expect(overlaps(toggle, playerActions)).toBe(false);
    expect(overlaps(toggle, touchPedals)).toBe(false);
    expect(toggle.left).toBeGreaterThanOrEqual(0);
    expect(toggle.right).toBeLessThanOrEqual(width);
    expect(toggle.top).toBeGreaterThanOrEqual(0);
    expect(toggle.bottom).toBeLessThanOrEqual(height);
  });

  it('stays inside asymmetric safe-area bounds and keeps a keyboard-visible native button target', () => {
    const width = 640, height = 360, safeLeft = 24, safeRight = 32, safeTop = 28;
    const toggle = ownerToolbarRect(width, height, safeTop, safeLeft, safeRight);
    expect(toggle.left).toBeGreaterThanOrEqual(safeLeft);
    expect(toggle.right).toBeLessThanOrEqual(width - safeRight);
    expect(toggle.top).toBe(safeTop);
    expect(OWNER_TOOLBAR_CSS).toContain('pointer-events:none');
    expect(OWNER_TOOLBAR_CSS).toContain('.ot-toggle:focus-visible');
    expect(OWNER_TOOLBAR_CSS).toContain('outline:3px solid #d8fa72');
    expect(OWNER_TOOLBAR_CSS).toContain('min-height:44px');
  });
});
