import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_STEER_RADIUS_PX, TouchControlTracker, rampSteering } from '../../src/input/touch-controls';
import { PlayerInput } from '../../src/input/player-input';

describe('touch control tracker', () => {
  it('holds steer, gas and handbrake on separate fingers at the same time', () => {
    const touch = new TouchControlTracker();
    touch.down(1, 'left'); touch.down(2, 'throttle'); touch.down(3, 'handbrake');
    expect([...touch.held()].sort()).toEqual(['handbrake', 'left', 'throttle']);
    touch.up(3);
    expect([...touch.held()].sort()).toEqual(['left', 'throttle']);
  });

  it('keeps a control held while another finger still holds it', () => {
    const touch = new TouchControlTracker();
    touch.down(1, 'throttle'); touch.down(2, 'throttle'); touch.up(1);
    expect(touch.held().has('throttle')).toBe(true);
    touch.up(2);
    expect(touch.held().size).toBe(0);
  });

  it('hands a sliding finger to the button beneath it and keeps the last button over empty space', () => {
    const touch = new TouchControlTracker();
    touch.down(7, 'left');
    expect(touch.move(7, 'right')).toBe(true);
    expect([...touch.held()]).toEqual(['right']);
    expect(touch.move(7, null)).toBe(false);
    expect([...touch.held()]).toEqual(['right']);
    touch.up(7);
    expect(touch.held().size).toBe(0);
  });

  it('ignores moves and lifts from unknown pointers', () => {
    const touch = new TouchControlTracker();
    expect(touch.move(9, 'throttle')).toBe(false);
    expect(touch.up(9)).toBe(false);
    expect(touch.held().size).toBe(0);
  });

  it('maps drag-steer travel to an analog value with a dead zone and a floating origin', () => {
    const touch = new TouchControlTracker();
    touch.down(4, 'steer-zone', 100);
    expect(touch.analogSteer()).toBe(0);
    touch.move(4, null, 102);
    expect(touch.analogSteer()).toBe(0);
    touch.move(4, null, 100 + DRAG_STEER_RADIUS_PX / 2);
    expect(touch.analogSteer()).toBeGreaterThan(0.4);
    expect(touch.analogSteer()).toBeLessThan(0.5);
    touch.move(4, null, 100 + DRAG_STEER_RADIUS_PX * 3);
    expect(touch.analogSteer()).toBe(1);
    // The origin followed the finger, so one radius back is centre and two is full opposite lock.
    touch.move(4, null, 100 + DRAG_STEER_RADIUS_PX * 2);
    expect(touch.analogSteer()).toBe(0);
    touch.move(4, null, 100 + DRAG_STEER_RADIUS_PX);
    expect(touch.analogSteer()).toBe(-1);
    expect(touch.held().size).toBe(0);
    touch.up(4);
    expect(touch.analogSteer()).toBeNull();
  });

  it('releaseAll drops every finger', () => {
    const touch = new TouchControlTracker();
    touch.down(1, 'throttle'); touch.down(2, 'steer-zone', 0);
    expect(touch.releaseAll()).toBe(true);
    expect(touch.held().size).toBe(0);
    expect(touch.analogSteer()).toBeNull();
    expect(touch.releaseAll()).toBe(false);
  });
});

describe('steering ramp', () => {
  it('reaches full lock in a bounded number of ticks, reverses faster and self-centres', () => {
    let steer = 0, ticks = 0;
    while (steer < 1) { steer = rampSteering(steer, 1); ticks++; }
    expect(ticks).toBe(11);
    expect(rampSteering(1, -1)).toBeCloseTo(0.8);
    expect(rampSteering(0.5, 0)).toBeCloseTo(0.34);
    expect(rampSteering(0.3, 0.3)).toBe(0.3);
  });
});

type Listener = (event: Record<string, unknown>) => void;
class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  fire(type: string, event: Record<string, unknown> = {}): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ preventDefault() {}, ...event }); }
  count(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}
class FakeButton {
  readonly dataset: Record<string, string>;
  readonly pressed = new Set<string>();
  readonly classList = { toggle: (name: string, on: boolean) => { if (on) this.pressed.add(name); else this.pressed.delete(name); }, remove: (name: string) => this.pressed.delete(name) };
  captured: number | null = null;
  constructor(control: string) { this.dataset = { control }; }
  closest(selector: string): FakeButton | null { return selector.includes('[data-control]') ? this : null; }
  hasAttribute(): boolean { return false; }
  setPointerCapture(id: number): void { this.captured = id; }
}

describe('PlayerInput touch driving', () => {
  let win: FakeTarget, doc: FakeTarget & { hidden: boolean; activeElement: unknown; elementFromPoint: (x: number, y: number) => unknown };
  let buttons: Record<string, FakeButton>, root: FakeTarget & { hidden: boolean; dataset: Record<string, string> }, underFinger: FakeButton | null;
  beforeEach(() => {
    win = new FakeTarget();
    underFinger = null;
    doc = Object.assign(new FakeTarget(), { hidden: false, activeElement: null, elementFromPoint: () => underFinger, createElement: () => ({ remove() {} }) });
    buttons = Object.fromEntries(['left', 'right', 'throttle', 'brake', 'handbrake'].map(control => [control, new FakeButton(control)]));
    root = Object.assign(new FakeTarget(), {
      hidden: false, dataset: {} as Record<string, string>,
      contains: (element: unknown) => Object.values(buttons).includes(element as FakeButton),
      querySelectorAll: () => Object.values(buttons),
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const create = () => new PlayerInput(Object.assign(new FakeTarget(), { tabIndex: 0, parentElement: null, focus() {} }) as unknown as HTMLCanvasElement, root as unknown as HTMLElement);
  const press = (id: number, control: string, clientX = 0) => root.fire('pointerdown', { pointerId: id, pointerType: 'touch', button: 0, clientX, clientY: 0, target: buttons[control] });

  it('drives with gas, steering and handbrake held together and paints pressed buttons', () => {
    const input = create();
    press(1, 'throttle'); press(2, 'left'); press(3, 'handbrake');
    let frame = input.read(1);
    expect(frame.throttle).toBe(1);
    expect(frame.handbrake).toBe(1);
    expect(frame.steering).toBeCloseTo(-0.095);
    for (let tick = 2; tick < 20; tick++) frame = input.read(tick);
    expect(frame.steering).toBe(-1);
    expect(buttons.throttle!.pressed.has('is-pressed')).toBe(true);
    expect(buttons.throttle!.captured).toBe(1);
    expect(input.activeDevice).toBe('touch');
    root.fire('pointerup', { pointerId: 3 });
    frame = input.read(21);
    expect(frame.handbrake).toBe(0);
    expect(frame.throttle).toBe(1);
    expect(buttons.handbrake!.pressed.has('is-pressed')).toBe(false);
    input.dispose();
  });

  it('follows a finger sliding from left to right steering', () => {
    const input = create();
    press(5, 'left');
    input.read(1);
    underFinger = buttons.right!;
    root.fire('pointermove', { pointerId: 5, clientX: 80, clientY: 0 });
    expect(input.read(2).steering).toBeGreaterThan(-0.095);
    expect(buttons.right!.pressed.has('is-pressed')).toBe(true);
    expect(buttons.left!.pressed.has('is-pressed')).toBe(false);
    input.dispose();
  });

  it.each([
    ['pointercancel', () => root.fire('pointercancel', { pointerId: 1 })],
    ['lost pointer capture', () => root.fire('lostpointercapture', { pointerId: 1 })],
    ['a lift seen only by the window', () => win.fire('pointerup', { pointerId: 1 })],
    ['window blur', () => win.fire('blur')],
    ['page hide', () => win.fire('pagehide')],
    ['the page becoming hidden', () => { doc.hidden = true; doc.fire('visibilitychange'); }],
  ])('never leaves gas stuck after %s', (_name, release) => {
    const input = create();
    press(1, 'throttle');
    expect(input.read(1).throttle).toBe(1);
    release();
    expect(input.read(2).throttle).toBe(0);
    expect(buttons.throttle!.pressed.has('is-pressed')).toBe(false);
    input.dispose();
  });

  it('only accepts touch while driving and releases held controls on entering a menu', () => {
    const input = create();
    press(1, 'throttle');
    input.setMenuMode(true);
    expect(input.read(1).throttle).toBe(0);
    press(2, 'throttle');
    expect(input.read(2).throttle).toBe(0);
    input.setMenuMode(false);
    press(3, 'throttle');
    expect(input.read(3).throttle).toBe(1);
    input.dispose();
  });

  it('turns the steer buttons into an analog drag surface in drag mode', () => {
    const input = create();
    input.setTouchSteerMode('drag');
    expect(root.dataset.steerMode).toBe('drag');
    press(1, 'left', 200);
    root.fire('pointermove', { pointerId: 1, clientX: 200 + DRAG_STEER_RADIUS_PX, clientY: 0 });
    let frame = input.read(1);
    for (let tick = 2; tick < 20; tick++) frame = input.read(tick);
    expect(frame.steering).toBe(1);
    expect(buttons.right!.pressed.has('is-pressed')).toBe(true);
    expect(buttons.left!.pressed.has('is-pressed')).toBe(false);
    root.fire('pointerup', { pointerId: 1 });
    for (let tick = 20; tick < 40; tick++) frame = input.read(tick);
    expect(frame.steering).toBe(0);
    expect(() => input.setTouchSteerMode('tilt' as never)).toThrow();
    input.dispose();
  });

  it('removes every listener it added on dispose', () => {
    const input = create();
    input.dispose();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu', 'touchstart']) expect(root.count(type)).toBe(0);
    for (const type of ['pointerup', 'pointercancel', 'keydown', 'keyup', 'blur', 'pagehide']) expect(win.count(type)).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
  });
});
