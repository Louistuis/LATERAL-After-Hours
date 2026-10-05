import type { RunResult, SaveEnvelope, SavedGhost } from '../../contracts/runtime-contracts.js';
import { utf8ByteLength, validateSavedGhost } from './recording.js';

export const DEFAULT_SAVE_BUDGET_BYTES = 512 * 1024;
const ROUTE_IDS = new Set(['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02']);

export interface GhostSaveResult {
  readonly save: SaveEnvelope;
  readonly stored: boolean;
  readonly reason: 'stored' | 'not-personal-best' | 'invalid-candidate' | 'unsupported-mode' | 'candidate-over-budget' | 'progression-over-budget';
  readonly serializedUtf8Bytes: number;
  readonly removedRouteIds: readonly string[];
}

export interface PersonalBestGhostProof {
  /** Immutable result returned by the finished run. */
  readonly result: RunResult;
  /** Caller compares it with the prior event record using that mode's score/time ranking. */
  readonly qualifiesAsPersonalBest: boolean;
}

/** Store only Time Trial ghosts because the save header has no mode field; Drift Attack scores cannot rank against elapsed-time ghosts. */
export function storePersonalBestGhost(
  current: SaveEnvelope,
  candidate: SavedGhost,
  proof: PersonalBestGhostProof,
  maxUtf8Bytes = DEFAULT_SAVE_BUDGET_BYTES,
): GhostSaveResult {
  const unchanged = (reason: GhostSaveResult['reason'], bytes = utf8ByteLength(JSON.stringify(current))): GhostSaveResult => ({
    save: current, stored: false, reason, serializedUtf8Bytes: bytes, removedRouteIds: [],
  });
  if (proof?.result?.mode !== 'time-trial') return unchanged('unsupported-mode');
  if (!proof?.result?.valid || proof.result.routeId !== candidate?.header?.routeId || proof.result.carId !== candidate?.header?.carId ||
    proof.result.rulesVersion !== candidate?.header?.rulesVersion || !proof.result.runId ||
    proof.result.routeVersion !== candidate?.header?.routeVersion || proof.result.physicsVersion !== candidate?.header?.physicsVersion ||
    proof.result.tuneHash !== candidate?.header?.tuneHash ||
    !Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0 || !isKnownGhost(candidate)) return unchanged('invalid-candidate');
  if (!proof.qualifiesAsPersonalBest) return unchanged('not-personal-best');
  const candidateMetadata = metadata(candidate);
  if (!validateSavedGhost(candidate, candidateMetadata).compatible) return unchanged('invalid-candidate');

  const byRoute = new Map<string, SavedGhost>();
  for (const ghost of current.ghosts) {
    if (!isKnownGhost(ghost) || !validateSavedGhost(ghost, metadata(ghost)).compatible) continue;
    const existing = byRoute.get(ghost.header.routeId);
    if (!existing || (sameCompatibility(existing, ghost) && ghost.header.durationSeconds < existing.header.durationSeconds)) {
      byRoute.set(ghost.header.routeId, ghost);
    }
  }
  const prior = byRoute.get(candidate.header.routeId);
  // Result ranking is event-mode-specific. GhostHeader intentionally carries no score metric;
  // the caller's proof is authoritative for replacing the single route ghost.

  byRoute.set(candidate.header.routeId, candidate);
  const selected = [...byRoute.values()];
  const candidateAloneFits = serializedBytes({ ...current, ghosts: [candidate] }) <= maxUtf8Bytes;
  const fitted = fitGhostBudget(current, selected, maxUtf8Bytes, candidateAloneFits ? candidate.header.routeId : undefined);
  if (!fitted) return unchanged('progression-over-budget');
  const candidateRetained = fitted.save.ghosts.some((ghost) => ghost.header.routeId === candidate.header.routeId && ghost === candidate);
  if (candidateRetained) return { save: fitted.save, stored: true, reason: 'stored', serializedUtf8Bytes: fitted.bytes, removedRouteIds: fitted.removed };

  // If the new recording cannot fit, retain the previous route PB when it is still valid.
  if (prior) {
    const fallbackGhosts = selected.filter((ghost) => ghost.header.routeId !== candidate.header.routeId).concat(prior);
    const fallback = fitGhostBudget(current, fallbackGhosts, maxUtf8Bytes);
    if (fallback) return { save: fallback.save, stored: false, reason: 'candidate-over-budget', serializedUtf8Bytes: fallback.bytes, removedRouteIds: fallback.removed };
  }
  return { save: fitted.save, stored: false, reason: 'candidate-over-budget', serializedUtf8Bytes: fitted.bytes, removedRouteIds: fitted.removed };
}

interface FitResult { readonly save: SaveEnvelope; readonly bytes: number; readonly removed: readonly string[]; }
function fitGhostBudget(current: SaveEnvelope, selected: readonly SavedGhost[], maxBytes: number, protectedRouteId?: string): FitResult | null {
  const progressionBytes = serializedBytes({ ...current, ghosts: [] });
  if (progressionBytes > maxBytes) return null;
  const ghosts = [...selected];
  const removed: string[] = [];
  let bytes = serializedBytes({ ...current, ghosts });
  while (bytes > maxBytes && ghosts.length > 0) {
    let largestIndex = -1;
    let largestBytes = -1;
    ghosts.forEach((ghost, index) => {
      if (ghost.header.routeId === protectedRouteId && ghosts.length > 1) return;
      const size = serializedBytes(ghost);
      if (size > largestBytes) { largestBytes = size; largestIndex = index; }
    });
    if (largestIndex < 0) largestIndex = ghosts.length - 1;
    removed.push(ghosts[largestIndex]!.header.routeId);
    ghosts.splice(largestIndex, 1);
    bytes = serializedBytes({ ...current, ghosts });
  }
  if (bytes > maxBytes) return null;
  const changed = !sameGhostList(current.ghosts, ghosts);
  const save: SaveEnvelope = changed
    ? Object.freeze({ ...current, revision: current.revision + 1, ghosts: Object.freeze(ghosts) })
    : current;
  return { save, bytes, removed: Object.freeze(removed) };
}

function isKnownGhost(ghost: SavedGhost): boolean {
  if (!ghost || typeof ghost !== 'object' || !ghost.header || typeof ghost.header !== 'object') return false;
  const h = ghost.header as SavedGhost['header'];
  return ROUTE_IDS.has(h.routeId) && typeof h.routeVersion === 'string' && !!h.routeVersion &&
    typeof h.rulesVersion === 'string' && !!h.rulesVersion && typeof h.physicsVersion === 'string' && !!h.physicsVersion &&
    typeof h.tuneHash === 'string' && !!h.tuneHash && typeof h.carId === 'string' &&
    typeof ghost.compressedSnapshots === 'string';
}
function metadata(ghost: SavedGhost) {
  return { routeId: ghost.header.routeId, routeVersion: ghost.header.routeVersion, rulesVersion: ghost.header.rulesVersion,
    physicsVersion: ghost.header.physicsVersion, carId: ghost.header.carId, tuneHash: ghost.header.tuneHash };
}
function sameCompatibility(a: SavedGhost, b: SavedGhost): boolean {
  const x = a.header, y = b.header;
  return x.routeVersion === y.routeVersion && x.rulesVersion === y.rulesVersion && x.physicsVersion === y.physicsVersion && x.carId === y.carId && x.tuneHash === y.tuneHash;
}
function sameGhostList(a: readonly SavedGhost[], b: readonly SavedGhost[]): boolean {
  return a.length === b.length && a.every((ghost, index) => ghost === b[index]);
}
function serializedBytes(value: unknown): number { return utf8ByteLength(JSON.stringify(value)); }
