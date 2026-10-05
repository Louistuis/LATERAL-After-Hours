import type { ScoreSnapshot, VehicleSnapshot } from '../../contracts/runtime-contracts.js';
import type { RouteClippingZone } from '../../contracts/world-contracts.js';

export interface DriftScoringConfig {
  readonly rulesVersion: string;
  readonly routeLengthM: number;
  readonly minSpeedMS?: number;
  readonly fullSpeedMS?: number;
  readonly minDriftAngleRad?: number;
  readonly idealDriftAngleRad?: number;
  readonly maxDriftAngleRad?: number;
  readonly minimumGroundedWheels?: number;
  readonly progressSpeedFactor?: number;
  readonly maximumMultiplier?: number;
  readonly pointsPerSecond?: number;
  /** Optional route-authored clip opportunities. Empty/omitted means neutral line factor 1. */
  readonly clippingZones?: readonly ScoringClipZone[];
}

/** Distances use the same monotonic route-progress origin as RouteProgressTracker. */
export type ScoringClipZone = RouteClippingZone;

export interface ScoringEvidence {
  /** Monotonic, route-projected distance validated by the ordered checkpoint tracker. */
  readonly routeProgressM: number;
  readonly legalCorridor: boolean;
  /** Set false for non-road contact; callers may omit it when that evidence is unavailable. */
  readonly roadContact?: boolean;
  /** Set true while scraping walls or barriers so wall riding cannot earn route score. */
  readonly wallContact?: boolean;
  readonly checkpointValid: boolean;
  /** Change in velocity due to impact, in m/s, independent of vehicle mass. */
  readonly impactDeltaMS: number;
  /** Signed route-forward offset from the selected plausible route segment; positive is right. */
  readonly routeLateralOffsetM?: number;
  readonly active: boolean;
  readonly paused: boolean;
}

export interface DriftScorer {
  update(snapshot: VehicleSnapshot, evidence: ScoringEvidence, dtSeconds: number): ScoreSnapshot;
  bank(): ScoreSnapshot;
  reset(): ScoreSnapshot;
  invalidate(reason: 'impact' | 'spin' | 'reset' | 'shortcut'): ScoreSnapshot;
  snapshot(): ScoreSnapshot;
  readonly rulesVersion: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const finite = (v: number): boolean => Number.isFinite(v);
const GRIP_LINK_GRACE_SECONDS = 0.7;
const CLEAN_EXIT_BANK_SECONDS = 1.2;
const MAX_CLIP_PASS_BONUS_SECONDS = 1;

/** Deterministic route-aware scoring. Call once per fixed 1/60 simulation step. */
export function createDriftScorer(config: DriftScoringConfig): DriftScorer {
  if (!config.rulesVersion || !finite(config.routeLengthM) || config.routeLengthM <= 0) {
    throw new Error('Scoring requires a rules version and positive route length');
  }
  const minSpeed = config.minSpeedMS ?? 5;
  const fullSpeed = config.fullSpeedMS ?? 25;
  const minAngle = config.minDriftAngleRad ?? (10 * Math.PI / 180);
  const idealAngle = config.idealDriftAngleRad ?? (42.5 * Math.PI / 180);
  const maxAngle = config.maxDriftAngleRad ?? (75 * Math.PI / 180);
  const minGrounded = config.minimumGroundedWheels ?? 3;
  const progressFactor = config.progressSpeedFactor ?? 1.25;
  const maxMultiplier = config.maximumMultiplier ?? 5;
  const pointsPerSecond = config.pointsPerSecond ?? 100;
  const clippingZones = config.clippingZones ?? [];
  if (new Set(clippingZones.map((zone) => zone.id)).size !== clippingZones.length || clippingZones.some((zone) =>
    !zone.id || !finite(zone.progressM) || zone.progressM < 0 || zone.progressM > config.routeLengthM ||
    !finite(zone.radiusM) || zone.radiusM <= 0 || !finite(zone.preferredOffsetM) ||
    !finite(zone.lateralToleranceM) || zone.lateralToleranceM <= 0 || !finite(zone.bonusFactor))) {
    throw new Error('Scoring clip zones require unique IDs and finite positive route geometry');
  }
  const usedClipZones = new Set<string>();
  let activeClipZone: ScoringClipZone | null = null;
  let activeClipSeconds = 0;
  let banked = 0;
  let unbanked = 0;
  let multiplier = 1;
  let activeSeconds = 0;
  let linkedSeconds = 0;
  let gripSeconds = 0;
  let lastProgress = 0;
  let lastTick = -1;

  const output = (validDrift: boolean): ScoreSnapshot => ({
    banked: Math.floor(banked), unbanked: Math.floor(unbanked), multiplier,
    validDrift, routeProgressM: lastProgress, activeSeconds,
  });
  const resetChain = (): void => { unbanked = 0; multiplier = 1; linkedSeconds = 0; gripSeconds = 0; activeClipZone = null; activeClipSeconds = 0; };
  const containsClipPoint = (zone: ScoringClipZone, progress: number, offset: number | undefined): boolean =>
    Math.abs(progress - zone.progressM) <= zone.radiusM && finite(offset ?? Number.NaN) &&
    Math.abs(offset! - zone.preferredOffsetM) <= zone.lateralToleranceM;

  return {
    rulesVersion: config.rulesVersion,
    update(snapshot, evidence, dtSeconds) {
      if (!finite(dtSeconds) || Math.abs(dtSeconds - 1 / 60) > 1e-6) return output(false);
      if (!evidence.active || evidence.paused) return output(false);
      if (!finite(evidence.routeProgressM) || !finite(evidence.impactDeltaMS)) return output(false);
      if (snapshot.simulationTick <= lastTick) return output(false);
      lastTick = snapshot.simulationTick;
      activeSeconds += dtSeconds;
      const progress = clamp(evidence.routeProgressM, lastProgress, config.routeLengthM);
      const deltaProgress = progress - lastProgress;
      lastProgress = progress;
      if (activeClipZone && !containsClipPoint(activeClipZone, progress, evidence.routeLateralOffsetM)) {
        activeClipZone = null;
        activeClipSeconds = 0;
      }

      if (evidence.impactDeltaMS >= 3.5) {
        resetChain();
        return output(false);
      }
      const groundedWheels = snapshot.wheels.reduce((n, wheel) => n + Number(wheel.contact), 0);
      const speed = Math.hypot(snapshot.linearVelocityMS.x, snapshot.linearVelocityMS.z);
      const { x: qx, y: qy, z: qz, w: qw } = snapshot.rotation;
      // Rotate local -Z into world space, then project velocity onto that heading.
      const forwardX = -2 * (qx * qz + qw * qy);
      const forwardY = -2 * (qy * qz - qw * qx);
      const forwardZ = -(1 - 2 * (qx * qx + qy * qy));
      const forwardSpeed = snapshot.linearVelocityMS.x * forwardX + snapshot.linearVelocityMS.y * forwardY + snapshot.linearVelocityMS.z * forwardZ;
      const angle = Math.abs(snapshot.driftAngleRad);
      const credibleProgress = deltaProgress > 0 && deltaProgress <= Math.max(0.25, speed * dtSeconds * progressFactor);
      const basicEligibility = evidence.legalCorridor && evidence.checkpointValid && evidence.roadContact !== false && !evidence.wallContact && groundedWheels >= minGrounded &&
        forwardSpeed > minSpeed && speed > minSpeed && credibleProgress;
      const valid = basicEligibility && angle >= minAngle && angle <= maxAngle;

      if (!valid) {
        if (!basicEligibility || angle > maxAngle) {
          resetChain();
          return output(false);
        }
        // Preserve linked multiplier only through a <=0.7s direction transition.
        gripSeconds += dtSeconds;
        // A clip passage requires consecutive scoring-eligible ticks; a grip tick consumes the ID but ends its bonus window.
        activeClipZone = null;
        activeClipSeconds = 0;
        if (gripSeconds - GRIP_LINK_GRACE_SECONDS > 1e-8) {
          multiplier = 1;
          linkedSeconds = 0;
        }
        // A longer clean exit may still bank points, but no longer extends the chain.
        if (unbanked > 0 && gripSeconds + 1e-8 >= CLEAN_EXIT_BANK_SECONDS) {
          banked += unbanked;
          resetChain();
        }
        return output(false);
      }

      gripSeconds = 0;
      linkedSeconds += dtSeconds;
      if (linkedSeconds >= 2) {
        multiplier = Math.min(maxMultiplier, multiplier + 1);
        linkedSeconds -= 2;
      }
      const speedFactor = clamp((speed - minSpeed) / (fullSpeed - minSpeed), 0, 1);
      const angleFactor = angle <= idealAngle
        ? clamp((angle - minAngle) / Math.max(0.01, idealAngle - minAngle), 0, 1)
        : clamp((maxAngle - angle) / Math.max(0.01, maxAngle - idealAngle), 0, 1);
      const legalDistance = Math.min(deltaProgress, speed * dtSeconds);
      const progressRate = legalDistance / dtSeconds;
      if (progressRate > 0 && speedFactor > 0 && angleFactor > 0) {
        const basePoints = pointsPerSecond * speedFactor * angleFactor * multiplier * dtSeconds;
        if (!activeClipZone) {
          const enteringZone = clippingZones.find((candidate) => clamp(candidate.bonusFactor, 1, 1.5) > 1 && !usedClipZones.has(candidate.id) &&
            containsClipPoint(candidate, progress, evidence.routeLateralOffsetM));
          if (enteringZone) {
            activeClipZone = enteringZone;
            activeClipSeconds = 0;
            usedClipZones.add(enteringZone.id);
          }
        }
        // One activation per authored zone/pass; it boosts eligible scoring while inside, capped at one second.
        const lineFactor = activeClipZone && activeClipSeconds < MAX_CLIP_PASS_BONUS_SECONDS
          ? clamp(activeClipZone.bonusFactor, 1, 1.5) : 1;
        unbanked += basePoints * lineFactor;
        if (lineFactor > 1) {
          activeClipSeconds += dtSeconds;
          if (activeClipSeconds + 1e-8 >= MAX_CLIP_PASS_BONUS_SECONDS) {
            activeClipZone = null;
            activeClipSeconds = 0;
          }
        }
      }
      return output(true);
    },
    bank() {
      banked += unbanked;
      resetChain();
      return output(false);
    },
    reset() { banked = 0; activeSeconds = 0; lastProgress = 0; lastTick = -1; usedClipZones.clear(); resetChain(); return output(false); },
    invalidate(_reason) { resetChain(); return output(false); },
    snapshot() { return output(false); },
  };
}
