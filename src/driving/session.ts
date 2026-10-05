import type {
  FrameSnapshot, InputFrame, RunResult, ScoreSnapshot, VehicleSnapshot,
} from '../../contracts/runtime-contracts.js';
import { FIXED_DT, FixedClock, PauseSet } from '../core/clock.js';
import type { VehicleSimulationHandle } from '../physics/index.js';
import type { CheckpointUpdate, RunController } from '../events/run-controller.js';
import type { DriftScorer } from '../events/scoring.js';
import { ReplayBuffer, createGhostRecorder } from '../ghosts/index.js';
import type { GhostRecorder, GhostTransform } from '../ghosts/index.js';
import { RECOVERY_PENALTY_SECONDS, STUCK_SPEED_MS, type RecoveryPose, type RecoveryReason, type RecoveryTracker } from './recovery.js';

export interface RecoveryState {
  /** Recoveries in this session (free drive or run). */
  readonly count: number;
  readonly reason: RecoveryReason | null;
  /** Seconds added to the run clock by the latest recovery (0 outside an active run). */
  readonly penaltySeconds: number;
}

export interface RouteEvidence {
  /** Distance on the nearest valid route segment, without spline wraparound. */
  readonly routeProgressM: number;
  /** Signed route-forward offset from the same plausible segment; positive is right. */
  readonly routeLateralOffsetM?: number;
  readonly legalCorridor: boolean;
  readonly checkpointValid: boolean;
  /** Explicit road classification from world metadata, when available. */
  readonly roadContact?: boolean;
  /**
   * At least three wheels on the road or its own curbs and run-off shoulder. Drives the sustained off-road
   * invalidation timer (curbs and shoulder are legal to use, just not asphalt for scoring). Defaults to roadContact.
   */
  readonly surfaceContact?: boolean;
  /** Wall contact from scene collision metadata, when available. */
  readonly wallContact?: boolean;
  /** Route tracker confirmed an unrecoverable run violation. */
  readonly runViolation?: 'shortcut' | 'wrong-way';
}

export interface DrivingSessionOptions {
  readonly simulation: VehicleSimulationHandle;
  readonly run?: RunController;
  readonly scorer?: DriftScorer;
  readonly routeEvidence?: (
    previous: VehicleSnapshot,
    current: VehicleSnapshot,
    checkpoints: CheckpointUpdate | null,
  ) => RouteEvidence;
  /** Fires once for each run ID, after an eligible finish. The caller owns persistence. */
  readonly onRunFinished?: (result: RunResult) => void;
  /** Crash recovery near the crash; without it, reset returns to the route spawn and aborts the run. */
  readonly recovery?: RecoveryTracker;
  /** Fires after the car has been placed at a recovery pose (route trackers re-anchor here). */
  readonly onRecovered?: (pose: RecoveryPose, reason: RecoveryReason) => void;
}

const EMPTY_SCORE: ScoreSnapshot = {
  banked: 0, unbanked: 0, multiplier: 1, validDrift: false,
  routeProgressM: 0, activeSeconds: 0,
};

const neutralInput = (simulationTick: number): InputFrame => ({
  simulationTick, throttle: 0, brake: 0, steering: 0, handbrake: 0,
  shift: 0, resetPressed: false,
});

/**
 * The game's authoritative driving transaction: one input, physics, route,
 * score, event timer and result update per fixed simulation tick. Rendering
 * reads interpolated snapshots but never advances any of those systems.
 */
export class DrivingSession {
  readonly clock = new FixedClock();
  readonly pauses = new PauseSet();
  readonly simulation: VehicleSimulationHandle;
  readonly run: RunController | undefined;
  readonly replay = new ReplayBuffer();

  private readonly scorer: DriftScorer | undefined;
  private readonly routeEvidence: DrivingSessionOptions['routeEvidence'];
  private readonly onRunFinished: DrivingSessionOptions['onRunFinished'];
  private readonly recovery: RecoveryTracker | undefined;
  private readonly onRecovered: DrivingSessionOptions['onRecovered'];
  private recoveryInfo: RecoveryState = { count: 0, reason: null, penaltySeconds: 0 };
  private readonly reportedRuns = new Set<string>();
  private previous: VehicleSnapshot;
  private current: VehicleSnapshot;
  private score: ScoreSnapshot;
  private ghost: GhostRecorder = createGhostRecorder();
  private frozenReplay: readonly GhostTransform[] = [];
  private visualSeconds = 0;
  private offRoadSeconds = 0;
  private inputTick: number;
  private consumedInput: InputFrame;
  private lastImpact: FrameSnapshot['impact'];
  private alpha = 0;
  private disposed = false;

  constructor(options: DrivingSessionOptions) {
    this.simulation = options.simulation;
    this.run = options.run;
    this.scorer = options.scorer;
    this.routeEvidence = options.routeEvidence;
    this.onRunFinished = options.onRunFinished;
    this.recovery = options.recovery;
    this.onRecovered = options.onRecovered;
    this.current = options.simulation.snapshot();
    this.previous = this.current;
    this.inputTick = this.current.simulationTick;
    this.consumedInput = neutralInput(this.inputTick);
    this.score = options.scorer?.snapshot() ?? EMPTY_SCORE;
  }

  advance(wallDeltaSeconds: number, readInput: (simulationTick: number) => InputFrame): FrameSnapshot {
    this.requireLive();
    // Impact feedback belongs only to this advance, including zero-step and
    // paused calls. Rendering may reread the tuple but must deduplicate by tick.
    this.lastImpact = undefined;
    this.alpha = this.clock.advance(wallDeltaSeconds, this.pauses.isPaused(), () => {
      // A finish callback can add a pause during a multi-tick catch-up frame.
      if (this.pauses.isPaused()) return false;
      const scheduledTick = ++this.inputTick;
      const input = readInput(scheduledTick);
      if (input.simulationTick !== scheduledTick) {
        throw new Error(`Input tick ${input.simulationTick} does not match simulation tick ${scheduledTick}`);
      }
      if (input.resetPressed && this.recovery) {
        // Recover near the crash. During the cooldown the press is ignored and the tick runs normally.
        if (this.recovery.ready && this.run?.status().state !== 'COUNTDOWN') {
          this.recover('manual');
          this.inputTick = this.current.simulationTick;
          this.consumedInput = neutralInput(this.inputTick);
          return false;
        }
      } else if (input.resetPressed) {
        this.simulation.resetToSafePoint();
        this.run?.abort('reset');
        this.score = this.scorer?.invalidate('reset') ?? EMPTY_SCORE;
        this.current = this.simulation.snapshot();
        this.previous = this.current;
        this.inputTick = this.current.simulationTick;
        this.consumedInput = neutralInput(this.inputTick);
        this.clearRecordings();
        return false;
      }

      const stateBeforeStep = this.run?.status().state;
      const effectiveInput: InputFrame = stateBeforeStep === 'COUNTDOWN'
        ? { ...input, throttle: 0, brake: 1, steering: 0, handbrake: 1, shift: 0, resetPressed: false }
        : input.resetPressed ? { ...input, resetPressed: false } : input;
      this.previous = this.current;
      this.simulation.step(effectiveInput);
      this.current = this.simulation.snapshot();
      if (this.current.simulationTick !== scheduledTick) {
        throw new Error(`Physics did not advance to simulation tick ${scheduledTick}`);
      }
      this.consumedInput = { ...effectiveInput };
      this.run?.tick(FIXED_DT);
      const active = stateBeforeStep === 'ACTIVE' && this.run?.status().state === 'ACTIVE';
      const checkpoints = active
        ? this.run?.updateCheckpoints(this.previous.position, this.current.position) ?? null
        : null;
      const route = (active ? this.routeEvidence?.(this.previous, this.current, checkpoints) : undefined) ?? {
        routeProgressM: 0, legalCorridor: false, checkpointValid: false,
      };
      if (route.runViolation) this.run?.markInvalid(route.runViolation);
      const collision = this.simulation.collisionTelemetry();
      if (active) {
        const legalSurface = route.surfaceContact ?? route.roadContact;
        if (legalSurface === true) this.offRoadSeconds = 0;
        else if (legalSurface === false && this.current.wheels.some(wheel => wheel.contact) && this.makingHeadway(collision)) {
          this.offRoadSeconds += FIXED_DT;
          if (this.offRoadSeconds > 2) this.run?.markInvalid('shortcut');
        }
      }
      if (collision.tick === this.current.simulationTick && collision.impact && collision.colliderIds.length > 0 &&
          Number.isFinite(collision.speedDeltaMS) && collision.speedDeltaMS > 0 &&
          Number.isFinite(collision.impulseNs) && collision.impulseNs > 0 &&
          (!this.lastImpact || collision.speedDeltaMS > this.lastImpact.speedDeltaMS)) {
        this.lastImpact = { simulationTick: collision.tick, speedDeltaMS: collision.speedDeltaMS, impulseNs: collision.impulseNs };
      }
      this.score = this.scorer?.update(this.current, {
        ...route,
        checkpointValid: route.checkpointValid && !checkpoints?.invalidCrossing,
        wallContact: route.wallContact || collision.colliderIds.length > 0,
        active,
        paused: false,
        impactDeltaMS: collision.speedDeltaMS,
      }, FIXED_DT) ?? EMPTY_SCORE;

      if (active || !this.run) {
        this.visualSeconds += FIXED_DT;
        this.replay.push(this.current, this.visualSeconds);
      }
      if (active) this.ghost.update(this.current, this.run!.status().elapsedActiveSeconds);

      if (active && checkpoints?.completed) {
        this.score = this.scorer?.bank() ?? this.score;
        const result = this.run?.finish(this.score.banked);
        if (result && !this.reportedRuns.has(result.runId)) {
          this.frozenReplay = this.replay.freeze();
          this.reportedRuns.add(result.runId);
          this.onRunFinished?.(result);
        }
      }
      const automatic = this.recovery?.observe(this.current, effectiveInput, stateBeforeStep !== 'COUNTDOWN') ?? null;
      if (automatic && (!this.run || this.run.status().state === 'ACTIVE')) this.recover(automatic);
    });
    return this.snapshot();
  }

  snapshot(): FrameSnapshot {
    this.requireLive();
    return {
      previous: this.previous,
      current: this.current,
      interpolationAlpha: this.alpha,
      score: this.score,
      ...(this.lastImpact ? { impact: { ...this.lastImpact } } : {}),
    };
  }

  /** Latest crash recovery, for HUD feedback. */
  recoveryState(): RecoveryState { return this.recoveryInfo; }

  /** Recover now (falling out of the world, scripted callers). False without a tracker or during the cooldown. */
  requestRecovery(reason: RecoveryReason = 'manual'): boolean {
    this.requireLive();
    // Falling out of the world always recovers, cooldown or not: the spawn fallback would read as a teleport.
    if (!this.recovery || (!this.recovery.ready && reason !== 'fallen')) return false;
    this.recover(reason);
    this.inputTick = this.current.simulationTick;
    this.consumedInput = neutralInput(this.inputTick);
    return true;
  }

  /** Defensive copy of the control frame handed to physics on the latest completed tick. */
  lastInput(): InputFrame { return { ...this.consumedInput }; }

  /** A copied visual-only buffer; playback must never call step or score. */
  finishedReplay(): readonly GhostTransform[] { return this.frozenReplay; }

  /** Freeze the latest 12 seconds for free-drive replay without changing gameplay state. */
  freezeReplay(): readonly GhostTransform[] {
    this.requireLive();
    return this.replay.freeze();
  }

  /** The just-finished recording can be saved only after result validation. */
  ghostRecording(): GhostRecorder { return this.ghost; }

  /** Retry begins a fresh run ID, score ledger and recording from the spawn. */
  retryEvent(): void {
    this.requireLive();
    if (!this.run || !this.scorer) throw new Error('Retry requires an event and scorer');
    const state = this.run.status().state;
    if (state !== 'RESULTS' && state !== 'ABORTED') {
      throw new Error(`Cannot retry event from ${state}`);
    }
    this.run.reset();
    this.run.startCountdown();
    this.score = this.scorer.reset();
    this.simulation.resetToSafePoint();
    this.previous = this.simulation.snapshot();
    this.current = this.previous;
    this.inputTick = this.current.simulationTick;
    this.consumedInput = neutralInput(this.inputTick);
    this.clock.reset();
    this.alpha = 0;
    this.clearRecordings();
  }

  resetToSafePoint(): void {
    this.requireLive();
    this.simulation.resetToSafePoint();
    this.run?.abort('reset');
    this.score = this.scorer?.invalidate('reset') ?? EMPTY_SCORE;
    this.current = this.simulation.snapshot();
    this.previous = this.current;
    this.inputTick = this.current.simulationTick;
    this.consumedInput = neutralInput(this.inputTick);
    this.clock.reset();
    this.alpha = 0;
    this.clearRecordings();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.simulation.dispose();
  }

  /** Place the car behind its last safe road point, at rest. The run lives on with a time penalty and a broken chain. */
  private recover(reason: RecoveryReason): void {
    const tracker = this.recovery!;
    const pose = tracker.safePose();
    if (this.simulation.recoverTo) this.simulation.recoverTo(pose.position, pose.rotation);
    else this.simulation.resetToSafePoint();
    tracker.markRecovered(pose);
    const live = this.run?.status().state === 'ACTIVE';
    if (live) this.run!.penalize?.(RECOVERY_PENALTY_SECONDS);
    if (this.scorer) this.score = this.scorer.invalidate('reset');
    this.current = this.simulation.snapshot();
    this.previous = this.current;
    this.offRoadSeconds = 0;
    this.recoveryInfo = { count: this.recoveryInfo.count + 1, reason, penaltySeconds: live ? RECOVERY_PENALTY_SECONDS : 0 };
    this.onRecovered?.(pose, reason);
  }

  /**
   * Whether an off-road tick can count toward the sustained off-road shortcut. A car pinned against a barrier
   * has wheels resting on the barrier's foot (not road), and a stuck car is still 'off road' while the 3 s stuck
   * auto-recovery winds up: neither is a cut, and both used to invalidate the run at 2 s, before the recovery
   * fired. Position stays policed by the route corridor either way.
   */
  private makingHeadway(collision: ReturnType<VehicleSimulationHandle['collisionTelemetry']>): boolean {
    const { linearVelocityMS: v, wheels, simulationTick } = this.current;
    if (Math.hypot(v.x, v.z) < STUCK_SPEED_MS) return false;
    if (collision.tick !== simulationTick || collision.colliderIds.length === 0) return true;
    const walls = new Set(collision.colliderIds);
    return !wheels.some(wheel => wheel.contact && wheel.surfaceId !== null && walls.has(wheel.surfaceId));
  }

  private requireLive(): void {
    if (this.disposed) throw new Error('DrivingSession is disposed');
  }

  private clearRecordings(): void {
    this.replay.clear();
    this.frozenReplay = [];
    this.ghost = createGhostRecorder();
    this.visualSeconds = 0;
    this.offRoadSeconds = 0;
    this.lastImpact = undefined;
  }
}
