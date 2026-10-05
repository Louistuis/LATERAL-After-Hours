import { describe, expect, it } from 'vitest';
import { applyGrant, applyPurchase, emptyWallet } from '../../src/economy/wallet';
import { ALL_AVAILABLE, claimKeyOf, dailyFor, weeklyFor, missionById } from '../../src/economy/mission-catalog';
import { dayIdOf, weekIdOf } from '../../src/economy/mission-progress';
import type { WalletRecord } from '../../src/economy/types';
import { applyGift, applyTestGrant, dayCandidates, validateTransition, weekCandidates, type Accepted, type Reject, type RulesContext } from '../../server/wallet-rules';
import { T0 } from './helpers';

const LAUNCH = Date.UTC(2026, 9, 4);
const ctx = (over: Partial<RulesContext> = {}): RulesContext => ({ now: T0, mode: 'steady', launchAt: LAUNCH, serverCreatedAt: T0 - 3600_000, hourlyEarned: 0, hourlyLimit: 600, ...over });
const ok = (r: Reject | Accepted): Accepted => { if (!r.ok) throw new Error(`rejected: ${r.reason} ${r.detail ?? ''}`); return r; };
const reason = (r: Reject | Accepted): string => (r.ok ? 'accepted' : r.reason);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const welcome = (r: WalletRecord, now = T0): WalletRecord => applyGrant(r, { source: 'welcome', key: 'gift', amount: 1500, reason: 'Starter gift', permanent: true }, undefined, now, { maxGrant: 1500, ceiling: 1500 }).record;
const mission = (r: WalletRecord, key: string, amount: number, now = T0): WalletRecord => applyGrant(r, { source: 'missions', key, amount, reason: 'm', permanent: true }, undefined, now, { maxGrant: 250 }).record;
const daily = (r: WalletRecord, key: string, amount: number, now = T0): WalletRecord => applyGrant(r, { source: 'daily', key, amount, reason: 'd' }, 80, now, { maxGrant: 30 }).record;
const buy = (r: WalletRecord, id: string, now = T0): WalletRecord => { const out = applyPurchase(r, id, 1e9, now); if (!out.ok) throw new Error(out.message); return out.record; };

/** An accepted starting wallet with the welcome gift opened. */
const base = (): WalletRecord => ok(validateTransition(null, welcome(emptyWallet(T0 - 3600_000), T0 - 3600_000), ctx({ mode: 'import' }))).record;
const today = dayIdOf(T0);
const dailyMission = dailyFor(today, ALL_AVAILABLE)[0]!;
const weeklyMission = weeklyFor(weekIdOf(T0), ALL_AVAILABLE)[0]!;

describe('wallet rules: accepted transitions', () => {
  it('accepts a fresh empty wallet and the opened starter gift', () => {
    ok(validateTransition(null, emptyWallet(T0), ctx({ mode: 'import' })));
    const r = ok(validateTransition(null, welcome(emptyWallet(T0)), ctx({ mode: 'import' })));
    expect(r.record.earned.welcome).toBe(1500);
    expect(r.ledger[0]).toMatchObject({ kind: 'earn:welcome', amount: 1500 });
  });
  it('accepts a career mission claim with the catalog reward', () => {
    const next = mission(base(), 'c:first-finish', 50);
    const r = ok(validateTransition(base(), next, ctx()));
    expect(r.ledger).toEqual([{ kind: 'earn:missions', amount: 50, ref: 'missions:c:first-finish' }]);
  });
  it('accepts several claims in one write (a debounced client)', () => {
    let next = mission(base(), 'c:first-finish', 50);
    next = mission(next, 'c:five-events', 75);
    next = mission(next, claimKeyOf(dailyMission, T0), dailyMission.reward);
    next = mission(next, claimKeyOf(weeklyMission, T0), weeklyMission.reward);
    const r = ok(validateTransition(base(), next, ctx()));
    expect(r.ledger[0]!.amount).toBe(50 + 75 + dailyMission.reward + weeklyMission.reward);
  });
  it('accepts a daily challenge payout up to 80 Marks in a day', () => {
    let next = base();
    for (const [tier, marks] of [['finish', 30], ['bronze', 15], ['silver', 15], ['gold', 20]] as const) next = daily(next, `${today}:${tier}`, marks);
    expect(ok(validateTransition(base(), next, ctx())).ledger[0]).toMatchObject({ kind: 'earn:daily', amount: 80 });
  });
  it('accepts a purchase paid from the balance and writes a spend ledger row', () => {
    const next = buy(base(), 'oxide-copper');
    const r = ok(validateTransition(base(), next, ctx()));
    expect(r.ledger).toEqual([{ kind: 'spend:oxide-copper', amount: -190, ref: '' }]);
  });
  it('accepts equipping owned and stock items and the custom plate text', () => {
    let next = buy(base(), 'oxide-copper');
    next = { ...next, equipped: { paint: 'oxide-copper', horn: 'horn-stock' }, updatedAt: T0 + 1 };
    ok(validateTransition(buy(base(), 'oxide-copper'), next, ctx()));
  });
  it('treats a timestamp-only change as unchanged', () => {
    const r = ok(validateTransition(base(), { ...base(), updatedAt: base().updatedAt + 5 }, ctx()));
    expect(r.unchanged).toBe(true);
  });
  it('accepts the previous day for ten minutes after midnight and not later', () => {
    const midnight = Date.UTC(2026, 9, 6, 0, 5, 0);
    const yesterday = dayIdOf(midnight - 86_400_000);
    const key = `${yesterday}:finish`;
    const prev = base();
    const next = daily(prev, key, 30, midnight - 60_000);
    expect(reason(validateTransition(prev, next, ctx({ now: midnight })))).toBe('accepted');
    expect(reason(validateTransition(prev, next, ctx({ now: midnight + 11 * 60_000 })))).toBe('daily-invalid');
    expect(dayCandidates(midnight)).toHaveLength(2);
    expect(dayCandidates(midnight + 11 * 60_000)).toHaveLength(1);
    expect(weekCandidates(Date.UTC(2026, 9, 5, 0, 3))).toHaveLength(2);
  });
});

describe('wallet rules: rejections', () => {
  it('rejects non objects, oversize and unknown keys', () => {
    expect(reason(validateTransition(base(), 'x', ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(base(), null, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(base(), { ...base(), junk: 'x'.repeat(40_000) }, ctx()))).toBe('too-large');
    expect(reason(validateTransition(base(), { ...base(), extra: 1 }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(base(), { ...base(), version: 2 }, ctx()))).toBe('bad-shape');
  });
  it('rejects non canonical records instead of repairing them', () => {
    const next = clone(base()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    next.equipped = { paint: 'harbor-slate', bogus: 'x' };
    expect(reason(validateTransition(base(), next, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(base(), { ...base(), receipts: [1] }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(base(), { ...base(), updatedAt: T0 + 3_600_000 }, ctx()))).toBe('bad-shape');
  });
  it('rejects unknown, stock and duplicate owned items and bad owned arrays', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, owned: ['made-up'] }, ctx()))).toBe('unknown-item');
    expect(reason(validateTransition(b, { ...b, owned: ['harbor-slate'] }, ctx()))).toBe('unknown-item');
    expect(reason(validateTransition(b, { ...b, owned: ['oxide-copper', 'oxide-copper'], spent: 380 }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, owned: 'x' }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, owned: [5] }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, owned: Array.from({ length: 600 }, (_, i) => `i${i}`) }, ctx()))).toBe('bad-shape');
  });
  it('rejects a wrong spent total (cheaper than the items, or more)', () => {
    const next = buy(base(), 'oxide-copper');
    expect(reason(validateTransition(base(), { ...next, spent: 0 }, ctx()))).toBe('spent-mismatch');
    expect(reason(validateTransition(base(), { ...next, spent: 999 }, ctx()))).toBe('spent-mismatch');
  });
  it('rejects removing owned items', () => {
    const owned = ok(validateTransition(base(), buy(base(), 'oxide-copper'), ctx())).record;
    expect(reason(validateTransition(owned, { ...owned, owned: [], spent: 0 }, ctx()))).toBe('owned-removed');
  });
  it('rejects a purchase that would make the balance negative', () => {
    const next = buy(base(), 'car-f1'); // 7990 > 1500
    expect(reason(validateTransition(base(), next, ctx()))).toBe('negative-balance');
  });
  it('rejects unknown earn sources, decreases and fractions', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, gameplay: 5 } }, ctx()))).toBe('earned-source-unknown');
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, tips: 0 } }, ctx()))).toBe('earned-source-unknown');
    expect(reason(validateTransition(b, { ...b, earned: { welcome: -1 } }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, earned: { welcome: 1.5 } }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, earned: { welcome: 0 } }, ctx()))).toBe('earned-decreased');
  });
  it('rejects client writes to the server-only sources', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, gift: 1000 } }, ctx()))).toBe('server-only-source');
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, testgrant: 20000 } }, ctx()))).toBe('server-only-source');
    expect(reason(validateTransition(b, { ...b, receipts: [...b.receipts, 'gift:abc'] }, ctx()))).toBe('server-only-source');
    expect(reason(validateTransition(b, { ...b, claims: [...(b.claims ?? []), 'testgrant:test:grant'], receipts: [...b.receipts, 'testgrant:test:grant'] }, ctx()))).toBe('server-only-source');
  });
  it('rejects a changed gift total even by one', () => {
    const credited = applyGift(base(), { id: 'g1', marks: 500, items: [] }, T0).record;
    expect(reason(validateTransition(credited, { ...credited, earned: { ...credited.earned, gift: 499 } }, ctx()))).toBe('server-only-source');
  });
  it('rejects a wrong welcome gift', () => {
    const e = emptyWallet(T0 - 1000);
    const claimed = welcome(e);
    expect(reason(validateTransition(e, { ...claimed, earned: { welcome: 1501 } }, ctx()))).toBe('welcome-invalid');
    expect(reason(validateTransition(e, { ...e, earned: { welcome: 1500 } }, ctx()))).toBe('welcome-invalid');
    const noMarks = { ...claimed, earned: {} };
    expect(reason(validateTransition(e, noMarks, ctx()))).toBe('welcome-invalid');
    const again = { ...base(), earned: { welcome: 3000 }, claims: base().claims, receipts: base().receipts };
    expect(reason(validateTransition(base(), again, ctx()))).toBe('welcome-invalid');
  });
  it('rejects mission claims that are not in the catalog or the period', () => {
    const b = base();
    expect(reason(validateTransition(b, mission(b, 'c:nope', 50), ctx()))).toBe('mission-claim-invalid');
    expect(reason(validateTransition(b, mission(b, 'x:what', 50), ctx()))).toBe('mission-claim-invalid');
    expect(reason(validateTransition(b, { ...b, receipts: [...b.receipts, 'hack:1'] }, ctx()))).toBe('receipts-invalid');
    const old = dayIdOf(T0 - 5 * 86_400_000);
    expect(reason(validateTransition(b, mission(b, `d:${old}:${dailyMission.id}`, 25), ctx()))).toBe('mission-claim-invalid');
    expect(reason(validateTransition(b, mission(b, `w:${weekIdOf(T0) - 2}:${weeklyMission.id}`, 100), ctx()))).toBe('mission-claim-invalid');
    expect(reason(validateTransition(b, mission(b, `d:2026-13-45:${dailyMission.id}`, 25), ctx()))).toBe('mission-claim-invalid');
  });
  it('rejects a daily mission that is not in today\'s rotation', () => {
    const b = base();
    const picked = dailyFor(today, ALL_AVAILABLE).map(m => m.id);
    const other = ['d-warm-up', 'd-hat-trick', 'd-mile', 'd-long-haul', 'd-slide', 'd-chain', 'd-score', 'd-clean', 'd-speed', 'd-assists-off', 'd-recover'].find(id => !picked.includes(id))!;
    expect(reason(validateTransition(b, mission(b, `d:${today}:${other}`, missionById(other)!.reward), ctx()))).toBe('mission-claim-invalid');
  });
  it('rejects a mission paid more than the catalog says, or less', () => {
    const b = base();
    expect(reason(validateTransition(b, mission(b, 'c:first-finish', 250), ctx()))).toBe('mission-reward-mismatch');
    const inflated = mission(b, 'c:first-finish', 50);
    expect(reason(validateTransition(b, { ...inflated, earned: { ...inflated.earned, missions: 51 } }, ctx()))).toBe('mission-reward-mismatch');
    expect(reason(validateTransition(b, { ...inflated, earned: { ...inflated.earned, missions: 49 } }, ctx()))).toBe('mission-reward-mismatch');
  });
  it('rejects marks with no claim, and a claim whose key is not permanent', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, missions: 50 } }, ctx()))).toBe('mission-reward-mismatch');
    const soft = applyGrant(b, { source: 'missions', key: 'c:first-finish', amount: 50, reason: 'm' }, undefined, T0, { maxGrant: 250 }).record;
    expect(reason(validateTransition(b, soft, ctx()))).toBe('mission-claim-invalid');
  });
  it('rejects claiming the same mission twice', () => {
    const once = ok(validateTransition(base(), mission(base(), 'c:first-finish', 50), ctx())).record;
    const twice = { ...once, earned: { ...once.earned, missions: 100 }, updatedAt: T0 + 1 };
    expect(reason(validateTransition(once, twice, ctx()))).toBe('mission-reward-mismatch');
  });
  it('rejects removing live claims so a mission can be claimed again', () => {
    const once = ok(validateTransition(base(), mission(base(), claimKeyOf(dailyMission, T0), dailyMission.reward), ctx())).record;
    const wiped = { ...once, claims: (once.claims ?? []).filter(k => !k.startsWith('missions:d:')), receipts: once.receipts.filter(k => !k.startsWith('missions:d:')) };
    expect(reason(validateTransition(once, wiped, ctx()))).toBe('claims-removed');
    const career = ok(validateTransition(base(), mission(base(), 'c:first-finish', 50), ctx())).record;
    const lost = { ...career, claims: ['welcome:gift'], receipts: ['welcome:gift'] };
    expect(reason(validateTransition(career, lost, ctx()))).toBe('claims-removed');
  });
  it('rejects too many daily or weekly mission claims in one period', () => {
    const picked = dailyFor(today, ALL_AVAILABLE);
    const extra = ['d-warm-up', 'd-hat-trick', 'd-mile', 'd-long-haul', 'd-slide', 'd-chain', 'd-score', 'd-clean', 'd-speed', 'd-assists-off', 'd-recover'].find(id => !picked.some(p => p.id === id))!;
    // A fourth key in the same day is outside the rotation set or over the slot count; either way it must not pass.
    let next = base();
    for (const m of picked) next = mission(next, claimKeyOf(m, T0), m.reward);
    next = mission(next, `d:${today}:${extra}`, missionById(extra)!.reward);
    expect(reason(validateTransition(base(), next, ctx()))).toBe('mission-claim-invalid');
  });
  it('rejects bad daily challenge claims', () => {
    const b = base();
    expect(reason(validateTransition(b, daily(b, `${today}:platinum`, 50), ctx()))).toBe('daily-invalid');
    expect(reason(validateTransition(b, daily(b, `${dayIdOf(T0 - 86_400_000 * 3)}:finish`, 30), ctx()))).toBe('daily-invalid');
    const tampered = daily(b, `${today}:finish`, 30);
    expect(reason(validateTransition(b, { ...tampered, earned: { ...tampered.earned, daily: 31 } }, ctx()))).toBe('daily-invalid');
    expect(reason(validateTransition(b, { ...b, earned: { ...b.earned, daily: 15 } }, ctx()))).toBe('daily-invalid');
  });
  it('rejects a daily tally that disagrees with what was earned', () => {
    const next = mission(base(), 'c:first-finish', 50);
    expect(reason(validateTransition(base(), { ...next, daily: { ...next.daily, missions: { day: today, amount: 9999 } } }, ctx()))).toBe('daily-invalid');
  });
  it('rejects more than 600 Marks from missions and daily in one hour and flags it', () => {
    let next = base();
    for (const id of ['c:fifty-events', 'c:chain-12000', 'c:drift-15s']) next = mission(next, id, missionByKey(id));
    expect(reason(validateTransition(base(), next, ctx({ hourlyEarned: 0 })))).toBe('rate-hour'); // 750 in one write is over 600
  });
  it('enforces the hourly limit using what the ledger already holds', () => {
    const next = mission(base(), 'c:fifty-events', 250);
    expect(reason(validateTransition(base(), next, ctx({ hourlyEarned: 400 })))).toBe('rate-hour');
    const v = validateTransition(base(), next, ctx({ hourlyEarned: 400 }));
    expect(v.ok === false && v.flag).toBe(true);
    expect(reason(validateTransition(base(), next, ctx({ hourlyEarned: 300 })))).toBe('accepted');
  });
  it('does not count gifts, the welcome gift or the test grant toward the hourly limit', () => {
    const credited = applyTestGrant(applyGift(base(), { id: 'g', marks: 5000, items: [] }, T0).record, 20000, T0).record;
    const next = mission(credited, 'c:first-finish', 50);
    expect(reason(validateTransition(credited, next, ctx()))).toBe('accepted');
  });
  it('rejects equipping what is not owned, in the wrong slot, or a bad plate', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, equipped: { paint: 'gold-chrome' } }, ctx()))).toBe('equipped-not-owned');
    expect(reason(validateTransition(b, { ...b, equipped: { horn: 'oxide-copper' } }, ctx()))).toBe('bad-shape');
    expect(reason(validateTransition(b, { ...b, equipped: { plateText: 'HELLO' } }, ctx()))).toBe('equipped-not-owned');
  });
  it('rejects a changed or backdated createdAt', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, createdAt: LAUNCH }, ctx()))).toBe('created-at-invalid');
    expect(reason(validateTransition(null, { ...emptyWallet(T0), createdAt: LAUNCH - 86_400_000 }, ctx({ mode: 'import' })))).toBe('created-at-invalid');
    expect(reason(validateTransition(null, { ...emptyWallet(T0), createdAt: T0 + 86_400_000 }, ctx({ mode: 'import' })))).toBe('created-at-invalid');
    const { createdAt: _drop, ...without } = b;
    expect(reason(validateTransition(b, without, ctx()))).toBe('created-at-invalid');
  });
  it('rejects duplicate receipts', () => {
    const b = base();
    expect(reason(validateTransition(b, { ...b, receipts: [...b.receipts, b.receipts[0]!] }, ctx()))).toBe('receipts-invalid');
  });
});

function missionByKey(key: string): number {
  const id = key.split(':')[1]!;
  return missionById(id)!.reward;
}

describe('wallet rules: importing local progress', () => {
  it('accepts a plausible local wallet and bounds an implausible one', () => {
    let local = emptyWallet(T0 - 20 * 3_600_000);
    local = welcome(local, T0 - 20 * 3_600_000);
    local = mission(local, 'c:first-finish', 50, T0 - 10 * 3_600_000);
    local = buy(local, 'oxide-copper');
    ok(validateTransition(null, local, ctx({ mode: 'import' })));
    const greedy = { ...local, earned: { ...local.earned, missions: 5_000_000 } };
    expect(reason(validateTransition(null, greedy, ctx({ mode: 'import' })))).toBe('mission-claim-invalid');
    const greedyDaily = { ...local, earned: { ...local.earned, daily: 50_000 } };
    expect(reason(validateTransition(null, greedyDaily, ctx({ mode: 'import' })))).toBe('daily-invalid');
  });
  it('still refuses server-only sources and unknown keys on import', () => {
    const local = { ...welcome(emptyWallet(T0)), earned: { welcome: 1500, gift: 100 } };
    expect(reason(validateTransition(null, local, ctx({ mode: 'import' })))).toBe('server-only-source');
    expect(reason(validateTransition(null, { ...emptyWallet(T0), receipts: ['hack:1'] }, ctx({ mode: 'import' })))).toBe('receipts-invalid');
  });
  it('accepts an import over a wallet that only holds server credits', () => {
    const server = applyGift(emptyWallet(T0), { id: 'g1', marks: 300, items: ['oxide-copper'] }, T0).record;
    const merged = welcome(server);
    ok(validateTransition(server, merged, ctx({ mode: 'import' })));
  });
});

describe('server credits', () => {
  it('a gifted item leaves the balance unchanged and skips items already owned', () => {
    let r = base();
    r = buy(r, 'oxide-copper');
    const out = applyGift(r, { id: 'g9', marks: 100, items: ['oxide-copper', 'salt-white', 'salt-white', 'harbor-slate', 'nope'] }, T0);
    expect(out.gained).toEqual(['salt-white']);
    expect(out.skipped).toEqual(['oxide-copper', 'salt-white', 'harbor-slate', 'nope']);
    const balance = (x: WalletRecord): number => Object.values(x.earned).reduce((a, b) => a + b, 0) - x.spent;
    expect(balance(out.record)).toBe(balance(r) + 100);
    expect(out.record.receipts).toContain('gift:g9');
    expect(out.ledger.map(l => l.amount)).toEqual([100, 190]);
  });
  it('a client write after a gift is judged against the credited record', () => {
    const credited = applyGift(base(), { id: 'g1', marks: 500, items: [] }, T0).record;
    ok(validateTransition(credited, buy(credited, 'oxide-copper'), ctx()));
    expect(reason(validateTransition(credited, base(), ctx()))).toBe('server-only-source');
  });
  it('test grant adds the claim and the earnings', () => {
    const out = applyTestGrant(base(), 20000, T0);
    expect(out.record.earned.testgrant).toBe(20000);
    expect(out.record.claims).toContain('testgrant:test:grant');
    ok(validateTransition(out.record, buy(out.record, 'car-f1'), ctx()));
  });
});
