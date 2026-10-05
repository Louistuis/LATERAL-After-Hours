import { describe, expect, it } from 'vitest';
import type { SaveEnvelope } from '../../contracts/runtime-contracts';
import { parseSaveEnvelope, SaveValidationError, serializeSaveEnvelope } from '../../src/save/envelope';

const base: SaveEnvelope = {
  schemaVersion: 1, revision: 2, updatedAtIso: '2026-09-30T10:00:00.000Z', garageCredits: 100,
  selectedCar: 'CAR-01', unlockedCars: ['CAR-01'], bestResults: [], settings: {}, cosmetics: {},
  appliedRewardOperationIds: ['reward-1'], ghosts: [],
};

describe('save envelope validation', () => {
  it('round trips valid profile data and migrates a known v0 envelope', () => {
    expect(parseSaveEnvelope(serializeSaveEnvelope(base)).schemaVersion).toBe(1);
    const migrated = parseSaveEnvelope(JSON.stringify({ ...base, schemaVersion: 0, ghosts: undefined }));
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.ghosts).toEqual([]);
  });

  it('rejects corrupt, future, unsupported and oversized data with distinct reasons', () => {
    expect(() => parseSaveEnvelope('{')).toThrowError(SaveValidationError);
    expect(() => parseSaveEnvelope(JSON.stringify({ ...base, schemaVersion: 99 }))).toThrow(/newer/);
    expect(() => parseSaveEnvelope(JSON.stringify({ ...base, selectedCar: 'CAR-99' }))).toThrow(/Selected car/);
    expect(() => parseSaveEnvelope(' '.repeat(512 * 1024 + 1))).toThrow(/512 KiB/);
  });

  it('rejects duplicate reward ledger IDs and non-finite or invalid collection entries', () => {
    expect(() => parseSaveEnvelope(JSON.stringify({ ...base, appliedRewardOperationIds: ['same', 'same'] }))).toThrow(/duplicate/);
    expect(() => parseSaveEnvelope(JSON.stringify({ ...base, ghosts: [null] }))).toThrow(/Ghost collection/);
  });
});
