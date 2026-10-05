import { describe, expect, it } from 'vitest';
import { createDailyChallengeSource, DAILY_CHALLENGE_CAP, DAILY_CHALLENGE_SOURCE, dailyChallengeCeiling } from '../../src/economy/daily-challenge';
import { applyGrant, emptyWallet, plausibleAccrued } from '../../src/economy/wallet';
import type { EarnSourceContext, GrantRequest, WalletRecord } from '../../src/economy/types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-03T10:00:00Z');

/** A wallet port over the real applyGrant, so caps, ceilings and duplicates behave like the economy. */
function harness(now = T0, createdAt = T0) {
  const source = createDailyChallengeSource();
  let record: WalletRecord = emptyWallet(createdAt);
  const requests: GrantRequest[] = [];
  const context: EarnSourceContext = {
    now: () => now,
    game: { onRunFinished: () => () => {} },
    wallet: {
      async grant(request) {
        requests.push(request);
        const out = applyGrant(record, request, source.dailyCap, now, { maxGrant: source.maxGrant, ceiling: source.ceiling?.(record.createdAt, now) });
        record = out.record;
        return out.result;
      },
      remainingToday: () => Math.max(0, DAILY_CHALLENGE_CAP - (record.daily[DAILY_CHALLENGE_SOURCE]?.day === new Date(now).toISOString().slice(0, 10) ? record.daily[DAILY_CHALLENGE_SOURCE]!.amount : 0)),
    },
  };
  source.attach!(context);
  return { source, requests, record: () => record };
}

describe('daily challenge earn source', () => {
  it('pays each tier once per day from the table, never more than the cap', async () => {
    const { source, record } = harness();
    expect(await source.award('2026-10-03', ['finish', 'bronze'])).toEqual([{ tier: 'finish', granted: 30 }, { tier: 'bronze', granted: 15 }]);
    expect(await source.award('2026-10-03', ['finish', 'bronze'])).toEqual([]);
    expect(await source.award('2026-10-03', ['silver', 'gold'])).toEqual([{ tier: 'silver', granted: 15 }, { tier: 'gold', granted: 20 }]);
    expect(record().earned[DAILY_CHALLENGE_SOURCE]).toBe(DAILY_CHALLENGE_CAP);
    expect(source.remainingToday()).toBe(0);
  });

  it('ignores unknown tiers and bad days, and is not offered in the Get Marks sheet', async () => {
    const { source, requests } = harness();
    expect(await source.award('yesterday', ['finish'])).toEqual([]);
    expect(await source.award('2026-10-03', ['platinum' as never])).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(source.available()).toBe(false);
    expect(source.kind).toBe('accrued');
  });

  it('has a plausibility ceiling of one full daily per day of wallet age', () => {
    expect(dailyChallengeCeiling(T0, T0)).toBe(80);
    expect(dailyChallengeCeiling(T0 - 9 * DAY, T0)).toBe(800);
    expect(dailyChallengeCeiling(null, T0)).toBe(80);
    expect(dailyChallengeCeiling(T0 + DAY, T0)).toBe(80);
    // A tampered record claiming more is cut back to the ceiling.
    const capped = plausibleAccrued({ [DAILY_CHALLENGE_SOURCE]: 99_999 }, { [DAILY_CHALLENGE_SOURCE]: DAILY_CHALLENGE_CAP }, T0 - DAY, T0, { [DAILY_CHALLENGE_SOURCE]: dailyChallengeCeiling(T0 - DAY, T0) });
    expect(capped[DAILY_CHALLENGE_SOURCE]).toBe(160);
  });
});
