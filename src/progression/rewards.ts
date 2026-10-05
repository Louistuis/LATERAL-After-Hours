import type { Medal, RewardSpec, RunResult, SaveEnvelope } from '../../contracts/runtime-contracts.js';

export interface RewardApplication {
  readonly save: SaveEnvelope;
  readonly applied: boolean;
  readonly reason: 'applied' | 'duplicate' | 'invalid-result' | 'invalid-reward' | 'ledger-full';
}

const MEDAL_RANK: Readonly<Record<Medal, number>> = { none: 0, bronze: 1, silver: 2, gold: 3 };
/** Matches the current save-envelope ledger bound; never evict an applied run ID. */
const MAX_REWARD_LEDGER = 4096;
/** Keep save files bounded while retaining the newest row and best historical medal per event. */
export const MAX_BEST_RESULT_ROWS = 100;
/** Product guardrail for any single event payout, independent of save integer capacity. */
export const MAX_REWARD_PER_RUN_CREDITS = 10_000;

/** Use the same medal-first, then mode-specific comparison when deciding whether to save a ghost. */
export function isPersonalBestResult(current: SaveEnvelope, result: RunResult): boolean {
  if (!result.valid || !result.runId) return false;
  const previous = findCompatibleBestResult(current, result);
  if (!previous) return true;
  if (MEDAL_RANK[result.medal] !== MEDAL_RANK[previous.medal]) return MEDAL_RANK[result.medal] > MEDAL_RANK[previous.medal];
  return result.mode === 'time-trial' || result.mode === 'rival-ghost'
    ? result.elapsedActiveSeconds < previous.elapsedActiveSeconds
    : result.bankedScore > previous.bankedScore;
}

/** Route/rules/physics changes start a new PB bucket; absent legacy metadata stays isolated. */
export function sameResultIdentity(a: RunResult, b: RunResult): boolean {
  return a.routeId === b.routeId && a.mode === b.mode && a.rulesVersion === b.rulesVersion &&
    (a.routeVersion ?? 'legacy:unknown') === (b.routeVersion ?? 'legacy:unknown') &&
    (a.physicsVersion ?? 'legacy:unknown') === (b.physicsVersion ?? 'legacy:unknown');
}

/** Returns the stored row compatible with a run's full scoring/route/physics identity. */
export function findCompatibleBestResult(current: SaveEnvelope, result: RunResult): RunResult | undefined {
  return current.bestResults.filter((entry) => sameResultIdentity(entry, result)).reduce<RunResult | undefined>((best, entry) => {
    if (!best) return entry;
    if (MEDAL_RANK[entry.medal] !== MEDAL_RANK[best.medal]) return MEDAL_RANK[entry.medal] > MEDAL_RANK[best.medal] ? entry : best;
    const better = result.mode === 'time-trial' || result.mode === 'rival-ghost'
      ? entry.elapsedActiveSeconds < best.elapsedActiveSeconds
      : entry.bankedScore > best.bankedScore;
    return better ? entry : best;
  }, undefined);
}

function retainBoundedBestResults(results: readonly RunResult[]): readonly RunResult[] {
  if (results.length <= MAX_BEST_RESULT_ROWS) return results;
  const groups = new Map<string, { indexes: number[]; bestMedalIndex: number }>();
  results.forEach((entry, index) => {
    const key = `${entry.routeId}:${entry.mode}`;
    const group = groups.get(key) ?? { indexes: [], bestMedalIndex: index };
    group.indexes.push(index);
    const best = results[group.bestMedalIndex]!;
    if (MEDAL_RANK[entry.medal] > MEDAL_RANK[best.medal] ||
        (MEDAL_RANK[entry.medal] === MEDAL_RANK[best.medal] && index > group.bestMedalIndex)) group.bestMedalIndex = index;
    groups.set(key, group);
  });
  const keep = new Set<number>();
  for (const group of groups.values()) {
    const newest = group.indexes[group.indexes.length - 1];
    if (newest !== undefined) keep.add(newest);
    keep.add(group.bestMedalIndex);
  }
  for (let index = results.length - 1; index >= 0 && keep.size < MAX_BEST_RESULT_ROWS; index--) keep.add(index);
  return results.filter((_entry, index) => keep.has(index));
}

/** Applies the reward and best result as one immutable in-memory transaction. Persist the returned envelope atomically. */
export function applyRunReward(
  current: SaveEnvelope,
  result: RunResult,
  reward: RewardSpec,
  operationId = result.runId,
): RewardApplication {
  const unchanged = (reason: RewardApplication['reason']): RewardApplication => ({ save: current, applied: false, reason });
  if (!result.valid || !result.runId || result.runId !== operationId || !Number.isFinite(result.bankedScore) || result.bankedScore < 0) return unchanged('invalid-result');
  if (reward.kind !== 'garage-credits' || !reward.id || !Number.isSafeInteger(reward.amount) || reward.amount < 0 || reward.amount > MAX_REWARD_PER_RUN_CREDITS ||
      !Number.isSafeInteger(current.garageCredits + reward.amount)) return unchanged('invalid-reward');
  if (current.appliedRewardOperationIds.includes(operationId)) return unchanged('duplicate');
  if (current.appliedRewardOperationIds.length >= MAX_REWARD_LEDGER) return unchanged('ledger-full');

  const improves = isPersonalBestResult(current, result);
  const bestResults = improves
    ? retainBoundedBestResults([...current.bestResults.filter((entry) => !sameResultIdentity(entry, result)), Object.freeze({ ...result })])
    : retainBoundedBestResults(current.bestResults);
  const completedEvents = new Set(bestResults.filter((entry) => entry.valid).map((entry) => `${entry.routeId}:${entry.mode}`)).size;
  const unlockedCars = new Set(current.unlockedCars);
  if (completedEvents >= 3) unlockedCars.add('CAR-02');
  if (completedEvents >= 6) unlockedCars.add('CAR-04');
  const save: SaveEnvelope = Object.freeze({
    ...current,
    revision: current.revision + 1,
    garageCredits: current.garageCredits + reward.amount,
    unlockedCars: [...unlockedCars],
    bestResults,
    appliedRewardOperationIds: [...current.appliedRewardOperationIds, operationId],
  });
  return { save, applied: true, reason: 'applied' };
}
