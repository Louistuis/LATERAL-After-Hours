import type { CarId, EventMode, Medal, RouteId, RunResult, Vec3 } from '../../contracts/runtime-contracts.js';

export type RunState = 'PREPARE' | 'COUNTDOWN' | 'ACTIVE' | 'FINISHING' | 'RESULTS' | 'ABORTED';
export type RunInvalidReason = 'shortcut' | 'wrong-way';

/** A directed plane gate. `forward` points in the required crossing direction. */
export interface DirectedCheckpoint {
  readonly id: string;
  readonly center: Vec3;
  readonly forward: Vec3;
  readonly halfWidthM: number;
  /** Maximum vertical distance from the plane at the crossing point; defaults to 3.5m. */
  readonly halfHeightM?: number;
  readonly finish?: boolean;
}

export interface EventRunConfig {
  readonly eventId: string;
  readonly routeId: RouteId;
  readonly mode: EventMode;
  readonly rulesVersion: string;
  readonly carId: CarId;
  readonly routeVersion: string;
  readonly physicsVersion: string;
  readonly tuneHash: string;
  readonly checkpoints: readonly DirectedCheckpoint[];
  readonly countdownSeconds?: number;
  /** Time targets in seconds (lower is better), score targets in points (higher is better). */
  readonly medalTargets?: Readonly<{ gold: number; silver: number; bronze: number }>;
  readonly maximumGateStepM?: number;
  readonly maximumDurationSeconds?: number;
}

export interface CheckpointUpdate {
  readonly acceptedIds: readonly string[];
  readonly expectedCheckpointId: string | null;
  readonly completed: boolean;
  readonly invalidCrossing: boolean;
  readonly progressM: number;
}

export interface RunStatus {
  readonly state: RunState;
  readonly runId: string;
  readonly elapsedActiveSeconds: number;
  readonly checkpointIndex: number;
  readonly expectedCheckpointId: string | null;
  readonly routeProgressM: number;
  readonly abortedReason: string | null;
  readonly invalidReason: RunInvalidReason | null;
}

export interface RunController {
  prepare(): RunStatus;
  startCountdown(): RunStatus;
  activate(): RunStatus;
  tick(dtSeconds: number): RunStatus;
  updateCheckpoints(previousPosition: Vec3, currentPosition: Vec3): CheckpointUpdate;
  finish(bankedScore: number): RunResult | null;
  /** Sticky nonfatal event invalidation; the player may still finish, but cannot earn a medal/reward. */
  markInvalid(reason: RunInvalidReason): RunStatus;
  showResults(): RunStatus;
  abort(reason: string): RunStatus;
  /** Adds active time (crash recovery penalty). Only an ACTIVE run is charged. */
  penalize?(seconds: number): RunStatus;
  reset(): RunStatus;
  status(): RunStatus;
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec3): Vec3 => { const m = length(v); return m > 1e-8 ? { x: v.x / m, y: v.y / m, z: v.z / m } : { x: 0, y: 0, z: 0 }; };
const horizontalRight = (f: Vec3): Vec3 => normalize({ x: -f.z, y: 0, z: f.x });
/** A crossing this close to a gate is that gate's business; farther away it belongs to another part of the road. */
const GATE_INFLUENCE_M = 12;
/**
 * Gates accept a crossing this far past their authored half width: a car running wide on the curb and run-off
 * shoulder up to the guardrail must not silently miss a gate (the run could then never finish). Real cuts are
 * caught by the route corridor, not by gate width.
 */
const GATE_ACCEPT_SLACK_M = 3.5;
const nearGate = (gate: DirectedCheckpoint, lateral: number, vertical: number): boolean =>
  lateral <= gate.halfWidthM + GATE_INFLUENCE_M && vertical <= (gate.halfHeightM ?? 3.5) + 3;

export function createRunController(config: EventRunConfig, makeRunId: () => string = defaultRunId): RunController {
  if (!config.eventId || !config.rulesVersion || !config.routeVersion || !config.physicsVersion || !config.tuneHash) throw new Error('Run metadata is incomplete');
  if (config.checkpoints.length === 0) throw new Error('An event requires ordered checkpoints');
  const ids = new Set<string>();
  const gates = config.checkpoints.map((gate) => {
    if (!gate.id || ids.has(gate.id) || gate.halfWidthM <= 0 || !Number.isFinite(gate.halfWidthM)) throw new Error(`Invalid checkpoint: ${gate.id}`);
    ids.add(gate.id);
    const forward = normalize(gate.forward);
    if (length(forward) < 0.99) throw new Error(`Checkpoint ${gate.id} has a zero direction`);
    return { ...gate, forward };
  });
  if (!gates[gates.length - 1]?.finish) throw new Error('Last checkpoint must be marked as finish');
  const cumulative = [0];
  for (let i = 1; i < gates.length; i++) cumulative.push(cumulative[i - 1]! + length(sub(gates[i]!.center, gates[i - 1]!.center)));
  const maxGateStep = config.maximumGateStepM ?? 30;
  let state: RunState = 'PREPARE';
  let runId = makeRunId();
  let elapsed = 0;
  let countdown = config.countdownSeconds ?? 3;
  let checkpointIndex = 0;
  let progress = 0;
  let result: RunResult | null = null;
  let abortedReason: string | null = null;
  let invalidReason: RunInvalidReason | null = null;

  const expected = (): string | null => gates[checkpointIndex]?.id ?? null;
  const status = (): RunStatus => ({ state, runId, elapsedActiveSeconds: elapsed, checkpointIndex, expectedCheckpointId: expected(), routeProgressM: progress, abortedReason, invalidReason });
  const setAborted = (reason: string): RunStatus => { state = 'ABORTED'; abortedReason = reason; result = null; return status(); };
  return {
    prepare() { if (state === 'ABORTED' || state === 'RESULTS') return this.reset(); return status(); },
    startCountdown() { if (state !== 'PREPARE') return status(); state = 'COUNTDOWN'; return status(); },
    activate() { if (state !== 'COUNTDOWN') return status(); state = 'ACTIVE'; return status(); },
    tick(dtSeconds) {
      if (state !== 'ACTIVE' && state !== 'COUNTDOWN') return status();
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > 1 / 60 + 1e-6) return status();
      if (state === 'COUNTDOWN') { countdown = Math.max(0, countdown - dtSeconds); if (countdown === 0) state = 'ACTIVE'; }
      else {
        elapsed += dtSeconds;
        if (elapsed >= (config.maximumDurationSeconds ?? 600)) return setAborted('maximum-duration');
      }
      return status();
    },
    updateCheckpoints(previousPosition, currentPosition) {
      const accepted: string[] = [];
      let invalidCrossing = false;
      const movement = sub(currentPosition, previousPosition);
      if (state !== 'ACTIVE') return { acceptedIds: accepted, expectedCheckpointId: expected(), completed: false, invalidCrossing, progressM: progress };
      if (length(movement) > maxGateStep) {
        return { acceptedIds: accepted, expectedCheckpointId: expected(), completed: false, invalidCrossing: true, progressM: progress };
      }
      const gate = gates[checkpointIndex];
      if (gate) {
        const from = dot(sub(previousPosition, gate.center), gate.forward);
        const to = dot(sub(currentPosition, gate.center), gate.forward);
        if (from < 0 && to >= 0) {
          const t = from / (from - to);
          const crossing = { x: previousPosition.x + movement.x * t, y: previousPosition.y + movement.y * t, z: previousPosition.z + movement.z * t };
          const offset = sub(crossing, gate.center);
          const right = horizontalRight(gate.forward);
          const lateral = Math.abs(dot(offset, right));
          const vertical = length(sub(offset, { x: gate.forward.x * dot(offset, gate.forward) + right.x * dot(offset, right), y: gate.forward.y * dot(offset, gate.forward) + right.y * dot(offset, right), z: gate.forward.z * dot(offset, gate.forward) + right.z * dot(offset, right) }));
          if (lateral <= gate.halfWidthM + GATE_ACCEPT_SLACK_M && vertical <= (gate.halfHeightM ?? 3.5)) {
            accepted.push(gate.id);
            progress = cumulative[checkpointIndex] ?? progress;
            checkpointIndex++;
            if (gate.finish) state = 'FINISHING';
          } else if (nearGate(gate, lateral, vertical)) invalidCrossing = true;
        } else if (from >= 0 && to < 0) {
          // Backward crossings never advance; caller can mark this run's route evidence invalid.
          // Gate planes are unbounded: crossing one on another leg of the road (switchbacks, a figure
          // eight) is not a crossing of this gate, so only crossings close to the gate count.
          const t = from / (from - to);
          const offset = sub({ x: previousPosition.x + movement.x * t, y: previousPosition.y + movement.y * t, z: previousPosition.z + movement.z * t }, gate.center);
          if (nearGate(gate, Math.abs(dot(offset, horizontalRight(gate.forward))), Math.abs(offset.y))) invalidCrossing = true;
        }
      }
      return { acceptedIds: accepted, expectedCheckpointId: expected(), completed: checkpointIndex >= gates.length, invalidCrossing, progressM: progress };
    },
    finish(bankedScore) {
      if (state !== 'FINISHING' || result || !Number.isFinite(bankedScore) || bankedScore < 0) return result;
      const targets = config.medalTargets;
      let medal: Medal = 'none';
      if (targets && !invalidReason) {
        if (config.mode === 'time-trial' || config.mode === 'rival-ghost') {
          if (elapsed <= targets.gold) medal = 'gold';
          else if (elapsed <= targets.silver) medal = 'silver';
          else if (elapsed <= targets.bronze) medal = 'bronze';
        } else {
          if (bankedScore >= targets.gold) medal = 'gold';
          else if (bankedScore >= targets.silver) medal = 'silver';
          else if (bankedScore >= targets.bronze) medal = 'bronze';
        }
      }
      result = Object.freeze({ runId, routeId: config.routeId, mode: config.mode, rulesVersion: config.rulesVersion,
        routeVersion: config.routeVersion, physicsVersion: config.physicsVersion, tuneHash: config.tuneHash,
        carId: config.carId, elapsedActiveSeconds: elapsed, bankedScore: Math.floor(bankedScore), medal, valid: invalidReason === null });
      return result;
    },
    markInvalid(reason) {
      if ((state === 'ACTIVE' || state === 'FINISHING') && !result && (reason === 'shortcut' || reason === 'wrong-way')) invalidReason ??= reason;
      return status();
    },
    showResults() { if (state === 'FINISHING' && result) state = 'RESULTS'; return status(); },
    abort(reason) { if (state === 'RESULTS') return status(); return setAborted(reason || 'aborted'); },
    penalize(seconds) {
      if (state !== 'ACTIVE' || !Number.isFinite(seconds) || seconds <= 0) return status();
      elapsed += Math.min(seconds, 30);
      if (elapsed >= (config.maximumDurationSeconds ?? 600)) return setAborted('maximum-duration');
      return status();
    },
    reset() {
      state = 'PREPARE'; runId = makeRunId(); elapsed = 0; countdown = config.countdownSeconds ?? 3; checkpointIndex = 0; progress = 0; result = null; abortedReason = null; invalidReason = null;
      return status();
    },
    status,
  };
}

function defaultRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
