import { describe, expect, it } from 'vitest';
import { keyboardConflicts, keyLabel, keyOwner, remapGamepad, remapKeyboard } from '../../src/input/bindings';
import { DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, validateBindings, type GamepadBindings, type KeyboardBindings } from '../../src/input/player-input';

const keyboard = (): KeyboardBindings => JSON.parse(DEFAULT_KEYBOARD_BINDINGS) as KeyboardBindings;
const gamepad = (): GamepadBindings => JSON.parse(DEFAULT_GAMEPAD_BINDINGS) as GamepadBindings;
const valid = (k: KeyboardBindings, g: GamepadBindings = gamepad()) => validateBindings(JSON.stringify(k), JSON.stringify(g)).valid;

describe('keyboard remap', () => {
  it('makes a free key the primary and keeps the secondary key', () => {
    const result = remapKeyboard(keyboard(), 'throttle', 'KeyI');
    expect(result.error).toBeNull();
    expect(result.movedFrom).toBeNull();
    expect(result.bindings.throttle).toEqual(['KeyI', 'ArrowUp']);
    expect(valid(result.bindings)).toBe(true);
  });

  it('moves a taken key and reports where it came from', () => {
    const result = remapKeyboard(keyboard(), 'handbrake', 'KeyS');
    expect(result.movedFrom).toBe('brake');
    expect(result.bindings.handbrake).toEqual(['KeyS']);
    expect(result.bindings.brake).toEqual(['ArrowDown']);
    expect(keyboardConflicts(result.bindings)).toEqual([]);
    expect(valid(result.bindings)).toBe(true);
  });

  it('swaps when the owner would be left without a key', () => {
    const result = remapKeyboard(keyboard(), 'camera', 'KeyR');
    expect(result.movedFrom).toBe('reset');
    expect(result.bindings.camera).toEqual(['KeyR']);
    expect(result.bindings.reset).toEqual(['KeyC']);
    expect(valid(result.bindings)).toBe(true);
  });

  it('refuses the horn key, Esc on driving actions and unsupported keys', () => {
    const base = keyboard();
    expect(remapKeyboard(base, 'throttle', 'KeyH').error).toMatch(/horn/);
    expect(remapKeyboard(base, 'throttle', 'Escape').error).toMatch(/pause/);
    expect(remapKeyboard(base, 'throttle', 'F5').error).not.toBeNull();
    expect(remapKeyboard(base, 'throttle', 'F5').bindings).toBe(base);
  });

  it('never hands Esc to a driving action in a swap', () => {
    const result = remapKeyboard(keyboard(), 'pause', 'KeyR');
    expect(result.error).toMatch(/Recover/);
    expect(result.bindings.reset).toEqual(['KeyR']);
  });

  it('keeps Esc on pause when pause gets a new key', () => {
    const once = remapKeyboard(keyboard(), 'pause', 'KeyP');
    expect(once.bindings.pause).toEqual(['KeyP', 'Escape']);
    expect(valid(once.bindings)).toBe(true);
    const twice = remapKeyboard(once.bindings, 'pause', 'KeyO');
    expect(twice.bindings.pause).toEqual(['KeyO', 'Escape']);
    // Taking a key from an action with spare keys keeps Esc too.
    const taken = remapKeyboard(keyboard(), 'pause', 'ArrowUp');
    expect(taken.bindings.pause).toEqual(['ArrowUp', 'Escape']);
    expect(taken.bindings.throttle).toEqual(['KeyW']);
  });

  it('is a no-op for the current primary key and finds key owners', () => {
    const base = keyboard();
    expect(remapKeyboard(base, 'throttle', 'KeyW').bindings).toBe(base);
    expect(keyOwner(base, 'Space')).toBe('handbrake');
    expect(keyOwner(base, 'KeyZ')).toBeNull();
  });

  it('detects conflicts from hand-edited storage', () => {
    const broken = { ...keyboard(), camera: ['KeyW'] };
    expect(keyboardConflicts(broken)).toEqual([{ code: 'KeyW', actions: ['throttle', 'camera'] }]);
  });

  it('labels keys for keycaps', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('Digit4')).toBe('4');
  });
});

describe('gamepad remap', () => {
  it('swaps a taken button with the action that had it', () => {
    const base = gamepad();
    const result = remapGamepad(base, 'handbrakeButton', 7);
    expect(result.movedFrom).toBe('throttleButton');
    expect(result.bindings.handbrakeButton).toBe(7);
    expect(result.bindings.throttleButton).toBe(base.handbrakeButton);
    expect(valid(keyboard(), result.bindings)).toBe(true);
  });

  it('binds a free button and validates the steering axis', () => {
    expect(remapGamepad(gamepad(), 'cameraButton', 10).bindings.cameraButton).toBe(10);
    expect(remapGamepad(gamepad(), 'steerAxis', 2).bindings.steerAxis).toBe(2);
    expect(remapGamepad(gamepad(), 'steerAxis', 5).error).not.toBeNull();
    expect(remapGamepad(gamepad(), 'resetButton', 16).error).not.toBeNull();
  });
});
