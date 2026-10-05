import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, achievementViews, applyStat, badgeMask, decodeBadgeMask, emptyStats, MAX_BADGE_MASK, normalizeStats, topBadges, unlockReached, type StatEvent } from '../../src/progression/achievements';

const run = (patch: Record<string, unknown> = {}): StatEvent => ({ type: 'run', result: { valid: true, mode: 'drift-attack', routeId: 'HW-01', carId: 'CAR-01', bankedScore: 500, medal: 'none', ...patch } } as StatEvent);

describe('achievements', () => {
  it('has unique ids and bits under 30, and short badges', () => {
    expect(new Set(ACHIEVEMENTS.map(a => a.id)).size).toBe(ACHIEVEMENTS.length);
    expect(new Set(ACHIEVEMENTS.map(a => a.bit)).size).toBe(ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) { expect(a.bit).toBeGreaterThanOrEqual(0); expect(a.bit).toBeLessThan(30); expect(a.badge.length).toBeLessThanOrEqual(2); expect(a.name + a.line).not.toMatch(/—/); }
  });

  it('folds runs into stats', () => {
    let s = emptyStats();
    s = applyStat(s, run({ medal: 'gold', bankedScore: 1500 }));
    s = applyStat(s, run({ valid: false, medal: 'gold', routeId: 'RP-01', carId: 'CAR-02' }));
    s = applyStat(s, run({ mode: 'time-trial', medal: 'gold', routeId: 'CL-01', carId: 'CAR-04', bankedScore: 99_999 }));
    expect(s).toMatchObject({ runs: 3, validRuns: 2, gold: 2, goldRoutes: ['HW-01', 'CL-01'], routes: ['HW-01', 'CL-01'], cars: ['CAR-01', 'CAR-04'], bestDrift: 1500 });
  });

  it('unlocks once when a target is reached', () => {
    let s = applyStat(emptyStats(), run({ medal: 'bronze', bankedScore: 1200 }));
    const first = unlockReached(s, 1000);
    expect(first.fresh.map(a => a.id)).toEqual(['first-run', 'medal', 'drift-1k']);
    s = first.stats;
    expect(unlockReached(s, 2000).fresh).toEqual([]);
    expect(achievementViews(s).find(v => v.id === 'drift-1k')).toMatchObject({ unlocked: true, unlockedAt: 1000, current: 1000, target: 1000 });
    expect(achievementViews(s).find(v => v.id === 'drift-5k')).toMatchObject({ unlocked: false, current: 1200, target: 5000 });
  });

  it('tracks daily days, streaks, ghosts, photos, replays and online races', () => {
    let s = emptyStats();
    s = applyStat(s, { type: 'daily', day: '2026-10-03', streak: 7 });
    s = applyStat(s, { type: 'daily', day: 'not-a-day', streak: 99 });
    s = applyStat(s, { type: 'ghost-win' });
    s = applyStat(s, { type: 'photo' });
    s = applyStat(s, { type: 'replay' });
    s = applyStat(s, { type: 'online', race: true, won: false });
    s = applyStat(s, { type: 'online', race: false, won: true });
    expect(s).toMatchObject({ dailyDays: ['2026-10-03'], bestStreak: 7, ghostWins: 1, photos: 1, replays: 1, onlineRaces: 1, onlineWins: 1 });
    const ids = unlockReached(s, 5).fresh.map(a => a.id);
    expect(ids).toEqual(expect.arrayContaining(['daily', 'streak-3', 'streak-7', 'ghost', 'photo', 'replay', 'online-win']));
  });

  it('normalizes junk storage', () => {
    const s = normalizeStats({ runs: -5, gold: 2.7, routes: ['HW-01', 'x', 3, 'HW-01'], unlocked: { 'first-run': 10, bogus: 5, gold: 'yes', ['__proto__']: 1 }, bestDrift: Infinity, dailyDays: ['2026-10-03', '<b>'] });
    expect(s).toMatchObject({ runs: 0, gold: 2, routes: ['HW-01'], unlocked: { 'first-run': 10 }, bestDrift: 0, dailyDays: ['2026-10-03'] });
    expect(normalizeStats(null)).toEqual(emptyStats());
    expect(normalizeStats('nope')).toEqual(emptyStats());
  });

  it('round trips the presence badge mask and rejects untrusted values', () => {
    const s = unlockReached(applyStat(applyStat(emptyStats(), run({ medal: 'gold', bankedScore: 6000 })), { type: 'ghost-win' }), 1).stats;
    const mask = badgeMask(s);
    expect(mask).toBeGreaterThan(0);
    expect(decodeBadgeMask(mask, 99).map(a => a.id).sort()).toEqual(Object.keys(s.unlocked).sort());
    expect(decodeBadgeMask(mask)).toHaveLength(3);
    expect(decodeBadgeMask(mask)[0]!.tier).toBe('gold');
    expect(topBadges(s, 2)).toHaveLength(2);
    for (const bad of [-1, 0, 1.5, MAX_BADGE_MASK + 1, Number.NaN, '7', null, {}]) expect(decodeBadgeMask(bad)).toEqual([]);
    expect(decodeBadgeMask(2 ** 29)).toEqual([]); // unknown bit
  });
});
