/**
 * Daily challenge earn source (accrued). A counted daily run pays up to four tiers once per UTC day (finish, bronze,
 * silver, gold; see DAILY_TIERS in src/events/daily.ts). The amounts come from that table, never from the caller, and
 * the wallet enforces the rest: idempotent keys per day and tier, a daily cap equal to the tier total, and a
 * plausibility ceiling of that cap times the wallet's age in UTC days (also used by remote verification).
 */
import { DAILY_MAX_MARKS, DAILY_TIERS, isDay, type DailyTier } from '../events/daily';
import type { EarnOffer, EarnSource, EarnSourceContext } from './types';
import { allowanceDays } from './wallet';

export const DAILY_CHALLENGE_SOURCE = 'daily';
export const DAILY_CHALLENGE_CAP = DAILY_MAX_MARKS;

/** Lifetime ceiling: one full daily per UTC day the wallet has existed. */
export function dailyChallengeCeiling(createdAt: number | null | undefined, now: number): number {
  return DAILY_CHALLENGE_CAP * allowanceDays(createdAt, now);
}

export interface DailyAward { readonly tier: DailyTier; readonly granted: number }
export interface DailyChallengeSource extends EarnSource {
  /** Pays the given tiers for `day` (each once). Returns what was actually granted. */
  award(day: string, tiers: readonly DailyTier[]): Promise<DailyAward[]>;
  /** Marks still available today from the daily. */
  remainingToday(): number;
}

export function createDailyChallengeSource(): DailyChallengeSource {
  const listeners = new Set<() => void>();
  let context: EarnSourceContext | null = null;
  const emit = (): void => { for (const listener of listeners) listener(); };
  return {
    id: DAILY_CHALLENGE_SOURCE, kind: 'accrued', label: 'Daily challenge', dailyCap: DAILY_CHALLENGE_CAP,
    maxGrant: Math.max(...DAILY_TIERS.map(tier => tier.marks)),
    ceiling: dailyChallengeCeiling,
    disclosure: `Finish the daily challenge for up to ${DAILY_CHALLENGE_CAP} Marks a day.`,
    // The daily has its own menu card; the Get Marks sheet does not list it.
    available: () => false,
    attach(next) { context = next; return () => { context = null; }; },
    offers(): readonly EarnOffer[] { return []; },
    remainingToday: () => context ? Math.max(0, context.wallet.remainingToday(DAILY_CHALLENGE_SOURCE)) : DAILY_CHALLENGE_CAP,
    async award(day, tiers) {
      const wallet = context?.wallet;
      if (!wallet || !isDay(day)) return [];
      const out: DailyAward[] = [];
      for (const id of [...new Set(tiers)]) {
        const tier = DAILY_TIERS.find(entry => entry.id === id);
        if (!tier) continue;
        try {
          const result = await wallet.grant({ source: DAILY_CHALLENGE_SOURCE, key: `${day}:${tier.id}`, amount: tier.marks, reason: `Daily challenge: ${tier.label.toLowerCase()}` });
          if (result.granted > 0) out.push({ tier: tier.id, granted: result.granted });
        } catch { /* The next counted run tries again. */ }
      }
      if (out.length) emit();
      return out;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { listeners.clear(); context = null; },
  };
}
