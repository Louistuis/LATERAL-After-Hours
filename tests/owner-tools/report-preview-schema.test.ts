import { describe, expect, it } from 'vitest';
import { validateBugReport } from '../../src/owner-tools';

const requiredSettings = {
  masterVolume: 0.8,
  musicVolume: 0.7,
  sfxVolume: 0.6,
  muted: false,
  reducedMotion: false,
  uiScale: 1,
  ghostVisible: true,
  keyboardBindings: '{}',
  gamepadBindings: '{}',
};
const emittedSettings = {
  masterVolume: 0.8,
  musicVolume: 0.7,
  sfxVolume: 0.6,
  muted: false,
  reducedMotion: false,
  cameraFovDeg: 58,
  cameraShakeEnabled: false,
  uiScale: 1,
  ghostVisible: true,
  keyboardBindings: '{}',
  gamepadBindings: '{}',
};

function report(settings: Record<string, unknown> = { ...requiredSettings }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reportId: 'local-report-1',
    identity: { version: '0.1', buildId: 'build-a', commit: 'abc123', contentHash: 'hash-a', target: 'owner-review' },
    profile: 'career',
    selection: { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'day', quality: 'balanced' },
    settings,
    timestamp: '2026-09-30T00:00:00.000Z',
    reproductionSteps: ['Turn into the corner'],
    expected: 'Car follows the line',
    observed: 'Car pushes wide',
    sanitizedDiagnostics: ['Tick: 42'],
    automaticUpload: false,
  };
}
async function validate(settings: Record<string, unknown>): Promise<string> {
  return validateBugReport(new Blob([JSON.stringify(report(settings))], { type: 'application/json' }));
}

describe('owner report preview settings schema', () => {
  it('accepts schema-1 reports without either newer camera preference', async () => {
    const preview = JSON.parse(await validate({ ...requiredSettings })) as Record<string, unknown>;
    expect(preview.settings).toEqual(requiredSettings);
    expect(preview.reproductionSteps).toEqual(['Turn into the corner']);
    expect(preview.expected).toBe('Car follows the line');
    expect(preview.observed).toBe('Car pushes wide');
  });

  it('preserves the canonical current export setting key order', async () => {
    const preview = JSON.parse(await validate({ ...emittedSettings })) as Record<string, unknown>;
    expect(Object.keys(preview.settings as object)).toEqual([
      'masterVolume','musicVolume','sfxVolume','muted','reducedMotion','cameraFovDeg','cameraShakeEnabled','uiScale','ghostVisible','keyboardBindings','gamepadBindings',
    ]);
  });

  it.each([
    ['both preferences', { cameraFovDeg: 58, cameraShakeEnabled: false }],
    ['only FOV', { cameraFovDeg: 75 }],
    ['only shake preference', { cameraShakeEnabled: true }],
  ])('accepts valid optional camera settings (%s)', async (_name, extra) => {
    const preview = await validate({ ...requiredSettings, ...extra });
    expect(JSON.parse(preview).settings).toEqual({ ...requiredSettings, ...extra });
  });

  it.each([
    ['out-of-range low FOV', { cameraFovDeg: 49 }],
    ['out-of-range high FOV', { cameraFovDeg: 76 }],
    ['wrong FOV type', { cameraFovDeg: '58' }],
    ['wrong shake type', { cameraShakeEnabled: 1 }],
    ['unapproved extra setting', { motionBlur: true }],
    ['raw save payload', { saveData: '{}' }],
  ])('rejects %s', async (_name, extra) => {
    await expect(validate({ ...requiredSettings, ...extra })).rejects.toThrow('Bug report settings are invalid.');
  });

  it('rejects a JSON numeric overflow that parses to a nonfinite FOV', async () => {
    const json = JSON.stringify(report({ ...requiredSettings, cameraFovDeg: null, cameraShakeEnabled: false }))
      .replace('"cameraFovDeg":null', '"cameraFovDeg":1e999');
    await expect(validateBugReport(new Blob([json]))).rejects.toThrow('Bug report settings are invalid.');
  });
});
