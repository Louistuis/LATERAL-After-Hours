import type { RouteId, RunResult, SavedGhost } from '../../contracts/runtime-contracts.js';
import { utf8ByteLength, validateSavedGhost, type GhostCompatibility } from '../ghosts/recording.js';

export interface RecordedRivalSourceManifest {
  readonly sourceId: string;
  readonly sourceKind: 'local-scripted-qa';
  readonly scriptSha256: string;
  readonly runResult: RunResult;
  readonly acceptedCheckpointIds: readonly string[];
  readonly routeViolation: string | null;
  readonly inputFrameCount: number;
}

export interface RecordedRivalValidation {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly serializedUtf8Bytes: number;
}

/** Validates source attribution, full ordered route completion, compatibility, decoding, and the per-ghost save bound. */
export function validateRecordedRivalCandidate(
  candidate: SavedGhost,
  source: RecordedRivalSourceManifest,
  expected: GhostCompatibility,
  requiredCheckpointIds: readonly string[],
  maxUtf8Bytes = 128 * 1024,
): RecordedRivalValidation {
  const bytes = utf8ByteLength(JSON.stringify(candidate));
  const fail = (reason: string): RecordedRivalValidation => ({ valid: false, reason, serializedUtf8Bytes: bytes });
  const result = source?.runResult;
  if (!source || source.sourceKind !== 'local-scripted-qa' || !source.sourceId || !/^[a-f\d]{64}$/i.test(source.scriptSha256) ||
      !Number.isSafeInteger(source.inputFrameCount) || source.inputFrameCount < 1) return fail('invalid source attribution');
  if (!result?.valid || !result.runId || result.mode !== 'time-trial' || result.routeId !== expected.routeId ||
      result.routeVersion !== expected.routeVersion || result.rulesVersion !== expected.rulesVersion ||
      result.physicsVersion !== expected.physicsVersion || result.carId !== expected.carId || result.tuneHash !== expected.tuneHash || source.routeViolation !== null) {
    return fail('source run identity or validity mismatch');
  }
  if (!Array.isArray(source.acceptedCheckpointIds) || requiredCheckpointIds.length < 2 || source.acceptedCheckpointIds.length !== requiredCheckpointIds.length ||
      requiredCheckpointIds.some((id, index) => source.acceptedCheckpointIds[index] !== id)) return fail('ordered checkpoint completion mismatch');
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0 || bytes > maxUtf8Bytes) return fail('candidate exceeds UTF-8 ghost bound');
  const decoded = validateSavedGhost(candidate, expected);
  if (!decoded.compatible) return fail(decoded.reason ?? 'ghost compatibility failure');
  if (decoded.samples.length !== candidate.header.sampleCount) return fail('decoded sample count mismatch');
  if (Math.abs(source.inputFrameCount - result.elapsedActiveSeconds * 60) > 1 ||
      Math.abs(candidate.header.durationSeconds - result.elapsedActiveSeconds) > 1 / 15 + 1 / 60) return fail('source input or ghost duration mismatch');
  return { valid: true, reason: null, serializedUtf8Bytes: bytes };
}

// Deliberately empty until a route recording has approved source-run evidence and validated metadata.
const RECORDED_RIVALS: Partial<Readonly<Record<RouteId, SavedGhost>>> = Object.freeze({});

/** Returns only an authored rival recording; personal-best ghosts are never substituted. */
export function getRecordedRival(routeId: RouteId): SavedGhost | null {
  return RECORDED_RIVALS[routeId] ?? null;
}
