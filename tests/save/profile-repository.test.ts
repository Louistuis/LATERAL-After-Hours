import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataStore, RunResult, VehicleSnapshot } from '../../contracts/runtime-contracts';
import { createProfileRepository, exportBugReport } from '../../src/save/profile-repository';
import type { ProfileRecord } from '../../src/experience/coordinator';
import { parseSaveEnvelope } from '../../src/save/envelope';
import { createGhostRecorder } from '../../src/ghosts/recording';
import type { LocalBugReportSettings } from '../../contracts/owner-review-contracts';
import { VEHICLE_TUNES } from '../../src/physics';

beforeEach(() => vi.stubGlobal('__OWNER_REVIEW__', true));
afterEach(() => vi.unstubAllGlobals());

function memoryStore(options: { denyRead?: boolean; denyWrite?: boolean } = {}) {
  const values = new Map<string, string>();
  let writes = 0;
  const store: DataStore = {
    async initialize() {},
    async read(key) { return options.denyRead ? { status: 'unavailable', reason: 'denied' } : values.has(key) ? { status: 'found', serialized: values.get(key)! } : { status: 'missing' }; },
    async write(key, serialized) { writes += 1; if (options.denyWrite) return { status: 'unavailable', reason: 'quota' }; values.set(key, serialized); return { status: 'written' }; },
    async flushPending() {},
  };
  return { store, values, get writes() { return writes; } };
}

const record = (profile: 'career' | 'sandbox', car: 'CAR-01' | 'CAR-02'): ProfileRecord => ({
  profile, selection: { car, route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: 'balanced' },
  settings: { masterVolume: .8, musicVolume: .4, sfxVolume: .7, muted: false, reducedMotion: true, cameraFovDeg: 58, cameraShakeEnabled: false, uiScale: 1.1, ghostVisible: false },
  cosmetics: { paint: 'blue', wheelStyle: 'mesh' },
});
const reportSettings: LocalBugReportSettings = {
  masterVolume: 1, musicVolume: 0.5, sfxVolume: 1, muted: false, reducedMotion: false, cameraFovDeg: 63, cameraShakeEnabled: true, uiScale: 1,
  ghostVisible: true, keyboardBindings: '', gamepadBindings: '',
};

const ghostFrame = (simulationTick: number): VehicleSnapshot => ({
  simulationTick, carId: 'CAR-01', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocityMS: { x: 0, y: 0, z: -1 }, angularVelocityRadS: { x: 0, y: 0, z: 0 }, engineRpm: 2000, gear: 1, driftAngleRad: 0,
  wheels: [0, 1, 2, 3].map(() => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0, normalLoadN: 1, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0, surfaceId: null })) as unknown as VehicleSnapshot['wheels'],
});

describe('profile repository', () => {
  it('persists career and sandbox in separate namespaces and restores each record', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    expect(typeof repository.exportProfileSave).toBe('function');
    expect(typeof repository.resetProfile).toBe('function');
    expect(repository.getProgression('career')).toMatchObject({ garageCredits: 0, unlockedCars: ['CAR-01'], bestResults: [] });
    expect(repository.getProgression('sandbox').unlockedCars).toEqual(['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06']);
    await repository.save(record('career', 'CAR-01'));
    await repository.save(record('sandbox', 'CAR-02'));
    expect(values.size).toBe(2);
    expect(repository.getProgression('career').unlockedCars).toEqual(['CAR-01']);
    expect(repository.getProgression('sandbox').unlockedCars).toEqual(['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06']);
    expect([...values.keys()]).toEqual(expect.arrayContaining(['lateral:owner-review:career:v1', 'lateral:owner-review:sandbox:v1']));
    const restored = createProfileRepository(store, 'owner-review');
    expect(await restored.load('career')).toMatchObject(record('career', 'CAR-01'));
    expect(await restored.load('sandbox')).toMatchObject(record('sandbox', 'CAR-02'));
  });

  it('round-trips a bounded custom tune through the same profile save', async () => {
    const { store } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    const custom = { id: 'Custom' as const, frontMuScale: 1.03, rearMuScale: 1.12, springScale: 0.96, steeringScale: 1.04, engineScale: 1, handbrakeRearMuScale: 0.3, rearDiffLock: 0.15, frontBrakeBias: 0.62 };
    await repository.save({ ...record('career', 'CAR-01'), selection: { ...record('career', 'CAR-01').selection, customTune: custom } });
    const restored = await createProfileRepository(store, 'owner-review').load('career');
    expect(restored?.selection.customTune).toEqual(custom);
    await repository.save(record('career', 'CAR-01'));
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.selection.customTune).toBeUndefined();
  });

  it('migrates legacy six-field custom tunes from the saved car and preset defaults', async () => {
    const { store, values } = memoryStore();
    const key = 'lateral:owner-review:career:v1';
    values.set(key, JSON.stringify({
      schemaVersion: 1, revision: 2, updatedAtIso: new Date().toISOString(), garageCredits: 0,
      selectedCar: 'CAR-02', unlockedCars: ['CAR-01', 'CAR-02'], bestResults: [],
      settings: {
        'profile.profile': 'career', 'profile.route': 'HW-01', 'profile.tune': 'Drift', 'profile.lighting': 'golden-hour', 'profile.quality': 'balanced',
        'profile.customTune.id': 'Custom', 'profile.customTune.frontMuScale': 1.08, 'profile.customTune.rearMuScale': 0.82,
        'profile.customTune.springScale': 0.94, 'profile.customTune.steeringScale': 1.13, 'profile.customTune.engineScale': 1.08,
        'profile.customTune.handbrakeRearMuScale': 0.2,
      }, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [],
    }));
    const repository = createProfileRepository(store, 'owner-review');
    const restored = await repository.load('career');
    expect(restored?.selection.customTune).toMatchObject({ id: 'Custom', frontMuScale: 1.08, rearMuScale: 0.82,
      rearDiffLock: VEHICLE_TUNES['CAR-02'].Drift.rearDiffLock, frontBrakeBias: VEHICLE_TUNES['CAR-02'].Drift.frontBrakeBias });
    await repository.save(restored!);
    const migrated = JSON.parse(values.get(key)!).settings as Record<string, unknown>;
    expect(migrated['profile.customTune.rearDiffLock']).toBe(VEHICLE_TUNES['CAR-02'].Drift.rearDiffLock);
    expect(migrated['profile.customTune.frontBrakeBias']).toBe(VEHICLE_TUNES['CAR-02'].Drift.frontBrakeBias);
  });

  it('preserves the auto quality selection across profile restoration', async () => {
    const { store } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save({ ...record('career', 'CAR-01'), selection: { ...record('career', 'CAR-01').selection, quality: 'auto' } });
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.selection.quality).toBe('auto');
  });

  it('persists camera preferences independently by profile and defaults legacy saves without rewriting them', async () => {
    const state = memoryStore();
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.save({ ...record('career', 'CAR-01'), settings: { ...record('career', 'CAR-01').settings, cameraFovDeg: 66, cameraShakeEnabled: true } });
    await repository.save({ ...record('sandbox', 'CAR-01'), settings: { ...record('sandbox', 'CAR-01').settings, cameraFovDeg: 72, cameraShakeEnabled: false } });
    expect(JSON.parse(state.values.get('lateral:owner-review:career:v1')!).settings).toMatchObject({
      'experience.cameraFovDeg': 66, 'experience.cameraShakeEnabled': true,
    });
    expect(JSON.parse(state.values.get('lateral:owner-review:sandbox:v1')!).settings).toMatchObject({
      'experience.cameraFovDeg': 72, 'experience.cameraShakeEnabled': false,
    });
    const restored = createProfileRepository(state.store, 'owner-review');
    expect((await restored.load('career'))?.settings).toMatchObject({ cameraFovDeg: 66, cameraShakeEnabled: true });
    expect((await restored.load('sandbox'))?.settings).toMatchObject({ cameraFovDeg: 72, cameraShakeEnabled: false });
    const careerRecord = await restored.load('career');
    await restored.save({ ...careerRecord!, settings: { ...careerRecord!.settings, reducedMotion: false } });
    expect((await createProfileRepository(state.store, 'owner-review').load('career'))?.settings).toMatchObject({
      reducedMotion: false, cameraFovDeg: 66, cameraShakeEnabled: true,
    });

    const legacy = JSON.parse(state.values.get('lateral:owner-review:career:v1')!) as { settings: Record<string, unknown> };
    delete legacy.settings['experience.cameraFovDeg'];
    delete legacy.settings['experience.cameraShakeEnabled'];
    const legacySerialized = JSON.stringify(legacy);
    state.values.set('lateral:owner-review:career:v1', legacySerialized);
    const migrated = createProfileRepository(state.store, 'owner-review');
    expect((await migrated.load('career'))?.settings).toMatchObject({ cameraFovDeg: 58, cameraShakeEnabled: false });
    expect(state.values.get('lateral:owner-review:career:v1')).toBe(legacySerialized);
  });

  it.each([
    ['below minimum', 49.99],
    ['above maximum', 75.01],
    ['non-finite', Number.NaN],
  ])('rejects camera FOV that is %s on a profile save', async (_label, cameraFovDeg) => {
    const repository = createProfileRepository(memoryStore().store, 'owner-review');
    await expect(repository.save({ ...record('career', 'CAR-01'), settings: { ...record('career', 'CAR-01').settings, cameraFovDeg } })).rejects.toThrow(/settings/);
  });

  it('rejects non-boolean camera shake values on profile saves', async () => {
    const repository = createProfileRepository(memoryStore().store, 'owner-review');
    await expect(repository.save({ ...record('career', 'CAR-01'), settings: { ...record('career', 'CAR-01').settings, cameraShakeEnabled: 'yes' as unknown as boolean } })).rejects.toThrow(/settings/);
  });

  it.each([50, 75])('accepts the camera FOV boundary %s degrees', async cameraFovDeg => {
    const state = memoryStore();
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.save({ ...record('career', 'CAR-01'), settings: { ...record('career', 'CAR-01').settings, cameraFovDeg } });
    expect((await createProfileRepository(state.store, 'owner-review').load('career'))?.settings?.cameraFovDeg).toBe(cameraFovDeg);
  });

  it.each([
    ['out of range FOV', 'experience.cameraFovDeg', 76],
    ['string FOV', 'experience.cameraFovDeg', '58'],
    ['non-boolean shake', 'experience.cameraShakeEnabled', 'true'],
  ])('fails closed on stored %s without rewriting the original save', async (_label, key, invalidValue) => {
    const state = memoryStore();
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.save(record('career', 'CAR-01'));
    const storageKey = 'lateral:owner-review:career:v1';
    const saved = JSON.parse(state.values.get(storageKey)!) as { settings: Record<string, unknown> };
    saved.settings[key] = invalidValue;
    const malformed = JSON.stringify(saved);
    state.values.set(storageKey, malformed);
    await expect(createProfileRepository(state.store, 'owner-review').load('career')).rejects.toThrow(/invalid/);
    expect(state.values.get(storageKey)).toBe(malformed);
  });

  it('round-trips tutorial completion and skip separately for career and sandbox', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    const career = record('career', 'CAR-01');
    const sandbox = record('sandbox', 'CAR-01');
    await repository.save({ ...career, settings: { ...career.settings, tutorialCompleted: true, tutorialSkipped: false } });
    await repository.save({ ...sandbox, settings: { ...sandbox.settings, tutorialCompleted: false, tutorialSkipped: true } });
    const restored = createProfileRepository(store, 'owner-review');
    expect((await restored.load('career'))?.settings).toMatchObject({ tutorialCompleted: true, tutorialSkipped: false });
    expect((await restored.load('sandbox'))?.settings).toMatchObject({ tutorialCompleted: false, tutorialSkipped: true });
    expect(JSON.parse(values.get('lateral:owner-review:career:v1')!).settings).toMatchObject({
      'experience.tutorialCompleted': true, 'experience.tutorialSkipped': false,
    });
    expect(JSON.parse(values.get('lateral:owner-review:sandbox:v1')!).settings).toMatchObject({
      'experience.tutorialCompleted': false, 'experience.tutorialSkipped': true,
    });
  });

  it('treats tutorial completion as authoritative if an old save has both flags set', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    const initial = record('career', 'CAR-01');
    await repository.save({ ...initial, settings: { ...initial.settings, tutorialCompleted: true, tutorialSkipped: false } });
    const key = 'lateral:owner-review:career:v1';
    const saved = JSON.parse(values.get(key)!) as { settings: Record<string, unknown> };
    saved.settings['experience.tutorialSkipped'] = true;
    values.set(key, JSON.stringify(saved));
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.settings).toMatchObject({
      tutorialCompleted: true, tutorialSkipped: false,
    });
  });

  it('returns only a saved ghost in the requested validated profile cache', async () => {
    const { store } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    const recorder = createGhostRecorder();
    recorder.update(ghostFrame(0), 0);
    recorder.update(ghostFrame(4), 4 / 60);
    const ghost = recorder.toSavedGhost({ routeId: 'HW-01', routeVersion: 'r1', rulesVersion: 'rules-v1', physicsVersion: 'physics-v1', carId: 'CAR-01', tuneHash: 'tune-hash' }, 64 * 1024)!;
    await repository.applyCareerTransaction(envelope => ({ ...envelope, ghosts: [ghost] }));
    expect(repository.getSavedGhost('career', 'HW-01')).toEqual(ghost);
    expect(repository.getSavedGhost('career', 'HW-02')).toBeNull();
    expect(repository.getSavedGhost('sandbox', 'HW-01')).toBeNull();
  });

  it('preserves legacy and versioned best-result metadata together with progression', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    const legacy: RunResult = { runId: 'legacy-run', routeId: 'HW-01', mode: 'drift-attack', rulesVersion: 'drift-score-v1', carId: 'CAR-01', elapsedActiveSeconds: 75, bankedScore: 900, medal: 'silver', valid: true };
    const current: RunResult = { ...legacy, runId: 'current-run', rulesVersion: 'drift-score-v2-provisional', routeVersion: '1.0.1', physicsVersion: 'vehicle-physics-v2', tuneHash: 'tune-v2-hash' };
    await repository.applyCareerTransaction(envelope => ({ ...envelope, garageCredits: 345, unlockedCars: ['CAR-01', 'CAR-02'], bestResults: [legacy, current] }));
    const restored = createProfileRepository(store, 'owner-review');
    expect(await restored.load('career')).not.toBeNull();
    expect(restored.getProgression('career')).toMatchObject({ garageCredits: 345, unlockedCars: ['CAR-01', 'CAR-02'], bestResults: [legacy, current] });
    const saved = parseSaveEnvelope(values.get('lateral:owner-review:career:v1')!);
    expect(saved.bestResults[0]).not.toHaveProperty('routeVersion');
    expect(saved.bestResults[1]).toMatchObject({ routeVersion: '1.0.1', physicsVersion: 'vehicle-physics-v2', tuneHash: 'tune-v2-hash' });
  });

  it('retains session-only progress and reports the storage limitation when durable reads or writes are denied', async () => {
    const deniedRead = memoryStore({ denyRead: true });
    const repository = createProfileRepository(deniedRead.store, 'standalone');
    expect(await repository.load('career')).toBeNull();
    await repository.save(record('career', 'CAR-02'));
    expect(await repository.load('career')).toMatchObject(record('career', 'CAR-02'));
    expect(repository.getPersistenceStatus('career')).toMatchObject({ state: 'session-only' });
    expect(deniedRead.values.size).toBe(0);

    const deniedWrite = memoryStore({ denyWrite: true });
    const writeFallback = createProfileRepository(deniedWrite.store, 'standalone');
    await writeFallback.save(record('sandbox', 'CAR-02'));
    expect(await writeFallback.load('sandbox')).toMatchObject(record('sandbox', 'CAR-02'));
    expect(writeFallback.getPersistenceStatus('sandbox')).toMatchObject({ state: 'session-only' });
  });

  it('does not rewrite or increment revisions when a transaction returns its unchanged envelope', async () => {
    const state = memoryStore();
    const { store, values } = state;
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save(record('career', 'CAR-01'));
    const before = values.get('lateral:owner-review:career:v1');
    await repository.applyCareerTransaction(envelope => envelope);
    expect(values.get('lateral:owner-review:career:v1')).toBe(before);
    expect(state.writes).toBe(1);
  });

  it('previews validated imports without writing, rejects cross-profile/malformed imports, and requires overwrite consent', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save(record('career', 'CAR-01'));
    const exported = await repository.exportProfileSave('career');
    expect(await repository.previewProfileImport('career', exported)).toMatchObject({ compatible: true });
    expect((await repository.previewProfileImport('sandbox', exported)).compatible).toBe(false);
    await expect(repository.importProfileSave('career', exported, false)).rejects.toThrow(/confirmation/);

    const malformed = JSON.parse(await exported.text()) as Record<string, unknown>;
    const settings = malformed.settings as Record<string, unknown>;
    settings['experience.keyboardBindings'] = '{bad json';
    const malformedBlob = new Blob([JSON.stringify(malformed)], { type: 'application/json' });
    expect((await repository.previewProfileImport('career', malformedBlob)).compatible).toBe(false);
    const before = values.get('lateral:owner-review:career:v1');
    await expect(repository.importProfileSave('career', malformedBlob, true)).rejects.toThrow(/valid JSON/);
    expect(values.get('lateral:owner-review:career:v1')).toBe(before);
    await repository.importProfileSave('career', exported, true);
    expect(parseSaveEnvelope(values.get('lateral:owner-review:career:v1')!).revision).toBeGreaterThan(parseSaveEnvelope(before!).revision);
  });

  it('requires export and confirmation before a factory reset, then clears progression', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save(record('career', 'CAR-02'));
    await repository.applyCareerTransaction(envelope => ({ ...envelope, garageCredits: 250 }));
    await expect(repository.resetProfile('career', true, false)).rejects.toThrow(/exporting a backup/);
    await repository.exportProfileSave('career');
    await repository.resetProfile('career', true, true);
    const reset = parseSaveEnvelope(values.get('lateral:owner-review:career:v1')!);
    expect(reset.garageCredits).toBe(0);
    expect(reset.selectedCar).toBe('CAR-01');
    expect(reset.unlockedCars).toEqual(['CAR-01']);
  });

  it('exports a bounded local-only bug report with recent sanitized diagnostics', async () => {
    const now = Date.now();
    const settingsWithTutorial = { ...reportSettings, tutorialCompleted: true, tutorialSkipped: false };
    const report = await exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' },
      { description: 'repro step token=private https://private.invalid/x', reproductionSteps: ['token=private https://private.invalid/x'], expected: 'expected', observed: 'observed' },
      [{ timestampMs: now - 1_000, message: 'request https://example.invalid/path?token=abc token=secret' }, { timestampMs: now - 61_000, message: 'old diagnostic' }],
      settingsWithTutorial);
    const value = JSON.parse(await report.text()) as Record<string, unknown>;
    expect(value.automaticUpload).toBe(false);
    expect(value.settings).toEqual(reportSettings);
    expect(Object.keys(value.settings as Record<string, unknown>)).toEqual([
      'masterVolume', 'musicVolume', 'sfxVolume', 'muted', 'reducedMotion', 'cameraFovDeg', 'cameraShakeEnabled',
      'uiScale', 'ghostVisible', 'keyboardBindings', 'gamepadBindings',
    ]);
    expect(JSON.stringify(value)).not.toContain('tutorialCompleted');
    expect(JSON.stringify(value)).not.toContain('tutorialSkipped');
    expect(value.sanitizedDiagnostics).toEqual(['request [url] token=[redacted]']);
    expect(JSON.stringify(value)).not.toContain('private.invalid');
    expect(JSON.stringify(value)).toContain('token=[redacted]');
    expect(new TextEncoder().encode(await report.text()).byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' }, { description: '' }, [],
      { ...reportSettings, keyboardBindings: 'x'.repeat(2049) })).rejects.toThrow(/settings/);
    const { cameraFovDeg, cameraShakeEnabled, ...legacyReportSettings } = reportSettings;
    void cameraFovDeg;
    void cameraShakeEnabled;
    const legacyReport = await exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' }, { description: '' }, [],
      legacyReportSettings);
    const legacyReportValue = JSON.parse(await legacyReport.text());
    expect(legacyReportValue.settings).toEqual(legacyReportSettings);
    expect(legacyReportValue.settings).not.toHaveProperty('cameraFovDeg');
    expect(legacyReportValue.settings).not.toHaveProperty('cameraShakeEnabled');
    const fovOnlyReport = await exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' }, { description: '' }, [],
      { ...legacyReportSettings, cameraFovDeg: 63 });
    const fovOnlySettings = JSON.parse(await fovOnlyReport.text()).settings;
    expect(fovOnlySettings.cameraFovDeg).toBe(63);
    expect(fovOnlySettings).not.toHaveProperty('cameraShakeEnabled');
    await expect(exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' }, { description: '' }, [],
      { ...reportSettings, cameraFovDeg: 75.01 })).rejects.toThrow(/settings/);
    await expect(exportBugReport('career', { version: '0.1', buildId: 'b1', commit: 'abc', contentHash: 'hash', target: 'owner-review' },
      { car: 'CAR-01', route: 'HW-01', eventId: null, lighting: 'golden-hour', quality: 'balanced' }, { description: '' }, [],
      { ...reportSettings, cameraShakeEnabled: 'true' as unknown as boolean })).rejects.toThrow(/settings/);
  });

  it.each([
    ['corrupt', '{'],
    ['future', JSON.stringify({ schemaVersion: 5 })],
  ])('does not convert %s data to a missing save or overwrite it', async (_label, serialized) => {
    const { store, values } = memoryStore();
    values.set('lateral:owner-review:career:v1', serialized);
    const repository = createProfileRepository(store, 'owner-review');
    await expect(repository.load('career')).rejects.toThrow();
    expect(values.get('lateral:owner-review:career:v1')).toBe(serialized);
  });

  it.each([
    ['corrupt', '{'],
    ['future', JSON.stringify({ schemaVersion: 5, privateMarker: 'must-not-leak' })],
  ])('offers explicit session-only recovery for %s data without writing over original bytes', async (_label, serialized) => {
    const state = memoryStore();
    const key = 'lateral:owner-review:career:v1';
    state.values.set(key, serialized);
    const repository = createProfileRepository(state.store, 'owner-review');
    const inspection = await repository.inspectRecovery('career');
    expect(inspection).toMatchObject({ status: 'recovery-required', rawBytes: new TextEncoder().encode(serialized).byteLength });
    expect(inspection.message).not.toContain('privateMarker');
    expect(inspection.message).not.toContain('must-not-leak');
    expect(state.writes).toBe(0);
    await expect(repository.resetAfterRecovery('career', true)).rejects.toThrow(/exporting a raw backup/);
    const backup = await repository.exportRawBackup('career');
    expect(await backup.text()).toBe(serialized);
    const recovered = await repository.startSessionOnlyRecovery('career', true);
    expect(recovered).toMatchObject({ profile: 'career', selection: { car: 'CAR-01', tune: 'Balanced' } });
    expect(await repository.load('career')).toEqual(recovered);
    const sessionExport = parseSaveEnvelope(await (await repository.exportProfileSave('career')).text());
    expect(sessionExport.settings['profile.profile']).toBe('career');
    expect(await repository.inspectRecovery('career')).toMatchObject({ status: 'recovery-required' });
    await repository.save({ ...recovered, selection: { ...recovered.selection, lighting: 'blue-hour' } });
    expect((await repository.load('career'))?.selection.lighting).toBe('blue-hour');
    expect(repository.getPersistenceStatus('career').state).toBe('session-only');
    expect(state.values.get(key)).toBe(serialized);
    expect(state.writes).toBe(0);
  });

  it('keeps sandbox recovery isolated, then allows replacement only after raw export and confirmation', async () => {
    const state = memoryStore();
    const careerKey = 'lateral:owner-review:career:v1';
    const sandboxKey = 'lateral:owner-review:sandbox:v1';
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.save(record('career', 'CAR-01'));
    const careerBefore = state.values.get(careerKey)!;
    const sandboxRaw = JSON.stringify({ schemaVersion: 9, savedFrom: 'sandbox' });
    state.values.set(sandboxKey, sandboxRaw);
    expect((await repository.inspectRecovery('sandbox')).status).toBe('recovery-required');
    expect(await repository.load('career')).toMatchObject(record('career', 'CAR-01'));
    const backup = await repository.exportRawBackup('sandbox');
    expect(await backup.text()).toBe(sandboxRaw);
    await expect(repository.resetAfterRecovery('sandbox', false)).rejects.toThrow(/confirmation/);
    await repository.resetAfterRecovery('sandbox', true);
    expect(state.values.get(careerKey)).toBe(careerBefore);
    expect(JSON.parse(state.values.get(sandboxKey)!).schemaVersion).toBe(1);
    expect(await repository.load('sandbox')).toMatchObject({ profile: 'sandbox', selection: { car: 'CAR-01' } });
  });

  it('allows backup then session-only play then confirmed durable reset and reload', async () => {
    const state = memoryStore();
    const key = 'lateral:owner-review:career:v1';
    const original = JSON.stringify({ schemaVersion: 11, private: 'raw original' });
    state.values.set(key, original);
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.inspectRecovery('career');
    expect(await (await repository.exportRawBackup('career')).text()).toBe(original);
    await repository.startSessionOnlyRecovery('career', true);
    await repository.resetAfterRecovery('career', true);
    const reloaded = createProfileRepository(state.store, 'owner-review');
    expect(await reloaded.load('career')).toMatchObject({ profile: 'career', selection: { car: 'CAR-01' } });
    expect(JSON.parse(state.values.get(key)!).schemaVersion).toBe(1);
    expect(state.values.get(key)).not.toBe(original);
  });

  it('serializes recovery reset with later profile writes', async () => {
    const key = 'lateral:owner-review:career:v1';
    const values = new Map([[key, '{']]);
    let releaseWrite!: () => void;
    const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writes = 0;
    const store: DataStore = {
      async initialize() {},
      async read(storageKey) { return values.has(storageKey) ? { status: 'found', serialized: values.get(storageKey)! } : { status: 'missing' }; },
      async write(storageKey, serialized) {
        writes += 1;
        if (writes === 1) await firstWrite;
        values.set(storageKey, serialized);
        return { status: 'written' };
      },
      async flushPending() {},
    };
    const repository = createProfileRepository(store, 'owner-review');
    await repository.inspectRecovery('career');
    await repository.exportRawBackup('career');
    const reset = repository.resetAfterRecovery('career', true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const save = repository.save(record('career', 'CAR-01'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toBe(1);
    releaseWrite();
    await Promise.all([reset, save]);
    expect(writes).toBe(2);
    expect(await createProfileRepository(store, 'owner-review').load('career')).toMatchObject(record('career', 'CAR-01'));
  });

  it('requires a raw backup before importing over unreadable data', async () => {
    const state = memoryStore();
    const key = 'lateral:owner-review:career:v1';
    const original = '{';
    state.values.set(key, original);
    const repository = createProfileRepository(state.store, 'owner-review');
    await repository.inspectRecovery('career');
    const replacementRepository = createProfileRepository(memoryStore().store, 'owner-review');
    await replacementRepository.save(record('career', 'CAR-01'));
    const replacement = await replacementRepository.exportProfileSave('career');
    await expect(repository.importProfileSave('career', replacement, true)).rejects.toThrow(/raw backup/);
    expect(state.values.get(key)).toBe(original);
    await repository.exportRawBackup('career');
    await repository.importProfileSave('career', replacement, true);
    expect(JSON.parse(state.values.get(key)!).settings['profile.profile']).toBe('career');
    expect(await createProfileRepository(state.store, 'owner-review').load('career')).toMatchObject(record('career', 'CAR-01'));
  });

  it('returns only fixed safe recovery copy and rejects a raw backup after storage changes', async () => {
    const state = memoryStore();
    const key = 'lateral:owner-review:career:v1';
    state.values.set(key, JSON.stringify({ schemaVersion: 6, secretText: 'private-marker' }));
    const repository = createProfileRepository(state.store, 'owner-review');
    const report = await repository.inspectRecovery('career');
    expect(report.message).toBe('This save was created by a newer game version.');
    expect(report.message).not.toContain('private-marker');
    state.values.set(key, '{"schemaVersion":5,"other":"changed"}');
    await expect(repository.exportRawBackup('career')).rejects.toThrow(/changed after inspection/);
    expect((await repository.inspectRecovery('career')).code).toBe('future-version');
    const refreshed = await repository.exportRawBackup('career');
    expect(await refreshed.text()).toBe(state.values.get(key));
  });

  it('does not let a stale async load replace an explicitly recovered session profile', async () => {
    let releaseFirstRead!: (value: Awaited<ReturnType<DataStore['read']>>) => void;
    let reads = 0;
    const future = JSON.stringify({ schemaVersion: 7 });
    const store: DataStore = {
      async initialize() {},
      read() {
        reads += 1;
        if (reads === 1) return new Promise(resolve => { releaseFirstRead = resolve; });
        return Promise.resolve({ status: 'found', serialized: future });
      },
      async write() { throw new Error('recovery must not write'); },
      async flushPending() {},
    };
    const repository = createProfileRepository(store, 'owner-review');
    const staleLoad = repository.load('career');
    const recovery = await repository.startSessionOnlyRecovery('career', true);
    releaseFirstRead({ status: 'missing' });
    expect(await staleLoad).toEqual(recovery);
    expect(await repository.load('career')).toEqual(recovery);
  });
});
