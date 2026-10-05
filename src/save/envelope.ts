import type { CarId, EventMode, Medal, RouteId, RunResult, SaveEnvelope, SavedGhost } from '../../contracts/runtime-contracts';
import { validateSavedGhost } from '../ghosts/recording';

export const SAVE_SCHEMA_VERSION = 1;
export const MAX_SAVE_BYTES = 512 * 1024;
export const MAX_BEST_RESULTS = 100;
export const MAX_REWARD_OPERATION_IDS = 4096;
export const MAX_GHOSTS = 6;

export type SaveFailureCode = 'corrupt' | 'future-version' | 'oversized' | 'incompatible';
export class SaveValidationError extends Error {
  constructor(readonly code: SaveFailureCode, message: string) {
    super(message);
    this.name = 'SaveValidationError';
  }
}

const cars: readonly CarId[] = ['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06'];
/** Retired cars: saves that reference them move to the free starter instead of failing validation. */
const RETIRED_CARS: Readonly<Record<string, CarId>> = { 'CAR-03': 'CAR-01' };
const routes: readonly RouteId[] = ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'];
const modes: readonly EventMode[] = ['drift-attack', 'time-trial', 'rival-ghost'];
const medals: readonly Medal[] = ['none', 'bronze', 'silver', 'gold'];

/** Parse, validate and migrate JSON without evaluating it. Unknown future data is never rewritten. */
export function parseSaveEnvelope(serialized: string): SaveEnvelope {
  if (utf8Bytes(serialized) > MAX_SAVE_BYTES) throw new SaveValidationError('oversized', 'Save exceeds the 512 KiB UTF-8 limit');
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; }
  catch { throw new SaveValidationError('corrupt', 'Save is not valid JSON'); }
  if (!record(value) || !Number.isInteger(value.schemaVersion)) throw new SaveValidationError('corrupt', 'Save header is invalid');
  if ((value.schemaVersion as number) > SAVE_SCHEMA_VERSION) throw new SaveValidationError('future-version', 'Save was written by a newer game version');
  const current = migrateRetiredCars(value);
  const migrated = current.schemaVersion === 0 ? migrateV0(current) : current;
  if (!record(migrated) || migrated.schemaVersion !== SAVE_SCHEMA_VERSION) throw new SaveValidationError('incompatible', 'Save schema cannot be migrated');
  validateEnvelope(migrated);
  return migrated as unknown as SaveEnvelope;
}

export function serializeSaveEnvelope(envelope: SaveEnvelope): string {
  const serialized = JSON.stringify(envelope);
  if (utf8Bytes(serialized) > MAX_SAVE_BYTES) throw new SaveValidationError('oversized', 'Save exceeds the 512 KiB UTF-8 limit');
  return serialized;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function migrateRetiredCars(value: Record<string, unknown>): Record<string, unknown> {
  const swap = (id: unknown): unknown => typeof id === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_CARS, id) ? RETIRED_CARS[id] : id;
  const out: Record<string, unknown> = { ...value, selectedCar: swap(value.selectedCar) };
  if (Array.isArray(value.unlockedCars)) out.unlockedCars = [...new Set(value.unlockedCars.map(swap))];
  if (Array.isArray(value.bestResults)) out.bestResults = value.bestResults.map(r => record(r) ? { ...r, carId: swap(r.carId) } : r);
  if (Array.isArray(value.ghosts)) out.ghosts = value.ghosts.map(g => record(g) && record(g.header) ? { ...g, header: { ...g.header, carId: swap(g.header.carId) } } : g);
  return out;
}

function migrateV0(value: Record<string, unknown>): Record<string, unknown> {
  // v0 was the pre-ghost single-profile shape. Preserve progression and add bounded empty collections.
  if (!Number.isInteger(value.revision) || typeof value.updatedAtIso !== 'string' ||
      !Number.isSafeInteger(value.garageCredits) || !isCar(value.selectedCar) || !Array.isArray(value.unlockedCars)) {
    throw new SaveValidationError('incompatible', 'Legacy save is missing required progression fields');
  }
  return {
    ...value,
    schemaVersion: SAVE_SCHEMA_VERSION,
    bestResults: Array.isArray(value.bestResults) ? value.bestResults : [],
    settings: record(value.settings) ? value.settings : {},
    cosmetics: record(value.cosmetics) ? value.cosmetics : {},
    appliedRewardOperationIds: Array.isArray(value.appliedRewardOperationIds) ? value.appliedRewardOperationIds : [],
    ghosts: Array.isArray(value.ghosts) ? value.ghosts : [],
  };
}

function validateEnvelope(value: Record<string, unknown>): void {
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) invalid('Save revision is invalid');
  if (typeof value.updatedAtIso !== 'string' || !Number.isFinite(Date.parse(value.updatedAtIso))) invalid('Save timestamp is invalid');
  if (!Number.isSafeInteger(value.garageCredits) || (value.garageCredits as number) < 0) invalid('Garage credits are invalid');
  if (!isCar(value.selectedCar)) invalid('Selected car is invalid');
  if (!Array.isArray(value.unlockedCars) || value.unlockedCars.length > cars.length || !value.unlockedCars.every(isCar)) invalid('Unlocked cars are invalid');
  if (!Array.isArray(value.bestResults) || value.bestResults.length > MAX_BEST_RESULTS || !value.bestResults.every(isRunResult)) invalid('Best results are invalid');
  if (!record(value.settings) || Object.keys(value.settings).length > 128 || !Object.values(value.settings).every(v => typeof v === 'string' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean')) invalid('Settings are invalid');
  if (!record(value.cosmetics) || Object.keys(value.cosmetics).length > 128 || !Object.values(value.cosmetics).every(v => typeof v === 'string' && v.length <= 256)) invalid('Cosmetics are invalid');
  if (!Array.isArray(value.appliedRewardOperationIds) || value.appliedRewardOperationIds.length > MAX_REWARD_OPERATION_IDS || !value.appliedRewardOperationIds.every(v => typeof v === 'string' && v.length > 0 && v.length <= 128)) invalid('Reward ledger is invalid');
  if (new Set(value.appliedRewardOperationIds as string[]).size !== (value.appliedRewardOperationIds as string[]).length) invalid('Reward ledger contains duplicate operation IDs');
  if (!Array.isArray(value.ghosts) || value.ghosts.length > MAX_GHOSTS || !value.ghosts.every(isGhost)) invalid('Ghost collection is invalid');
  const ghostRoutes = (value.ghosts as SavedGhost[]).map(ghost => ghost.header.routeId);
  if (new Set(ghostRoutes).size !== ghostRoutes.length) invalid('Ghost collection contains more than one personal best for a route');
}

function isRunResult(value: unknown): value is RunResult {
  if (!record(value)) return false;
  if (value.assist !== undefined && value.assist !== 'off' && value.assist !== 'medium' && value.assist !== 'high') return false;
  return typeof value.runId === 'string' && value.runId.length > 0 && value.runId.length <= 128 &&
    routes.includes(value.routeId as RouteId) && modes.includes(value.mode as EventMode) &&
    typeof value.rulesVersion === 'string' && value.rulesVersion.length <= 64 && isCar(value.carId) &&
    optionalText(value.routeVersion, 64) && optionalText(value.physicsVersion, 64) && optionalText(value.tuneHash, 128) &&
    finiteNonNegative(value.elapsedActiveSeconds) && finiteNonNegative(value.bankedScore) &&
    medals.includes(value.medal as Medal) && typeof value.valid === 'boolean';
}

function isGhost(value: unknown): value is SavedGhost {
  if (!record(value) || !record(value.header)) return false;
  const h = value.header;
  return h.formatVersion === 1 && routes.includes(h.routeId as RouteId) &&
    typeof h.routeVersion === 'string' && h.routeVersion.length <= 64 &&
    typeof h.rulesVersion === 'string' && h.rulesVersion.length <= 64 &&
    typeof h.physicsVersion === 'string' && h.physicsVersion.length <= 64 && isCar(h.carId) &&
    typeof h.tuneHash === 'string' && h.tuneHash.length <= 128 && h.sampleHz === 15 &&
    Number.isSafeInteger(h.sampleCount) && (h.sampleCount as number) >= 0 && (h.sampleCount as number) <= 100_000 &&
    finiteNonNegative(h.durationSeconds) && typeof value.compressedSnapshots === 'string' &&
    value.compressedSnapshots.length <= 400_000 &&
    validateSavedGhost(value as unknown as SavedGhost, {
      routeId: h.routeId as RouteId,
      routeVersion: h.routeVersion as string,
      rulesVersion: h.rulesVersion as string,
      physicsVersion: h.physicsVersion as string,
      carId: h.carId as CarId,
      tuneHash: h.tuneHash as string,
    }).compatible;
}

function isCar(value: unknown): value is CarId { return cars.includes(value as CarId); }
function optionalText(value: unknown, maxLength: number): boolean { return value === undefined || typeof value === 'string' && value.length > 0 && value.length <= maxLength; }
function finiteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): never { throw new SaveValidationError('corrupt', message); }
