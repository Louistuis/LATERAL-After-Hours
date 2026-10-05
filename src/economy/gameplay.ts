/**
 * Gameplay earn source ("accrued", platform-neutral). Finishing events pays a few Marks. The client computes
 * this, so it is cheatable by design: amounts stay small and the wallet caps them per UTC day.
 */
import type { RunResult } from '../../contracts/runtime-contracts';
import type { EarnOffer, EarnSource, EarnSourceContext } from './types';

export const GAMEPLAY_DAILY_CAP = 25;
/** Runs shorter than this pay nothing (restart farming). */
export const MIN_RUN_SECONDS = 15;

const MEDAL_BONUS: Readonly<Record<string, number>> = { gold: 3, silver: 2, bronze: 1, none: 0 };

/** Marks for one finished run, before the daily cap. */
export function marksForRun(result: Pick<RunResult, 'valid' | 'mode' | 'bankedScore' | 'medal' | 'elapsedActiveSeconds'>): number {
  if (!result.valid || !(result.elapsedActiveSeconds >= MIN_RUN_SECONDS)) return 0;
  const base = 2;
  const score = Number.isFinite(result.bankedScore) ? Math.max(0, result.bankedScore) : 0;
  const drift = result.mode === 'drift-attack' ? Math.min(3, Math.floor(Math.sqrt(score) / 60)) : 1;
  return base + drift + (MEDAL_BONUS[result.medal] ?? 0);
}

export function describeRun(result: Pick<RunResult, 'mode'>): string {
  return result.mode === 'drift-attack' ? 'Drift attack finished' : result.mode === 'time-trial' ? 'Time trial finished' : 'Run finished';
}

export function createGameplaySource(dailyCap = GAMEPLAY_DAILY_CAP): EarnSource {
  const listeners = new Set<() => void>();
  let context: EarnSourceContext | null = null;
  const emit = (): void => { for (const listener of listeners) listener(); };
  return {
    id: 'gameplay', kind: 'accrued', label: 'Drive for Marks', dailyCap,
    disclosure: `Finish clean events to earn Marks: more for long drift chains and medals. Up to ${dailyCap} Marks a day from driving.`,
    available: () => true,
    attach(next) {
      context = next;
      const off = next.game.onRunFinished(result => {
        const amount = marksForRun(result);
        if (amount <= 0 || !result.runId) return;
        void next.wallet.grant({ source: 'gameplay', key: `run:${result.runId}`, amount, reason: describeRun(result) }).then(emit, () => {});
      });
      return () => { off(); context = null; };
    },
    offers(): readonly EarnOffer[] {
      const left = context ? context.wallet.remainingToday('gameplay') : dailyCap;
      const done = dailyCap - Math.max(0, Math.min(dailyCap, left));
      return [{
        id: 'gameplay-daily', title: 'Today on the quay', marks: Math.max(0, left),
        detail: left > 0 ? `${done} of ${dailyCap} Marks earned today` : 'Daily driving Marks collected. Back tomorrow.',
        cta: 'Drive', progress: done / dailyCap,
      }];
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { listeners.clear(); context = null; },
  };
}
