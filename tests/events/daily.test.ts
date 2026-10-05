import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../contracts/runtime-contracts';
import { DAILY_CAR_NAMES, DAILY_CARS, DAILY_MAX_MARKS, DAILY_POOL_V2_FROM, DAILY_TIERS, DAY_MS, dailyCarWeights, dailyOutcome, dailySpec, dailyStreak, dailyTiersFor, formatCountdown, hashString, isDay, msUntilReset, previousDay, seededRandom, utcDay } from '../../src/events/daily';
import { PLAYABLE_ROUTE_IDS } from '../../src/world/route-registry';

const days = (start: string, count: number): string[] => Array.from({ length: count }, (_, i) => utcDay(Date.parse(`${start}T00:00:00Z`) + i * DAY_MS));

describe('daily spec', () => {
  it('is deterministic per UTC day and the same for every caller', () => {
    expect(dailySpec('2026-10-03')).toEqual(dailySpec('2026-10-03'));
    expect(utcDay(Date.parse('2026-10-03T23:59:59Z'))).toBe('2026-10-03');
    expect(utcDay(Date.parse('2026-10-04T00:00:00Z'))).toBe('2026-10-04');
  });

  it('keeps every day before the Lancia and Agera joined exactly as it was', () => {
    // Snapshot of the original pool: days up to 2026-10-03 must not move (live board rows are keyed to them).
    const before = days('2026-01-01', 276);
    expect(before.at(-1)).toBe('2026-10-03');
    // The original pick: second draw of the day seed over CAR-01 4, CAR-02 3, CAR-04 3.
    const legacyCar = (day: string): string => { const rand = seededRandom(hashString(`lateral-daily:${day}`)); rand(); const at = rand() * 10; return at < 4 ? 'CAR-01' : at < 7 ? 'CAR-02' : 'CAR-04'; };
    for (const day of before) expect(dailySpec(day).car).toBe(legacyCar(day));
    const legacyCars = new Set(before.map(day => dailySpec(day).car));
    expect(legacyCars).toEqual(new Set(['CAR-01', 'CAR-02', 'CAR-04']));
    expect(dailySpec('2026-10-03')).toMatchObject({ route: 'RP-01', mode: 'drift-attack', car: 'CAR-04', lighting: 'golden-hour', rule: 'no-reset' });
    expect(dailyCarWeights('2026-10-03').map(([car]) => car)).toEqual(['CAR-01', 'CAR-02', 'CAR-04']);
    expect(dailyCarWeights(DAILY_POOL_V2_FROM).map(([car]) => car)).toContain('CAR-05');
  });

  it('only picks playable routes, both modes, roster cars and both lightings', () => {
    const specs = days('2026-10-04', 365).map(dailySpec);
    expect(new Set(specs.map(spec => spec.route))).toEqual(new Set(PLAYABLE_ROUTE_IDS));
    expect(new Set(specs.map(spec => spec.mode))).toEqual(new Set(['drift-attack', 'time-trial']));
    expect(new Set(specs.map(spec => spec.car))).toEqual(new Set(['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06']));
    expect(new Set(DAILY_CARS)).toEqual(new Set(['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06']));
    for (const car of DAILY_CARS) expect(DAILY_CAR_NAMES[car]).toBeTruthy();
    expect(new Set(specs.map(spec => spec.lighting))).toEqual(new Set(['golden-hour', 'blue-hour']));
    expect(specs.some(spec => spec.rule === 'no-reset')).toBe(true);
    expect(specs.some(spec => spec.rule === 'none')).toBe(true);
  });

  it('reads like a challenge, with no em dashes', () => {
    for (const spec of days('2026-10-01', 30).map(dailySpec)) {
      expect(spec.title).toBe(`${spec.routeName} ${spec.modeName.toLowerCase()} in the ${spec.carName}`);
      expect(spec.title + spec.condition).not.toMatch(/—/);
    }
  });

  it('rarely repeats the route two days in a row', () => {
    const specs = days('2026-01-01', 365).map(dailySpec);
    let repeats = 0;
    for (let i = 1; i < specs.length; i++) if (specs[i]!.route === specs[i - 1]!.route) repeats++;
    expect(repeats).toBeLessThan(60);
  });

  it('never throws on a bad day string', () => {
    expect(dailySpec('nonsense').day).toBe('1970-01-01');
    expect(isDay('2026-02-30')).toBe(true); // Date.parse rolls it; format check is what matters for keys
    expect(isDay('2026-1-1')).toBe(false);
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('prng and hash are stable', () => {
    expect(hashString('lateral')).toBe(hashString('lateral'));
    const a = seededRandom(42), b = seededRandom(42);
    for (let i = 0; i < 5; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
});

describe('daily outcome', () => {
  const spec = { ...dailySpec('2026-10-03'), route: 'RP-01' as const, mode: 'drift-attack' as const, car: 'CAR-02' as const, rule: 'none' as const };
  const result = (patch: Partial<RunResult> = {}): RunResult => ({ runId: 'r1', routeId: 'RP-01', mode: 'drift-attack', rulesVersion: 'x', carId: 'CAR-02', elapsedActiveSeconds: 95.4, bankedScore: 812.4, medal: 'silver', valid: true, ...patch });
  const ctx = { startedDay: '2026-10-03', finishedDay: '2026-10-03', recoveries: 0 };

  it('counts a valid run on the right route, mode and car', () => {
    expect(dailyOutcome(spec, result(), ctx)).toEqual({ counts: true, reason: null, value: 812 });
    expect(dailyOutcome({ ...spec, mode: 'time-trial' }, result({ mode: 'time-trial' }), ctx).value).toBe(95400);
  });
  it('rejects other cars, routes, modes, invalid runs and midnight crossings', () => {
    expect(dailyOutcome(spec, result({ carId: 'CAR-01' }), ctx).counts).toBe(false);
    expect(dailyOutcome(spec, result({ routeId: 'HW-01' }), ctx).counts).toBe(false);
    expect(dailyOutcome(spec, result({ mode: 'time-trial' }), ctx).counts).toBe(false);
    expect(dailyOutcome(spec, result({ valid: false }), ctx).counts).toBe(false);
    expect(dailyOutcome(spec, result(), { ...ctx, finishedDay: '2026-10-04' }).counts).toBe(false);
    expect(dailyOutcome(spec, result({ bankedScore: Number.NaN }), ctx).counts).toBe(false);
    expect(dailyOutcome(spec, null, ctx).counts).toBe(false);
  });
  it('enforces the no reset rule', () => {
    const strict = { ...spec, rule: 'no-reset' as const };
    expect(dailyOutcome(strict, result(), ctx).counts).toBe(true);
    expect(dailyOutcome(strict, result(), { ...ctx, recoveries: 1 }).reason).toMatch(/no reset/i);
  });
});

describe('daily rewards, streak and clock', () => {
  it('unlocks tiers up to the medal and sums to the cap', () => {
    expect(dailyTiersFor('none')).toEqual(['finish']);
    expect(dailyTiersFor('bronze')).toEqual(['finish', 'bronze']);
    expect(dailyTiersFor('gold')).toEqual(['finish', 'bronze', 'silver', 'gold']);
    expect(DAILY_MAX_MARKS).toBe(DAILY_TIERS.reduce((sum, tier) => sum + tier.marks, 0));
    expect(DAILY_MAX_MARKS).toBe(80);
  });
  it('counts a streak ending today or yesterday', () => {
    expect(dailyStreak(['2026-10-01', '2026-10-02', '2026-10-03'], '2026-10-03')).toBe(3);
    expect(dailyStreak(['2026-10-01', '2026-10-02'], '2026-10-03')).toBe(2);
    expect(dailyStreak(['2026-09-30', '2026-10-02'], '2026-10-03')).toBe(1);
    expect(dailyStreak(['2026-09-29'], '2026-10-03')).toBe(0);
    expect(dailyStreak(['junk', '2026-10-03'], '2026-10-03')).toBe(1);
  });
  it('counts down to the next UTC midnight', () => {
    expect(msUntilReset(Date.parse('2026-10-03T23:00:00Z'))).toBe(3_600_000);
    expect(msUntilReset(Date.parse('2026-10-03T00:00:00Z'))).toBe(DAY_MS);
    expect(formatCountdown(3_723_000)).toBe('01:02:03');
    expect(formatCountdown(-5)).toBe('00:00:00');
  });
});
