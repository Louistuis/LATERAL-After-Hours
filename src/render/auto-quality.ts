import type { QualityPreset } from '../../contracts/runtime-contracts';

export interface AutoQualityControllerOptions {
  /** Tier Auto starts from: the device/GPU guess (see gpu-tier.ts). Defaults to Balanced. */
  readonly initialPreset?: QualityPreset;
  /** Target cadence for the current device class. */
  readonly targetFps?: 30 | 60;
  /** Highest tier Auto may climb to (phones stop below Ultra). Defaults to Ultra. */
  readonly maxPreset?: QualityPreset;
}

export interface AutoQualityController {
  /** Feed one delivered frame interval; inactive samples clear streaks without advancing timers. */
  sample(frameIntervalMs: number, active: boolean): QualityPreset;
  readonly effectivePreset: QualityPreset;
  /**
   * Render-resolution multiplier, 0.6 to 1 in 0.1 steps. Auto spends resolution before effects: a slow
   * stretch first lowers this, and only a slow stretch at the floor drops a tier. Always 1 for fixed presets.
   */
  readonly resolutionScale: number;
  reset(): void;
  /** Lock a benchmark/user-selected fixed preset, or pass null to resume Auto. */
  lockFixed(preset: QualityPreset | null): void;
}

export const QUALITY_TIERS: readonly QualityPreset[] = ['low', 'balanced', 'high', 'ultra'];
const DOWN_WINDOW = 45;
const DOWN_REQUIRED = 30;
const DOWN_FACTOR = 1.15;
const HEADROOM_FACTOR = 1.05;
const HEADROOM_ACTIVE_MS = 30_000;
const HEADROOM_WINDOW_MS = 2_000;
const UPGRADE_TRIAL_MS = 5_000;
const TRANSITION_COOLDOWN_MS = 5_000;
const FAILED_UPGRADE_BACKOFF_MS = 30_000;
const FREEZE_INTERVAL_MS = 100;
/** Dynamic resolution: floor, step and the (shorter) timers that govern it. */
export const MIN_RESOLUTION_SCALE = 0.6;
const SCALE_STEP = 0.1;
const SCALE_COOLDOWN_MS = 1_500;
const SCALE_UP_HEALTHY_MS = 4_000;
const SCALE_TRIAL_MS = 3_000;
const SCALE_BACKOFF_MS = 20_000;
/**
 * Startup probe: the first active seconds measure the guessed tier. A slow probe first buys the frame time back with
 * resolution (fill cost scales with pixel count, so the scale needed is about sqrt(target / measured)); only when even
 * the resolution floor cannot get there does it drop a tier. Each change re-probes.
 */
const PROBE_MS = 3_000;
/** Aim a little under the frame budget so the estimate lands on the 60 fps side. */
const PROBE_AIM = 0.92;
/**
 * Averages drop this share of the slowest intervals: a shader compile, a resize or a busy moment elsewhere on the
 * machine must not pass for a slow GPU (and must not chase resolution down), while a steady 40 fps still shows.
 */
const MEAN_TRIM = 0.15;

function percentileNearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function tierIndex(preset: QualityPreset): number {
  return QUALITY_TIERS.indexOf(preset);
}

const roundScale = (value: number): number => Math.round(value * 10) / 10;
/**
 * Mean of the intervals without the slowest MEAN_TRIM share. It sees a 40 fps vsync alternation (16.7/33.3 ms) that
 * a median or a slow-frame count misses, and ignores the odd hitch.
 */
function trimmedMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const kept = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * (1 - MEAN_TRIM))));
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

/** Pure render policy driven by delivered frame intervals; it never touches simulation or scoring. */
export function createAutoQualityController(options: AutoQualityControllerOptions = {}): AutoQualityController {
  const initialPreset = options.initialPreset ?? 'balanced';
  const targetFps = options.targetFps ?? 60;
  const maxPreset = options.maxPreset ?? 'ultra';
  if (tierIndex(initialPreset) < 0) throw new RangeError(`Unknown initial Auto quality: ${String(initialPreset)}`);
  if (tierIndex(maxPreset) < 0) throw new RangeError(`Unknown maximum Auto quality: ${String(maxPreset)}`);
  if (targetFps !== 30 && targetFps !== 60) {
    throw new RangeError(`Auto quality target must be 30 or 60 FPS, got ${String(targetFps)}`);
  }
  const maxTier = tierIndex(maxPreset);
  const startPreset = QUALITY_TIERS[Math.min(tierIndex(initialPreset), maxTier)]!;

  const targetIntervalMs = 1000 / targetFps;
  let preset: QualityPreset = startPreset;
  let scale = 1;
  let fixedPreset: QualityPreset | null = null;
  let recentIntervals: number[] = [];
  let recentActiveMs = 0;
  let badIntervals: boolean[] = [];
  let windowIntervals: number[] = [];
  let healthyActiveMs = 0;
  let transitionCooldownMs = 0;
  let scaleCooldownMs = 0;
  let upgradeBackoffMs = 0;
  let scaleBackoffMs = 0;
  let trialPreviousPreset: QualityPreset | null = null;
  let trialActiveMs = 0;
  let scaleTrialMs = -1;
  let probeIntervals: number[] = [];
  let probeActiveMs = 0;
  let probing = true;

  function clearStreaks(): void {
    recentIntervals = [];
    recentActiveMs = 0;
    badIntervals = [];
    windowIntervals = [];
    healthyActiveMs = 0;
  }
  function clearTrial(): void {
    trialPreviousPreset = null;
    trialActiveMs = 0;
  }
  function restartProbe(): void {
    probeIntervals = [];
    probeActiveMs = 0;
    probing = true;
  }
  function effective(): QualityPreset {
    return fixedPreset ?? preset;
  }
  function moveOneTier(direction: -1 | 1): void {
    const nextTier = Math.max(0, Math.min(maxTier, tierIndex(preset) + direction));
    preset = QUALITY_TIERS[nextTier]!;
  }
  function badWindowIsSustained(): boolean {
    if (badIntervals.length < DOWN_WINDOW) return false;
    if (badIntervals.filter(Boolean).length >= DOWN_REQUIRED) return true;
    // At 40-50 fps on a 60 Hz display frames alternate between one and two vsyncs, so only about half count as slow.
    return trimmedMean(windowIntervals) > targetIntervalMs * DOWN_FACTOR;
  }

  return {
    get effectivePreset(): QualityPreset { return effective(); },
    get resolutionScale(): number { return fixedPreset === null ? scale : 1; },
    sample(frameIntervalMs, active): QualityPreset {
      if (fixedPreset !== null) return fixedPreset;
      if (!active || !Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
        clearStreaks();
        trialActiveMs = 0;
        return effective();
      }

      // Startup probe: a guessed tier that runs far below target drops at once instead of crawling down.
      if (probing) {
        probeIntervals.push(frameIntervalMs);
        probeActiveMs += frameIntervalMs;
        if (probeActiveMs >= PROBE_MS) {
          probing = false;
          const settled = probeIntervals.slice(Math.floor(probeIntervals.length / 4));
          const mean = trimmedMean(settled);
          if (mean > targetIntervalMs * DOWN_FACTOR) {
            // Resolution first: the scale that should bring this tier under budget, rounded down to a step.
            const needed = Math.floor(scale * Math.sqrt(targetIntervalMs * PROBE_AIM / mean) * 10 + 1e-6) / 10;
            if (needed >= MIN_RESOLUTION_SCALE - 1e-6 && needed < scale) scale = roundScale(needed);
            else if (tierIndex(preset) > 0) { moveOneTier(-1); scale = 1; }
            else scale = MIN_RESOLUTION_SCALE;
            clearStreaks();
            clearTrial();
            if (scale > MIN_RESOLUTION_SCALE + 1e-6 || tierIndex(preset) > 0) restartProbe();
            transitionCooldownMs = 0;
            scaleCooldownMs = 0;
            return effective();
          }
        }
      }

      transitionCooldownMs = Math.max(0, transitionCooldownMs - frameIntervalMs);
      scaleCooldownMs = Math.max(0, scaleCooldownMs - frameIntervalMs);
      upgradeBackoffMs = Math.max(0, upgradeBackoffMs - frameIntervalMs);
      scaleBackoffMs = Math.max(0, scaleBackoffMs - frameIntervalMs);
      recentIntervals.push(frameIntervalMs);
      recentActiveMs += frameIntervalMs;
      while (recentIntervals.length > 1 && recentActiveMs - recentIntervals[0]! >= HEADROOM_WINDOW_MS) {
        recentActiveMs -= recentIntervals.shift()!;
      }
      badIntervals.push(frameIntervalMs > targetIntervalMs * DOWN_FACTOR);
      if (badIntervals.length > DOWN_WINDOW) badIntervals.shift();
      windowIntervals.push(frameIntervalMs);
      if (windowIntervals.length > DOWN_WINDOW) windowIntervals.shift();

      const hasHeadroomWindow = recentActiveMs >= HEADROOM_WINDOW_MS;
      const hasFreeze = recentIntervals.some((interval) => interval > FREEZE_INTERVAL_MS);
      const hasHeadroom = hasHeadroomWindow && !hasFreeze &&
        percentileNearestRank(recentIntervals, 0.95) <= targetIntervalMs * HEADROOM_FACTOR;
      healthyActiveMs = hasHeadroom ? healthyActiveMs + frameIntervalMs : 0;
      if (trialPreviousPreset !== null) trialActiveMs += frameIntervalMs;
      if (scaleTrialMs >= 0) scaleTrialMs += frameIntervalMs;

      // A tier upgrade that stutters is undone first, before resolution is touched.
      if (trialPreviousPreset !== null && (frameIntervalMs > FREEZE_INTERVAL_MS || badWindowIsSustained())) {
        preset = trialPreviousPreset;
        clearTrial();
        transitionCooldownMs = TRANSITION_COOLDOWN_MS;
        upgradeBackoffMs = FAILED_UPGRADE_BACKOFF_MS;
        clearStreaks();
        return effective();
      }
      if (trialPreviousPreset !== null && trialActiveMs >= UPGRADE_TRIAL_MS) {
        clearTrial();
        healthyActiveMs = 0;
      }
      if (scaleTrialMs >= SCALE_TRIAL_MS) scaleTrialMs = -1;

      if (transitionCooldownMs > 0 || scaleCooldownMs > 0) return effective();
      if (badWindowIsSustained()) {
        if (scaleTrialMs >= 0) scaleBackoffMs = SCALE_BACKOFF_MS;
        scaleTrialMs = -1;
        if (scale > MIN_RESOLUTION_SCALE + 1e-6) {
          scale = roundScale(Math.max(MIN_RESOLUTION_SCALE, scale - SCALE_STEP));
          clearStreaks();
          scaleCooldownMs = SCALE_COOLDOWN_MS;
          return effective();
        }
        if (tierIndex(preset) > 0) {
          moveOneTier(-1);
          scale = 1;
          clearStreaks();
          clearTrial();
          transitionCooldownMs = TRANSITION_COOLDOWN_MS;
          return effective();
        }
      }
      if (scale < 1 && scaleBackoffMs === 0 && healthyActiveMs >= SCALE_UP_HEALTHY_MS) {
        scale = roundScale(Math.min(1, scale + SCALE_STEP));
        scaleTrialMs = 0;
        scaleCooldownMs = SCALE_COOLDOWN_MS;
        clearStreaks();
        return effective();
      }
      if (scale >= 1 && tierIndex(preset) < maxTier && upgradeBackoffMs === 0 && healthyActiveMs >= HEADROOM_ACTIVE_MS) {
        const previous = preset;
        moveOneTier(1);
        trialPreviousPreset = previous;
        trialActiveMs = 0;
        transitionCooldownMs = TRANSITION_COOLDOWN_MS;
        clearStreaks();
      }
      return effective();
    },
    reset(): void {
      preset = startPreset;
      scale = 1;
      fixedPreset = null;
      transitionCooldownMs = 0;
      scaleCooldownMs = 0;
      upgradeBackoffMs = 0;
      scaleBackoffMs = 0;
      scaleTrialMs = -1;
      clearStreaks();
      clearTrial();
      restartProbe();
    },
    lockFixed(nextPreset): void {
      if (nextPreset !== null && !QUALITY_TIERS.includes(nextPreset)) {
        throw new RangeError(`Unknown fixed quality preset: ${String(nextPreset)}`);
      }
      fixedPreset = nextPreset;
      transitionCooldownMs = 0;
      scaleCooldownMs = 0;
      upgradeBackoffMs = 0;
      scaleBackoffMs = 0;
      scaleTrialMs = -1;
      clearStreaks();
      clearTrial();
      if (nextPreset === null) restartProbe();
    },
  };
}
