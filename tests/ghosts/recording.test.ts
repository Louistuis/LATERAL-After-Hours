import { describe, expect, it } from 'vitest';
import type { RunResult, SaveEnvelope, VehicleSnapshot } from '../../contracts/runtime-contracts.js';
import { createGhostRecorder, interpolateGhost, ReplayBuffer, storePersonalBestGhost, validateSavedGhost, utf8ByteLength } from '../../src/ghosts/index.js';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const snapshot = (tick: number, x = 0): VehicleSnapshot => ({
  simulationTick: tick, carId: 'CAR-01', position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocityMS: { x: 0, y: 0, z: -10 }, angularVelocityRadS: { x: 0, y: 0, z: 0 }, engineRpm: 2000, gear: 1, driftAngleRad: 0,
  wheels: [0, 1, 2, 3].map(() => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0, normalLoadN: 1, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0, surfaceId: null })) as unknown as VehicleSnapshot['wheels'],
});
const metadata = { routeId: 'HW-01' as const, routeVersion: 'r1', rulesVersion: 's1', physicsVersion: 'p1', carId: 'CAR-01' as const, tuneHash: 'h1' };
const timeTrialResult = (routeId: RunResult['routeId']): RunResult => ({ runId: `run-${routeId}`, routeId, mode: 'time-trial', rulesVersion: 's1', routeVersion: 'r1', physicsVersion: 'p1', tuneHash: 'h1', carId: 'CAR-01', elapsedActiveSeconds: 100, bankedScore: 0, medal: 'bronze', valid: true });

describe('bounded replay and ghost', () => {
  it('keeps at most twelve seconds at 30Hz and freezes an independent copy', () => {
    const replay = new ReplayBuffer();
    for (let i = 0; i <= 450; i++) replay.push(snapshot(i, i), i / 30);
    expect(replay.size).toBe(360);
    const frozen = replay.freeze();
    replay.push(snapshot(451), 451 / 30);
    expect(frozen).toHaveLength(360);
  });

  it('records at 15Hz, checks complete UTF-8 serialized size, validates and interpolates', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 120; i++) recorder.update(snapshot(i, i / 60), i / 60);
    const saved = recorder.toSavedGhost(metadata, 64 * 1024);
    expect(saved?.header.sampleHz).toBe(15);
    expect(saved && utf8ByteLength(JSON.stringify(saved))).toBeLessThanOrEqual(64 * 1024);
    const validated = validateSavedGhost(saved!, metadata);
    expect(validated.compatible).toBe(true);
    expect(interpolateGhost(validated.samples, 0.5)?.position.x).toBeCloseTo(0.5);
    expect(validateSavedGhost(saved!, { ...metadata, tuneHash: 'different' })).toMatchObject({ compatible: false, reason: 'incompatible tuneHash' });
    expect(recorder.toSavedGhost(metadata, 16)).toBeNull();
  });

  it.each([
    ['routeVersion', 'old-route'], ['rulesVersion', 'old-rules'], ['physicsVersion', 'old-physics'],
    ['carId', 'CAR-02'], ['tuneHash', 'old-tune'],
  ] as const)('rejects a recorded rival with mismatched %s metadata', (key, value) => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 60; i++) recorder.update(snapshot(i, i / 60), i / 60);
    const saved = recorder.toSavedGhost(metadata, 10_000)!;
    expect(validateSavedGhost({ ...saved, header: { ...saved.header, [key]: value } }, metadata))
      .toMatchObject({ compatible: false, reason: `incompatible ${key}` });
  });

  it('accepts a current-physics Time Trial ghost and rejects the historical v4 ghost without retagging it', () => {
    const currentMetadata = { ...metadata, routeVersion: '1.0.3', rulesVersion: 'drift-score-v3-provisional', physicsVersion: VEHICLE_PHYSICS_VERSION };
    const recorder = createGhostRecorder();
    for (let tick = 0; tick <= 60; tick++) recorder.update(snapshot(tick), tick / 60);
    const currentGhost = recorder.toSavedGhost(currentMetadata, 128 * 1024)!;
    expect(currentGhost.header.physicsVersion).toBe(VEHICLE_PHYSICS_VERSION);
    expect(validateSavedGhost(currentGhost, currentMetadata)).toMatchObject({ compatible: true, reason: null });

    const historicalMetadata = { ...currentMetadata, physicsVersion: 'lateral-force-60hz-v4' };
    const historicalRecorder = createGhostRecorder();
    for (let tick = 0; tick <= 60; tick++) historicalRecorder.update(snapshot(tick), tick / 60);
    const historicalV4Ghost = historicalRecorder.toSavedGhost(historicalMetadata, 128 * 1024)!;
    expect(historicalV4Ghost.header.physicsVersion).toBe('lateral-force-60hz-v4');
    expect(validateSavedGhost(historicalV4Ghost, currentMetadata))
      .toMatchObject({ compatible: false, reason: 'incompatible physicsVersion' });

    const result: RunResult = { ...timeTrialResult('HW-01'), routeVersion: currentMetadata.routeVersion,
      rulesVersion: currentMetadata.rulesVersion, physicsVersion: currentMetadata.physicsVersion, tuneHash: currentMetadata.tuneHash };
    const accepted = storePersonalBestGhost({ schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 0,
      selectedCar: 'CAR-01', unlockedCars: ['CAR-01'], bestResults: [], settings: {}, cosmetics: {},
      appliedRewardOperationIds: [], ghosts: [] }, currentGhost, { result, qualifiesAsPersonalBest: true });
    expect(accepted.stored).toBe(true);
    expect(storePersonalBestGhost(accepted.save, historicalV4Ghost, { result, qualifiesAsPersonalBest: true }).reason)
      .toBe('invalid-candidate');
  });

  it('compactly stores a three-minute recording and rejects checksum corruption', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 10_800; i++) recorder.update(snapshot(i, i / 60), i / 60);
    expect(recorder.sampleCount).toBeGreaterThanOrEqual(2700);
    expect(recorder.sampleCount).toBeLessThanOrEqual(2701);
    const saved = recorder.toSavedGhost(metadata, 128 * 1024);
    expect(saved?.compressedSnapshots.startsWith('g2:')).toBe(true);
    expect(saved && utf8ByteLength(JSON.stringify(saved))).toBeLessThan(100 * 1024);
    expect(validateSavedGhost(saved!, metadata).compatible).toBe(true);
    const payload = saved!.compressedSnapshots;
    const corruptAt = 25;
    const corrupted = { ...saved!, compressedSnapshots: `${payload.slice(0, corruptAt)}${payload[corruptAt] === 'A' ? 'B' : 'A'}${payload.slice(corruptAt + 1)}` };
    expect(validateSavedGhost(corrupted, metadata)).toMatchObject({ compatible: false, reason: 'corrupt recording' });
    expect(validateSavedGhost({ ...saved!, header: { ...saved!.header, formatVersion: 2 } as never }, metadata).reason).toBe('unsupported format version');
  });

  it('reads legacy JSON ghosts with absolute source timestamps as route-relative time', () => {
    const legacyFrames = [
      { ...snapshot(0, 2), timeSeconds: 14, position: { x: 2, y: 0, z: 0 } },
      { ...snapshot(1, 3), timeSeconds: 14 + 1 / 15, position: { x: 3, y: 0, z: 0 } },
    ];
    const binary = new TextEncoder().encode(JSON.stringify(legacyFrames));
    const legacyString = btoa(Array.from(binary, (byte) => String.fromCharCode(byte)).join(''));
    const saved = {
      header: { formatVersion: 1 as const, ...metadata, sampleHz: 15 as const, sampleCount: 2, durationSeconds: 1 / 15 },
      compressedSnapshots: legacyString,
    };
    const result = validateSavedGhost(saved, metadata);
    expect(result.compatible).toBe(true);
    expect(result.samples[0]?.timeSeconds).toBe(0);
    expect(result.samples[1]?.timeSeconds).toBeCloseTo(1 / 15);
    expect(validateSavedGhost({ ...saved, compressedSnapshots: 'A'.repeat(700_001) }, metadata)).toMatchObject({ compatible: false, reason: 'corrupt recording' });
  });

  it('keeps one fastest compatible personal-best ghost per route within the full save budget', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 10_800; i++) recorder.update(snapshot(i, i / 60), i / 60);
    const threeMinuteGhost = recorder.toSavedGhost(metadata, 128 * 1024)!;
    const baseSave = {
      schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 999, selectedCar: 'CAR-01' as const,
      unlockedCars: ['CAR-01'] as const, bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: ['run-1'], ghosts: [],
    };
    let current: SaveEnvelope = baseSave;
    for (const routeId of ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'] as const) {
      const ghost = { ...threeMinuteGhost, header: { ...threeMinuteGhost.header, routeId } };
      const stored = storePersonalBestGhost(current, ghost, { result: timeTrialResult(routeId), qualifiesAsPersonalBest: true }, 512 * 1024);
      expect(stored.stored).toBe(true);
      current = stored.save;
      expect(stored.serializedUtf8Bytes).toBeLessThanOrEqual(512 * 1024);
    }
    expect(current.ghosts).toHaveLength(6);
    expect(new Set(current.ghosts.map((ghost) => ghost.header.routeId)).size).toBe(6);
    expect(current.garageCredits).toBe(999);
    expect(current.appliedRewardOperationIds).toEqual(['run-1']);

    const fastRecorder = createGhostRecorder();
    for (let i = 0; i <= 5400; i++) fastRecorder.update(snapshot(i, i / 60), i / 60);
    const fasterBase = fastRecorder.toSavedGhost(metadata, 128 * 1024)!;
    const faster = { ...fasterBase, header: { ...fasterBase.header, routeId: 'HW-01' as const } };
    const fasterStored = storePersonalBestGhost(current, faster, { result: { ...timeTrialResult('HW-01'), runId: 'run-faster', elapsedActiveSeconds: 89 }, qualifiesAsPersonalBest: true }, 512 * 1024);
    expect(fasterStored.stored).toBe(true);
    expect(fasterStored.save.ghosts.filter((ghost) => ghost.header.routeId === 'HW-01')).toHaveLength(1);
    const slower = { ...threeMinuteGhost, header: { ...threeMinuteGhost.header, routeId: 'HW-01' as const } };
    expect(storePersonalBestGhost(fasterStored.save, slower, { result: timeTrialResult('HW-01'), qualifiesAsPersonalBest: false }, 512 * 1024).reason).toBe('not-personal-best');
  });

  it('does not store Drift Attack bests in the mode-less Time Trial ghost slot', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 120; i++) recorder.update(snapshot(i, i / 60), i / 60);
    const ghost = recorder.toSavedGhost(metadata, 10_000)!;
    const current: SaveEnvelope = {
      schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 0, selectedCar: 'CAR-01',
      unlockedCars: ['CAR-01'], bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [],
    };
    const result = { ...timeTrialResult('HW-01'), mode: 'drift-attack' as const, bankedScore: 500 };
    expect(storePersonalBestGhost(current, ghost, { result, qualifiesAsPersonalBest: true }))
      .toMatchObject({ stored: false, reason: 'unsupported-mode', save: current });
  });

  it('rejects legacy or mismatched result identity when writing a current personal-best ghost', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i <= 120; i++) recorder.update(snapshot(i, i / 60), i / 60);
    const ghost = recorder.toSavedGhost(metadata, 10_000)!;
    const current = { schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 0, selectedCar: 'CAR-01' as const,
      unlockedCars: ['CAR-01'] as const, bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [] } satisfies SaveEnvelope;
    const legacy = { runId: 'legacy', routeId: 'HW-01', mode: 'time-trial', rulesVersion: 's1', carId: 'CAR-01', elapsedActiveSeconds: 100, bankedScore: 0, medal: 'bronze', valid: true } as RunResult;
    expect(storePersonalBestGhost(current, ghost, { result: legacy, qualifiesAsPersonalBest: true }).reason).toBe('invalid-candidate');
    expect(storePersonalBestGhost(current, ghost, { result: { ...timeTrialResult('HW-01'), routeVersion: 'old' }, qualifiesAsPersonalBest: true }).reason).toBe('invalid-candidate');
  });

  it('protects a fitting new personal-best ghost while evicting older route ghosts', () => {
    const smallRecorder = createGhostRecorder();
    for (let i = 0; i <= 240; i++) smallRecorder.update(snapshot(i, i / 60), i / 60);
    const oldBase = smallRecorder.toSavedGhost(metadata, 128 * 1024)!;
    const longRecorder = createGhostRecorder();
    for (let i = 0; i <= 10_800; i++) longRecorder.update(snapshot(i, i / 60), i / 60);
    const longBase = longRecorder.toSavedGhost(metadata, 128 * 1024)!;
    const oldGhost = { ...oldBase, header: { ...oldBase.header, routeId: 'HW-01' as const } };
    const candidate = { ...longBase, header: { ...longBase.header, routeId: 'HW-02' as const } };
    const current: SaveEnvelope = {
      schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 20, selectedCar: 'CAR-01', unlockedCars: ['CAR-01'],
      bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [oldGhost],
    };
    const candidateOnlyBytes = utf8ByteLength(JSON.stringify({ ...current, ghosts: [candidate] }));
    const result = storePersonalBestGhost(current, candidate, { result: timeTrialResult('HW-02'), qualifiesAsPersonalBest: true }, candidateOnlyBytes);
    expect(result.stored).toBe(true);
    expect(result.save.ghosts.map((ghost) => ghost.header.routeId)).toEqual(['HW-02']);
    expect(result.serializedUtf8Bytes).toBe(candidateOnlyBytes);
  });

  it('drops ghosts before progression when over budget and leaves oversized progression unchanged', () => {
    const recorder = createGhostRecorder();
    for (let i = 0; i < 120; i++) recorder.update(snapshot(i), i / 60);
    const ghost = recorder.toSavedGhost(metadata, 128 * 1024)!;
    const baseSave = {
      schemaVersion: 1, revision: 0, updatedAtIso: '', garageCredits: 44, selectedCar: 'CAR-01' as const,
      unlockedCars: ['CAR-01'] as const, bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: ['finished-run'], ghosts: [],
    };
    const limited = storePersonalBestGhost(baseSave, ghost, { result: timeTrialResult('HW-01'), qualifiesAsPersonalBest: true }, 600);
    expect(limited.stored).toBe(false);
    expect(limited.save.ghosts).toHaveLength(0);
    expect(limited.save.garageCredits).toBe(44);
    expect(limited.save.appliedRewardOperationIds).toEqual(['finished-run']);
    const tooSmall = storePersonalBestGhost({ ...baseSave, settings: { oversized: 'x'.repeat(1000) } }, ghost, { result: timeTrialResult('HW-01'), qualifiesAsPersonalBest: true }, 600);
    expect(tooSmall.reason).toBe('progression-over-budget');
    expect(tooSmall.save.garageCredits).toBe(44);
  });
});
