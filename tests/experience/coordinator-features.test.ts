import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../contracts/runtime-contracts';
import type { GameRuntime, RuntimeView } from '../../src/core/game-runtime';
import { ExperienceCoordinator, type ProfileRecord } from '../../src/experience';
import { EVENTS, ROUTES } from '../../content/events/catalog';

const routeVersion = ROUTES.find(route => route.routeId === 'HW-01')!.version;
const ttRules = EVENTS.find(event => event.routeId === 'HW-01' && event.mode === 'time-trial')!.rulesVersion;

/** Minimal runtime and ports: enough for the loaner, the challenge rival and the replay presentation. */
function fixture() {
  let car: RuntimeView['carId'] = 'CAR-01';
  let mode: RuntimeView['mode'] = 'free-drive';
  let presentation: RuntimeView['presentation'] = 'drive';
  let result: RunResult | null = null;
  const pauses = new Set<string>();
  const view = (): RuntimeView => ({ carId: car, route: { id: 'HW-01', version: routeVersion } as RuntimeView['route'], tune: 'Balanced', mode, run: null, result, paused: pauses.size > 0, presentation, replayProgress: 0, frame: {} as RuntimeView['frame'], input: { simulationTick: 0, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false }, metrics: {} as RuntimeView['metrics'] });
  const runtime = {
    scene: { setLighting: vi.fn(), setQuality: vi.fn(), setCosmetics: vi.fn() }, view, routes: () => [{ id: 'HW-01' }], setQuality: vi.fn(),
    pause: (reason: string) => { pauses.add(reason); }, resume: (reason: string) => { pauses.delete(reason); },
    onRunFinished: vi.fn(), subscribe: () => () => {}, start: vi.fn(),
    leavePresentation: vi.fn(() => { presentation = 'drive'; }), freeDrive: vi.fn(() => { mode = 'free-drive'; }), resetVehicle: vi.fn(),
    selectCar: async (id: typeof car) => { car = id; }, selectRoute: vi.fn(), selectTune: vi.fn(),
    tuning: () => ({ id: 'Balanced', frontMuScale: 1, rearMuScale: 1, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: .4 }),
    selectCustomTune: vi.fn(), restoreFactoryTune: vi.fn(),
    beginEvent: vi.fn((selection: { mode: RuntimeView['mode'] }) => { mode = selection.mode; }), retry: vi.fn(), setRival: vi.fn(), setGhostVisible: vi.fn(), setAssist: vi.fn(), tuneHash: () => 'tune-1',
    enterReplay: vi.fn(() => true), enterPhoto: vi.fn(() => { presentation = 'photo'; }), screenshot: vi.fn(),
    enterReplayWith: vi.fn((samples: readonly unknown[]) => { if (samples.length < 2) return false; presentation = 'replay'; return true; }),
  } as unknown as GameRuntime;
  const records = new Map<string, ProfileRecord>();
  const coordinator = new ExperienceCoordinator(runtime, {
    profiles: { load: async profile => records.get(profile) ?? null, save: async record => { records.set(record.profile, record); }, getProgression: () => ({ garageCredits: 0, unlockedCars: ['CAR-01'], bestResults: [] }), getSavedGhost: () => null },
    audio: { setTemporaryMute: vi.fn(), resumeFromGesture: async () => {}, setUserMute: vi.fn(), setVolumes: vi.fn() },
    rewards: { recordCareerResult: async () => {}, applyCareerReward: async () => {} },
    platform: { handle: vi.fn(), requestAd: vi.fn() } as never,
  });
  return { coordinator, runtime, setResult: (value: RunResult | null) => { result = value; } };
}

describe('coordinator feature hooks', () => {
  beforeEach(() => { vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('__OWNER_REVIEW__', false); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('lends a locked car for the daily and takes it back', async () => {
    const { coordinator } = fixture();
    await coordinator.initialize();
    coordinator.setCarGate({ allowed: car => car === 'CAR-01' });
    expect(coordinator.carAllowed('CAR-02')).toBe(false);
    await expect(coordinator.selectCar('CAR-02')).rejects.toThrow(/locked/);
    coordinator.setCarLoan('CAR-02');
    expect(coordinator.carAllowed('CAR-02')).toBe(true);
    expect(coordinator.state().progression.unlockedCars).toContain('CAR-02');
    await coordinator.selectCar('CAR-02');
    expect(coordinator.state().selection.car).toBe('CAR-02');
    coordinator.setCarLoan(null);
    expect(coordinator.carLoaned()).toBeNull();
    expect(coordinator.carAllowed('CAR-02')).toBe(false);
    await coordinator.reconcileCar();
    expect(coordinator.state().selection.car).toBe('CAR-01');
  });

  it('races a challenge ghost once, then the personal best again', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.initialize();
    const samples = [0, 1].map(t => ({ timeSeconds: t, position: { x: t, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, driftAngleRad: 0, gear: 1 }));
    coordinator.setNextRival(samples);
    await coordinator.beginEvent({ mode: 'time-trial', rulesVersion: ttRules });
    expect(runtime.setRival).toHaveBeenLastCalledWith(samples);
    await coordinator.beginEvent({ mode: 'time-trial', rulesVersion: ttRules });
    expect(runtime.setRival).toHaveBeenLastCalledWith([]);
    coordinator.setNextRival([samples[0]!]);
    await coordinator.beginEvent({ mode: 'time-trial', rulesVersion: ttRules });
    expect(runtime.setRival).toHaveBeenLastCalledWith([]);
  });

  it('replays a whole run and steps back to results or the menu', async () => {
    const { coordinator, setResult } = fixture();
    await coordinator.initialize();
    const samples = [0, 1, 2].map(t => ({ timeSeconds: t, position: { x: t, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, driftAngleRad: 0, gear: 1 }));
    expect(coordinator.replayRun([])).toBe(false);
    expect(coordinator.replayRun(samples)).toBe(true);
    expect(coordinator.state().screen).toBe('replay');
    coordinator.leavePresentation();
    expect(coordinator.state().screen).toBe('pause');
    setResult({ runId: 'r', routeId: 'HW-01', mode: 'time-trial', rulesVersion: ttRules, carId: 'CAR-01', elapsedActiveSeconds: 30, bankedScore: 0, medal: 'none', valid: true });
    coordinator.photo();
    expect(coordinator.state().screen).toBe('photo');
    coordinator.leavePresentation();
    expect(coordinator.state().screen).toBe('results');
  });
});
