import { describe, expect, it } from 'vitest';
import type { RunResult, SaveEnvelope } from '../../contracts/runtime-contracts.js';
import { applyRunReward, findCompatibleBestResult, isPersonalBestResult, MAX_BEST_RESULT_ROWS } from '../../src/progression/rewards.js';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const save: SaveEnvelope = { schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 0, selectedCar: 'CAR-01', unlockedCars: ['CAR-01'], bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [] };
const result: RunResult = { runId: 'r1', routeId: 'HW-01', mode: 'drift-attack', rulesVersion: 'v1', carId: 'CAR-01', elapsedActiveSeconds: 60, bankedScore: 400, medal: 'silver', valid: true };

describe('reward transaction', () => {
  it('applies immutable reward and best result once', () => {
    const first = applyRunReward(save, result, { id: 'event-complete', kind: 'garage-credits', amount: 25 });
    expect(first.applied).toBe(true);
    expect(first.save.garageCredits).toBe(25);
    expect(first.save.revision).toBe(1);
    expect(first.save.bestResults).toEqual([result]);
    expect(save.garageCredits).toBe(0);
    expect(applyRunReward(first.save, result, { id: 'event-complete', kind: 'garage-credits', amount: 25 }).reason).toBe('duplicate');
  });

  it('does not reward invalid runs or silently downgrade the best medal', () => {
    expect(applyRunReward(save, { ...result, valid: false }, { id: 'x', kind: 'garage-credits', amount: 4 }).applied).toBe(false);
    const current = { ...save, bestResults: [{ ...result, medal: 'gold' as const, bankedScore: 800 }] };
    const applied = applyRunReward(current, { ...result, runId: 'r2', medal: 'bronze' }, { id: 'x', kind: 'garage-credits', amount: 4 });
    expect(applied.save.bestResults[0]?.medal).toBe('gold');
    expect(applied.save.garageCredits).toBe(4);
  });

  it('unlocks cars deterministically at three and six distinct completed events', () => {
    const results: RunResult[] = [
      result,
      { ...result, runId: 'r2', routeId: 'HW-02' },
      { ...result, runId: 'r3', routeId: 'RP-01' },
    ];
    let current = save;
    for (let i = 0; i < results.length; i++) current = applyRunReward(current, results[i]!, { id: 'reward', kind: 'garage-credits', amount: 0 }).save;
    expect(current.unlockedCars).toContain('CAR-02');
    for (const [i, routeId] of ['RP-02', 'CL-01', 'CL-02'].entries()) {
      current = applyRunReward(current, { ...result, runId: `r${i + 4}`, routeId: routeId as RunResult['routeId'] }, { id: 'reward', kind: 'garage-credits', amount: 0 }).save;
    }
    expect(current.unlockedCars).toContain('CAR-04');
  });

  it('uses elapsed time when selecting a better Rival Ghost result', () => {
    const old = { ...result, mode: 'rival-ghost' as const, elapsedActiveSeconds: 50, bankedScore: 10 };
    const current = { ...save, bestResults: [old] };
    const faster = { ...old, runId: 'r2', elapsedActiveSeconds: 40, bankedScore: 5 };
    const applied = applyRunReward(current, faster, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(applied.save.bestResults[0]?.elapsedActiveSeconds).toBe(40);
  });

  it('uses score to qualify Drift Attack ghosts and elapsed time for Time Trial ghosts', () => {
    const scoredBest = { ...result, medal: 'silver' as const, bankedScore: 800 };
    const scoreSave = { ...save, bestResults: [scoredBest] };
    expect(isPersonalBestResult(scoreSave, { ...scoredBest, runId: 'lower', bankedScore: 700 })).toBe(false);
    expect(isPersonalBestResult(scoreSave, { ...scoredBest, runId: 'higher', bankedScore: 900 })).toBe(true);
    const timedBest = { ...result, mode: 'time-trial' as const, elapsedActiveSeconds: 60 };
    const timeSave = { ...save, bestResults: [timedBest] };
    expect(isPersonalBestResult(timeSave, { ...timedBest, runId: 'slower', elapsedActiveSeconds: 61 })).toBe(false);
    expect(isPersonalBestResult(timeSave, { ...timedBest, runId: 'faster', elapsedActiveSeconds: 59 })).toBe(true);
  });

  it('keeps old-version medals while starting a fresh current PB bucket', () => {
    const historical = { ...result, medal: 'gold' as const, bankedScore: 900, routeVersion: '1.0.0', physicsVersion: 'physics-1' };
    const current = { ...result, rulesVersion: 'drift-score-v2-provisional', routeVersion: '1.0.1', physicsVersion: 'physics-1', medal: 'bronze' as const, bankedScore: 120 };
    const oldSave = { ...save, bestResults: [historical] };
    expect(isPersonalBestResult(oldSave, current)).toBe(true);
    const applied = applyRunReward(oldSave, current, { id: 'v2', kind: 'garage-credits', amount: 2 });
    expect(applied.save.bestResults).toEqual([historical, current]);
    expect(findCompatibleBestResult(applied.save, current)).toEqual(current);
    expect(findCompatibleBestResult(applied.save, historical)).toEqual(historical);
    expect(isPersonalBestResult(applied.save, { ...current, runId: 'worse', bankedScore: 100 })).toBe(false);
    expect(applyRunReward(applied.save, current, { id: 'v2', kind: 'garage-credits', amount: 2 }).reason).toBe('duplicate');
  });

  it('retains a v4 gold Time Trial while opening a separate current-physics v5 PB bucket', () => {
    const historicalV4 = { ...result, mode: 'time-trial' as const, medal: 'gold' as const,
      elapsedActiveSeconds: 60, routeVersion: '1.0.3', rulesVersion: 'drift-score-v3-provisional',
      physicsVersion: 'lateral-force-60hz-v4' };
    const firstCurrentV5 = { ...historicalV4, runId: 'current-v5-bronze', medal: 'bronze' as const,
      elapsedActiveSeconds: 75, physicsVersion: VEHICLE_PHYSICS_VERSION };
    expect(VEHICLE_PHYSICS_VERSION).toBe('lateral-force-60hz-v6');
    const otherCompletedEvents = [
      { ...historicalV4, runId: 'hw01-drift', mode: 'drift-attack' as const },
      { ...historicalV4, runId: 'hw02-time', routeId: 'HW-02' as const },
      { ...historicalV4, runId: 'rp01-time', routeId: 'RP-01' as const },
      { ...historicalV4, runId: 'rp02-time', routeId: 'RP-02' as const },
    ];
    const oldSave: SaveEnvelope = { ...save, bestResults: [historicalV4, ...otherCompletedEvents] };
    expect(findCompatibleBestResult(oldSave, firstCurrentV5)).toBeUndefined();
    expect(isPersonalBestResult(oldSave, firstCurrentV5)).toBe(true);

    const applied = applyRunReward(oldSave, firstCurrentV5, { id: 'current-v5', kind: 'garage-credits', amount: 0 });
    expect(applied.save.bestResults).toEqual([historicalV4, ...otherCompletedEvents, firstCurrentV5]);
    expect(findCompatibleBestResult(applied.save, firstCurrentV5)).toEqual(firstCurrentV5);
    expect(findCompatibleBestResult(applied.save, historicalV4)).toEqual(historicalV4);
    expect(applied.save.bestResults.find(entry => entry.physicsVersion === 'lateral-force-60hz-v4')?.medal).toBe('gold');
    expect(applied.save.bestResults.find(entry => entry.physicsVersion === VEHICLE_PHYSICS_VERSION)?.medal).toBe('bronze');
    const completedEventKeys = new Set(applied.save.bestResults.filter(entry => entry.valid).map(entry => `${entry.routeId}:${entry.mode}`));
    expect(completedEventKeys.size).toBe(5);
    expect(applied.save.unlockedCars).toContain('CAR-02');
    expect(applied.save.unlockedCars).not.toContain('CAR-04');
    expect(isPersonalBestResult(applied.save, { ...firstCurrentV5, runId: 'worse-v5', elapsedActiveSeconds: 80 })).toBe(false);
  });

  it('compares against the strongest row when imported saves contain duplicate identities', () => {
    const weak = { ...result, runId: 'weak-row', bankedScore: 400, medal: 'silver' as const };
    const strong = { ...result, runId: 'strong-row', bankedScore: 800, medal: 'silver' as const };
    const current = { ...save, bestResults: [weak, strong] };
    expect(findCompatibleBestResult(current, result)).toEqual(strong);
    expect(isPersonalBestResult(current, { ...result, runId: 'middle', bankedScore: 600 })).toBe(false);
    const replacement = applyRunReward(current, { ...result, runId: 'new-top', bankedScore: 900 }, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(replacement.save.bestResults.filter((entry) => entry.routeId === 'HW-01' && entry.mode === 'drift-attack')).toEqual([
      { ...result, runId: 'new-top', bankedScore: 900 },
    ]);
  });

  it('isolates legacy rows and counts unique events across versions for unlocks', () => {
    const legacy = { ...result, medal: 'gold' as const };
    const modern = { ...result, runId: 'modern', routeVersion: '1.0.1', physicsVersion: 'physics-2', rulesVersion: 'v2', medal: 'bronze' as const };
    const first = applyRunReward({ ...save, bestResults: [legacy] }, modern, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(first.save.bestResults).toHaveLength(2);
    expect(first.save.unlockedCars).not.toContain('CAR-02');
    const second = applyRunReward(first.save, { ...modern, runId: 'other-event', routeId: 'HW-02', mode: 'time-trial' }, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(second.save.unlockedCars).not.toContain('CAR-02');
    const third = applyRunReward(second.save, { ...modern, runId: 'third-event', routeId: 'RP-01', mode: 'rival-ghost' }, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(third.save.unlockedCars).toContain('CAR-02');
    const duplicateVersion = applyRunReward(third.save, { ...modern, runId: 'same-event-new-version', rulesVersion: 'v3' }, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(duplicateVersion.save.unlockedCars).toContain('CAR-02');
    expect(duplicateVersion.save.bestResults.filter((entry) => entry.routeId === 'HW-01' && entry.mode === 'drift-attack')).toHaveLength(3);
  });

  it('bounds PB history while retaining the newest row and historical top medal per event', () => {
    const history: RunResult[] = Array.from({ length: 120 }, (_, index) => ({
      ...result, runId: `history-${index}`, rulesVersion: `rules-${index}`, routeVersion: `route-${index}`,
      physicsVersion: 'physics-1', medal: index === 4 ? 'gold' as const : 'bronze' as const, bankedScore: index,
    }));
    const latest = { ...result, runId: 'new-current', rulesVersion: 'current', routeVersion: '1.0.1', physicsVersion: 'physics-1', medal: 'none' as const, bankedScore: 0 };
    const applied = applyRunReward({ ...save, bestResults: history }, latest, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(applied.save.bestResults).toHaveLength(MAX_BEST_RESULT_ROWS);
    expect(applied.save.bestResults.some((entry) => entry.medal === 'gold')).toBe(true);
    expect(applied.save.bestResults.some((entry) => entry.runId === 'new-current')).toBe(true);

    const nonImproving = { ...history[119]!, runId: 'non-improving', medal: 'none' as const, bankedScore: 0 };
    const compacted = applyRunReward({ ...save, bestResults: history }, nonImproving, { id: 'reward', kind: 'garage-credits', amount: 0 });
    expect(compacted.save.bestResults).toHaveLength(MAX_BEST_RESULT_ROWS);
    expect(compacted.save.bestResults.some((entry) => entry.medal === 'gold')).toBe(true);
    expect(compacted.save.bestResults.some((entry) => entry.runId === 'history-119')).toBe(true);
    expect(compacted.save.bestResults.some((entry) => entry.runId === 'non-improving')).toBe(false);
  });

  it('never evicts reward IDs and refuses rewards after the bounded ledger fills', () => {
    const full = { ...save, appliedRewardOperationIds: Array.from({ length: 4096 }, (_, i) => `run-${i}`) };
    const rejected = applyRunReward(full, result, { id: 'reward', kind: 'garage-credits', amount: 5 });
    expect(rejected).toMatchObject({ applied: false, reason: 'ledger-full', save: full });
    expect(rejected.save.appliedRewardOperationIds).toHaveLength(4096);
    expect(applyRunReward(save, result, { id: 'reward', kind: 'garage-credits', amount: 10_001 }).reason).toBe('invalid-reward');
    const nearLimit = { ...save, garageCredits: Number.MAX_SAFE_INTEGER - 2 };
    expect(applyRunReward(nearLimit, { ...result, runId: 'overflow-run' }, { id: 'reward', kind: 'garage-credits', amount: 5 }))
      .toMatchObject({ applied: false, reason: 'invalid-reward', save: nearLimit });
  });
});
