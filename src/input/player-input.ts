import type { InputFrame } from '../../contracts/runtime-contracts';
import type { InputSource } from '../core/game-runtime';
import { detectDeviceProfile } from '../platform/device-profile';
import { remapGamepad, remapKeyboard } from './bindings';
import { TouchControlTracker, isTouchButtonControl, rampSteering, type TouchButtonControl, type TouchSteerMode } from './touch-controls';

export type InputDevice = 'keyboard' | 'gamepad' | 'touch' | 'unknown';
export type PlayerAction = 'pause' | 'camera';
export type GamepadMenuAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back';
export type KeyboardAction = 'throttle' | 'brake' | 'steerLeft' | 'steerRight' | 'handbrake' | 'reset' | 'pause' | 'camera' | 'shiftUp' | 'shiftDown';
type Control = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake';
export interface KeyboardBindings {
  schemaVersion: 1; throttle: string[]; brake: string[]; steerLeft: string[]; steerRight: string[];
  handbrake: string[]; reset: string[]; pause: string[]; camera: string[]; shiftUp: string[]; shiftDown: string[];
}
export interface GamepadBindings {
  schemaVersion: 1; steerAxis: number; throttleButton: number; brakeButton: number; handbrakeButton: number;
  resetButton: number; pauseButton: number; cameraButton: number; shiftUpButton: number; shiftDownButton: number;
}
export type GamepadBindingAction = keyof Omit<GamepadBindings,'schemaVersion'>;
/** Outcome of one remap capture: done (maybe moving the key from another action), refused, or cancelled. */
export interface RemapEvent { readonly device: 'keyboard' | 'gamepad'; readonly action: KeyboardAction | GamepadBindingAction; readonly status: 'done' | 'refused' | 'cancelled'; readonly movedFrom: KeyboardAction | GamepadBindingAction | null; readonly message: string | null }
export const DEFAULT_KEYBOARD_BINDINGS = JSON.stringify({ schemaVersion: 1, throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], steerLeft: ['KeyA', 'ArrowLeft'], steerRight: ['KeyD', 'ArrowRight'], handbrake: ['Space'], reset: ['KeyR'], pause: ['Escape'], camera: ['KeyC'], shiftUp: ['KeyE'], shiftDown: ['KeyQ'] });
export const DEFAULT_GAMEPAD_BINDINGS = JSON.stringify({ schemaVersion: 1, steerAxis: 0, throttleButton: 7, brakeButton: 6, handbrakeButton: 0, resetButton: 1, pauseButton: 9, cameraButton: 3, shiftUpButton: 4, shiftDownButton: 5 });
const DEFAULT_KEYBOARD = JSON.parse(DEFAULT_KEYBOARD_BINDINGS) as KeyboardBindings;
const DEFAULT_GAMEPAD = JSON.parse(DEFAULT_GAMEPAD_BINDINGS) as GamepadBindings;
const KEYBOARD_ACTIONS: readonly KeyboardAction[] = ['throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake', 'reset', 'pause', 'camera', 'shiftUp', 'shiftDown'];
const GAMEPAD_FIELDS: readonly (keyof Omit<GamepadBindings, 'schemaVersion'|'steerAxis'>)[] = ['throttleButton','brakeButton','handbrakeButton','resetButton','pauseButton','cameraButton','shiftUpButton','shiftDownButton'];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Browser input adapter with normalized controls, edge actions and focus/disconnect recovery. */
export class PlayerInput implements InputSource {
  private readonly held = new Set<Control>();
  private readonly listeners = new Set<(action: PlayerAction) => void>();
  private readonly touch = new TouchControlTracker();
  private touchEnabled = true;
  private touchSteerMode: TouchSteerMode = readStoredSteerMode();
  private readonly touchRoot: HTMLElement;
  private readonly madeTouchRoot: boolean;
  private readonly style = document.createElement('style');
  private readonly previousParentPosition: string | null;
  private readonly firstControlListeners = new Set<(device: Exclude<InputDevice,'unknown'>) => void>();
  private readonly menuListeners = new Set<(action: GamepadMenuAction) => void>();
  private readonly bindingsListeners = new Set<(bindings: { keyboard: string; gamepad: string }) => void>();
  private readonly menuButtonEdges = new Map<string, boolean>();
  private keyboard: KeyboardBindings = structuredClone(DEFAULT_KEYBOARD);
  private gamepadBindings: GamepadBindings = { ...DEFAULT_GAMEPAD };
  private shift = 0;
  private resetPressed = false;
  // Touch-first devices start out showing touch prompts; any key, pad or finger then takes over.
  private device: InputDevice = detectDeviceProfile().touch ? 'touch' : 'unknown';
  private firstControlSent = false;
  private disposed = false;
  private menuMode = false;
  private gamepadBlocked = false;
  private gamepadPauseWasDown = false;
  private gamepadCameraWasDown = false;
  private gamepadResetWasDown = false;
  private gamepadShiftUpWasDown = false;
  private gamepadShiftDownWasDown = false;
  private pendingRemap: KeyboardAction | null = null;
  private pendingGamepadRemap: GamepadBindingAction | null = null;
  private gamepadRemapArmed = false;
  private readonly remapListeners = new Set<(event: RemapEvent) => void>();
  private actionRaf = 0;

  constructor(private readonly canvas: HTMLCanvasElement, controlsRoot?: HTMLElement) {
    canvas.tabIndex = canvas.tabIndex < 0 ? 0 : canvas.tabIndex;
    this.madeTouchRoot = !controlsRoot; this.touchRoot = controlsRoot ?? document.createElement('div');
    const parent = canvas.parentElement; this.previousParentPosition = !controlsRoot && parent ? parent.style.position : null;
    if (this.madeTouchRoot) {
      this.style.textContent = `.lateral-touch-controls{position:absolute;z-index:4;inset:auto 12px max(12px,env(safe-area-inset-bottom));display:flex;justify-content:space-between;align-items:end;pointer-events:none;touch-action:none;user-select:none}.lateral-touch-controls button{pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;border:1px solid #ffffff65;border-radius:14px;background:#101c27cf;color:#fff;min-width:58px;min-height:58px;font:700 16px system-ui}.lateral-touch-controls [data-control=throttle]{min-width:78px;min-height:80px;background:#d98d37e8;color:#111}.lateral-touch-controls [data-control=brake]{min-height:68px}.lateral-touch-controls .is-pressed{transform:scale(.95);filter:brightness(1.35)}.lateral-steer,.lateral-pedals{display:flex;align-items:end;gap:8px}.lateral-touch-controls [data-recover]{position:absolute;right:0;bottom:calc(100% + 10px);min-width:0;min-height:40px;padding:0 12px;font-size:12px}@media(hover:hover) and (pointer:fine){.lateral-touch-controls{display:none}}@media(max-height:420px){.lateral-touch-controls button{min-width:50px;min-height:50px}.lateral-touch-controls [data-control=throttle]{min-height:60px}}`;
      document.head.append(this.style); if (parent && !parent.style.position) parent.style.position = 'relative';
      this.touchRoot.className = 'lateral-touch-controls'; this.touchRoot.setAttribute('aria-label','Driving controls');
      this.touchRoot.innerHTML = `<div class="lateral-steer"><button type="button" data-control="left" aria-label="Steer left">◀</button><button type="button" data-control="right" aria-label="Steer right">▶</button></div><div class="lateral-pedals"><button type="button" data-control="handbrake" aria-label="Handbrake">HB</button><button type="button" data-control="brake" aria-label="Brake">Brake</button><button type="button" data-control="throttle" aria-label="Throttle">Gas</button></div><button type="button" data-recover aria-label="Recover car (R)">&#8634; Recover</button>`;
      (parent ?? document.body).append(this.touchRoot);
    }
    this.touchRoot.dataset.steerMode = this.touchSteerMode;
    this.touchRoot.addEventListener('pointerdown', this.pointerDown); this.touchRoot.addEventListener('pointermove', this.pointerMove);
    this.touchRoot.addEventListener('pointerup', this.pointerUp); this.touchRoot.addEventListener('pointercancel', this.pointerUp);
    this.touchRoot.addEventListener('lostpointercapture', this.pointerUp); this.touchRoot.addEventListener('contextmenu', this.preventDefault);
    this.touchRoot.addEventListener('touchstart', this.touchStart, { passive: false });
    // Window-level backstops: a finger lifted after capture was refused still releases its control.
    window.addEventListener('pointerup', this.pointerUp, true); window.addEventListener('pointercancel', this.pointerUp, true);
    window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp); window.addEventListener('blur', this.clear);
    window.addEventListener('pagehide', this.clear);
    document.addEventListener('visibilitychange', this.visibility); window.addEventListener('gamepaddisconnected', this.gamepadDisconnected);
    canvas.addEventListener('pointerdown', this.focusCanvas); this.actionRaf = requestAnimationFrame(this.pollActions);
  }

  get activeDevice(): InputDevice { return this.device; }
  onAction(listener: (action: PlayerAction) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFirstControl(listener: (device: Exclude<InputDevice,'unknown'>) => void): () => void { this.firstControlListeners.add(listener); return () => this.firstControlListeners.delete(listener); }
  onMenuAction(listener: (action: GamepadMenuAction) => void): () => void { this.menuListeners.add(listener); return () => this.menuListeners.delete(listener); }
  onRemap(listener: (event: RemapEvent) => void): () => void { this.remapListeners.add(listener); return () => this.remapListeners.delete(listener); }
  /** The action waiting for a key or button, if a capture is running. */
  get pendingRemapAction(): KeyboardAction | GamepadBindingAction | null { return this.pendingRemap ?? this.pendingGamepadRemap; }
  cancelRemap(): void {
    const action = this.pendingRemap ?? this.pendingGamepadRemap, device = this.pendingRemap ? 'keyboard' : 'gamepad';
    this.pendingRemap = null; this.pendingGamepadRemap = null;
    if (action) this.emitRemap({ device, action, status: 'cancelled', movedFrom: null, message: null });
  }
  onBindingsChanged(listener: (bindings: { keyboard: string; gamepad: string }) => void): () => void { this.bindingsListeners.add(listener); return () => this.bindingsListeners.delete(listener); }
  setMenuMode(active: boolean): void { if (this.menuMode === active) return; this.menuMode = active; this.setTouchEnabled(!active); if (active) this.clear(); }
  /** Touch controls only accept fingers while driving; disabling releases anything still held. */
  setTouchEnabled(enabled: boolean): void { this.touchEnabled = enabled; if (this.madeTouchRoot) this.touchRoot.hidden = !enabled; if (!enabled) this.clear(); }
  get touchControlsEnabled(): boolean { return this.touchEnabled; }
  /** 'buttons' (default): ◀ ▶ buttons with the digital ramp. 'drag': a finger on the steer area is an analog slider. */
  get steerMode(): TouchSteerMode { return this.touchSteerMode; }
  setTouchSteerMode(mode: TouchSteerMode): void {
    if (mode !== 'buttons' && mode !== 'drag') throw new Error('Unknown touch steering mode');
    this.touchSteerMode = mode; this.touchRoot.dataset.steerMode = mode; this.releaseTouch();
    try { localStorage.setItem(STEER_MODE_KEY, mode); } catch { /* storage blocked: keep for this session */ }
  }
  focusDrivingCanvas(): void { this.canvas.focus({ preventScroll:true }); }
  getBindings(): { keyboard: string; gamepad: string } { return { keyboard: JSON.stringify(this.keyboard), gamepad: JSON.stringify(this.gamepadBindings) }; }
  setBindings(keyboardJson: string, gamepadJson: string): void {
    const result = validateBindings(keyboardJson, gamepadJson);
    if (!result.valid || !result.keyboard || !result.gamepad) throw new Error(result.errors.join('; '));
    this.keyboard = result.keyboard; this.gamepadBindings = result.gamepad; this.clear();
  }
  beginRemap(action: KeyboardAction): void { this.pendingGamepadRemap = null; this.pendingRemap = action; }
  // Armed only once the pad is neutral, so the button that opened the capture is not captured itself.
  beginGamepadRemap(action: GamepadBindingAction): void { this.pendingRemap = null; this.pendingGamepadRemap = action; this.gamepadRemapArmed = false; }

  private keySteer = 0;
  read(tick: number): InputFrame {
    const touchHeld = this.touch.held(), has = (control: Control) => this.held.has(control) || touchHeld.has(control);
    let throttle = Number(has('throttle')), brake = Number(has('brake'));
    // Keyboard, touch buttons and drag steer all feed one deterministic per-tick ramp (see rampSteering).
    const analog = this.touch.analogSteer();
    const keyTarget = Number(has('right')) - Number(has('left'));
    this.keySteer = rampSteering(this.keySteer, keyTarget !== 0 ? keyTarget : analog ?? 0);
    let steering = this.keySteer;
    let handbrake = Number(has('handbrake'));
    const pad = navigator.getGamepads?.().find(candidate => candidate?.connected);
    if (pad) {
      if (this.gamepadBlocked && isNeutral(pad)) this.gamepadBlocked = false;
      if (!this.gamepadBlocked) {
      const axisValue = pad.axes[this.gamepadBindings.steerAxis] ?? 0, magnitude = Math.abs(axisValue), deadZone = 0.14;
      const shaped = magnitude <= deadZone ? 0 : Math.sign(axisValue) * Math.pow((magnitude - deadZone) / (1 - deadZone), 1.35);
      if (Math.abs(shaped) > Math.abs(steering)) steering = shaped;
      throttle = Math.max(throttle, trigger(pad.buttons[this.gamepadBindings.throttleButton]));
      brake = Math.max(brake, trigger(pad.buttons[this.gamepadBindings.brakeButton]));
      handbrake = Math.max(handbrake, Number(Boolean(pad.buttons[this.gamepadBindings.handbrakeButton]?.pressed)));
      const resetDown = Boolean(pad.buttons[this.gamepadBindings.resetButton]?.pressed);
      if (resetDown && !this.gamepadResetWasDown) this.resetPressed = true;
      this.gamepadResetWasDown = resetDown;
      const shiftUpDown = Boolean(pad.buttons[this.gamepadBindings.shiftUpButton]?.pressed);
      const shiftDownDown = Boolean(pad.buttons[this.gamepadBindings.shiftDownButton]?.pressed);
      if (shiftUpDown && !this.gamepadShiftUpWasDown) this.shift = 1;
      if (shiftDownDown && !this.gamepadShiftDownWasDown) this.shift = -1;
      this.gamepadShiftUpWasDown = shiftUpDown; this.gamepadShiftDownWasDown = shiftDownDown;
      if (Math.abs(shaped) > .03 || throttle > 0 || brake > 0 || handbrake > 0) { this.device = 'gamepad'; this.noteFirstControl('gamepad'); }
      }
    }
    const frame: InputFrame = { simulationTick: tick, throttle: clamp(throttle,0,1), brake: clamp(brake,0,1), steering: clamp(steering,-1,1), handbrake: clamp(handbrake,0,1), shift: this.shift as -1|0|1, resetPressed: this.resetPressed };
    if (this.device === 'touch' && (throttle > 0 || brake > 0 || Math.abs(steering) > 0 || handbrake > 0)) this.noteFirstControl('touch');
    this.shift = 0; this.resetPressed = false; return frame;
  }

  clear = (): void => {
    this.held.clear(); this.shift = 0; this.resetPressed = false; this.gamepadBlocked = true; this.releaseTouch();
  };
  private releaseTouch(): void { this.touch.releaseAll(); this.paintTouch(); }
  /** Mirror held touch targets onto the buttons as .is-pressed (styling belongs to the UI layer). */
  private paintTouch(): void {
    const held = this.touch.held(), analog = this.touch.analogSteer();
    // While drag-steering, light the ◀ or ▶ button on the side the finger is steering towards.
    if (analog !== null && analog < 0) held.add('left'); else if (analog !== null && analog > 0) held.add('right');
    for (const element of this.touchRoot.querySelectorAll<HTMLElement>('[data-control],[data-steer-zone]')) {
      const control = element.dataset.control;
      element.classList.toggle('is-pressed', isTouchButtonControl(control) ? held.has(control) : analog !== null && element.hasAttribute('data-steer-zone'));
    }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.clear(); cancelAnimationFrame(this.actionRaf);
    this.touchRoot.removeEventListener('pointerdown', this.pointerDown); this.touchRoot.removeEventListener('pointermove', this.pointerMove);
    this.touchRoot.removeEventListener('pointerup', this.pointerUp); this.touchRoot.removeEventListener('pointercancel', this.pointerUp);
    this.touchRoot.removeEventListener('lostpointercapture', this.pointerUp); this.touchRoot.removeEventListener('contextmenu', this.preventDefault);
    this.touchRoot.removeEventListener('touchstart', this.touchStart);
    window.removeEventListener('pointerup', this.pointerUp, true); window.removeEventListener('pointercancel', this.pointerUp, true);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.clear);
    window.removeEventListener('pagehide', this.clear);
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('gamepaddisconnected', this.gamepadDisconnected); this.canvas.removeEventListener('pointerdown', this.focusCanvas);
    this.listeners.clear(); this.firstControlListeners.clear(); this.menuListeners.clear(); this.bindingsListeners.clear();
    if (this.madeTouchRoot) { this.touchRoot.remove(); this.style.remove(); if (this.canvas.parentElement && this.previousParentPosition !== null) this.canvas.parentElement.style.position = this.previousParentPosition; }
  }

  private focusCanvas = (): void => { this.canvas.focus({ preventScroll:true }); };
  private visibility = (): void => { if (document.hidden) this.clear(); };
  private gamepadDisconnected = (): void => { if (![...navigator.getGamepads()].some(pad => pad?.connected)) { this.clear(); this.gamepadPauseWasDown = this.gamepadCameraWasDown = this.gamepadResetWasDown = false; this.gamepadShiftUpWasDown = this.gamepadShiftDownWasDown = false; if (this.device === 'gamepad') this.device = 'unknown'; } };
  private emit(action: PlayerAction): void { for (const listener of this.listeners) listener(action); }
  private emitMenu(action: GamepadMenuAction): void { for (const listener of this.menuListeners) listener(action); }
  private noteFirstControl(device: Exclude<InputDevice,'unknown'>): void { if (this.firstControlSent) return; this.firstControlSent = true; for (const listener of this.firstControlListeners) listener(device); }
  private pollActions = (): void => {
    if (this.disposed) return; this.actionRaf = requestAnimationFrame(this.pollActions);
    if (document.hidden) return;
    const pad = navigator.getGamepads?.().find(candidate => candidate?.connected); if (!pad) return;
    if (this.pendingGamepadRemap) {
      if (!this.gamepadRemapArmed) { this.gamepadRemapArmed = isNeutral(pad); return; }
      const action = this.pendingGamepadRemap;
      const value = action === 'steerAxis' ? pad.axes.findIndex(axis => Math.abs(axis) > .65) : pad.buttons.findIndex(button => button.pressed);
      if (value < 0) return;
      const result = remapGamepad(this.gamepadBindings, action, value);
      if (result.error) { this.emitRemap({ device: 'gamepad', action, status: 'refused', movedFrom: null, message: result.error }); this.gamepadRemapArmed = false; return; }
      this.gamepadBindings = result.bindings; this.pendingGamepadRemap = null; this.gamepadBlocked = true;
      this.publishBindings(); this.emitRemap({ device: 'gamepad', action, status: 'done', movedFrom: result.movedFrom, message: null });
      return;
    }
    if (this.gamepadBlocked && isNeutral(pad)) this.gamepadBlocked = false; if (this.gamepadBlocked) return;
    const edge = (key: string, down: boolean, action: () => void): void => { const old = this.menuButtonEdges.get(key) ?? false; if (down && !old) action(); this.menuButtonEdges.set(key,down); };
    edge('pause',Boolean(pad.buttons[this.gamepadBindings.pauseButton]?.pressed),()=>this.emit('pause'));
    edge('camera',Boolean(pad.buttons[this.gamepadBindings.cameraButton]?.pressed),()=>this.emit('camera'));
    if (this.menuMode) {
      edge('up',Boolean(pad.buttons[12]?.pressed)||(pad.axes[1]??0)<-.55,()=>this.emitMenu('up'));
      edge('down',Boolean(pad.buttons[13]?.pressed)||(pad.axes[1]??0)>.55,()=>this.emitMenu('down'));
      edge('left',Boolean(pad.buttons[14]?.pressed)||(pad.axes[0]??0)<-.55,()=>this.emitMenu('left'));
      edge('right',Boolean(pad.buttons[15]?.pressed)||(pad.axes[0]??0)>.55,()=>this.emitMenu('right'));
      edge('accept',Boolean(pad.buttons[0]?.pressed),()=>this.emitMenu('accept'));
      edge('back',Boolean(pad.buttons[1]?.pressed),()=>this.emitMenu('back'));
    } else for (const key of ['up','down','left','right','accept','back']) this.menuButtonEdges.set(key,false);
  };
  private ownsFocus(): boolean {
    const target = document.activeElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return false;
    return target === this.canvas || this.touchRoot.contains(target) || Boolean(this.canvas.parentElement?.contains(target));
  }
  /**
   * Esc is the universal back key, so it must also reach the menus when focus sits on a slider, checkbox or select in
   * a panel (clicking one focuses it) or has fallen back to the page body (the focused button was re-rendered away).
   * Text fields keep Esc for themselves (the plate field blurs on it).
   */
  private ownsEscape(): boolean {
    return this.ownsFocus() || escapeReachesMenus(document.activeElement, document, this.canvas.parentElement);
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape' && !this.pendingRemap && !this.ownsFocus() && this.ownsEscape()) {
      if (!event.repeat || this.menuMode) { this.emit('pause'); event.preventDefault(); }
      return;
    }
    if (!this.ownsFocus()) return;
    if (this.pendingRemap) {
      event.preventDefault(); event.stopPropagation(); if (event.code === 'Escape') { this.cancelRemap(); return; }
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      const action = this.pendingRemap, result = remapKeyboard(this.keyboard, action, event.code);
      if (result.error) { this.emitRemap({ device: 'keyboard', action, status: 'refused', movedFrom: null, message: result.error }); return; }
      this.keyboard = result.bindings; this.pendingRemap = null;
      this.publishBindings(); this.emitRemap({ device: 'keyboard', action, status: 'done', movedFrom: result.movedFrom, message: null }); return;
    }
    if (this.menuMode) {
      if (event.code.startsWith('Arrow')) { this.emitMenu(event.code.slice(5).toLowerCase() as GamepadMenuAction); event.preventDefault(); }
      else if (event.code === 'Enter' || event.code === 'Space') { this.emitMenu('accept'); event.preventDefault(); }
      else if (event.code === 'Escape') { this.emit('pause'); event.preventDefault(); }
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const action = KEYBOARD_ACTIONS.find(name => this.keyboard[name].includes(event.code));
    if (action === 'throttle' || action === 'brake' || action === 'steerLeft' || action === 'steerRight' || action === 'handbrake') {
      const control: Control = action === 'steerLeft' ? 'left' : action === 'steerRight' ? 'right' : action;
      this.held.add(control); this.device = 'keyboard'; this.noteFirstControl('keyboard'); if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault(); return;
    }
    if (event.repeat) return;
    if (action === 'pause') { this.emit('pause'); event.preventDefault(); }
    else if (action === 'camera') this.emit('camera');
    else if (action === 'reset') { this.resetPressed = true; this.device = 'keyboard'; this.noteFirstControl('keyboard'); }
    else if (action === 'shiftUp') { this.shift = 1; this.device = 'keyboard'; this.noteFirstControl('keyboard'); }
    else if (action === 'shiftDown') { this.shift = -1; this.device = 'keyboard'; this.noteFirstControl('keyboard'); }
  };
  private keyUp = (event: KeyboardEvent): void => {
    const action = KEYBOARD_ACTIONS.find(name => this.keyboard[name].includes(event.code));
    if (action === 'throttle') this.held.delete('throttle'); else if (action === 'brake') this.held.delete('brake'); else if (action === 'steerLeft') this.held.delete('left'); else if (action === 'steerRight') this.held.delete('right'); else if (action === 'handbrake') this.held.delete('handbrake');
  };
  private preventDefault = (event: Event): void => { event.preventDefault(); };
  /** Stop iOS from turning a held button into text selection, the loupe, double-tap zoom or a synthetic click. */
  private touchStart = (event: TouchEvent): void => {
    if (event.target instanceof Element && event.target.closest('[data-control],[data-steer-zone]')) event.preventDefault();
  };
  private touchTargetAt(element: Element | null, allowZone: boolean): TouchButtonControl | 'steer-zone' | null {
    if (!element || !this.touchRoot.contains(element)) return null;
    if (allowZone && element.closest('[data-steer-zone]')) return 'steer-zone';
    const control = element.closest<HTMLElement>('[data-control]')?.dataset.control;
    if (!isTouchButtonControl(control)) return null;
    // In drag mode the ◀ ▶ buttons (and their group) become the analog steer surface.
    if (allowZone && this.touchSteerMode === 'drag' && (control === 'left' || control === 'right')) return 'steer-zone';
    return control;
  }
  private pointerDown = (event: PointerEvent): void => {
    if (!this.touchEnabled || this.disposed || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // Recover is a one-shot action like R, not a held control.
    const recover = (event.target as Element | null)?.closest?.('[data-recover]') as HTMLElement | null | undefined;
    if (recover && this.touchRoot.contains(recover)) {
      event.preventDefault(); this.resetPressed = true; this.device = 'touch'; this.noteFirstControl('touch');
      recover.classList.add('is-pressed'); setTimeout(() => recover.classList.remove('is-pressed'), 180);
      return;
    }
    const target = this.touchTargetAt(event.target as Element | null, true);
    if (!target) return;
    event.preventDefault();
    try { (event.target as Element).setPointerCapture(event.pointerId); } catch { /* window backstop still releases it */ }
    this.touch.down(event.pointerId, target, event.clientX); this.paintTouch();
    this.device = 'touch'; this.noteFirstControl('touch');
  };
  private pointerMove = (event: PointerEvent): void => {
    if (!this.touch.has(event.pointerId)) return;
    // Pointer capture pins event.target to the first button, so hit-test the finger's real position.
    const under = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : null;
    const control = this.touchTargetAt(under, false);
    if (this.touch.move(event.pointerId, control === 'steer-zone' ? null : control, event.clientX)) this.paintTouch();
  };
  private pointerUp = (event: PointerEvent): void => { if (this.touch.up(event.pointerId)) this.paintTouch(); };
  private emitRemap(event: RemapEvent): void { for (const listener of this.remapListeners) listener(event); }
  private publishBindings(): void { const value = this.getBindings(); for (const listener of this.bindingsListeners) listener(value); }
}

export function validateBindings(keyboardJson: string, gamepadJson: string): { valid: boolean; errors: string[]; keyboard?: KeyboardBindings; gamepad?: GamepadBindings } {
  const errors: string[] = [];
  if (keyboardJson.length > 2048 || gamepadJson.length > 2048) return { valid:false, errors:['Bindings exceed 2048 characters'] };
  let keyboard: unknown, gamepad: unknown;
  try { keyboard = JSON.parse(keyboardJson); } catch { errors.push('Keyboard bindings are not valid JSON'); }
  try { gamepad = JSON.parse(gamepadJson); } catch { errors.push('Gamepad bindings are not valid JSON'); }
  if (!keyboard || typeof keyboard !== 'object' || Array.isArray(keyboard)) errors.push('Keyboard bindings must be an object');
  if (!gamepad || typeof gamepad !== 'object' || Array.isArray(gamepad)) errors.push('Gamepad bindings must be an object');
  if (errors.length) return { valid:false, errors };
  const key = keyboard as Record<string,unknown>, pad = gamepad as Record<string,unknown>;
  const keyNames = ['schemaVersion',...KEYBOARD_ACTIONS];
  if (!sameKeys(key,keyNames) || key.schemaVersion !== 1) errors.push('Keyboard bindings have an unsupported shape or schema version');
  const seenCodes = new Set<string>();
  for (const action of KEYBOARD_ACTIONS) {
    const codes = key[action];
    if (!Array.isArray(codes) || codes.length < 1 || codes.length > 3 || codes.some(code => typeof code !== 'string' || !isRemappableCode(code) || (code === 'Escape' && action !== 'pause'))) { errors.push(`Invalid keyboard mapping for ${action}`); continue; }
    for (const code of codes as string[]) { if (seenCodes.has(code)) errors.push(`Duplicate keyboard code ${code}`); seenCodes.add(code); }
  }
  const padNames = ['schemaVersion','steerAxis',...GAMEPAD_FIELDS];
  if (!sameKeys(pad,padNames) || pad.schemaVersion !== 1) errors.push('Gamepad bindings have an unsupported shape or schema version');
  if (!Number.isInteger(pad.steerAxis) || (pad.steerAxis as number) < 0 || (pad.steerAxis as number) > 3) errors.push('Gamepad steer axis must be from 0 to 3');
  const seenButtons = new Set<number>();
  for (const field of GAMEPAD_FIELDS) {
    const index = pad[field];
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 15) errors.push(`Invalid gamepad button ${String(field)}`);
    else if (seenButtons.has(index as number)) errors.push(`Duplicate gamepad button ${index}`);
    else seenButtons.add(index as number);
  }
  if (errors.length) return { valid:false, errors };
  return { valid:true, errors, keyboard:key as unknown as KeyboardBindings, gamepad:pad as unknown as GamepadBindings };
}

function sameKeys(value: Record<string,unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)); }
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color']);
/**
 * Whether Esc with focus on `target` belongs to the game menus: nothing focused (page body), or any control inside the
 * game root except a text field, which keeps Esc for itself.
 */
export function escapeReachesMenus(
  target: Pick<Element, 'tagName'> & { readonly type?: string; readonly isContentEditable?: boolean } | null,
  page: { readonly body: unknown; readonly documentElement: unknown },
  gameRoot: { contains(node: never): boolean } | null,
): boolean {
  if (!target || target === page.body || target === page.documentElement) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || target.isContentEditable === true) return false;
  if (tag === 'INPUT' && !NON_TEXT_INPUTS.has(String(target.type ?? 'text').toLowerCase())) return false;
  return Boolean(gameRoot?.contains(target as never));
}
function isRemappableCode(code: string): boolean { return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Escape'].includes(code); }
function isNeutral(pad: Gamepad): boolean { return pad.axes.every(axis => Math.abs(axis) < .14) && pad.buttons.every(button => !button.pressed && (button.value ?? 0) < .08); }
function trigger(button: GamepadButton|undefined): number { if (!button) return 0; const value=button.value??Number(button.pressed); return value<.08?0:clamp((value-.08)/.92,0,1); }

const STEER_MODE_KEY = 'lateral.touchSteerMode';
function readStoredSteerMode(): TouchSteerMode {
  try { return localStorage.getItem(STEER_MODE_KEY) === 'drag' ? 'drag' : 'buttons'; } catch { return 'buttons'; }
}

export function createPlayerInput(canvas: HTMLCanvasElement, controlsRoot?: HTMLElement): PlayerInput { return new PlayerInput(canvas,controlsRoot); }
