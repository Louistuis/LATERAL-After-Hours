import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdRequest, AdResult, RunResult, SavedGhost, SemanticEvent } from '../../contracts/runtime-contracts';
import type { GameRuntime, RuntimeView } from '../../src/core/game-runtime';
import { ExperienceCoordinator, type ProfileRecord } from '../../src/experience';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics';
import { EVENTS, ROUTES } from '../../content/events/catalog';

const result: RunResult = { runId: 'run-1', routeId: 'HW-01', mode: 'drift-attack', rulesVersion: '1', carId: 'CAR-01', elapsedActiveSeconds: 20, bankedScore: 100, medal: 'bronze', valid: true };
const rewarded: AdRequest = { operationId: 'ad-1', kind: 'rewarded', placement: 'event-results-return', reward: { id: 'credits', kind: 'garage-credits', amount: 50 } };
const rivalRules = EVENTS.find(event => event.routeId === 'HW-01' && event.mode === 'rival-ghost')!.rulesVersion;
const routeVersion = ROUTES.find(route => route.routeId === 'HW-01')!.version;
function ghost(tuneHash = 'tune-1'): SavedGhost {
  const frame = (timeSeconds: number) => ({ timeSeconds, position: { x: timeSeconds, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, driftAngleRad: 0, gear: 1 });
  return { header: { formatVersion: 1, routeId: 'HW-01', routeVersion, rulesVersion: rivalRules, physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash, sampleHz: 15, sampleCount: 2, durationSeconds: 1 }, compressedSnapshots: btoa(JSON.stringify([frame(0), frame(1)])) };
}

function fixture() {
  const pauseReasons = new Set<string>();
  let car: RuntimeView['carId'] = 'CAR-01';
  let route: RuntimeView['route']['id'] = 'HW-01';
  let tune: RuntimeView['tune'] = 'Balanced';
  let mode: RuntimeView['mode'] = 'free-drive';
  let presentation: RuntimeView['presentation'] = 'drive';
  let failEventSetup = false;
  let emitOnRecoveryResume = false;
  let customTune: ReturnType<GameRuntime['tuning']> | null = null;
  let onFinished: ((value: RunResult) => void) | undefined;
  let onView: ((value: RuntimeView) => void) | undefined;
  const records = new Map<string, ProfileRecord>();
  let savedGhost: SavedGhost | null = null;
  let unlockedCars: readonly RuntimeView['carId'][] = ['CAR-01', 'CAR-02', 'CAR-04'];
  let saveGate: Promise<void> | null = null;
  let resultGate: Promise<void> | null = null;
  let resultFailure = false;
  const mute = vi.fn();
  const setVolumes = vi.fn();
  const recordCareerResult = vi.fn(async () => { if (resultGate) await resultGate; if (resultFailure) throw new Error('career write failed'); });
  const applyCareerReward = vi.fn(async () => {});
  let adResolve: ((value: AdResult) => void) | undefined;
  let adStarted: ((id: string) => void) | undefined;
  const requestAd = vi.fn((_request: AdRequest, lifecycle: { onStarted(id: string): void }) => {
    adStarted = lifecycle.onStarted;
    return new Promise<AdResult>(resolve => { adResolve = resolve; });
  });
  const scene = { setLighting: vi.fn(), setQuality: vi.fn(), setCosmetics: vi.fn() };
  const view = (): RuntimeView => ({ carId: car, route: { id: route, version: routeVersion } as RuntimeView['route'], tune, mode, run: null, result: null, paused: pauseReasons.size > 0, presentation, replayProgress: 0, frame: {} as RuntimeView['frame'], input: { simulationTick: 0, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false }, metrics: {} as RuntimeView['metrics'] });
  const platformHandle = vi.fn((_event: SemanticEvent) => {});
  const runtime = {
    scene, view, routes: () => [{ id: 'HW-01' }, { id: 'HW-02' }], setQuality: vi.fn(),
    pause: (reason: string) => { pauseReasons.add(reason); },
    resume: (reason: string) => { pauseReasons.delete(reason); if (reason === 'recovery' && emitOnRecoveryResume) onView?.(lessonView(42, {})); },
    onRunFinished: (callback: (value: RunResult) => void) => { onFinished = callback; },
    subscribe: (callback: (value: RuntimeView) => void) => { onView = callback; return () => { onView = undefined; }; }, start: vi.fn(), leavePresentation: vi.fn(() => { presentation = 'drive'; }), freeDrive: vi.fn(() => { mode = 'free-drive'; presentation = 'drive'; }), resetVehicle: vi.fn(),
    selectCar: async (id: typeof car) => { car = id; },
    selectRoute: (id: typeof route) => { route = id; },
    selectTune: (id: typeof tune) => { tune = id; },
    tuning: () => customTune ?? { id: tune, frontMuScale: 1, rearMuScale: 1, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: .4 },
    selectCustomTune: (value: ReturnType<GameRuntime['tuning']>) => { customTune = value; },
    restoreFactoryTune: () => { customTune = null; },
    beginEvent: vi.fn((selection: { mode: RuntimeView['mode'] }) => { if (failEventSetup) throw new Error('event setup failed'); mode = selection.mode; }), retry: vi.fn(), setRival: vi.fn(), setGhostVisible: vi.fn(), setAssist: vi.fn(), tuneHash: () => 'tune-1', enterReplay: vi.fn(() => { presentation = 'replay'; return true; }), enterPhoto: vi.fn(() => { presentation = 'photo'; }), screenshot: vi.fn()
  } as unknown as GameRuntime;
  const coordinator = new ExperienceCoordinator(runtime, {
    profiles: { load: async profile => records.get(profile) ?? null, save: async record => { if (saveGate) await saveGate; records.set(record.profile, structuredClone(record)); },
      getProgression: () => ({ garageCredits: 0, unlockedCars, bestResults: [] }), getSavedGhost: () => savedGhost,
      getPersistenceStatus: profile => profile === 'sandbox' ? { state: 'session-only', warning: 'Sandbox storage unavailable' } : { state: 'persistent', warning: null } },
    audio: { setTemporaryMute: mute, resumeFromGesture: async () => {}, setUserMute: vi.fn(), setVolumes },
    rewards: { recordCareerResult, applyCareerReward },
    platform: { target: 'owner-review', initialize: async () => ({ interstitialAds: false, rewardedAds: true, authoritativeStore: 'guarded-browser' }), handle: platformHandle, requestAd, dispose: vi.fn() }
  });
  return { coordinator, runtime, records, pauseReasons, mute, setVolumes, platformHandle, recordCareerResult, applyCareerReward,
    lockCars: () => { unlockedCars = ['CAR-01']; }, setGhost: (ghost: SavedGhost | null) => { savedGhost = ghost; },
    holdSave: () => { let release!: () => void; saveGate = new Promise<void>(resolve => { release = resolve; }); return () => { saveGate = null; release(); }; },
    holdResultWrite: () => { let release!: () => void; resultGate = new Promise<void>(resolve => { release = resolve; }); return () => { resultGate = null; release(); }; },
    failResultWrite: () => { resultFailure = true; }, failEventSetup: () => { failEventSetup = true; },
    emitDuringRecoveryResume: () => { emitOnRecoveryResume = true; },
    finish: (value: RunResult) => onFinished?.(value), emitView: (value: RuntimeView) => onView?.(value), startAd: (id: string) => adStarted?.(id), resolveAd: (value: AdResult) => adResolve?.(value) };
}

function lessonView(tick: number, input: { throttle?: number; steering?: number; handbrake?: number }): RuntimeView {
  return {
    paused: false, presentation: 'drive', mode: 'free-drive',
    frame: { current: { simulationTick: tick, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -7 }, angularVelocityRadS: { x: 0, y: .15, z: 0 }, driftAngleRad: .25, wheels: Array.from({ length: 4 }, () => ({ contact: true })) } },
    input: { throttle: input.throttle ?? 0, steering: input.steering ?? 0, handbrake: input.handbrake ?? 0 },
  } as unknown as RuntimeView;
}

describe('ExperienceCoordinator', () => {
  beforeEach(() => { vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('__OWNER_REVIEW__', true); });
  afterEach(() => vi.unstubAllGlobals());

  it('reports actual free-drive, menu, event and result activity once per transition', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    expect(activities()).toEqual([]);
    await f.coordinator.drive();
    f.emitView(lessonView(1, {}));
    f.emitView(lessonView(2, {}));
    expect(activities()).toEqual([{ type: 'activity', active: true, context: 'drive' }]);
    f.coordinator.open('pause');
    f.coordinator.open('settings');
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
    ]);
    await f.coordinator.drive();
    f.coordinator.freeDrive();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    f.coordinator.open('pause');
    await f.coordinator.retry();
    f.finish(result);
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
      { type: 'activity', active: true, context: 'event' },
      { type: 'activity', active: false, context: 'event' },
      { type: 'activity', active: true, context: 'event' },
      { type: 'activity', active: false, context: 'event' },
    ]);
    const finalEvents = f.platformHandle.mock.calls.slice(-2).map(([event]) => event.type);
    expect(finalEvents).toEqual(['activity', 'run-finished']);
    f.coordinator.dispose();
  });

  it('composes hidden and other pause reasons without duplicate starts and stops on disposal', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    await f.coordinator.drive();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    f.pauseReasons.add('context-lost');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
    ]);
    f.pauseReasons.delete('context-lost');
    f.emitView(lessonView(3, {}));
    expect(activities().at(-1)).toEqual({ type: 'activity', active: true, context: 'drive' });
    f.coordinator.dispose();
    expect(activities().at(-1)).toEqual({ type: 'activity', active: false, context: 'drive' });
    expect(activities()).toHaveLength(4);
  });

  it('stops activity for replay and photo and restarts only after returning to driving', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    await f.coordinator.drive();
    expect(f.coordinator.replay()).toBe(true);
    f.emitView({ ...lessonView(3, {}), presentation: f.runtime.view().presentation });
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
    ]);
    await f.coordinator.drive();
    f.coordinator.photo();
    f.emitView({ ...lessonView(4, {}), presentation: f.runtime.view().presentation });
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
    ]);
    f.coordinator.dispose();
  });

  it('does not restart platform activity after a failed event transition', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    await f.coordinator.drive();
    f.failEventSetup();
    await expect(f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' })).rejects.toThrow('event setup failed');
    expect(f.coordinator.state().screen).toBe('pause');
    f.emitView(lessonView(3, {}));
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'drive' },
      { type: 'activity', active: false, context: 'drive' },
    ]);
    f.coordinator.dispose();
  });

  it('leaves a finished event for free drive after replay or photo', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    f.finish(result);
    expect(f.coordinator.replay()).toBe(true);
    await f.coordinator.drive();
    expect(f.runtime.freeDrive).toHaveBeenCalledTimes(1);
    expect(f.runtime.view().mode).toBe('free-drive');
    expect(activities().at(-1)).toEqual({ type: 'activity', active: true, context: 'drive' });
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    f.finish({ ...result, runId: 'run-2' });
    f.coordinator.photo();
    await f.coordinator.drive();
    expect(f.runtime.freeDrive).toHaveBeenCalledTimes(2);
    expect(f.runtime.view().mode).toBe('free-drive');
    expect(activities().at(-1)).toEqual({ type: 'activity', active: true, context: 'drive' });
    expect(activities().filter(event => event.active && event.context === 'event')).toHaveLength(2);
    f.coordinator.dispose();
  });

  it('does not briefly restart activity when a pending result drains after synchronous resume updates', async () => {
    const f = fixture();
    const activities = () => f.platformHandle.mock.calls.map(([event]) => event)
      .filter((event): event is Extract<SemanticEvent, { type: 'activity' }> => event.type === 'activity');
    await f.coordinator.initialize();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    f.emitDuringRecoveryResume();
    const release = f.holdSave();
    const pending = f.coordinator.setSettings({ muted: true });
    f.finish(result);
    release();
    await pending;
    expect(f.coordinator.state().screen).toBe('results');
    expect(activities()).toEqual([
      { type: 'activity', active: true, context: 'event' },
      { type: 'activity', active: false, context: 'event' },
    ]);
    expect(f.platformHandle.mock.calls.at(-1)?.[0].type).toBe('run-finished');
    f.coordinator.dispose();
  });

  it('isolates sandbox selection and excludes sandbox results from career', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.selectCar('CAR-02');
    expect(f.records.get('career')?.selection.car).toBe('CAR-02');
    await f.coordinator.switchProfile('sandbox');
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    expect(f.coordinator.state().persistence.state).toBe('session-only');
    await f.coordinator.selectRoute('HW-02');
    f.finish(result);
    expect(f.recordCareerResult).not.toHaveBeenCalled();
    await f.coordinator.switchProfile('career');
    expect(f.coordinator.state().selection).toMatchObject({ car: 'CAR-02', route: 'HW-01' });
    expect(f.coordinator.state().persistence.state).toBe('persistent');
    expect(f.records.get('sandbox')?.selection.route).toBe('HW-02');
    f.coordinator.dispose();
  });

  it('keeps the main menu open when the solo picker changes route or car (QA B3)', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.coordinator.open('pause');
    await f.coordinator.selectRoute('HW-02');
    expect(f.coordinator.state().screen).toBe('pause');
    await f.coordinator.selectCar('CAR-02');
    expect(f.coordinator.state().screen).toBe('pause');
    f.coordinator.open('garage');
    await f.coordinator.selectRoute('HW-01');
    expect(f.coordinator.state().screen).toBe('garage');
    f.coordinator.dispose();
  });

  it('rejects owner profile transitions in a production-target build', async () => {
    vi.stubGlobal('__OWNER_REVIEW__', false);
    const f = fixture();
    await f.coordinator.initialize();
    await expect(f.coordinator.switchProfile('sandbox')).rejects.toThrow('unavailable in this build');
    await expect(f.coordinator.reloadProfile()).rejects.toThrow('unavailable in this build');
    expect(f.coordinator.state().profile).toBe('career');
    expect(f.runtime.freeDrive).not.toHaveBeenCalled();
    f.coordinator.dispose();
  });

  it('car ownership gate: locked cars can not be selected or driven, the starter always can, sandbox is exempt', async () => {
    const f = fixture();
    const owned = new Set<string>(['CAR-01']);
    f.coordinator.setCarGate({ allowed: car => owned.has(car) });
    await f.coordinator.initialize();
    expect(f.coordinator.state().progression.unlockedCars).toEqual(['CAR-01']);
    await expect(f.coordinator.selectCar('CAR-02')).rejects.toThrow('locked');
    await expect(f.coordinator.selectCar('CAR-04')).rejects.toThrow('locked');
    await f.coordinator.selectCar('CAR-01');
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    // A buyer selects the premium car, then it becomes locked (a failed verification): driving falls back to the starter.
    owned.add('CAR-02');
    await f.coordinator.selectCar('CAR-02');
    owned.delete('CAR-02');
    await f.coordinator.drive();
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    expect(f.runtime.view().carId).toBe('CAR-01');
    // reconcileCar moves a locked selection back in menus.
    f.coordinator.open('garage');
    owned.add('CAR-02');
    await f.coordinator.selectCar('CAR-02');
    owned.delete('CAR-02');
    await f.coordinator.reconcileCar();
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    // Events (and so online races) are gated the same way.
    owned.add('CAR-02');
    await f.coordinator.selectCar('CAR-02');
    owned.delete('CAR-02');
    await f.coordinator.beginEvent({ mode: 'time-trial', rulesVersion: '1' } as never);
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    await f.coordinator.switchProfile('sandbox');
    await f.coordinator.selectCar('CAR-02');
    expect(f.coordinator.state().selection.car).toBe('CAR-02');
    f.coordinator.dispose();
  });

  it('play gate: driving, the lesson and events wait for the starter gift, menus stay reachable, and it never soft-locks', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    let opened = false, requests = 0, carryOn = false;
    f.coordinator.setPlayGate({ allowed: () => opened, require: async () => { requests++; if (carryOn) opened = true; return carryOn; } });
    expect(f.coordinator.playAllowed()).toBe(false);
    f.coordinator.open('settings');
    f.coordinator.open('pause');
    expect(f.coordinator.state().screen).toBe('pause');
    // The player asked to start but chose something else (the shop): nothing starts.
    await f.coordinator.drive();
    await f.coordinator.startTutorial();
    await expect(f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' })).rejects.toThrow(/starter gift/);
    expect(requests).toBe(3);
    expect(f.coordinator.state().screen).toBe('pause');
    expect(f.runtime.beginEvent).not.toHaveBeenCalled();
    // Opened and carried on: the same action goes through.
    carryOn = true;
    await f.coordinator.drive();
    expect(f.coordinator.state().screen).toBe('drive');
    expect(f.coordinator.playAllowed()).toBe(true);
    // Once open nothing asks again.
    requests = 0;
    f.coordinator.open('pause');
    await f.coordinator.drive();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    expect(requests).toBe(0);
    expect(f.runtime.beginEvent).toHaveBeenCalledTimes(1);
    // Removing the gate (a build without a gift) never blocks.
    f.coordinator.setPlayGate(null);
    expect(f.coordinator.playAllowed()).toBe(true);
  });
  it('keeps locked career cars unavailable while sandbox can select them', async () => {
    const f = fixture();
    f.lockCars();
    await f.coordinator.initialize();
    expect(f.coordinator.state().progression.unlockedCars).toEqual(['CAR-01']);
    await expect(f.coordinator.selectCar('CAR-02')).rejects.toThrow('locked in career');
    expect(f.coordinator.state().selection.car).toBe('CAR-01');
    await f.coordinator.switchProfile('sandbox');
    await f.coordinator.selectCar('CAR-02');
    expect(f.coordinator.state().selection.car).toBe('CAR-02');
    f.coordinator.dispose();
  });

  it('leaves authored Rival Ghost unavailable until an approved recording exists', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.coordinator.state().rivalAvailable).toBe(false);
    f.setGhost(ghost());
    expect(f.coordinator.state().rivalAvailable).toBe(false);
    await expect(f.coordinator.beginEvent({ mode: 'rival-ghost', rulesVersion: rivalRules })).rejects.toThrow('no approved recording');
    expect(f.runtime.beginEvent).not.toHaveBeenCalled();
    f.coordinator.dispose();
  });

  it('plays compatible personal-best recordings in Time Trial and safely ignores stale ones', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.setGhost(ghost('old-tune'));
    await f.coordinator.beginEvent({ mode: 'time-trial', rulesVersion: rivalRules });
    expect(f.runtime.setRival).toHaveBeenLastCalledWith([]);
    expect(f.coordinator.state().error).toContain('tuneHash');
    f.setGhost(ghost());
    await f.coordinator.beginEvent({ mode: 'time-trial', rulesVersion: rivalRules });
    expect(f.runtime.setRival).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ timeSeconds: 0 }), expect.objectContaining({ timeSeconds: 1 })]));
    expect(f.runtime.beginEvent).toHaveBeenCalledTimes(2);
    f.coordinator.dispose();
  });

  it('does not install a ghost if the event transition fails', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.setGhost(ghost());
    vi.mocked(f.runtime.beginEvent).mockImplementationOnce(() => { throw new Error('event setup failed'); });
    await expect(f.coordinator.beginEvent({ mode: 'time-trial', rulesVersion: rivalRules })).rejects.toThrow('event setup failed');
    expect(f.runtime.setRival).not.toHaveBeenCalled();
    await f.coordinator.beginEvent({ mode: 'time-trial', rulesVersion: rivalRules });
    expect(f.runtime.setRival).toHaveBeenCalledOnce();
    f.coordinator.dispose();
  });

  it('applies ghost visibility on settings changes and profile restoration', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.runtime.setGhostVisible).toHaveBeenCalledWith(true);
    await f.coordinator.setSettings({ ghostVisible: false });
    expect(f.runtime.setGhostVisible).toHaveBeenLastCalledWith(false);
    await f.coordinator.switchProfile('sandbox');
    expect(f.runtime.setGhostVisible).toHaveBeenLastCalledWith(true);
    await f.coordinator.switchProfile('career');
    expect(f.runtime.setGhostVisible).toHaveBeenLastCalledWith(false);
    f.coordinator.dispose();
  });

  it('bounds the saved base FOV and preserves the shake choice under reduced motion', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.coordinator.state().settings).toMatchObject({ cameraFovDeg: 58, cameraShakeEnabled: false });
    await f.coordinator.setSettings({ cameraFovDeg: Infinity, cameraShakeEnabled: true, reducedMotion: true });
    expect(f.coordinator.state().settings).toMatchObject({ cameraFovDeg: 58, cameraShakeEnabled: true, reducedMotion: true });
    await f.coordinator.setSettings({ cameraFovDeg: 90 });
    expect(f.records.get('career')?.settings).toMatchObject({ cameraFovDeg: 75, cameraShakeEnabled: true, reducedMotion: true });
    await f.coordinator.switchProfile('sandbox');
    expect(f.coordinator.state().settings).toMatchObject({ cameraFovDeg: 58, cameraShakeEnabled: false, reducedMotion: false });
    await f.coordinator.switchProfile('career');
    expect(f.coordinator.state().settings).toMatchObject({ cameraFovDeg: 75, cameraShakeEnabled: true, reducedMotion: true });
    await f.coordinator.setSettings({ cameraFovDeg: 40 });
    expect(f.coordinator.state().settings.cameraFovDeg).toBe(50);
    f.coordinator.dispose();
  });

  it('routes the engine volume to audio on its own channel, defaults it quieter and clamps it per profile', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.coordinator.state().settings.engineVolume).toBe(0.45);
    await f.coordinator.setSettings({ reducedMotion: true });
    expect(f.setVolumes).toHaveBeenLastCalledWith({ master: 1, music: 0.5, sfx: 1, engine: 0.45 });
    await f.coordinator.setSettings({ engineVolume: 0 });
    expect(f.setVolumes).toHaveBeenLastCalledWith({ master: 1, music: 0.5, sfx: 1, engine: 0 });
    expect(f.records.get('career')?.settings).toMatchObject({ engineVolume: 0, sfxVolume: 1 });
    await f.coordinator.setSettings({ sfxVolume: 0.3 });
    expect(f.setVolumes).toHaveBeenLastCalledWith({ master: 1, music: 0.5, sfx: 0.3, engine: 0 });
    await f.coordinator.setSettings({ engineVolume: 7 });
    expect(f.coordinator.state().settings.engineVolume).toBe(1);
    await f.coordinator.setSettings({ engineVolume: Number.NaN });
    expect(f.coordinator.state().settings.engineVolume).toBe(0.45);
    await f.coordinator.setSettings({ engineVolume: 0.2 });
    await f.coordinator.switchProfile('sandbox');
    expect(f.coordinator.state().settings.engineVolume).toBe(0.45);
    await f.coordinator.switchProfile('career');
    expect(f.coordinator.state().settings.engineVolume).toBe(0.2);
    expect(f.setVolumes).toHaveBeenLastCalledWith({ master: 1, music: 0.5, sfx: 0.3, engine: 0.2 });
    f.coordinator.dispose();
  });

  it('mutes only after real ad start and unlocks only on terminal result', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.finish(result);
    const pending = f.coordinator.requestAd(rewarded);
    expect(f.coordinator.state().ad).toBe('requested');
    expect(f.mute).not.toHaveBeenCalledWith('ad', true);
    expect(() => f.coordinator.open('garage')).toThrow('ad operation');
    f.startAd('ad-1');
    expect(f.mute).toHaveBeenCalledWith('ad', true);
    f.resolveAd({ operationId: 'ad-1', status: 'finished', rewardEligible: true });
    await pending;
    expect(f.applyCareerReward).toHaveBeenCalledOnce();
    expect(f.coordinator.state().ad).toBe('none');
    expect(f.pauseReasons.has('ad')).toBe(false);
    f.coordinator.dispose();
  });

  it('processes a valid finish queued during an unrelated settings save', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    const release = f.holdSave();
    const update = f.coordinator.setSettings({ uiScale: 1.2 });
    f.finish(result);
    expect(f.recordCareerResult).not.toHaveBeenCalled();
    release();
    await update;
    expect(f.recordCareerResult).toHaveBeenCalledOnce();
    expect(f.coordinator.state().screen).toBe('results');
    f.coordinator.dispose();
  });

  it('discards a run cancelled by a profile switch', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    const switching = f.coordinator.switchProfile('sandbox');
    f.finish(result);
    await switching;
    expect(f.recordCareerResult).not.toHaveBeenCalled();
    expect(f.coordinator.state().profile).toBe('sandbox');
    f.coordinator.dispose();
  });

  it('applies a rewarded result only after the career result write settles', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.beginEvent({ mode: 'drift-attack', rulesVersion: '1' });
    const release = f.holdResultWrite();
    f.finish(result);
    const pending = f.coordinator.requestAd(rewarded);
    f.startAd('ad-1');
    f.resolveAd({ operationId: 'ad-1', status: 'finished', rewardEligible: true });
    await Promise.resolve();
    expect(f.applyCareerReward).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.applyCareerReward).toHaveBeenCalledOnce();
    f.coordinator.dispose();
  });

  it('rejects reward eligibility without an actual ad-start signal', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.finish(result);
    const pending = f.coordinator.requestAd(rewarded);
    f.resolveAd({ operationId: 'ad-1', status: 'finished', rewardEligible: true });
    await expect(pending).rejects.toThrow('without an ad-start signal');
    expect(f.applyCareerReward).not.toHaveBeenCalled();
    expect(f.coordinator.state().ad).toBe('none');
    f.coordinator.dispose();
  });

  it('locks every presentation transition during an unresolved ad', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.finish(result);
    const pending = f.coordinator.requestAd(rewarded);
    for (const action of [() => f.coordinator.freeDrive(), () => f.coordinator.replay(), () => f.coordinator.photo(), () => f.coordinator.screenshot()]) {
      expect(action).toThrow('ad operation');
    }
    f.startAd('ad-1');
    expect(() => f.coordinator.freeDrive()).toThrow('ad operation');
    expect(() => f.coordinator.photo()).toThrow('ad operation');
    f.resolveAd({ operationId: 'ad-1', status: 'cancelled', rewardEligible: false });
    await pending;
    expect(f.coordinator.state().ad).toBe('none');
    f.coordinator.dispose();
  });

  it('persists bounded custom tuning and restores the base preset', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.selectCustomTune({ id: 'Custom', frontMuScale: 1.2, rearMuScale: .85, springScale: 1.1, steeringScale: 1, engineScale: 1.05, handbrakeRearMuScale: .35 });
    expect(f.coordinator.state().tuning.id).toBe('Custom');
    expect(f.records.get('career')?.selection.customTune?.rearMuScale).toBe(.85);
    await f.coordinator.restoreFactoryTune();
    expect(f.coordinator.state().tuning.id).toBe('Balanced');
    expect(f.records.get('career')?.selection.customTune).toBeUndefined();
    f.coordinator.dispose();
  });

  it('preserves Auto quality selection through profile restoration via runtime controller', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.setPresentation('blue-hour', 'auto');
    expect(f.runtime.setQuality).toHaveBeenLastCalledWith('auto');
    expect(f.records.get('career')?.selection.quality).toBe('auto');
    await f.coordinator.switchProfile('sandbox');
    await f.coordinator.switchProfile('career');
    expect(f.runtime.setQuality).toHaveBeenLastCalledWith('auto');
    expect(f.coordinator.state().selection.quality).toBe('auto');
    f.coordinator.dispose();
  });

  it('starts a new desktop player on Auto graphics and hands it to the renderer on first run', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.runtime.setQuality).toHaveBeenCalledWith('auto');
    expect(f.coordinator.state().selection.quality).toBe('auto');
    expect(f.records.get('career')?.selection.quality).toBe('auto');
    f.coordinator.dispose();
  });

  it('keeps a saved explicit graphics preset for an existing player', async () => {
    const first = fixture();
    await first.coordinator.initialize();
    const saved = structuredClone(first.records.get('career')!);
    first.coordinator.dispose();
    const f = fixture();
    f.records.set('career', { ...saved, selection: { ...saved.selection, quality: 'balanced' } });
    await f.coordinator.initialize();
    expect(f.runtime.setQuality).toHaveBeenLastCalledWith('balanced');
    expect(f.coordinator.state().selection.quality).toBe('balanced');
    f.coordinator.dispose();
  });

  it('does not credit a rewarded ad after career result persistence fails', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.failResultWrite();
    f.finish(result);
    const pending = f.coordinator.requestAd(rewarded);
    f.startAd('ad-1');
    f.resolveAd({ operationId: 'ad-1', status: 'finished', rewardEligible: true });
    await expect(pending).rejects.toThrow('Career result was not saved');
    expect(f.applyCareerReward).not.toHaveBeenCalled();
    expect(f.coordinator.state()).toMatchObject({ ad: 'none', error: 'career write failed' });
    f.coordinator.dispose();
  });

  it('starts a first-drive tutorial and persists skip/replay per profile', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.coordinator.state().tutorial.status).toBe('not-started');
    await f.coordinator.drive();
    expect(f.coordinator.state().tutorial).toMatchObject({ status: 'active', step: 'accelerate' });
    await f.coordinator.skipTutorial();
    expect(f.coordinator.state().tutorial.status).toBe('skipped');
    expect(f.records.get('career')?.settings).toMatchObject({ tutorialCompleted: false, tutorialSkipped: true });
    await f.coordinator.switchProfile('sandbox');
    expect(f.coordinator.state().tutorial.status).toBe('not-started');
    await f.coordinator.switchProfile('career');
    expect(f.coordinator.state().tutorial.status).toBe('skipped');
    await f.coordinator.startTutorial();
    expect(f.coordinator.state().tutorial).toMatchObject({ status: 'active', step: 'accelerate' });
    expect(f.records.get('career')?.settings).toMatchObject({ tutorialCompleted: false, tutorialSkipped: false });
    expect(f.runtime.freeDrive).toHaveBeenCalled();
    expect(f.runtime.resetVehicle).toHaveBeenCalled();
    f.coordinator.dispose();
  });

  it('does not let general settings writes fabricate a completed or skipped lesson', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.setSettings({ uiScale: 1.1, tutorialCompleted: true, tutorialSkipped: true } as never);
    expect(f.coordinator.state().tutorial.status).toBe('not-started');
    expect(f.records.get('career')?.settings).toMatchObject({ tutorialCompleted: false, tutorialSkipped: false, uiScale: 1.1 });
    f.coordinator.dispose();
  });

  it('persists measured lesson completion once after runtime input advances all steps', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.drive();
    for (let tick = 1; tick <= 20; tick++) f.emitView(lessonView(tick, { throttle: .8 }));
    for (let tick = 21; tick <= 40; tick++) f.emitView(lessonView(tick, { steering: .6 }));
    for (let tick = 41; tick <= 50; tick++) f.emitView(lessonView(tick, { handbrake: .8 }));
    for (let tick = 51; tick <= 65; tick++) f.emitView(lessonView(tick, { steering: -.6 }));
    expect(f.coordinator.state().tutorial.status).toBe('completed');
    await vi.waitFor(() => expect(f.records.get('career')?.settings).toMatchObject({ tutorialCompleted: true, tutorialSkipped: false }));
    await f.coordinator.switchProfile('sandbox');
    await f.coordinator.switchProfile('career');
    expect(f.coordinator.state().tutorial.status).toBe('completed');
    f.coordinator.dispose();
  });
});
