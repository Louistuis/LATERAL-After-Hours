import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRuntime } from '../../src/core/game-runtime';
import type { ExperienceCoordinator } from '../../src/experience/coordinator';
import type { RunResult } from '../../contracts/runtime-contracts';
import { createExperienceServices } from '../../src/experience/services';
import { EVENTS, ROUTES } from '../../content/events/catalog';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics';
import { profileStorageKey } from '../../src/save/profile-repository';

const routeVersion = ROUTES.find(route => route.routeId === 'HW-01')!.version;

const run: RunResult = {
  runId: 'real-run-1', routeId: 'HW-01', mode: 'drift-attack', rulesVersion: EVENTS.find(event => event.routeId === 'HW-01' && event.mode === 'drift-attack')!.rulesVersion,
  routeVersion, physicsVersion: VEHICLE_PHYSICS_VERSION,
  carId: 'CAR-01', elapsedActiveSeconds: 45, bankedScore: 850, medal: 'none', valid: true,
};

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
function fakeRuntime(toSavedGhost: (_header: unknown, _budget: number) => null = () => null): GameRuntime {
  return {
    subscribe: () => () => {},
    routes: () => [{ id: 'HW-01', version: routeVersion }],
    ghostRecording: () => ({ toSavedGhost }),
    tuneHash: () => 'car:tune:physics-v1',
  } as unknown as GameRuntime;
}

describe('experience services', () => {
  beforeEach(() => vi.stubGlobal('__OWNER_REVIEW__', true));
  afterEach(() => vi.unstubAllGlobals());

  it('serializes profile, valid result and idempotent rewarded credit in one save', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const services = await createExperienceServices(fakeRuntime(), 'owner-review');
    await services.profiles.save({ profile: 'career', selection: { car: 'CAR-01', route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: 'balanced' } });
    await services.rewards.recordCareerResult(run);
    await services.rewards.recordCareerResult(run);
    const request = { operationId: 'ad-op-1', kind: 'rewarded' as const, placement: 'event-results-return' as const, reward: { id: 'bonus', kind: 'garage-credits' as const, amount: 25 } };
    const result = { operationId: 'ad-op-1', status: 'finished' as const, rewardEligible: true };
    await services.rewards.applyCareerReward(request, result);
    await services.rewards.applyCareerReward(request, result);
    await expect(services.rewards.applyCareerReward({ ...request, operationId: 'over-cap', reward: { ...request.reward, amount: 10_001 } }, { ...result, operationId: 'over-cap' })).rejects.toThrow('Invalid reward specification');
    await services.profiles.save({ profile: 'career', selection: { car: 'CAR-01', route: 'HW-01', tune: 'Drift', lighting: 'golden-hour', quality: 'balanced' } });
    const saved = JSON.parse(await (await services.profiles.exportProfileSave('career')).text()) as { garageCredits: number; bestResults: RunResult[]; appliedRewardOperationIds: string[]; settings: Record<string, unknown> };
    expect(saved.garageCredits).toBe(25);
    expect(saved.bestResults).toHaveLength(1);
    expect(saved.bestResults[0]?.runId).toBe(run.runId);
    expect(saved.appliedRewardOperationIds).toEqual(['real-run-1', 'ad-op-1']);
    expect(saved.settings['profile.tune']).toBe('Drift');
    await services.dispose();
  });

  it('requires a career backup export before owner reset', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const services = await createExperienceServices(fakeRuntime(), 'owner-review');
    await services.profiles.save({ profile: 'career', selection: { car: 'CAR-01', route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: 'balanced' } });
    await services.rewards.recordCareerResult(run);
    const coordinator = { state: () => ({ profile: 'career' }), reloadProfile: vi.fn(async () => {}) } as unknown as ExperienceCoordinator;
    const owner = services.ownerTools!(coordinator);
    await expect(owner.onResetCareer()).rejects.toThrow('Export your career save');
    const backup = await owner.onExportSave();
    expect(backup.size).toBeGreaterThan(0);
    await owner.onResetCareer();
    const saved = JSON.parse(await (await services.profiles.exportProfileSave('career')).text()) as { bestResults: RunResult[]; garageCredits: number };
    expect(saved.bestResults).toHaveLength(0);
    expect(saved.garageCredits).toBe(0);
    expect(coordinator.reloadProfile).toHaveBeenCalledOnce();
    await services.dispose();
  });

  it('reserves the single route ghost slot for Time Trial personal bests', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const toSavedGhost = vi.fn((_header: unknown, _budget: number) => null);
    const services = await createExperienceServices(fakeRuntime(toSavedGhost), 'owner-review');
    await services.profiles.save({ profile: 'career', selection: { car: 'CAR-01', route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: 'balanced' } });
    await services.rewards.recordCareerResult(run);
    expect(toSavedGhost).not.toHaveBeenCalled();
    await services.rewards.recordCareerResult({ ...run, runId: 'legacy-time-run', mode: 'time-trial', rulesVersion: EVENTS.find(event => event.routeId === 'HW-01' && event.mode === 'time-trial')!.rulesVersion, routeVersion: undefined, physicsVersion: undefined, tuneHash: undefined });
    expect(toSavedGhost).not.toHaveBeenCalled();
    await services.rewards.recordCareerResult({ ...run, runId: 'time-run-1', mode: 'time-trial', rulesVersion: EVENTS.find(event => event.routeId === 'HW-01' && event.mode === 'time-trial')!.rulesVersion, tuneHash: 'captured-tune-v2' });
    expect(toSavedGhost).toHaveBeenCalledOnce();
    expect(toSavedGhost.mock.calls[0]?.[0]).toMatchObject({ routeVersion, physicsVersion: VEHICLE_PHYSICS_VERSION, tuneHash: 'captured-tune-v2' });
    await services.dispose();
  });

  it('rejects results from a different route or physics version before updating career', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const services = await createExperienceServices(fakeRuntime(), 'owner-review');
    await expect(services.rewards.recordCareerResult({ ...run, routeVersion: 'older-route' })).rejects.toThrow('version');
    await expect(services.rewards.recordCareerResult({ ...run, physicsVersion: 'older-physics' })).rejects.toThrow('version');
    const saved = JSON.parse(await (await services.profiles.exportProfileSave('career')).text()) as { bestResults: RunResult[]; appliedRewardOperationIds: string[] };
    expect(saved.bestResults).toHaveLength(0);
    expect(saved.appliedRewardOperationIds).toHaveLength(0);
    await services.dispose();
  });

  it('exports the active allowlisted settings in a local bug report', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    vi.stubGlobal('__BUILD__', { version: '0.1.0', buildId: 'review-test', commit: 'abcdef', contentHash: 'f'.repeat(64), target: 'owner-review' });
    const services = await createExperienceServices(fakeRuntime(), 'owner-review');
    const settings = { masterVolume: .7, musicVolume: .2, sfxVolume: .9, muted: true, reducedMotion: true, uiScale: 1.1, ghostVisible: false, keyboardBindings: '', gamepadBindings: '' };
    const coordinator = { state: () => ({ profile: 'sandbox', selection: { car: 'CAR-01', route: 'HW-01', lighting: 'blue-hour', quality: 'balanced' }, settings, runtime: { mode: 'free-drive' } }) } as unknown as ExperienceCoordinator;
    const report = JSON.parse(await (await services.ownerTools!(coordinator).onExportBugReport({ description: 'A local repro', reproductionSteps: ['Start a run', 'Cross the line'], expected: 'Result appears', observed: 'No result' })).text()) as { profile: string; settings: typeof settings; automaticUpload: boolean; identity: { contentHash: string }; reproductionSteps: string[]; expected: string; observed: string };
    expect(report).toMatchObject({ profile: 'sandbox', settings, automaticUpload: false, identity: { contentHash: 'f'.repeat(64) }, reproductionSteps: ['Start a run', 'Cross the line'], expected: 'Result appears', observed: 'No result' });
    await services.dispose();
  });

  it('offers explicit owner-only sandbox recovery without replacing stored bytes', async () => {
    const storage = fakeStorage();
    const key = `lateral:save:v1:owner-review:${profileStorageKey('owner-review', 'sandbox')}`;
    const raw = JSON.stringify({ schemaVersion: 99, marker: 'original-sandbox' });
    storage.setItem(key, raw);
    vi.stubGlobal('window', { localStorage: storage });
    const services = await createExperienceServices(fakeRuntime(), 'owner-review');
    const coordinator = { state: () => ({ profile: 'career' }), switchProfile: vi.fn(async () => {}), reloadProfile: vi.fn(async () => {}) } as unknown as ExperienceCoordinator;
    const owner = services.ownerTools!(coordinator);
    expect(await owner.inspectProfileRecovery('sandbox')).toMatchObject({ status: 'recovery-required', code: 'future-version' });
    expect(await (await owner.onExportRawBackup('sandbox')).text()).toBe(raw);
    await owner.onPlayProfileForSession('sandbox');
    expect(coordinator.switchProfile).toHaveBeenCalledWith('sandbox');
    expect(services.profiles.getPersistenceStatus('sandbox').state).toBe('session-only');
    expect(storage.getItem(key)).toBe(raw);
    await services.dispose();
  });
});
