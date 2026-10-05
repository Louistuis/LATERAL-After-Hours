import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, validateBindings,
} from '../../src/input/player-input';

describe('persisted input bindings', () => {
  it('accepts the canonical keyboard and gamepad defaults', () => {
    const parsed = validateBindings(DEFAULT_KEYBOARD_BINDINGS, DEFAULT_GAMEPAD_BINDINGS);
    expect(parsed.valid).toBe(true);
    expect(parsed.keyboard?.pause).toEqual(['Escape']);
    expect(parsed.gamepad?.steerAxis).toBe(0);
  });

  it('rejects Escape remapped onto a driving action and conflicting keys', () => {
    const keyboard = JSON.parse(DEFAULT_KEYBOARD_BINDINGS) as Record<string, unknown>;
    keyboard.throttle = ['Escape'];
    keyboard.brake = ['KeyW'];
    expect(validateBindings(JSON.stringify(keyboard), DEFAULT_GAMEPAD_BINDINGS).valid).toBe(false);
  });

  it('rejects unknown fields, duplicate gamepad buttons and out of range axes', () => {
    const extra = JSON.parse(DEFAULT_KEYBOARD_BINDINGS) as Record<string, unknown>;
    extra.eval = 'ignored';
    expect(validateBindings(JSON.stringify(extra), DEFAULT_GAMEPAD_BINDINGS).valid).toBe(false);
    const pad = JSON.parse(DEFAULT_GAMEPAD_BINDINGS) as Record<string, number>;
    pad.cameraButton = pad.pauseButton!;
    pad.steerAxis = 4;
    expect(validateBindings(DEFAULT_KEYBOARD_BINDINGS, JSON.stringify(pad)).valid).toBe(false);
  });

  it('rejects oversized serialized preferences before parsing', () => {
    const result = validateBindings(' '.repeat(2049), DEFAULT_GAMEPAD_BINDINGS);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Bindings exceed 2048 characters');
  });
});
