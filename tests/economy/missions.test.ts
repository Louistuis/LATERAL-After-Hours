import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../contracts/runtime-contracts';
import { createEconomy } from '../../src/economy/economy';
import {
  ALL_AVAILABLE, ALL_MISSIONS, allowanceWeeks, FALLBACK_GRADE_SCORE, CAREER, CAREER_TOTAL, claimKeyOf, DAILY_MAX, DAILY_POOL, dailyFor, driveChanges, gradeOf, MAX_REWARD, MIN_REWARD,
  isAvailable, missionCeiling, missionViews, onlineChanges, qualifyingRun, runChanges, WEEKLY_MAX, WEEKLY_POOL, weeklyFor,
} from '../../src/economy/mission-catalog';
import { applyStats, dayEndsAt, dayIdOf, emptyProgress, mergeProgress, normalizeProgress, rollProgress, weekEndsAt, weekIdOf, type MissionProgress } from '../../src/economy/mission-progress';
import { createMissionsSource, MissionTracker, onlineOutcome, type MissionsSource } from '../../src/economy/missions';
import { WELCOME_MARKS } from '../../src/economy/welcome';
import { createRemoteVerifier } from '../../src/economy/remote-verify';
import type { EconomyGameEvents, FrameSample, OnlineRaceSample, WalletRecord, WalletStore } from '../../src/economy/types';
import { applyGrant, emptyWallet, mergeWallets, normalizeWallet, plausibleAccrued, verifyOwned } from '../../src/economy/wallet';
import { VEHICLE_PHYSICS_VERSION } from '../../src/vehicle/tune-identity';

const DAY = 86_400_000;
/** Friday 2026-10-02 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 2, 12);
const ROUTES = ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'];

const run = (over: Partial<RunResult> = {}): RunResult => ({
  runId: 'run-1', routeId: 'HW-01', mode: 'drift-attack', rulesVersion: 'r', physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-01',
  assist: 'medium', elapsedActiveSeconds: 60, bankedScore: 3000, medal: 'none', valid: true, ...over,
});
const sample = (tick: number, over: Partial<FrameSample> = {}): FrameSample => ({
  tick, paused: false, x: 0, y: 0, z: 0, speedMS: 0, runId: null, active: false, unbanked: 0, validDrift: false, recoveries: 0, ...over,
});

/* ------------------------------------------------------------------ content invariants */

describe('mission content', () => {
  it('has at least 30 one-time missions and rewards inside the fixed bounds', () => {
    expect(CAREER.length).toBeGreaterThanOrEqual(30);
    for (const mission of CAREER) expect(mission.reward).toBeGreaterThanOrEqual(50);
    for (const mission of DAILY_POOL) { expect(mission.reward).toBeGreaterThanOrEqual(25); expect(mission.reward).toBeLessThanOrEqual(100); }
    for (const mission of WEEKLY_POOL) { expect(mission.reward).toBeGreaterThanOrEqual(150); expect(mission.reward).toBeLessThanOrEqual(250); }
    for (const mission of ALL_MISSIONS) {
      expect(Number.isInteger(mission.reward)).toBe(true);
      expect(mission.reward).toBeGreaterThanOrEqual(MIN_REWARD);
      expect(mission.reward).toBeLessThanOrEqual(MAX_REWARD);
      expect(mission.title.length).toBeGreaterThan(0);
      expect(mission.text).not.toMatch(/—|–/);
      expect(mission.title).not.toMatch(/—|–/);
    }
    expect(Math.max(...ALL_MISSIONS.map(mission => mission.reward))).toBe(250);
  });
  it('has unique ids, and unique claim keys for a whole year of days', () => {
    expect(new Set(ALL_MISSIONS.map(mission => mission.id)).size).toBe(ALL_MISSIONS.length);
    const keys = new Set<string>();
    for (let day = 0; day < 365; day++) {
      const now = NOW + day * DAY;
      for (const mission of [...dailyFor(dayIdOf(now)), ...weeklyFor(weekIdOf(now)), ...CAREER]) keys.add(claimKeyOf(mission, now));
    }
    expect(keys.size).toBeGreaterThan(CAREER.length + 365 * 3);
    for (const key of keys) expect(`missions:m:${key}`.length).toBeLessThanOrEqual(120);
  });
  it('every mission is reachable: its target is positive for the real route list', () => {
    for (const mission of ALL_MISSIONS) expect(mission.target({ routes: ROUTES })).toBeGreaterThan(0);
  });
  it('never uses a measure that reads a counter the game does not produce', () => {
    // Every counter a mission reads must be one runChanges, driveChanges, onlineChanges or purchaseChanges can write.
    const written = new Set(['runs', 'runs.tt', 'runs.da', 'runs.rg', 'runs.off', 'score.max', 'chain.max', 'drift.ds', 'recov.fin', 'recov.grade', 'clean', 'dist.m', 'speed.kmh', 'net.races', 'net.wins', 'buy.items', 'buy.car']);
    let progress: MissionProgress = emptyProgress(NOW);
    progress = applyStats(progress, NOW, [...runChanges(run({ medal: 'bronze' }), { maxChain: 100, driftSeconds: 5, recoveries: 1 })!, ...runChanges(run({ mode: 'time-trial', assist: 'off', medal: 'bronze' }), null)!, ...runChanges(run({ mode: 'rival-ghost' }), null)!, ...runChanges(run(), { maxChain: 1, driftSeconds: 1, recoveries: 0 })!, ...driveChanges(100, 30), ...onlineChanges('finish', { id: 'a', participants: 2, position: 1, won: true }), ...onlineChanges('win', { id: 'a', participants: 2, position: 1, won: true }), { key: 'buy.items', max: 1 }, { key: 'buy.car', max: 1 }]);
    const names = Object.keys(progress.life).filter(key => !key.includes(':'));
    for (const name of names) expect(written.has(name)).toBe(true);
    for (const name of written) expect(names).toContain(name);
  });
});

/* ------------------------------------------------------------------ periods and rotation */

describe('periods and rotation', () => {
  it('days roll at UTC midnight and weeks on Monday 00:00 UTC', () => {
    expect(dayIdOf(Date.UTC(2026, 9, 2, 23, 59, 59))).toBe('2026-10-02');
    expect(dayIdOf(Date.UTC(2026, 9, 3, 0, 0, 0))).toBe('2026-10-03');
    expect(weekIdOf(Date.UTC(2026, 9, 4, 23, 59, 59))).toBe(weekIdOf(Date.UTC(2026, 9, 2)));
    expect(weekIdOf(Date.UTC(2026, 9, 5, 0, 0, 0))).toBe(weekIdOf(Date.UTC(2026, 9, 2)) + 1);
    expect(new Date(weekEndsAt(NOW)).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(new Date(dayEndsAt(NOW)).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
  it('rotation is deterministic per UTC date, three different missions a day, two a week', () => {
    const today = dailyFor('2026-10-02');
    expect(today.map(mission => mission.id)).toEqual(dailyFor('2026-10-02').map(mission => mission.id));
    expect(new Set(today.map(mission => mission.id)).size).toBe(3);
    expect(new Set(today.map(mission => mission.group)).size).toBe(3);
    const sets = new Set<string>();
    for (let day = 0; day < 30; day++) sets.add(dailyFor(dayIdOf(NOW + day * DAY)).map(mission => mission.id).join());
    expect(sets.size).toBeGreaterThan(15);
    const week = weeklyFor(weekIdOf(NOW));
    expect(week).toHaveLength(2);
    expect(week.map(mission => mission.id)).toEqual(weeklyFor(weekIdOf(NOW)).map(mission => mission.id));
    expect(new Set(Array.from({ length: 20 }, (_, i) => weeklyFor(weekIdOf(NOW) + i).map(mission => mission.id).join())).size).toBeGreaterThan(8);
  });
  it('a new day or week resets only its own counters and never touches lifetime', () => {
    let progress = applyStats(emptyProgress(NOW), NOW, [{ key: 'runs', add: 3 }]);
    expect(progress.day.c.runs).toBe(3);
    const tomorrow = rollProgress(progress, NOW + DAY);
    expect(tomorrow.day.c.runs ?? 0).toBe(0);
    expect(tomorrow.week.c.runs).toBe(3);
    expect(tomorrow.life.runs).toBe(3);
    const nextWeek = rollProgress(progress, NOW + 4 * DAY);
    expect(nextWeek.week.c.runs ?? 0).toBe(0);
    expect(nextWeek.life.runs).toBe(3);
    // A stored period in the future (tampered or clock skew) is reset, not trusted.
    progress = { ...progress, day: { id: '2099-01-01', c: { runs: 99 } } };
    expect(rollProgress(progress, NOW).day.c.runs ?? 0).toBe(0);
  });
  it('merging two copies keeps the best of each and the newer period', () => {
    const a = applyStats(emptyProgress(NOW), NOW, [{ key: 'runs', add: 5 }, { key: 'chain.max', max: 900 }]);
    const b = applyStats(emptyProgress(NOW), NOW, [{ key: 'runs', add: 2 }, { key: 'chain.max', max: 2000 }]);
    const merged = mergeProgress(a, b);
    expect(merged.life).toMatchObject({ runs: 5, 'chain.max': 2000 });
    const old = applyStats(emptyProgress(NOW - 3 * DAY), NOW - 3 * DAY, [{ key: 'runs', add: 50 }]);
    expect(mergeProgress(a, old).day.c.runs).toBe(5);
    expect(mergeProgress(old, a).day.id).toBe(dayIdOf(NOW));
  });
  it('normalizeProgress bounds junk from storage', () => {
    const junk = normalizeProgress({ life: { runs: -4, 'bad key!': 5, ok: 'x', big: 1e30, fine: 7.9 }, day: { id: 'nope', c: { runs: 1 } }, week: { id: 'x', c: {} }, seen: ['a', 5, 'b'.repeat(200)] });
    expect(junk.life).toEqual({ big: 1e9, fine: 7 });
    expect(junk.day.id).toBe('1970-01-01');
    expect(junk.seen).toEqual(['a']);
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i + 1]));
    expect(Object.keys(normalizeProgress({ life: many }).life).length).toBeLessThanOrEqual(80);
    expect(normalizeProgress('x').life).toEqual({});
    expect(normalizeProgress(null).v).toBe(1);
  });
});

/* ------------------------------------------------------------------ only what is possible */

describe('missions are only offered when the content exists', () => {
  const one = { routes: ['HW-01'], online: false, rival: false, cars: true };
  const ids = (list: { id: string }[]): string[] => list.map(mission => mission.id);
  it('with one playable route and no online, no daily or weekly mission needs more than that, for a whole year', () => {
    const impossible = new Set(['d-two-roads', 'd-three-roads', 'd-online', 'd-online-win', 'w-grand-tour', 'w-online', 'w-online-wins']);
    for (let day = 0; day < 400; day++) {
      const now = NOW + day * DAY;
      const daily = dailyFor(dayIdOf(now), one), weekly = weeklyFor(weekIdOf(now), one);
      expect(daily).toHaveLength(3);
      expect(weekly).toHaveLength(2);
      for (const mission of [...daily, ...weekly]) { expect(impossible.has(mission.id), mission.id).toBe(false); expect(isAvailable(mission, one)).toBe(true); }
    }
  });
  it('the rotation is still deterministic for the same date and content, and re-rolls when new content arrives', () => {
    expect(ids(dailyFor('2026-10-02', one))).toEqual(ids(dailyFor('2026-10-02', one)));
    const grown = { routes: ['HW-01', 'HW-02', 'RP-01'], online: true, rival: false, cars: true };
    const seen = new Set<string>();
    for (let day = 0; day < 60; day++) for (const mission of dailyFor(dayIdOf(NOW + day * DAY), grown)) seen.add(mission.id);
    expect(seen.has('d-three-roads') && seen.has('d-online')).toBe(true);
  });
  it('career missions that need routes, online, a rival ghost or cars for sale are hidden until they exist', () => {
    const visible = (ctx: Parameters<typeof missionViews>[1]): string[] => missionViews(emptyProgress(NOW), ctx, () => false, NOW).filter(view => view.kind === 'career').map(view => view.def.id);
    const base = visible(one);
    for (const hidden of ['routes-3', 'routes-all', 'region-harbor', 'region-ridge', 'region-coast', 'bronze-everywhere', 'silver-everywhere', 'gold-three', 'online-first', 'online-win', 'online-5', 'online-wins-3', 'ghost-race']) expect(base, hidden).not.toContain(hidden);
    for (const shown of ['first-finish', 'distance-5km', 'chain-500', 'buy-1', 'buy-car']) expect(base, shown).toContain(shown);
    expect(visible({ ...one, online: true })).toContain('online-win');
    expect(visible({ ...one, rival: true })).toContain('ghost-race');
    expect(visible({ ...one, cars: false })).not.toContain('buy-car');
    const three = visible({ routes: ['HW-01', 'HW-02', 'RP-01'], online: false });
    expect(three).toEqual(expect.arrayContaining(['routes-3', 'routes-all', 'region-harbor', 'bronze-everywhere', 'gold-three']));
    expect(three).not.toContain('region-ridge');
    expect(visible(ALL_AVAILABLE).length).toBe(CAREER.length);
    // Every visible mission can be completed: its target is reachable with this content.
    for (const view of missionViews(emptyProgress(NOW), one, () => false, NOW)) expect(view.target).toBeGreaterThan(0);
    expect(CAREER.every(mission => isAvailable(mission, ALL_AVAILABLE))).toBe(true);
  });
  it('the payout budget does not depend on what is available (it is the upper bound for all content)', () => {
    expect(missionCeiling(NOW, NOW)).toBe(CAREER_TOTAL + DAILY_MAX + WEEKLY_MAX);
  });
});

/* ------------------------------------------------------------------ the ceiling */

describe('the most missions can ever pay', () => {
  it('is career once + daily maximum per UTC day + weekly maximum per UTC week', () => {
    expect(CAREER_TOTAL).toBe(CAREER.reduce((sum, mission) => sum + mission.reward, 0));
    expect(DAILY_MAX).toBe([...DAILY_POOL].map(mission => mission.reward).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0));
    expect(WEEKLY_MAX).toBe([...WEEKLY_POOL].map(mission => mission.reward).sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0));
    expect(missionCeiling(NOW, NOW)).toBe(CAREER_TOTAL + DAILY_MAX + WEEKLY_MAX);
    expect(missionCeiling(NOW - 9 * DAY, NOW)).toBe(CAREER_TOTAL + DAILY_MAX * 10 + WEEKLY_MAX * allowanceWeeks(NOW - 9 * DAY, NOW));
    expect(allowanceWeeks(NOW - 9 * DAY, NOW)).toBe(2);
    expect(allowanceWeeks(NOW - 20 * DAY, NOW)).toBe(4);
    // Unknown or future creation: the strictest value (one day, one week).
    expect(missionCeiling(null, NOW)).toBe(missionCeiling(NOW, NOW));
    expect(missionCeiling(NOW + DAY, NOW)).toBe(missionCeiling(NOW, NOW));
  });
  it('the real daily rotation never pays more than DAILY_MAX in a day, nor the weekly more than WEEKLY_MAX', () => {
    for (let day = 0; day < 400; day++) {
      const now = NOW + day * DAY;
      expect(dailyFor(dayIdOf(now)).reduce((sum, mission) => sum + mission.reward, 0)).toBeLessThanOrEqual(DAILY_MAX);
      expect(weeklyFor(weekIdOf(now)).reduce((sum, mission) => sum + mission.reward, 0)).toBeLessThanOrEqual(WEEKLY_MAX);
    }
  });
  it('plausibleAccrued clamps stored mission earnings to the ceiling and leaves other sources on their daily cap', () => {
    const out = plausibleAccrued({ missions: 1e6, gameplay: 1e6 }, { gameplay: 25 }, NOW - 4 * DAY, NOW, { missions: missionCeiling(NOW - 4 * DAY, NOW) });
    expect(out.missions).toBe(missionCeiling(NOW - 4 * DAY, NOW));
    expect(out.gameplay).toBe(125);
    expect(plausibleAccrued({ missions: 100 }, {}, NOW, NOW, { missions: 5000 }).missions).toBe(100);
  });
  it('applyGrant refuses to go past the ceiling or the per grant maximum, and does not consume a blocked one-time claim', () => {
    let record = { ...emptyWallet(NOW), earned: { missions: 990 } };
    const blocked = applyGrant(record, { source: 'missions', key: 'c:x', amount: 250, reason: 'x', permanent: true }, undefined, NOW, { maxGrant: 250, ceiling: 1000 });
    expect(blocked.result.granted).toBe(10);
    record = { ...record, earned: { missions: 1000 } };
    const none = applyGrant(record, { source: 'missions', key: 'c:y', amount: 250, reason: 'y', permanent: true }, undefined, NOW, { maxGrant: 250, ceiling: 1000 });
    expect(none.result).toEqual({ granted: 0, capped: true, duplicate: false });
    expect(none.record).toBe(record);
    expect(none.record.claims).toBeUndefined();
    const huge = applyGrant(emptyWallet(NOW), { source: 'missions', key: 'c:z', amount: 99999, reason: 'z', permanent: true }, undefined, NOW, { maxGrant: 250, ceiling: 1e6 });
    expect(huge.result.granted).toBe(250);
  });
  it('permanent claims survive the bounded receipt list, so a one-time reward can never be paid twice', () => {
    let record = emptyWallet(NOW);
    record = applyGrant(record, { source: 'missions', key: 'c:first-finish', amount: 50, reason: 'x', permanent: true }, undefined, NOW, { maxGrant: 250 }).record;
    for (let i = 0; i < 400; i++) record = applyGrant(record, { source: 'gameplay', key: `run:${i}`, amount: 1, reason: 'r' }, undefined, NOW).record;
    expect(record.receipts).not.toContain('missions:c:first-finish');
    const again = applyGrant(record, { source: 'missions', key: 'c:first-finish', amount: 50, reason: 'x', permanent: true }, undefined, NOW, { maxGrant: 250 });
    expect(again.result.duplicate).toBe(true);
    expect(again.record.earned.missions).toBe(50);
    // Survives normalize and merge too; period claims are trimmed before career claims.
    expect(normalizeWallet(JSON.parse(JSON.stringify(record))).claims).toContain('missions:c:first-finish');
    const many = Array.from({ length: 700 }, (_, i) => `missions:d:2026-01-01:m${i}`);
    const merged = mergeWallets({ ...record, claims: ['missions:c:first-finish', ...many] }, emptyWallet(NOW));
    expect(merged.claims).toContain('missions:c:first-finish');
    expect(merged.claims!.length).toBeLessThanOrEqual(400);
  });
});

/* ------------------------------------------------------------------ evaluating game events */

describe('evaluating run results', () => {
  it('counts a believable run: mode, route, score, assists and grade', () => {
    const changes = runChanges(run({ assist: 'off', bankedScore: 600, medal: 'silver' }), { maxChain: 250, driftSeconds: 7.34, recoveries: 0 })!;
    const get = (key: string) => changes.find(change => change.key === key);
    expect(get('runs')).toMatchObject({ add: 1 });
    expect(get('runs.da')).toMatchObject({ add: 1 });
    expect(get('runs.off')).toMatchObject({ add: 1 });
    expect(get('score.max')).toMatchObject({ max: 600 });
    expect(get('rc:HW-01')).toMatchObject({ max: 1 });
    expect(get('rg:HW-01')).toMatchObject({ max: 2 });
    expect(get('chain.max')).toMatchObject({ max: 250 });
    expect(get('drift.ds')).toMatchObject({ max: 73 });
    expect(get('clean')).toMatchObject({ add: 1 });
    expect(get('recov.fin')).toBeUndefined();
  });
  it('rejects runs that are invalid, too short, from another physics version, without a recorded assist level or absurd', () => {
    expect(runChanges(run({ valid: false }), null)).toBeNull();
    expect(runChanges(run({ elapsedActiveSeconds: 14 }), null)).toBeNull();
    expect(runChanges(run({ elapsedActiveSeconds: 7200 }), null)).toBeNull();
    expect(runChanges(run({ physicsVersion: 'old' }), null)).toBeNull();
    expect(runChanges(run({ physicsVersion: undefined }), null)).toBeNull();
    expect(runChanges(run({ assist: undefined }), null)).toBeNull();
    expect(runChanges(run({ bankedScore: 5e9 }), null)).toBeNull();
    expect(runChanges(run({ bankedScore: Number.NaN }), null)).toBeNull();
    expect(runChanges(run({ bankedScore: -1 }), null)).toBeNull();
    expect(runChanges(run({ routeId: '../../x' as never }), null)).toBeNull();
    expect(runChanges(run({ mode: 'hack' as never }), null)).toBeNull();
    expect(runChanges(run({ runId: '' }), null)).toBeNull();
    expect(runChanges(null, null)).toBeNull();
    expect(qualifyingRun(run())).toBe(true);
  });
  it('clamps impossible telemetry instead of paying it', () => {
    const changes = runChanges(run({ elapsedActiveSeconds: 30 }), { maxChain: 1e12, driftSeconds: 900, recoveries: 3 })!;
    expect(changes.find(change => change.key === 'chain.max')).toMatchObject({ max: 500000 });
    expect(changes.find(change => change.key === 'drift.ds')).toMatchObject({ max: 300 });
    expect(changes.find(change => change.key === 'recov.fin')).toMatchObject({ add: 1 });
    const nan = runChanges(run(), { maxChain: Number.NaN, driftSeconds: Number.NaN, recoveries: Number.NaN })!;
    expect(nan.find(change => change.key === 'chain.max')).toBeUndefined();
    expect(nan.find(change => change.key === 'drift.ds')).toBeUndefined();
  });
  it('a crash recovery plus a grade counts as "recover and still medal" but not as a clean run', () => {
    const changes = runChanges(run({ medal: 'bronze' }), { maxChain: 0, driftSeconds: 0, recoveries: 1 })!;
    expect(changes.find(change => change.key === 'recov.fin')).toBeDefined();
    expect(changes.find(change => change.key === 'recov.grade')).toBeDefined();
    expect(changes.find(change => change.key === 'clean')).toBeUndefined();
    expect(runChanges(run({ medal: 'none' }), { maxChain: 0, driftSeconds: 0, recoveries: 1 })!.find(change => change.key === 'recov.grade')).toBeUndefined();
  });
  it('grades by the real medal when the route has medal targets (no medal is grade 0, whatever the score)', () => {
    const base = { mode: 'drift-attack' as const };
    expect(gradeOf({ ...base, medal: 'none', bankedScore: 100 })).toBe(0);
    expect(gradeOf({ ...base, medal: 'none', bankedScore: 5000 })).toBe(0);
    expect(gradeOf({ ...base, medal: 'none', bankedScore: 5000 }, true)).toBe(0);
    expect(gradeOf({ ...base, medal: 'bronze', bankedScore: 0 })).toBe(1);
    expect(gradeOf({ ...base, medal: 'silver', bankedScore: 0 })).toBe(2);
    expect(gradeOf({ ...base, medal: 'gold', bankedScore: 0 })).toBe(3);
    const changes = runChanges(run({ medal: 'none', bankedScore: 5000 }), { maxChain: 1, driftSeconds: 1, recoveries: 0, hasTargets: true })!;
    expect(changes.find(change => change.key === 'rg:HW-01')).toMatchObject({ max: 0 });
  });
  it('on a route without medal targets a drift attack is graded from its score on the real scale, other modes are not graded', () => {
    const drift = { mode: 'drift-attack' as const, medal: 'none' as const };
    expect(gradeOf({ ...drift, bankedScore: 50 }, false)).toBe(0);
    expect(gradeOf({ ...drift, bankedScore: FALLBACK_GRADE_SCORE[0] }, false)).toBe(1);
    expect(gradeOf({ ...drift, bankedScore: FALLBACK_GRADE_SCORE[1] }, false)).toBe(2);
    expect(gradeOf({ ...drift, bankedScore: FALLBACK_GRADE_SCORE[2] }, false)).toBe(3);
    expect(gradeOf({ mode: 'time-trial', medal: 'none', bankedScore: 99999 }, false)).toBe(0);
    expect(gradeOf({ mode: 'drift-attack', medal: 'silver', bankedScore: 0 }, false)).toBe(2);
    // The fallback sits between the calibrated routes (HW-01 100/400/1200, RP-01 60/150/500).
    expect(FALLBACK_GRADE_SCORE[0]).toBeGreaterThanOrEqual(60); expect(FALLBACK_GRADE_SCORE[0]).toBeLessThanOrEqual(100);
    expect(FALLBACK_GRADE_SCORE[2]).toBeLessThanOrEqual(1200);
    const changes = runChanges(run({ medal: 'none', bankedScore: 300 }), { maxChain: 1, driftSeconds: 1, recoveries: 0, hasTargets: false })!;
    expect(changes.find(change => change.key === 'rg:HW-01')).toMatchObject({ max: 2 });
  });
  it('score and chain missions sit on the drift attack scale of the medal table (gold on HW-01 is 1200 points)', () => {
    for (const mission of ALL_MISSIONS.filter(entry => entry.unit === 'pts')) {
      const target = mission.target(ALL_AVAILABLE);
      expect(target, mission.id).toBeGreaterThanOrEqual(50);
      expect(target, mission.id).toBeLessThanOrEqual(1200);
      expect(mission.text.replace(/,/g, '')).toContain(String(target));
    }
    const score = (id: string) => ALL_MISSIONS.find(entry => entry.id === id)!.target(ALL_AVAILABLE);
    expect(score('score-2500')).toBeLessThan(score('score-8000'));
    expect(score('score-8000')).toBeLessThan(score('score-20000'));
    expect(score('chain-500')).toBeLessThan(score('chain-12000'));
  });
  it('driving counters drop speeds above the physical limit', () => {
    expect(driveChanges(40.7, 30)).toEqual([{ key: 'dist.m', add: 40 }, { key: 'speed.kmh', max: 108 }]);
    expect(driveChanges(0, 500)).toEqual([]);
    expect(driveChanges(1e9, Number.NaN)).toEqual([{ key: 'dist.m', add: 5000 }]);
  });
  it('online: a finish needs another racer, a win needs the race decided and you first', () => {
    const base = { lobbyId: 'lob', race: 2, finished: true, lobby: { ph: 'r', race: 2 }, standings: [
      { self: true, finished: true, invalid: false, timeMs: 61000, position: 1 },
      { self: false, finished: false, invalid: false, timeMs: 0, position: 2 },
    ] };
    expect(onlineOutcome(base)).toMatchObject({ id: 'lob:2', participants: 2, position: 1, won: false });
    expect(onlineOutcome({ ...base, standings: [base.standings[0]!, { ...base.standings[1]!, finished: true, timeMs: 65000 }] })!.won).toBe(true);
    expect(onlineOutcome({ ...base, lobby: { ph: 'w', race: 2 } })!.won).toBe(true);
    expect(onlineOutcome({ ...base, lobby: { ph: 'w', race: 1 } })!.won).toBe(false);
    expect(onlineOutcome({ ...base, standings: [base.standings[0]!, { ...base.standings[1]!, finished: true, timeMs: 50000, position: 1 }].map((s, i) => ({ ...s, position: i === 0 ? 2 : 1 })) })!.won).toBe(false);
    expect(onlineOutcome({ ...base, standings: [base.standings[0]!] })!.won).toBe(false);
    expect(onlineOutcome({ ...base, finished: false })).toBeNull();
    expect(onlineOutcome({ ...base, race: 0 })).toBeNull();
    expect(onlineOutcome({ ...base, lobbyId: null })).toBeNull();
    expect(onlineOutcome({ ...base, standings: [{ ...base.standings[0]!, timeMs: 3000 }] })).toBeNull();
    expect(onlineOutcome({ ...base, standings: [{ ...base.standings[0]!, invalid: true }] })).toBeNull();
    expect(onlineOutcome(null)).toBeNull();
    expect(onlineChanges('finish', { id: 'x', participants: 1, position: 1, won: true })).toEqual([]);
    expect(onlineChanges('win', { id: 'x', participants: 2, position: 2, won: true })).toEqual([]);
    expect(onlineChanges('win', { id: 'x', participants: 2, position: 1, won: true })).toEqual([{ key: 'net.wins', add: 1 }]);
  });
});

describe('frame tracker', () => {
  it('counts distance and top speed from real driving, never teleports, pauses or backwards ticks', () => {
    const tracker = new MissionTracker();
    let tick = 0, x = 0, total = 0, best = 0;
    const step = (over: Partial<FrameSample> = {}): void => {
      const changes = tracker.feed(sample(tick, { x, speedMS: 40, ...over }));
      for (const change of changes) { if ('add' in change && change.key === 'dist.m') total += change.add; if ('max' in change && change.key === 'speed.kmh') best = Math.max(best, change.max); }
    };
    step();
    for (let i = 0; i < 100; i++) { tick += 6; x += 4; step(); }
    expect(total).toBeGreaterThanOrEqual(380);
    expect(total).toBeLessThanOrEqual(400);
    expect(best).toBe(144);
    const before = total;
    tick += 6; x += 5000; step();
    expect(total).toBe(before);
    for (let i = 0; i < 30; i++) { tick += 6; x += 4; step({ paused: true }); }
    expect(total).toBe(before);
    tick -= 600; x += 4; step();
    expect(total).toBe(before);
    tick += 6000; x += 4; step();
    expect(total).toBe(before);
    for (let i = 0; i < 40; i++) { tick += 6; x += 4; step({ speedMS: 999 }); }
    expect(best).toBe(144);
  });
  it('tracks the longest unbroken drift, the biggest chain and crash recoveries per run', () => {
    const tracker = new MissionTracker();
    let tick = 0;
    const frames = (n: number, over: Partial<FrameSample>): void => { for (let i = 0; i < n; i++) { tick += 6; tracker.feed(sample(tick, { runId: 'r1', active: true, ...over })); } };
    frames(1, {});
    frames(30, { validDrift: true, unbanked: 800 });
    frames(5, { validDrift: false, unbanked: 0 });
    frames(20, { validDrift: true, unbanked: 300 });
    frames(2, { recoveries: 1 });
    const telemetry = tracker.take('r1')!;
    expect(telemetry.maxChain).toBe(800);
    expect(telemetry.driftSeconds).toBeCloseTo(3, 1);
    expect(telemetry.recoveries).toBe(1);
    expect(telemetry.hasTargets).toBe(true);
    expect(tracker.take('r1')).toBeNull();
    frames(2, { runId: 'r3', hasMedalTargets: false });
    expect(tracker.take('r3')!.hasTargets).toBe(false);
    // Paused or inactive frames do not build a drift.
    frames(40, { runId: 'r2', active: false, validDrift: true, unbanked: 99999 });
    expect(tracker.take('r2')!.maxChain).toBe(0);
  });
});

/* ------------------------------------------------------------------ the source inside a real economy */

function memory(record: WalletRecord | null = null): WalletStore & { current: WalletRecord | null; saves: number } {
  const store = { current: record, saves: 0, id: 'm', durable: true, load: async () => store.current, save: async (next: WalletRecord) => { store.current = next; store.saves++; } };
  return store;
}
async function rig(opts: { record?: WalletRecord | null; at?: number } = {}) {
  const clock = { t: opts.at ?? NOW };
  const frame = new Set<(s: FrameSample) => void>(), finished = new Set<(r: RunResult) => void>(), online = new Set<(s: OnlineRaceSample) => void>();
  const game: EconomyGameEvents = {
    onRunFinished: l => { finished.add(l); return () => finished.delete(l); },
    onFrame: l => { frame.add(l); return () => frame.delete(l); },
    onOnlineRace: l => { online.add(l); return () => online.delete(l); },
  };
  const store = memory(opts.record ?? null);
  const source = createMissionsSource({ now: () => clock.t, context: () => ({ routes: ROUTES, online: true, rival: true }) }) as MissionsSource;
  const economy = createEconomy({ store, sources: [source], game, now: () => clock.t });
  await economy.refresh();
  const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  return {
    clock, store, source, economy, flush,
    finish: async (result: RunResult) => { for (const l of finished) l(result); await flush(); },
    online: async (s: OnlineRaceSample) => { for (const l of online) l(s); await flush(); },
    frames: (s: FrameSample) => { for (const l of frame) l(s); },
  };
}
const maxed = (now: number): MissionProgress => {
  const counters: Record<string, number> = { runs: 999, 'runs.tt': 99, 'runs.da': 99, 'runs.rg': 9, 'runs.off': 99, 'score.max': 1e6, 'chain.max': 1e6, 'drift.ds': 1e4, 'dist.m': 1e7, 'speed.kmh': 999, 'recov.fin': 99, 'recov.grade': 99, clean: 99, 'net.races': 99, 'net.wins': 99, 'buy.items': 99, 'buy.car': 9 };
  for (const route of ROUTES) { counters[`rc:${route}`] = 1; counters[`rg:${route}`] = 3; }
  const base = emptyProgress(now);
  return { ...base, life: counters, day: { id: dayIdOf(now), c: counters }, week: { id: weekIdOf(now), c: counters } };
};

describe('missions source', () => {
  it('is an accrued source with a per grant maximum of 250 and a ceiling, hidden from Get Marks', async () => {
    const { source } = await rig();
    expect(source.kind).toBe('accrued');
    expect(source.maxGrant).toBe(250);
    expect(source.ceiling!(NOW, NOW)).toBe(missionCeiling(NOW, NOW));
    expect(source.available()).toBe(false);
    expect(source.offers!()).toEqual([]);
    expect(source.dailyCap).toBeUndefined();
  });
  it('a finished run completes First finish, it is claimed once, and the Marks arrive exactly once', async () => {
    const r = await rig();
    const completed = vi.fn();
    r.source.onComplete(completed);
    await r.finish(run());
    const first = r.source.views().find(view => view.def.id === 'first-finish')!;
    expect(first).toMatchObject({ complete: true, claimed: false, value: 1, target: 1 });
    expect(completed.mock.calls.map(call => call[0].def.id)).toContain('first-finish');
    expect(r.store.current!.missions!.life.runs).toBe(1);
    expect(r.economy.view().balance).toBe(0);
    const results = await Promise.all([r.source.claim(first.key), r.source.claim(first.key), r.source.claim(first.key)]);
    // Concurrent claims share one claim and one result: the Marks are paid once.
    expect(results.every(result => result.status === 'claimed' && result.marks === 50)).toBe(true);
    expect(r.economy.view().balance).toBe(50);
    expect(r.economy.view().earnedBySource.missions).toBe(50);
    expect((await r.source.claim(first.key)).status).toBe('already');
    expect(r.economy.view().balance).toBe(50);
    expect(r.source.views().find(view => view.def.id === 'first-finish')!.claimed).toBe(true);
    // The same result delivered again counts nothing.
    await r.finish(run());
    expect(r.source.views().find(view => view.def.id === 'five-events')!.value).toBe(1);
  });
  it('does not offer, and will not pay, a mission that needs content the build does not have', async () => {
    const clock = NOW;
    const store = memory({ ...emptyWallet(clock), missions: maxed(clock) });
    const source = createMissionsSource({ now: () => clock, context: () => ({ routes: ['HW-01'], online: false, rival: false }) });
    const economy = createEconomy({ store, sources: [source], game: { onRunFinished: () => () => {} }, now: () => clock });
    await economy.refresh();
    const views = source.views();
    expect(views.find(view => view.def.id === 'online-win')).toBeUndefined();
    expect(views.find(view => view.def.id === 'routes-3')).toBeUndefined();
    expect((await source.claim('c:online-win')).status).toBe('expired');
    expect((await source.claim('c:routes-3')).status).toBe('expired');
    expect((await source.claim('c:first-finish')).status).toBe('claimed');
    expect(economy.view().balance).toBe(50);
  });
  it('does not pay unfinished, unknown, expired or made-up claims, and never trusts a caller amount', async () => {
    const r = await rig();
    expect((await r.source.claim('c:first-finish')).status).toBe('not-complete');
    expect((await r.source.claim('c:nope')).status).toBe('expired');
    expect((await r.source.claim('d:2020-01-01:d-warm-up')).status).toBe('expired');
    expect((await r.source.claim('w:1:w-chain')).status).toBe('expired');
    expect((await r.source.claim('x')).status).toBe('expired');
    expect((await r.source.claim('')).status).toBe('expired');
    expect(r.economy.view().balance).toBe(0);
    // A direct grant through the port is still clamped to the per grant maximum.
    const record = applyGrant(emptyWallet(NOW), { source: 'missions', key: 'c:x', amount: 99999, reason: 'x', permanent: true }, undefined, NOW, { maxGrant: r.source.maxGrant });
    expect(record.result.granted).toBe(250);
  });
  it('rejects runs that fail the sanity checks and counts nothing', async () => {
    const r = await rig();
    for (const bad of [run({ valid: false, runId: 'a' }), run({ elapsedActiveSeconds: 5, runId: 'b' }), run({ physicsVersion: 'v0', runId: 'c' }), run({ assist: undefined, runId: 'd' }), run({ bankedScore: 9e9, runId: 'e' })]) await r.finish(bad);
    expect(r.source.views().find(view => view.def.id === 'first-finish')!.complete).toBe(false);
    expect(r.store.current?.missions?.life.runs ?? 0).toBe(0);
  });
  it('live driving completes distance missions mid drive and announces each only once', async () => {
    const r = await rig();
    const completed = vi.fn();
    r.source.onComplete(completed);
    let tick = 0, x = 0;
    for (let i = 0; i < 1100; i++) { tick += 6; x += 5; r.frames(sample(tick, { x, speedMS: 50 })); }
    const ids = completed.mock.calls.map(call => call[0].def.id);
    expect(ids).toContain('distance-5km');
    expect(ids.filter(id => id === 'distance-5km')).toHaveLength(1);
    expect(ids).toContain('speed-150');
    expect(r.source.views().find(view => view.def.id === 'distance-5km')!.complete).toBe(true);
    for (let i = 0; i < 300; i++) { tick += 6; x += 5; r.frames(sample(tick, { x, speedMS: 50 })); }
    expect(completed.mock.calls.filter(call => call[0].def.id === 'distance-5km')).toHaveLength(1);
  });
  it('online results count a finish once per race and a win once, and nothing alone in a lobby', async () => {
    const r = await rig();
    const race: OnlineRaceSample = { id: 'lob:1', participants: 3, position: 1, won: false };
    await r.online(race); await r.online(race);
    expect(r.source.views().find(view => view.def.id === 'online-first')!.complete).toBe(true);
    expect(r.source.views().find(view => view.def.id === 'online-win')!.complete).toBe(false);
    await r.online({ ...race, won: true }); await r.online({ ...race, won: true });
    expect(r.source.views().find(view => view.def.id === 'online-win')!.value).toBe(1);
    expect(r.source.views().find(view => view.def.id === 'online-5')!.value).toBe(1);
    await r.online({ id: 'lob:2', participants: 1, position: 1, won: true });
    expect(r.source.views().find(view => view.def.id === 'online-5')!.value).toBe(1);
    await r.online({ id: 'lob:3', participants: 2, position: 1, won: true });
    expect(r.source.views().find(view => view.def.id === 'online-5')!.value).toBe(2);
    expect(r.source.views().find(view => view.def.id === 'online-wins-3')!.value).toBe(2);
  });
  it('counts shop purchases from the verified wallet', async () => {
    const r = await rig({ record: { ...emptyWallet(NOW), earned: { missions: 0, gameplay: 25 }, owned: [] } });
    expect(r.source.views().find(view => view.def.id === 'buy-1')!.value).toBe(0);
    const bought = await r.economy.purchase('oxide-copper');
    expect(bought.ok).toBe(false); // 25 Marks is not enough: nothing counted
    expect(r.source.views().find(view => view.def.id === 'buy-1')!.value).toBe(0);
  });
  it('pays daily missions once per UTC day and weekly ones once per week, career never again', async () => {
    const created = NOW;
    const record = { ...emptyWallet(created), missions: maxed(NOW) };
    const r = await rig({ record });
    const views = r.source.views();
    const day1 = views.filter(view => view.kind === 'daily'), week1 = views.filter(view => view.kind === 'weekly');
    expect(day1).toHaveLength(3); expect(week1).toHaveLength(2);
    for (const view of views) expect((await r.source.claim(view.key)).status).toBe('claimed');
    const expected = CAREER_TOTAL + day1.reduce((s, v) => s + v.def.reward, 0) + week1.reduce((s, v) => s + v.def.reward, 0);
    expect(r.economy.view().balance).toBe(expected);
    for (const view of views) expect((await r.source.claim(view.key)).status).toBe('already');
    expect(r.economy.view().balance).toBe(expected);
    // Next day, same week: a fresh daily set can be claimed, the weekly set and career cannot.
    r.clock.t = NOW + DAY;
    await r.economy.refresh();
    const next = r.source.views();
    const dailyKeys = next.filter(view => view.kind === 'daily').map(view => view.key);
    expect(dailyKeys.every(key => !day1.some(view => view.key === key))).toBe(true);
    // The tracker only rolls its progress when something happens: finish a run so the new day has counters.
    expect(next.filter(view => view.kind === 'weekly').map(view => view.key)).toEqual(week1.map(view => view.key));
    expect(next.filter(view => view.kind === 'weekly').every(view => view.claimed)).toBe(true);
    expect(next.filter(view => view.kind === 'career').every(view => view.claimed)).toBe(true);
  });
  it('never pays past the ceiling, even when every mission is complete on a brand new wallet', async () => {
    const r = await rig({ record: { ...emptyWallet(NOW), missions: maxed(NOW) } });
    for (const view of r.source.views()) await r.source.claim(view.key);
    expect(r.economy.view().balance).toBeLessThanOrEqual(missionCeiling(NOW, NOW));
    expect(r.economy.view().earnedBySource.missions).toBeLessThanOrEqual(missionCeiling(NOW, NOW));
  });
  it('a tampered record with huge mission earnings only buys up to the ceiling', async () => {
    const owned = ['gold-chrome', 'mirror-chrome', 'black-chrome', 'northern-shift', 'car-cybertruck', 'car-challenger'].filter(id => id !== 'car-challenger');
    const record = { ...emptyWallet(NOW), earned: { missions: 1e9 }, owned };
    const r = await rig({ record });
    const view = r.economy.view();
    expect(view.earnedBySource.missions).toBe(missionCeiling(NOW, NOW));
    expect(view.balance + view.spent).toBeLessThanOrEqual(missionCeiling(NOW, NOW));
    expect(view.locked!.size).toBeGreaterThan(0);
  });
  it('progress and claims survive a reload, and two stale copies merge without losing either', async () => {
    const first = await rig();
    await first.finish(run({ runId: 'a' }));
    await first.source.claim(first.source.views().find(view => view.def.id === 'first-finish')!.key);
    const saved = first.store.current!;
    expect(saved.claims).toContain('missions:c:first-finish');
    const second = await rig({ record: saved });
    expect(second.source.views().find(view => view.def.id === 'first-finish')!.claimed).toBe(true);
    expect(second.economy.view().balance).toBe(50);
    expect((await second.source.claim('c:first-finish')).status).toBe('already');
    // A second tab that only knows about an older record can not take progress back.
    const older = { ...saved, missions: emptyProgress(NOW), claims: [] };
    expect(mergeWallets(saved, older).missions!.life.runs).toBe(1);
    expect(mergeWallets(older, saved).claims).toContain('missions:c:first-finish');
  });
  it('missionViews lists today\'s three, this week\'s two and then every career mission', () => {
    const views = missionViews(emptyProgress(NOW), ALL_AVAILABLE, () => false, NOW);
    expect(views.map(view => view.kind)).toEqual([...Array(3).fill('daily'), ...Array(2).fill('weekly'), ...Array(CAREER.length).fill('career')]);
    expect(views.every(view => view.fraction === 0 && !view.complete)).toBe(true);
    expect(views.filter(view => view.kind === 'daily').every(view => view.endsAt === dayEndsAt(NOW))).toBe(true);
    expect(views.filter(view => view.kind === 'weekly').every(view => view.endsAt === weekEndsAt(NOW))).toBe(true);
    expect(views.filter(view => view.kind === 'career').every(view => view.endsAt === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ other players */

describe('remote verification counts the mission allowance', () => {
  const rows = (owned: string[], ageDays: number) => [{ username: 'bob', w: JSON.stringify({ version: 1, owned }), created_at: new Date(NOW - ageDays * DAY).toISOString() }];
  const setup = (owned: string[], ageDays: number, extra: { missionAllowance?: (c: number | null, n: number) => number; welcomeAllowance?: number } = {}) => {
    const verifier = createRemoteVerifier({
      fetchJson: vi.fn(async () => ({ comments: { data: [], meta: { has_next_page: false, end_cursor: null } } })), projectId: () => 'p', now: () => NOW,
      wallets: () => rows(owned, ageDays), ...extra,
    });
    return verifier;
  };
  const expensive = ['gold-chrome', 'mirror-chrome', 'black-chrome', 'northern-shift', 'car-cybertruck'];
  it('allows what the missions could have paid and still hides a wallet that claims far more', async () => {
    const verifier = setup(expensive, 0);
    await verifier.refresh();
    const budget = 25 + WELCOME_MARKS + missionCeiling(NOW, NOW);
    expect([...verifier.allowed('bob')!]).toEqual(verifyOwned(expensive, budget).valid);
    expect(verifier.allowed('bob')!.size).toBeGreaterThan(0);
    expect(verifier.allowed('bob')!.size).toBeLessThan(expensive.length);
  });
  it('grows with the server-set age of the wallet row (daily and weekly maximums) and is zero without the allowance', async () => {
    const young = setup(expensive, 0), old = setup(expensive, 60), none = setup(expensive, 0, { missionAllowance: () => 0, welcomeAllowance: 0 });
    await Promise.all([young.refresh(), old.refresh(), none.refresh()]);
    expect(old.allowed('bob')!.size).toBeGreaterThanOrEqual(young.allowed('bob')!.size);
    expect(none.allowed('bob')!.size).toBe(0);
  });
});
