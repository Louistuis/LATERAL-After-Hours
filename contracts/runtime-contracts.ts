/** LATERAL shared interface seed. No game or vendor SDK implementation is supplied. */
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export type Quat = Readonly<{ x: number; y: number; z: number; w: number }>;
/** Roster: CAR-01 Challenger (free starter), CAR-02 Cybertruck, CAR-04 McLaren Formula 1, CAR-05 Lancia Delta (rally), CAR-06 Koenigsegg Agera (halo). CAR-03 is retired; saves move it to CAR-01. */
export type CarId = 'CAR-01' | 'CAR-02' | 'CAR-04' | 'CAR-05' | 'CAR-06';
export type RouteId = 'HW-01' | 'HW-02' | 'RP-01' | 'RP-02' | 'CL-01' | 'CL-02';
export type PlatformTarget = 'owner-review' | 'standalone' | 'poki' | 'crazygames-basic' | 'crazygames-full' | 'selfhost';
export type QualityPreset = 'low' | 'balanced' | 'high' | 'ultra';
/** Player selection; the effective renderer preset always remains a QualityPreset. */
export type QualitySelection = QualityPreset | 'auto';
export type LightingPreset = 'golden-hour' | 'blue-hour';
export type PauseReason = 'menu' | 'manual' | 'hidden' | 'ad' | 'context-lost' | 'recovery';
export type AppState = 'boot' | 'loading' | 'ready' | 'playing' | 'paused' |
  'results' | 'replay' | 'ad-requested' | 'ad-playing' | 'recovering' | 'fatal';
export type EventMode = 'drift-attack' | 'time-trial' | 'rival-ghost';
export type Medal = 'none' | 'bronze' | 'silver' | 'gold';

/** SI units; world +Y up, local -Z forward, +X right. Positive steer means right. */
export interface InputFrame {
  readonly simulationTick: number;
  readonly throttle: number; // [0,1]
  readonly brake: number; // [0,1]
  readonly steering: number; // [-1,1]
  readonly handbrake: number; // [0,1]
  readonly shift: -1 | 0 | 1; // one-shot; consume once per input edge
  readonly resetPressed: boolean; // one-shot; not repeated for held input
}
export interface WheelSnapshot {
  readonly contact: boolean;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly compressionM: number;
  readonly normalLoadN: number;
  readonly angularVelocityRadS: number;
  readonly slipRatio: number;
  readonly slipAngleRad: number;
  readonly surfaceId: string | null;
}
export interface VehicleSnapshot {
  readonly simulationTick: number;
  readonly carId: CarId;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly linearVelocityMS: Vec3;
  readonly angularVelocityRadS: Vec3;
  readonly wheels: readonly [WheelSnapshot, WheelSnapshot, WheelSnapshot, WheelSnapshot];
  readonly engineRpm: number;
  readonly gear: number;
  readonly driftAngleRad: number;
}
export interface ScoreSnapshot {
  readonly banked: number;
  readonly unbanked: number;
  readonly multiplier: number;
  readonly validDrift: boolean;
  readonly routeProgressM: number;
  readonly activeSeconds: number;
}
export interface FrameSnapshot {
  readonly previous: VehicleSnapshot;
  readonly current: VehicleSnapshot;
  readonly interpolationAlpha: number; // [0,1]; visual interpolation only
  readonly score: ScoreSnapshot;
  /** Strongest actual obstacle impact during this advance; absent for no impact,
   * zero-step/paused frames, or reset. Consumers deduplicate by simulationTick.
   * Visual/audio feedback only; never an input to physics or scoring. */
  readonly impact?: Readonly<{
    readonly simulationTick: number;
    readonly speedDeltaMS: number;
    readonly impulseNs: number;
  }>;
}
export interface Simulation {
  step(input: InputFrame): void; // implementation uses fixed 1/60 s, not caller frame delta
  snapshot(): VehicleSnapshot;
  resetToSafePoint(): void;
  dispose(): void;
}
export interface PauseController {
  add(reason: PauseReason): void;
  remove(reason: PauseReason): void;
  reasons(): ReadonlySet<PauseReason>;
  isPaused(): boolean;
}

export type SemanticEvent =
  /** null means transfer size has not been measured; readiness is independent of this metric. */
  | Readonly<{ type: 'first-playable'; firstPlayableTransferBytes: number | null }>
  | Readonly<{ type: 'first-control'; input: 'keyboard' | 'touch' | 'gamepad' }>
  | Readonly<{ type: 'activity'; active: boolean; context: 'drive' | 'event' }>
  | Readonly<{ type: 'run-finished'; runId: string; result: RunResult }>
  | Readonly<{ type: 'visibility'; hidden: boolean }>
  | Readonly<{ type: 'context-lost' }>
  | Readonly<{ type: 'context-restored' }>;

export interface RewardSpec {
  readonly id: string;
  readonly kind: 'garage-credits';
  readonly amount: number;
}
export interface AdRequest {
  readonly operationId: string;
  readonly kind: 'interstitial' | 'rewarded';
  readonly placement: 'event-results-return';
  readonly reward: RewardSpec | null; // required for rewarded, forbidden for interstitial
}
export interface AdLifecycle {
  /** Called only by an actual SDK start notification. Adds temporary ad audio mute. */
  onStarted(operationId: string): void;
}
export type AdResult =
  | Readonly<{ operationId: string; status: 'finished'; rewardEligible: boolean }>
  | Readonly<{ operationId: string; status: 'failed' | 'unavailable' | 'cancelled';
               rewardEligible: false; errorCode?: string }>;
export interface PlatformCapabilities {
  readonly interstitialAds: boolean;
  readonly rewardedAds: boolean;
  readonly authoritativeStore: 'guarded-browser' | 'crazygames-data';
}
export interface PlatformAdapter {
  readonly target: PlatformTarget;
  initialize(): Promise<PlatformCapabilities>;
  handle(event: SemanticEvent): void;
  /** App locks input on request. One outstanding operation; no fake-success fallback. */
  requestAd(request: AdRequest, lifecycle: AdLifecycle): Promise<AdResult>;
  dispose(): void;
}

/** A timeout is NOT a terminal SDK result. Recovery must not resume beneath a live ad. */
export type StoreRead =
  | Readonly<{ status: 'found'; serialized: string }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
export type StoreWrite =
  | Readonly<{ status: 'written' }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
export interface DataStore {
  initialize(): Promise<void>;
  read(key: string): Promise<StoreRead>;
  write(key: string, serialized: string): Promise<StoreWrite>;
  /** Resolves local SDK acceptance only; must not claim guaranteed remote cloud sync. */
  flushPending(): Promise<void>;
}
export interface RunResult {
  readonly runId: string;
  readonly routeId: RouteId;
  readonly mode: EventMode;
  readonly rulesVersion: string;
  /** New runs include all identity fields; absence only denotes a legacy stored result. */
  readonly routeVersion?: string;
  readonly physicsVersion?: string;
  readonly tuneHash?: string;
  readonly carId: CarId;
  /** Driving assist level the run was driven with ('high' when it changed mid-run to a more assisted level). */
  readonly assist?: 'off' | 'medium' | 'high';
  readonly elapsedActiveSeconds: number;
  readonly bankedScore: number;
  readonly medal: Medal;
  readonly valid: boolean;
}
export interface GhostHeader {
  readonly formatVersion: 1;
  readonly routeId: RouteId;
  readonly routeVersion: string;
  readonly rulesVersion: string;
  readonly physicsVersion: string;
  readonly carId: CarId;
  readonly tuneHash: string;
  readonly sampleHz: 15;
  readonly sampleCount: number;
  readonly durationSeconds: number;
}
export interface SavedGhost {
  readonly header: GhostHeader;
  readonly compressedSnapshots: string; // encoding/size limits documented by implementation
}
export interface SaveEnvelope {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly updatedAtIso: string; // metadata only; wall time must not determine race results
  readonly garageCredits: number;
  readonly selectedCar: CarId;
  readonly unlockedCars: readonly CarId[];
  readonly bestResults: readonly RunResult[];
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly cosmetics: Readonly<Record<string, string>>;
  readonly appliedRewardOperationIds: readonly string[]; // bounded ledger, never evict pending IDs
  readonly ghosts: readonly SavedGhost[]; // evict ghosts before progression; total save <=512 KiB
}
export interface BenchmarkSample {
  readonly monotonicTimeMs: number;
  readonly frameIntervalMs: number;
  readonly simulationCpuMs: number;
  readonly renderingCpuMs: number;
  readonly gpuMs: number | null; // null when unsupported/disjoint; never substitute CPU time
  readonly drawCallsAllPasses: number;
  readonly mainPassTriangles: number;
}
