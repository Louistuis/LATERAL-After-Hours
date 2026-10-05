/**
 * Driving assists (handling layer on top of the raw lateral-force model).
 *
 * Assists only change inputs and forces inside the fixed-step simulation (steering target, steering lag,
 * drive torque, brake request and a bounded chassis yaw torque). They never move the car directly.
 * 'off' is the raw model, bit-for-bit. All gains are dimensionless or scaled by the car's own yaw inertia,
 * grip and wheelbase, so new cars need no per-car assist entries.
 */
// Level ids are wire and save stable (results, leaderboards, race presence, missions), so they keep their old
// names: 'medium' is the drift-friendly default (shown as "Drift"), 'high' is the full safety net ("Beginner").
export type AssistLevel = 'off' | 'medium' | 'high';
export const ASSIST_LEVELS: readonly AssistLevel[] = ['medium', 'high', 'off'];
/** What a brand new player gets. The simulation itself defaults to 'off' so fixtures stay raw. */
export const DEFAULT_PLAYER_ASSIST: AssistLevel = 'medium';
export const isAssistLevel = (value: unknown): value is AssistLevel => value === 'off' || value === 'medium' || value === 'high';
/**
 * Saved assist settings version. Version 1 saves (no version) defaulted everyone to 'high', so a stored 'high'
 * cannot be told apart from "never chose": those move once to the new default. 'medium' and 'off' were explicit
 * choices and are kept ('medium' is now the Drift level, the closest match). Once saved at version 2 every value,
 * including a deliberate 'high' (Beginner), is kept as is.
 */
export const ASSIST_SETTINGS_VERSION = 2;
export function migrateAssistLevel(stored: unknown, version: unknown): AssistLevel {
  if (!isAssistLevel(stored)) return DEFAULT_PLAYER_ASSIST;
  return version !== ASSIST_SETTINGS_VERSION && stored === 'high' ? DEFAULT_PLAYER_ASSIST : stored;
}
export const ASSIST_LABELS: Readonly<Record<AssistLevel, string>> = { high: 'Beginner', medium: 'Drift', off: 'Off' };
/** Short badge text for leaderboards and results. */
export const ASSIST_BADGES: Readonly<Record<AssistLevel, string>> = { high: 'BEG', medium: 'AST', off: 'PRO' };

export interface AssistProfile {
  /** Front slip-angle window, as a multiple of the tyre peak slip angle, around the front axle travel direction. */
  readonly lockUsefulMultiple: number;
  /** Speed (m/s) where the slip-angle limiter starts to apply, and the speed range over which it ramps to full. */
  readonly limiterOnsetMS: number;
  readonly limiterRampMS: number;
  /** Extra steering lag at 30 m/s, as a multiple of the car's own response time (1 = twice as slow). */
  readonly steerLagAtSpeed: number;
  /** Countersteer: minimum shortfall gain, cap (rad), gate start (rad), gate width (rad), share kept when the driver opposes it. */
  readonly counterGain: number;
  readonly counterCapRad: number;
  readonly counterGateRad: number;
  readonly counterGateWidthRad: number;
  readonly counterOpposedKeep: number;
  /** Yaw stability: slip allowed before the restoring torque starts, restoring and slip-rate damping gains (1/s^2, 1/s). */
  readonly stabilitySlipRad: number;
  readonly stabilityRestore: number;
  readonly stabilityDamping: number;
  /** Traction control: rear slip ratio target and the lowest drive share it may cut to. */
  readonly tractionSlipTarget: number;
  readonly tractionFloor: number;
  /** Traction control fades out between this speed and 1.5x it (Infinity keeps it on at every speed). */
  readonly tractionMaxSpeedMS: number;
  /** Traction control only acts while body slip is below this (Infinity: always), so it never cuts a slide. */
  readonly tractionMaxSlipRad: number;
  /** Power-oversteer guard: drive cut per rad/s of growing body slip beyond the allowed slip. */
  readonly powerOversteerCut: number;
  /** Understeer management: drive cut and brake request when steering demand far exceeds available grip. */
  readonly understeerThrottleCut: number;
  readonly understeerBrake: number;
  /** Whether this level detects drift intent (handbrake/flick) and runs the drift-mode angle hold at all. */
  readonly driftIntent: boolean;
  /** Spin catch on yaw: slip-rate damping also applies past spinGateRad when slip grows faster than spinRateRadS. */
  readonly spinRateRadS: number;
  readonly spinGateRad: number;
  /** Exit help: restoring gain (1/s^2) past ~17 deg while the driver countersteers and lifts (asking to straighten). */
  readonly exitRestore: number;
  /** Late countersteer catch on top of the normal countersteer: gate start and width (rad; Infinity disables) and cap. */
  readonly catchGateRad: number;
  readonly catchGateWidthRad: number;
  readonly catchCapRad: number;
  /** Drift intent: steering swing (input units, full lock to full lock = 2) inside 0.25 s that counts as a flick (> 2 disables). */
  readonly flickSwing: number;
  /** Drift hold: widest angle the hold accepts, and restoring/damping gains around the chosen angle. */
  readonly driftMaxRad: number;
  readonly driftHoldRestore: number;
  readonly driftHoldDamping: number;
  /** Share of the hold that also keeps a drift from collapsing below the chosen angle while the driver stays on throttle. */
  readonly driftHoldLow: number;
}

export const ASSIST_PROFILES: Readonly<Record<Exclude<AssistLevel, 'off'>, AssistProfile>> = {
  high: {
    lockUsefulMultiple: 1.1, limiterOnsetMS: 4, limiterRampMS: 6, steerLagAtSpeed: 1.1,
    counterGain: 1, counterCapRad: 0.5, counterGateRad: 0.08, counterGateWidthRad: 0.16, counterOpposedKeep: 0.5,
    stabilitySlipRad: 0.1, stabilityRestore: 14, stabilityDamping: 6,
    tractionSlipTarget: 0.15, tractionFloor: 0.25, tractionMaxSpeedMS: Infinity, tractionMaxSlipRad: Infinity, powerOversteerCut: 2.5,
    understeerThrottleCut: 1, understeerBrake: 0.55,
    driftIntent: true, spinRateRadS: Infinity, spinGateRad: 0, exitRestore: 0, catchGateRad: Infinity, catchGateWidthRad: 1, catchCapRad: 0,
    // High: handbrake is the only drift trigger, so a keyboard newcomer's lock-to-lock corrections never disarm the guard.
    flickSwing: 3, driftMaxRad: 0.7, driftHoldRestore: 10, driftHoldDamping: 4, driftHoldLow: 0.8,
  },
  // Drift (the default): close to the raw car. No steering lag, a loose slip limiter only at high speed, no throttle
  // cut or brake, traction control only at launch. Slides are free to about 50-55 degrees; past that, or when the
  // slip grows fast, a strong late countersteer and yaw catch stops the spin. Any initiation works (handbrake,
  // flick, power) because there is no drift mode to arm.
  medium: {
    lockUsefulMultiple: 2.6, limiterOnsetMS: 24, limiterRampMS: 12, steerLagAtSpeed: 0,
    // Countersteer exactly as the raw car (gain from the car config, same gate and cap); the catch is the yaw torque.
    counterGain: 0, counterCapRad: 0.35, counterGateRad: 0.14, counterGateWidthRad: 0.21, counterOpposedKeep: 0.2,
    stabilitySlipRad: 0.98, stabilityRestore: 16, stabilityDamping: 6,
    tractionSlipTarget: 0.25, tractionFloor: 0.45, tractionMaxSpeedMS: 10, tractionMaxSlipRad: 0.12, powerOversteerCut: 0,
    understeerThrottleCut: 0, understeerBrake: 0,
    driftIntent: false, spinRateRadS: 1.6, spinGateRad: 0.4, exitRestore: 8,
    catchGateRad: 0.85, catchGateWidthRad: 0.2, catchCapRad: 0.5,
    flickSwing: 3, driftMaxRad: 0.95, driftHoldRestore: 0, driftHoldDamping: 0, driftHoldLow: 0,
  },
};

export const assistProfile = (level: AssistLevel): AssistProfile | null => level === 'off' ? null : ASSIST_PROFILES[level];

/** Live assist activity for HUD/telemetry and the handling probes. */
export interface AssistTelemetry {
  readonly level: AssistLevel;
  readonly driftMode: boolean;
  readonly driftTargetRad: number;
  readonly throttleScale: number;
  readonly brakeAdded: number;
  readonly yawTorqueNm: number;
  readonly steerLimitRad: number;
}
