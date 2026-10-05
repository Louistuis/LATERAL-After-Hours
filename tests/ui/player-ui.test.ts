import { describe, expect, it } from 'vitest';
import type { GamepadBindings } from '../../src/input/player-input';
import { COMPACT_TUTORIAL_LAYOUT_CSS, gamepadAxisLabel, gamepadButtonLabel, renderCameraSettings, renderTutorialCard, renderTutorialCompletion, tutorialInstruction, tutorialTitle } from '../../src/ui/player-ui';

describe('camera settings controls', () => {
  it('labels the base field of view and exposes the specified accessible bounds', () => {
    const markup = renderCameraSettings({ cameraFovDeg: 58, cameraShakeEnabled: false, reducedMotion: false });
    expect(markup).toContain('Base field of view');
    expect(markup).toContain('aria-label="Base field of view"');
    expect(markup).toContain('min="50" max="75" step="1" value="58"');
    expect(markup).toContain('58°');
  });

  it('keeps the shake preference visible while explaining reduced-motion suppression', () => {
    const markup = renderCameraSettings({ cameraFovDeg: 58, cameraShakeEnabled: true, reducedMotion: true });
    expect(markup).toContain('Impact camera shake');
    expect(markup).toContain('type="checkbox" checked');
    expect(markup).toContain('Reduced motion suppresses speed-based field-of-view widening and impact shake');
    expect(markup).not.toContain('disabled');
  });
});

describe('compact first-drive tutorial', () => {
  it('uses accessible compact layout with separated map and camera control at narrow viewports', () => {
    expect(COMPACT_TUTORIAL_LAYOUT_CSS).toContain('@media(max-width:640px)');
    expect(COMPACT_TUTORIAL_LAYOUT_CSS).toContain('max-width:min(232px,37vw)');
    expect(COMPACT_TUTORIAL_LAYOUT_CSS).toContain('.lp-route-guide{top:112px');
    expect(COMPACT_TUTORIAL_LAYOUT_CSS).toContain('.lp-icon+[data-action=camera]{top:60px');
  });

  it('labels mapped gamepad buttons recognizably and keeps unknown bindings honest', () => {
    expect(gamepadButtonLabel(0, 'standard')).toBe('A / Cross');
    expect(gamepadButtonLabel(5, 'standard')).toBe('Right bumper');
    expect(gamepadButtonLabel(0, null)).toBe('gamepad button 0');
    expect(gamepadButtonLabel(0, 'xinput')).toBe('gamepad button 0');
    expect(gamepadButtonLabel(14, 'standard')).toBe('gamepad button 14');
    expect(gamepadAxisLabel(0, 'standard')).toBe('left stick');
    expect(gamepadAxisLabel(2, 'standard')).toBe('right stick');
    expect(gamepadAxisLabel(1, 'standard')).toBe('axis 1');
    expect(gamepadAxisLabel(0, null)).toBe('axis 0');
    const bindings = { schemaVersion: 1, steerAxis: 0, throttleButton: 7, brakeButton: 6, handbrakeButton: 0, resetButton: 1, pauseButton: 9, cameraButton: 3, shiftUpButton: 4, shiftDownButton: 5 } as GamepadBindings;
    expect(tutorialInstruction('handbrake', 'gamepad', { gamepadBindings: () => bindings, gamepadMapping: () => 'standard' })).toContain('A / Cross');
    expect(tutorialInstruction('handbrake', 'gamepad', { gamepadBindings: () => bindings, gamepadMapping: () => null })).toContain('gamepad button 0');
    expect(tutorialInstruction('turn', 'gamepad', { gamepadBindings: () => bindings, gamepadMapping: () => 'standard' })).toContain('left stick');
    const remappedAxis = { ...bindings, steerAxis: 1 };
    expect(tutorialInstruction('turn', 'gamepad', { gamepadBindings: () => remappedAxis, gamepadMapping: () => 'standard' })).toContain('axis 1');
    const remapped = { ...bindings, handbrakeButton: 5 };
    expect(tutorialInstruction('handbrake', 'gamepad', { gamepadBindings: () => remapped, gamepadMapping: () => 'standard' })).toContain('Right bumper');
  });

  it('keeps every lesson step precise about practice attempts and retains Skip without progress-driven markup', () => {
    const options = {};
    const steps = ['accelerate','turn','handbrake','countersteer'] as const;
    for (const step of steps) {
      expect(tutorialTitle(step)).toContain(step === 'countersteer' ? 'Try' : `${steps.indexOf(step) + 1}`);
      const card = renderTutorialCard(step, 'keyboard', options);
      expect(card).toContain('data-action="skip-tutorial"');
      expect(card).toContain('aria-label="Measured lesson progress"');
      if (step === 'handbrake' || step === 'countersteer') expect(card).toContain('Practice only. No score.');
    }
    expect(tutorialInstruction('countersteer', 'keyboard', options)).toBe('During a slide, try steering against its direction.');
    expect(renderTutorialCompletion('completed')).toContain('data-action="replay-tutorial"');
    expect(renderTutorialCompletion('skipped')).toContain('data-action="dismiss-tutorial-card"');
    expect(renderTutorialCard('accelerate', 'keyboard', options)).toBe(renderTutorialCard('accelerate', 'keyboard', options));
  });
});
