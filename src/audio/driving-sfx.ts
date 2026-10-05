import type { FrameSnapshot, Medal, VehicleSnapshot } from '../../contracts/runtime-contracts';
import { clamp01 } from './dsp';
import type { CueKind } from './synth-buffers';

/**
 * Pure mappings from driving telemetry to effect parameters (tyres, surfaces, barrier scrape, impacts) and the
 * race cue tracker. PlayerAudio only applies what these return.
 */

type Wheels = VehicleSnapshot['wheels'];
const abs = (value: number): number => Number.isFinite(value) ? Math.abs(value) : 0;

export interface TyreParams {
  /** Tonal squeal level and pitch. */
  readonly squealGain: number;
  readonly squealHz: number;
  /** Broadband scrub under the squeal. */
  readonly scrubGain: number;
  readonly scrubHz: number;
}

const SILENT_TYRES: TyreParams = { squealGain: 0, squealHz: 900, scrubGain: 0, scrubHz: 900 };

/**
 * Squeal follows how far past peak grip the tyres are, sideways (slip angle) or lengthways (wheelspin, locking),
 * and fades in with speed. The two most stressed wheels lead, so a rear-wheel drift is heard at full strength.
 * A deep slide drops the pitch towards a lower howl; speed lifts it slightly.
 */
export function tyreParams(wheels: Wheels, speedMS: number): TyreParams {
  if (!Number.isFinite(speedMS) || speedMS < 2.5) return SILENT_TYRES;
  const stresses: number[] = [];
  let lateralSum = 0, angleSum = 0, grounded = 0;
  for (const wheel of wheels) {
    if (!wheel.contact) continue;
    const angle = abs(wheel.slipAngleRad);
    const lateral = clamp01((angle - 0.1) / 0.38);
    const longitudinal = clamp01((abs(wheel.slipRatio) - 0.14) / 0.6);
    stresses.push(Math.max(lateral, longitudinal * 0.85));
    lateralSum += lateral; angleSum += angle; grounded++;
  }
  if (grounded < 2) return SILENT_TYRES;
  stresses.sort((a, b) => b - a);
  const intensity = (stresses[0]! + stresses[1]!) / 2;
  if (intensity <= 0) return SILENT_TYRES;
  const speedFactor = clamp01((speedMS - 2.5) / 11);
  const meanAngle = angleSum / grounded;
  const lateral = lateralSum / grounded;
  return {
    squealGain: 0.5 * Math.pow(intensity, 1.25) * speedFactor,
    squealHz: Math.max(560, Math.min(1250, 860 + 180 * lateral - 340 * clamp01((meanAngle - 0.5) / 0.6) + 2.4 * Math.min(speedMS, 60))),
    scrubGain: 0.32 * intensity * speedFactor,
    scrubHz: 700 + 2600 * intensity,
  };
}

export interface SurfaceParams {
  readonly gravelGain: number;
  /** Playback rate of the gravel loop (grain density follows speed). */
  readonly gravelRate: number;
  readonly curbGain: number;
  /** Rumble strip buzz rate: strips pass under the tyres at speed / spacing. */
  readonly curbHz: number;
}

const isOffRoad = (surfaceId: string | null): boolean => surfaceId !== null && (surfaceId.startsWith('ground:') || surfaceId.startsWith('water:') || surfaceId.startsWith('gravel'));
const isCurb = (surfaceId: string | null): boolean => surfaceId !== null && surfaceId.startsWith('curb:');

export function surfaceParams(wheels: Wheels, speedMS: number): SurfaceParams {
  const speed = Number.isFinite(speedMS) ? Math.max(0, speedMS) : 0;
  let offRoad = 0, curb = 0;
  for (const wheel of wheels) {
    if (!wheel.contact) continue;
    if (isOffRoad(wheel.surfaceId)) offRoad++;
    else if (isCurb(wheel.surfaceId)) curb++;
  }
  return {
    gravelGain: 0.55 * (offRoad / 4) * clamp01(speed / 16),
    gravelRate: 0.55 + Math.min(1.3, speed / 28),
    curbGain: 0.42 * (curb / 4) * clamp01((speed - 1) / 7),
    curbHz: Math.max(6, Math.min(75, speed / 0.6)),
  };
}

/**
 * Grinding along a barrier produces a contact on most ticks. Two or more contacts within the last 0.3 s (18 ticks)
 * at speed count as a scrape; louder with more contacts and more speed.
 */
export function scrapeLevel(impactTicks: readonly number[], tick: number, speedMS: number): number {
  if (!Number.isFinite(tick) || !Number.isFinite(speedMS)) return 0;
  let recent = 0;
  for (const value of impactTicks) if (tick - value >= 0 && tick - value <= 18) recent++;
  if (recent < 2) return 0;
  return clamp01((recent - 1) / 5) * clamp01((speedMS - 2) / 14);
}

/**
 * Collision cue threshold/curve uses actual frame impact telemetry, never wheel load.
 * With both positive finite fields present, 0.32 m/s or 400 N·s reaches the quiet threshold.
 * Both scales saturate at a strong 4 m/s or 5000 N·s event.
 */
export function calculateImpactSeverity(impact: Pick<NonNullable<FrameSnapshot['impact']>, 'speedDeltaMS' | 'impulseNs'>): number {
  if (!Number.isFinite(impact.speedDeltaMS) || !Number.isFinite(impact.impulseNs) || impact.speedDeltaMS <= 0 || impact.impulseNs <= 0) return 0;
  const normalized = Math.max(impact.speedDeltaMS / 4, impact.impulseNs / 5000);
  const threshold = 0.08;
  return normalized <= threshold ? 0 : clamp01((normalized - threshold) / (1 - threshold));
}

/** Which generated impact to play and how loud: a knock, a crunch or a crash. */
export function impactVoice(severity: number): { level: 0 | 1 | 2; gain: number } | null {
  if (!(severity >= 0.02)) return null;
  const s = clamp01(severity);
  const level: 0 | 1 | 2 = s < 0.28 ? 0 : s < 0.68 ? 1 : 2;
  return { level, gain: 0.3 + 0.7 * Math.sqrt(s) };
}

/** A fresh handbrake pull while moving (not a held lever). */
export function isHandbrakePull(previous: number | null, handbrake: number, speedMS: number): boolean {
  return previous !== null && previous < 0.3 && handbrake >= 0.6 && speedMS > 5;
}

/** Up- or downshift between forward gears, or into/out of reverse. */
export function gearChange(previous: number | null, gear: number): 'up' | 'down' | 'reverse' | null {
  if (previous === null || previous === gear || !Number.isFinite(gear)) return null;
  if (gear < 0 || previous < 0) return 'reverse';
  return gear > previous ? 'up' : 'down';
}

export interface RaceCueInput {
  readonly run: Readonly<{ runId: string; state: string; checkpointIndex: number }> | null;
  readonly result: Readonly<{ runId: string; medal: Medal; valid: boolean }> | null;
  readonly tick: number;
}
export interface RaceCue { readonly cue: CueKind; readonly delay: number }

export function medalCue(medal: Medal): CueKind | null {
  return medal === 'gold' ? 'medal-gold' : medal === 'silver' ? 'medal-silver' : medal === 'bronze' ? 'medal-bronze' : null;
}

/**
 * Derives countdown beeps, GO, checkpoint, finish and medal cues from the run status the runtime already publishes.
 * Countdown timing mirrors the HUD's 3-2-1 (simulation ticks at 60 Hz), so beeps land on the numbers.
 */
export class RaceCueTracker {
  private runId: string | null = null;
  private countStartTick: number | null = null;
  private lastCount = 0;
  private goArmed = false;
  private checkpointIndex = 0;
  private finishedRunId: string | null = null;

  update(input: RaceCueInput): RaceCue[] {
    const cues: RaceCue[] = [];
    const run = input.run;
    if (!run) { this.goArmed = false; this.countStartTick = null; return cues; }
    if (run.runId !== this.runId) {
      this.runId = run.runId; this.countStartTick = null; this.lastCount = 0; this.goArmed = false;
      this.checkpointIndex = run.checkpointIndex;
    }
    if (run.state === 'COUNTDOWN') {
      if (this.countStartTick === null) this.countStartTick = input.tick;
      const count = Math.max(1, Math.ceil(3 - (input.tick - this.countStartTick) / 60));
      if (count !== this.lastCount) { this.lastCount = count; this.goArmed = true; cues.push({ cue: 'count', delay: 0 }); }
    } else if (run.state === 'ACTIVE' && this.goArmed) {
      this.goArmed = false;
      cues.push({ cue: 'go', delay: 0 });
    }
    const result = input.result && input.result.runId === run.runId ? input.result : null;
    if (run.checkpointIndex > this.checkpointIndex) {
      this.checkpointIndex = run.checkpointIndex;
      // The finish gate is announced by the finish cue instead.
      if (run.state === 'ACTIVE' && !result) cues.push({ cue: 'checkpoint', delay: 0 });
    } else if (run.checkpointIndex < this.checkpointIndex) this.checkpointIndex = run.checkpointIndex;
    if (result && result.runId !== this.finishedRunId) {
      this.finishedRunId = result.runId;
      cues.push({ cue: 'finish', delay: 0 });
      const medal = result.valid ? medalCue(result.medal) : null;
      if (medal) cues.push({ cue: medal, delay: 0.9 });
    }
    return cues;
  }
}
