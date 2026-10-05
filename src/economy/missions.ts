/**
 * Missions earn source (accrued). 47 one-time career missions, 3 daily and 2 weekly rotating missions, each paying a
 * fixed 25..250 Marks. The rules and content live in mission-catalog.ts; this file connects them to the game:
 *
 *   events in : onFrame (distance, speed, drift and chain telemetry), onRunFinished, onOnlineRace, wallet changes (purchases)
 *   progress  : kept in the wallet record (WalletRecord.missions) through WalletGrantPort.progress/saveProgress
 *   payout    : claim(key) -> WalletGrantPort.grant with a permanent key, so a mission is paid exactly once
 *
 * A mission is "complete" when its counter reaches the target and "claimed" once the player took the Marks. Nothing is
 * paid without a claim, and every payout is bounded (wallet.applyGrant: fixed amount from the catalog, max 250 per
 * grant, lifetime ceiling = missionCeiling(createdAt, now)).
 */
import { ROUTES } from '../../content/events/catalog';
import { catalogEntry } from './catalog';
import {
  activeByKey, driveChanges, MAX_REWARD, missionCeiling, missionViews, onlineChanges, purchaseChanges, runChanges, viewOf,
  type MissionContext, type MissionView, type OnlineOutcome, type RunTelemetry,
} from './mission-catalog';
import { applyStats, emptyProgress, markSeen, mergeProgress, rollProgress, sameProgress, type MissionProgress, type StatChange } from './mission-progress';
import type { EarnOffer, EarnSource, EarnSourceContext, FrameSample, OnlineRaceSample } from './types';

export type ClaimStatus = 'claimed' | 'not-complete' | 'already' | 'expired' | 'unavailable';
export interface ClaimResult { readonly status: ClaimStatus; readonly marks: number; readonly message: string }

export interface MissionsSource extends EarnSource {
  /** Today's daily set, this week's weekly set, then the career list, with progress. */
  views(): MissionView[];
  /** Takes the Marks of a completed mission (a view's `key`). Idempotent. */
  claim(key: string): Promise<ClaimResult>;
  /** Missions that are complete and not yet claimed. */
  claimable(): number;
  /** Fires once when a mission becomes complete while playing (not for ones already complete at start). */
  onComplete(listener: (view: MissionView) => void): () => void;
  /** ms until the next daily and weekly reset. */
  resets(): { readonly dayMs: number; readonly weekMs: number };
}

export interface MissionsOptions {
  readonly now?: () => number;
  /** What this build can do right now (playable routes, online, rival ghost, cars for sale). Read on every view, so it may change. */
  readonly context?: () => Partial<MissionContext>;
  /** Debounce for saving driving progress, ms. Default 20 s. */
  readonly saveDelayMs?: number;
}

/* ------------------------------------------------------------------ tracker (pure, testable) */

const MIN_FLUSH_M = 20;
const MAX_STEP_S = 0.5;
const MAX_STEP_SPEED = 130;
const TICK_S = 1 / 60;

/** Turns per frame samples into distance and speed counters, and per run drift, chain and crash telemetry. */
export class MissionTracker {
  private lastTick = -1;
  private last: { x: number; y: number; z: number } | null = null;
  private pending = 0;
  private top = 0;
  private reportedKmh = 0;
  private run: { id: string; maxChain: number; drift: number; longest: number; recoveries: number; targets: boolean } | null = null;
  private readonly finished = new Map<string, RunTelemetry>();

  /** Feeds one frame. Returns counter changes when there is something worth recording, else an empty list. */
  feed(sample: FrameSample): StatChange[] {
    const tick = Number.isFinite(sample.tick) ? sample.tick : -1;
    const dt = this.lastTick >= 0 ? (tick - this.lastTick) * TICK_S : 0;
    const advanced = tick > this.lastTick;
    const ok = advanced && dt > 0 && dt <= MAX_STEP_S && !sample.paused;
    const position = { x: sample.x, y: sample.y, z: sample.z };
    if (ok && this.last && [position.x, position.y, position.z].every(Number.isFinite)) {
      const step = Math.hypot(position.x - this.last.x, position.y - this.last.y, position.z - this.last.z);
      // A reset, a respawn or a car swap moves the car without driving: never counted as distance.
      if (step <= MAX_STEP_SPEED * dt + 0.5) this.pending += step;
      if (Number.isFinite(sample.speedMS) && sample.speedMS > 0 && sample.speedMS <= Math.min(MAX_STEP_SPEED, 120)) this.top = Math.max(this.top, sample.speedMS);
    }
    if (advanced) { this.lastTick = tick; this.last = position; } else if (tick < this.lastTick) { this.lastTick = tick; this.last = position; }
    this.trackRun(sample, ok ? dt : 0);
    const kmh = Math.floor(this.top * 3.6);
    if (this.pending >= MIN_FLUSH_M || kmh > this.reportedKmh) {
      const metres = Math.floor(this.pending);
      this.pending -= metres;
      this.reportedKmh = kmh;
      return driveChanges(metres, this.top);
    }
    return [];
  }

  private trackRun(sample: FrameSample, dt: number): void {
    if (!sample.runId) { this.run = null; return; }
    if (!this.run || this.run.id !== sample.runId) this.run = { id: sample.runId, maxChain: 0, drift: 0, longest: 0, recoveries: 0, targets: sample.hasMedalTargets !== false };
    const run = this.run;
    if (sample.active && dt > 0) {
      if (sample.validDrift) { run.drift += dt; run.longest = Math.max(run.longest, run.drift); } else run.drift = 0;
      if (Number.isFinite(sample.unbanked)) run.maxChain = Math.max(run.maxChain, sample.unbanked);
    }
    run.recoveries = Math.max(run.recoveries, Math.max(0, Math.floor(sample.recoveries) || 0));
    this.finished.set(run.id, { maxChain: run.maxChain, driftSeconds: run.longest, recoveries: run.recoveries, hasTargets: run.targets });
    if (this.finished.size > 4) this.finished.delete(this.finished.keys().next().value as string);
  }

  /** The telemetry of a finished run (and forgets it). */
  take(runId: string): RunTelemetry | null {
    const telemetry = this.finished.get(runId) ?? null;
    this.finished.delete(runId);
    return telemetry;
  }
}

/* ------------------------------------------------------------------ online results */

/** The parts of the net session's OnlineView that missions read. */
export interface OnlineViewLike {
  readonly lobbyId: string | null;
  readonly race: number;
  readonly finished: boolean;
  readonly lobby?: { readonly ph?: string; readonly race?: number } | null;
  readonly standings: readonly { readonly self: boolean; readonly finished: boolean; readonly invalid: boolean; readonly timeMs: number; readonly position: number }[];
}

/**
 * Your result in the current online race, or null until you have a valid finish. `won` is true only once the race is
 * decided: every other racer finished or is invalid, or the lobby went back to waiting after this race, and you were first.
 */
export function onlineOutcome(view: OnlineViewLike | null | undefined, minSeconds = 15): OnlineOutcome | null {
  if (!view || !view.lobbyId || !(view.race > 0) || !view.finished || !Array.isArray(view.standings)) return null;
  const self = view.standings.find(entry => entry.self);
  if (!self || !self.finished || self.invalid || !(self.timeMs >= minSeconds * 1000)) return null;
  const others = view.standings.filter(entry => !entry.self);
  const decided = others.every(entry => entry.finished || entry.invalid) || (view.lobby?.ph === 'w' && view.lobby.race === view.race);
  const participants = view.standings.length;
  return { id: `${view.lobbyId}:${view.race}`.slice(0, 70), participants, position: self.position, won: decided && participants >= 2 && self.position === 1 };
}

/* ------------------------------------------------------------------ the source */

const NOT_YET: ClaimResult = { status: 'not-complete', marks: 0, message: 'Not finished yet.' };

export function createMissionsSource(options: MissionsOptions = {}): MissionsSource {
  const now = options.now ?? (() => Date.now());
  const defaultRoutes = ROUTES.map(route => route.routeId);
  const contextNow = (): MissionContext => {
    let given: Partial<MissionContext> = {};
    try { given = options.context?.() ?? {}; } catch { /* Fall back to the defaults. */ }
    return { routes: given.routes ?? defaultRoutes, online: given.online ?? false, rival: given.rival ?? false, cars: given.cars ?? true };
  };
  const saveDelay = options.saveDelayMs ?? 20_000;
  const listeners = new Set<() => void>();
  const completeListeners = new Set<(view: MissionView) => void>();
  const tracker = new MissionTracker();
  const inflight = new Map<string, Promise<ClaimResult>>();
  const announced = new Set<string>();
  let context: EarnSourceContext | null = null;
  let progress: MissionProgress = emptyProgress(now());
  let dirty = false, saving: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isClaimed = (key: string): boolean => context?.wallet.claimed?.(`missions:${key}`) ?? false;
  const emit = (): void => { for (const listener of listeners) listener(); };
  const views = (): MissionView[] => missionViews(rollProgress(progress, now()), contextNow(), isClaimed, now());

  /** Announces missions that just became complete (once each). */
  const checkComplete = (quiet = false): number => {
    let fresh = 0;
    for (const view of views()) {
      if (!view.complete || view.claimed || announced.has(view.key)) continue;
      announced.add(view.key);
      fresh++;
      if (!quiet) for (const listener of completeListeners) { try { listener(view); } catch { /* A broken toast must not stop earning. */ } }
    }
    return fresh;
  };
  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const wallet = context?.wallet;
    if (!dirty || !wallet?.saveProgress) return saving;
    dirty = false;
    const snapshot = progress;
    saving = saving.then(() => wallet.saveProgress!(snapshot)).catch(() => { dirty = true; });
    return saving;
  };
  const later = (): void => { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, saveDelay); };
  const change = (changes: readonly StatChange[], immediate: boolean): void => {
    if (!changes.length) return;
    const next = applyStats(progress, now(), changes);
    if (sameProgress(next, progress)) return;
    progress = next;
    dirty = true;
    if (immediate) void flush(); else later();
    // Driving progress is saved quietly; the economy (and every open shop screen) hears about completions and events.
    if (checkComplete() > 0 || immediate) emit();
  };
  const countOwned = (): void => {
    const owned = context?.wallet.owned?.();
    if (!owned) return;
    const cars = new Set(owned.filter(id => catalogEntry(id)?.kind === 'car'));
    change(purchaseChanges(owned, cars), true);
  };
  const adopt = (): void => {
    const stored = context?.wallet.progress?.();
    if (!stored) return;
    const merged = mergeProgress(rollProgress(progress, now()), rollProgress(stored, now()));
    if (!sameProgress(merged, progress)) { progress = merged; checkComplete(true); emit(); }
  };

  const claimNow = async (key: string): Promise<ClaimResult> => {
    if (!context) return { status: 'unavailable', marks: 0, message: 'Missions are not ready yet.' };
    const ctx = contextNow();
    const def = activeByKey(key, now(), ctx);
    if (!def) return { status: 'expired', marks: 0, message: 'That mission has ended.' };
    const view = viewOf(def, rollProgress(progress, now()), ctx, isClaimed, now());
    if (view.claimed) return { status: 'already', marks: 0, message: 'Already claimed.' };
    if (!view.complete) return NOT_YET;
    // Amount comes from the catalog, never from the caller. permanent = the claim outlives the bounded receipt list.
    const result = await context.wallet.grant({ source: 'missions', key, amount: def.reward, reason: def.title, permanent: true });
    if (result.duplicate) return { status: 'already', marks: 0, message: 'Already claimed.' };
    if (result.granted <= 0) return { status: 'unavailable', marks: 0, message: 'The wallet could not pay this one yet. Try again later.' };
    emit();
    return { status: 'claimed', marks: result.granted, message: `+${result.granted} Marks` };
  };

  const onVisibility = (): void => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void flush(); };

  return {
    id: 'missions', kind: 'accrued', label: 'Missions',
    disclosure: 'Finish missions to earn Marks. Each one pays once.',
    // Missions have their own screen; the Get Marks sheet lists tips and the daily driving Marks only.
    available: () => false,
    maxGrant: MAX_REWARD,
    ceiling: missionCeiling,
    attach(next) {
      context = next;
      adopt();
      countOwned();
      checkComplete(true);
      const offs: (() => void)[] = [];
      if (next.game.onFrame) offs.push(next.game.onFrame(sample => {
        const changes = tracker.feed(sample);
        if (changes.length) change(changes, false);
      }));
      offs.push(next.game.onRunFinished(result => {
        const seen = markSeen(progress, `r:${result?.runId}`);
        const changes = seen.fresh ? runChanges(result, tracker.take(result.runId)) : null;
        if (!changes) return;
        progress = seen.progress;
        change(changes, true);
      }));
      if (next.game.onOnlineRace) offs.push(next.game.onOnlineRace((sample: OnlineRaceSample) => {
        const finish = markSeen(progress, `n:${sample.id}`);
        if (finish.fresh) { progress = finish.progress; change(onlineChanges('finish', sample), true); }
        if (sample.won) {
          const win = markSeen(progress, `nw:${sample.id}`);
          if (win.fresh) { progress = win.progress; change(onlineChanges('win', sample), true); }
        }
      }));
      if (typeof document !== 'undefined') { document.addEventListener('visibilitychange', onVisibility); offs.push(() => document.removeEventListener('visibilitychange', onVisibility)); }
      return () => { for (const off of offs) off(); void flush(); context = null; };
    },
    walletChanged() {
      if (!context) return;
      adopt();
      countOwned();
    },
    offers(): readonly EarnOffer[] { return []; },
    views,
    claim(key) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const run = claimNow(key).catch((): ClaimResult => ({ status: 'unavailable', marks: 0, message: 'The claim did not go through. Nothing was lost.' }))
        .finally(() => { inflight.delete(key); });
      inflight.set(key, run);
      return run;
    },
    claimable: () => views().filter(view => view.complete && !view.claimed).length,
    onComplete(listener) { completeListeners.add(listener); return () => { completeListeners.delete(listener); }; },
    resets() { const t = now(), all = views(); return { dayMs: Math.max(0, (all.find(v => v.kind === 'daily')?.endsAt ?? t) - t), weekMs: Math.max(0, (all.find(v => v.kind === 'weekly')?.endsAt ?? t) - t) }; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { void flush(); listeners.clear(); completeListeners.clear(); context = null; },
  };
}
