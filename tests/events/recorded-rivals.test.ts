import { describe, expect, it } from 'vitest';
import type { RunResult, VehicleSnapshot } from '../../contracts/runtime-contracts.js';
import { getRecordedRival, validateRecordedRivalCandidate, type RecordedRivalSourceManifest } from '../../src/events/recorded-rivals.js';
import { createGhostRecorder, validateSavedGhost, type GhostCompatibility } from '../../src/ghosts/recording.js';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';

const expected: GhostCompatibility = { routeId: 'HW-01', routeVersion: '1.0.3', rulesVersion: 'drift-score-v3-provisional', physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01', tuneHash: 'tune-hash-v2' };
const checkpointIds = ['HW01-CP-01', 'HW01-CP-02', 'HW01-CP-03', 'HW01-CP-04', 'HW01-CP-05', 'HW01-CP-06', 'HW01-CP-07', 'HW01-CP-08'];
const sample = (simulationTick: number): VehicleSnapshot => ({
  simulationTick, carId: 'CAR-01', position: { x: simulationTick / 60, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocityMS: { x: 0, y: 0, z: -8 }, angularVelocityRadS: { x: 0, y: 0, z: 0 }, engineRpm: 2000, gear: 2, driftAngleRad: 0,
  wheels: [0, 1, 2, 3].map(() => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0, normalLoadN: 100, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0, surfaceId: 'road:harbor:hw01' })) as unknown as VehicleSnapshot['wheels'],
});
const fixture = () => {
  const recorder = createGhostRecorder();
  for (let tick = 0; tick <= 60; tick++) recorder.update(sample(tick), tick / 60);
  const candidate = recorder.toSavedGhost(expected, 128 * 1024)!;
  const runResult: RunResult = { runId: 'qa-source-run', routeId: 'HW-01', mode: 'time-trial', rulesVersion: expected.rulesVersion,
    routeVersion: expected.routeVersion, physicsVersion: expected.physicsVersion, tuneHash: expected.tuneHash, carId: expected.carId,
    elapsedActiveSeconds: 1, bankedScore: 0, medal: 'none', valid: true };
  const source: RecordedRivalSourceManifest = { sourceId: 'fixture-source', sourceKind: 'local-scripted-qa', scriptSha256: 'a'.repeat(64),
    runResult, acceptedCheckpointIds: checkpointIds, routeViolation: null, inputFrameCount: 60 };
  return { candidate, source };
};

describe('authored rival registry', () => {
  it('keeps unapproved or provisional recordings unavailable and never substitutes a personal best', () => {
    expect(getRecordedRival('HW-01')).toBeNull();
    expect(getRecordedRival('HW-02')).toBeNull();
  });

  it('accepts only fully attributed, compatible, bounded candidates with all gates in order', () => {
    const { candidate, source } = fixture();
    expect(validateRecordedRivalCandidate(candidate, source, expected, checkpointIds)).toMatchObject({ valid: true, reason: null });
    expect(validateRecordedRivalCandidate(candidate, { ...source, acceptedCheckpointIds: checkpointIds.slice(1) }, expected, checkpointIds).reason)
      .toBe('ordered checkpoint completion mismatch');
    expect(validateRecordedRivalCandidate(candidate, { ...source, routeViolation: 'shortcut' }, expected, checkpointIds).reason)
      .toBe('source run identity or validity mismatch');
    const newPhysics = { ...expected, physicsVersion: 'new-physics' };
    expect(validateRecordedRivalCandidate(candidate, { ...source, runResult: { ...source.runResult, physicsVersion: 'new-physics' } }, newPhysics, checkpointIds).reason)
      .toContain('incompatible physicsVersion');
    const bumpedRoute = { ...expected, routeVersion: '1.0.4' };
    expect(validateRecordedRivalCandidate(candidate, { ...source, runResult: { ...source.runResult, routeVersion: '1.0.4' } }, bumpedRoute, checkpointIds).reason)
      .toContain('incompatible routeVersion');
    const priorRules = { ...expected, rulesVersion: 'drift-score-v2-provisional' };
    const priorRulesRecorder = createGhostRecorder();
    for (let tick = 0; tick <= 60; tick++) priorRulesRecorder.update(sample(tick), tick / 60);
    const priorRulesGhost = priorRulesRecorder.toSavedGhost(priorRules, 128 * 1024)!;
    expect(validateRecordedRivalCandidate(priorRulesGhost, source, expected, checkpointIds).reason)
      .toContain('incompatible rulesVersion');
    const priorPhysics = { ...expected, physicsVersion: 'lateral-force-60hz-v4' };
    const priorPhysicsRecorder = createGhostRecorder();
    for (let tick = 0; tick <= 60; tick++) priorPhysicsRecorder.update(sample(tick), tick / 60);
    const priorPhysicsGhost = priorPhysicsRecorder.toSavedGhost(priorPhysics, 128 * 1024)!;
    expect(validateSavedGhost(priorPhysicsGhost, expected).reason).toContain('incompatible physicsVersion');
    expect(validateRecordedRivalCandidate(priorPhysicsGhost, source, expected, checkpointIds).reason)
      .toContain('incompatible physicsVersion');
    expect(validateRecordedRivalCandidate(candidate, source, expected, checkpointIds, 1).reason)
      .toBe('candidate exceeds UTF-8 ghost bound');
  });

  it('rejects corrupt payloads and invalid or incomplete source identities', () => {
    const { candidate, source } = fixture();
    expect(validateRecordedRivalCandidate({ ...candidate, compressedSnapshots: 'g2:corrupt' }, source, expected, checkpointIds).valid).toBe(false);
    expect(validateRecordedRivalCandidate(candidate, { ...source, scriptSha256: 'not-a-hash' }, expected, checkpointIds).reason)
      .toBe('invalid source attribution');
    expect(validateRecordedRivalCandidate(candidate, { ...source, runResult: { ...source.runResult, valid: false } }, expected, checkpointIds).reason)
      .toBe('source run identity or validity mismatch');
    expect(validateRecordedRivalCandidate(candidate, { ...source, inputFrameCount: 1 }, expected, checkpointIds).reason)
      .toBe('source input or ghost duration mismatch');
  });
});
