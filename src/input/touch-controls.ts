/** Digital driving controls a touch button can hold. */
export type TouchButtonControl = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake';
/** What a finger is currently doing: holding a button, or dragging the analog steer zone. */
export type TouchTarget = TouchButtonControl | 'steer-zone';
export type TouchSteerMode = 'buttons' | 'drag';

export const TOUCH_BUTTON_CONTROLS: readonly TouchButtonControl[] = ['throttle', 'brake', 'left', 'right', 'handbrake'];
export const isTouchButtonControl = (value: unknown): value is TouchButtonControl =>
  typeof value === 'string' && (TOUCH_BUTTON_CONTROLS as readonly string[]).includes(value);

/** Horizontal CSS pixels from the drag origin to full lock. */
export const DRAG_STEER_RADIUS_PX = 64;
const DRAG_DEAD_ZONE = 0.06;

interface Finger { target: TouchTarget; originX: number; value: number }

/**
 * DOM-free multi-touch state. Each pointer id owns exactly one target, so steer, gas and handbrake can
 * be held at once, a finger can slide from one button onto another, and lifting any finger releases
 * only what that finger held. `releaseAll` is the stuck-input escape hatch (blur, hidden page, menus).
 */
export class TouchControlTracker {
  private readonly fingers = new Map<number, Finger>();

  get activePointers(): number { return this.fingers.size; }
  has(pointerId: number): boolean { return this.fingers.has(pointerId); }

  down(pointerId: number, target: TouchTarget, clientX = 0): void {
    this.fingers.set(pointerId, { target, originX: clientX, value: 0 });
  }

  /**
   * A finger moved. `under` is the button currently beneath it (null over empty space). Sliding onto
   * another button hands the finger over to that button; sliding off into empty space keeps the last
   * button, so a thumb drifting a little off Gas does not drop the throttle. A drag-steer finger stays
   * on the steer zone wherever it goes and turns horizontal travel into an analog value.
   */
  move(pointerId: number, under: TouchButtonControl | null, clientX = 0): boolean {
    const finger = this.fingers.get(pointerId);
    if (!finger) return false;
    if (finger.target === 'steer-zone') {
      let dx = clientX - finger.originX;
      // Floating origin: once past full lock, drag the origin along so reversing direction responds at once.
      if (Math.abs(dx) > DRAG_STEER_RADIUS_PX) { finger.originX = clientX - Math.sign(dx) * DRAG_STEER_RADIUS_PX; dx = clientX - finger.originX; }
      const raw = dx / DRAG_STEER_RADIUS_PX, magnitude = Math.abs(raw);
      const value = magnitude <= DRAG_DEAD_ZONE ? 0 : Math.sign(raw) * Math.min(1, (magnitude - DRAG_DEAD_ZONE) / (1 - DRAG_DEAD_ZONE));
      const changed = value !== finger.value; finger.value = value; return changed;
    }
    if (under && under !== finger.target) { finger.target = under; return true; }
    return false;
  }

  up(pointerId: number): boolean { return this.fingers.delete(pointerId); }
  releaseAll(): boolean { const had = this.fingers.size > 0; this.fingers.clear(); return had; }

  /** Buttons held by at least one finger. */
  held(): Set<TouchButtonControl> {
    const held = new Set<TouchButtonControl>();
    for (const finger of this.fingers.values()) if (finger.target !== 'steer-zone') held.add(finger.target);
    return held;
  }

  /** Analog steering from the most recent drag-steer finger, or null when none is down. */
  analogSteer(): number | null {
    let value: number | null = null;
    for (const finger of this.fingers.values()) if (finger.target === 'steer-zone') value = finger.value;
    return value;
  }
}

/**
 * Deterministic per-simulation-tick steering ramp shared by keyboard, touch buttons and drag steer:
 * ~0.18 s to full lock, faster when reversing direction, and a quicker self-centre on release, so
 * digital countersteer feels like a wheel, not a switch.
 */
export function rampSteering(current: number, target: number): number {
  const rate = target === 0 ? 0.16 : Math.sign(target) !== Math.sign(current) && current !== 0 ? 0.2 : 0.095;
  return current + Math.max(-rate, Math.min(rate, target - current));
}
