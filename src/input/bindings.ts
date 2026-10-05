/**
 * Pure control-remap rules shared by PlayerInput (capture) and the Controls page (display).
 * A key or button belongs to exactly one action. Binding a taken key moves it: the action that
 * lost it gets the remapped action's old key instead, so nothing is ever left unbound.
 */
import type { GamepadBindingAction, GamepadBindings, KeyboardAction, KeyboardBindings } from './player-input';

export const KEYBOARD_ACTION_ORDER: readonly KeyboardAction[] = ['throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake', 'reset', 'camera', 'shiftUp', 'shiftDown', 'pause'];
export const GAMEPAD_ACTION_ORDER: readonly GamepadBindingAction[] = ['steerAxis', 'throttleButton', 'brakeButton', 'handbrakeButton', 'resetButton', 'cameraButton', 'shiftUpButton', 'shiftDownButton', 'pauseButton'];
const GAMEPAD_BUTTON_FIELDS = GAMEPAD_ACTION_ORDER.filter(action => action !== 'steerAxis') as readonly Exclude<GamepadBindingAction, 'steerAxis'>[];

/** Keys the game uses outside the remappable set. Binding them would fire two things at once. */
export const RESERVED_KEYS: Readonly<Record<string, string>> = { KeyH: 'Horn' };

export const ACTION_LABELS: Readonly<Record<KeyboardAction, string>> = {
  throttle: 'Throttle', brake: 'Brake / reverse', steerLeft: 'Steer left', steerRight: 'Steer right', handbrake: 'Handbrake',
  reset: 'Recover', pause: 'Pause', camera: 'Camera', shiftUp: 'Shift up', shiftDown: 'Shift down',
};
/** Very short tags drawn on keycaps in the keyboard diagram. */
export const ACTION_TAGS: Readonly<Record<KeyboardAction, string>> = {
  throttle: 'GAS', brake: 'BRAKE', steerLeft: 'LEFT', steerRight: 'RIGHT', handbrake: 'HANDBRAKE',
  reset: 'RECOVER', pause: 'PAUSE', camera: 'CAM', shiftUp: 'UP', shiftDown: 'DOWN',
};
export const GAMEPAD_ACTION_KEY: Readonly<Record<GamepadBindingAction, KeyboardAction | 'steer'>> = {
  steerAxis: 'steer', throttleButton: 'throttle', brakeButton: 'brake', handbrakeButton: 'handbrake', resetButton: 'reset',
  pauseButton: 'pause', cameraButton: 'camera', shiftUpButton: 'shiftUp', shiftDownButton: 'shiftDown',
};

export function isRemappableKey(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Escape'].includes(code);
}

/** "KeyW" -> "W", "ArrowUp" -> "↑", "Space" -> "Space", "Escape" -> "Esc". */
export function keyLabel(code: string): string {
  if (code === 'Escape') return 'Esc';
  if (code === 'Space') return 'Space';
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** The action that currently owns `code`, if any. */
export function keyOwner(bindings: KeyboardBindings, code: string): KeyboardAction | null {
  for (const action of KEYBOARD_ACTION_ORDER) if (bindings[action].includes(code)) return action;
  return null;
}

/** Every key bound to more than one action (should stay empty; shown as a warning if storage was edited). */
export function keyboardConflicts(bindings: KeyboardBindings): { code: string; actions: KeyboardAction[] }[] {
  const owners = new Map<string, KeyboardAction[]>();
  for (const action of KEYBOARD_ACTION_ORDER) for (const code of bindings[action]) owners.set(code, [...(owners.get(code) ?? []), action]);
  return [...owners].filter(([, actions]) => actions.length > 1).map(([code, actions]) => ({ code, actions }));
}

export interface KeyboardRemapResult {
  readonly bindings: KeyboardBindings;
  /** The action that gave up the key, when the key was taken. */
  readonly movedFrom: KeyboardAction | null;
  /** Why the key was refused; bindings are unchanged when set. */
  readonly error: string | null;
}

/**
 * Makes `code` the primary key for `action`. Secondary keys stay. If another action owned `code`,
 * it loses that key and, if that left it with none, takes over `action`'s previous primary key.
 */
export function remapKeyboard(bindings: KeyboardBindings, action: KeyboardAction, code: string): KeyboardRemapResult {
  const refuse = (error: string): KeyboardRemapResult => ({ bindings, movedFrom: null, error });
  if (RESERVED_KEYS[code]) return refuse(`${keyLabel(code)} is the ${RESERVED_KEYS[code]!.toLowerCase()}`);
  if (!isRemappableKey(code)) return refuse('Use a letter, number, arrow or Space');
  if (code === 'Escape' && action !== 'pause') return refuse('Esc is kept for pause');
  const current = bindings[action];
  if (current[0] === code) return { bindings, movedFrom: null, error: null };
  const owner = keyOwner(bindings, code);
  const oldPrimary = current[0]!;
  // Esc always pauses (a remap can never bind it again, since Esc cancels the capture): a new pause key goes in front of it.
  const keepEscape = action === 'pause' && current.includes('Escape') && code !== 'Escape';
  const nextOwn = keepEscape
    ? [code, 'Escape', ...current.slice(1).filter(other => other !== code && other !== 'Escape')].slice(0, 3)
    : [code, ...current.slice(1).filter(other => other !== code)];
  if (!owner || owner === action) return { bindings: { ...bindings, [action]: nextOwn.slice(0, 3) }, movedFrom: null, error: null };
  let ownerKeys = bindings[owner].filter(other => other !== code);
  if (!ownerKeys.length) {
    if (oldPrimary === 'Escape') return refuse(`${keyLabel(code)} is ${ACTION_LABELS[owner]}`);
    ownerKeys = [oldPrimary];
    // The swapped key now belongs to the owner only.
    const own = nextOwn.filter(other => other !== oldPrimary);
    return { bindings: { ...bindings, [action]: own.slice(0, 3), [owner]: ownerKeys }, movedFrom: owner, error: null };
  }
  return { bindings: { ...bindings, [action]: nextOwn.slice(0, 3), [owner]: ownerKeys }, movedFrom: owner, error: null };
}

export interface GamepadRemapResult { readonly bindings: GamepadBindings; readonly movedFrom: GamepadBindingAction | null; readonly error: string | null }

/** Binds a button (or the steering axis). A taken button swaps with the action that had it. */
export function remapGamepad(bindings: GamepadBindings, action: GamepadBindingAction, value: number): GamepadRemapResult {
  if (action === 'steerAxis') {
    if (!Number.isInteger(value) || value < 0 || value > 3) return { bindings, movedFrom: null, error: 'Use a stick to steer' };
    return { bindings: { ...bindings, steerAxis: value }, movedFrom: null, error: null };
  }
  if (!Number.isInteger(value) || value < 0 || value > 15) return { bindings, movedFrom: null, error: 'That button is not supported' };
  if (bindings[action] === value) return { bindings, movedFrom: null, error: null };
  const owner = GAMEPAD_BUTTON_FIELDS.find(field => field !== action && bindings[field] === value) ?? null;
  const next: GamepadBindings = { ...bindings, [action]: value };
  if (owner) (next as unknown as Record<string, number>)[owner] = bindings[action];
  return { bindings: next, movedFrom: owner, error: null };
}
