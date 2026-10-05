import { describe, expect, it, vi } from 'vitest';
import { decodeLoadout, encodeLoadout } from '../../src/economy/catalog';
import { createRemoteVerifier, parsePresencePaint, type RemoteWalletRow } from '../../src/economy/remote-verify';
import { GAMEPLAY_DAILY_CAP } from '../../src/economy/gameplay';
import { MAX_WALLET_JSON } from '../../src/economy/wallet';

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86_400_000;
const tip = (id: string, author: string, credits: number) => ({ comment: { id, author: { id: `id-${author}`, username: author }, card_data: { type: 'tip_comment', credits_spent: credits } } });
const page = (rows: unknown[]) => ({ comments: { data: rows, meta: { has_next_page: false, end_cursor: null } } });
const wallet = (owned: string[]) => JSON.stringify({ version: 1, owned });
const row = (username: string, owned: string[], ageDays: number | null = 0, w?: string): RemoteWalletRow => ({
  username, w: w ?? wallet(owned), ...(ageDays === null ? {} : { created_at: new Date(NOW - ageDays * DAY).toISOString() }),
});

function setup(opts: { tips?: unknown[]; rows?: RemoteWalletRow[]; fail?: () => boolean; now?: () => number; minFetchGapMs?: number } = {}) {
  const state = { rows: opts.rows ?? [], tips: opts.tips ?? [] };
  const fetchJson = vi.fn(async () => { if (opts.fail?.()) throw new Error('503'); return page(state.tips); });
  const verifier = createRemoteVerifier({ fetchJson, projectId: () => 'proj', wallets: () => state.rows, now: opts.now ?? (() => NOW), minFetchGapMs: opts.minFetchGapMs, missionAllowance: () => 0, welcomeAllowance: 0 });
  return { verifier, fetchJson, state };
}
const paint = (items: Record<string, string>) => encodeLoadout(items);

describe('remote cosmetics verification', () => {
  it('shows stock looks without any network call', () => {
    const { verifier, fetchJson } = setup();
    const look = verifier.look('bob', 'CAR-01', paint({ paint: 'harbor-slate', wheelStyle: 'forged' }));
    expect(look.car).toBe('CAR-01');
    expect(decodeLoadout(look.paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged' });
    expect(verifier.look('bob', 'CAR-01', 'harbor-slate').paint).toBe(look.paint);
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it('fails closed until the tip index has loaded, then shows items the verified budget can pay for', async () => {
    const { verifier, fetchJson } = setup({ tips: [tip('t1', 'bob', 1000)], rows: [row('bob', ['rim-bronze', 'horn-twotone'])] });
    const wanted = paint({ paint: 'harbor-slate', rim: 'rim-bronze', horn: 'horn-twotone' });
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wanted).paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged' });
    const changed = vi.fn();
    verifier.subscribe(changed);
    await verifier.refresh();
    expect(changed).toHaveBeenCalled();
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wanted).paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged', rim: 'rim-bronze', horn: 'horn-twotone' });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it('hides items a forged wallet claims without tips, but allows what the daily allowance could have bought', async () => {
    const { verifier } = setup({ rows: [row('cheat', ['gold-chrome', 'car-cybertruck', 'rim-gold', 'horn-twotone'], 0)], tips: [tip('t', 'someone-else', 99999)] });
    await verifier.refresh();
    const look = verifier.look('cheat', 'CAR-02', paint({ paint: 'gold-chrome', rim: 'rim-gold', horn: 'horn-twotone' }));
    expect(look.car).toBe('CAR-01');
    expect(decodeLoadout(look.paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged' });
    expect(verifier.allowed('cheat')!.size).toBe(0);
  });
  it('uses the purchase list order: the first items that fit are shown, the rest are not', async () => {
    const { verifier } = setup({ rows: [row('bob', ['rim-gold', 'gold-chrome', 'horn-twotone'])], tips: [tip('a', 'bob', 1000)] });
    await verifier.refresh();
    // 1250 tip Marks plus one day of driving (25): rim-gold 950 fits, gold-chrome 2490 does not, and nothing after it counts.
    expect([...verifier.allowed('bob')!]).toEqual(['rim-gold']);
  });
  it('counts only that user\'s tips, case-insensitively, and ignores other users\' tips', async () => {
    const { verifier } = setup({ rows: [row('Bob', ['rim-gold'])], tips: [tip('a', 'bob', 1000), tip('b', 'alice', 5000), tip('a', 'bob', 1000)] });
    await verifier.refresh();
    expect(verifier.allowed('BOB')!.has('rim-gold')).toBe(true);
    expect(verifier.allowed('alice')!.size).toBe(0);
  });
  it('allowance grows with the server-set age of the wallet row; a missing or future created_at gets one day', async () => {
    const { verifier } = setup({ tips: [], rows: [
      row('old', ['rim-gold'], 60), row('nodate', ['rim-gold'], null), row('future', ['rim-gold'], -400), row('young', ['horn-twotone'], 8),
    ] });
    await verifier.refresh();
    expect(verifier.allowed('old')!.has('rim-gold')).toBe(true); // 61 days x 25 = 1525 >= 950
    expect(verifier.allowed('nodate')!.has('rim-gold')).toBe(false);
    expect(verifier.allowed('future')!.has('rim-gold')).toBe(false);
    expect(verifier.allowed('young')!.has('horn-twotone')).toBe(true); // 9 x 25 = 225 >= 190
    expect(GAMEPLAY_DAILY_CAP * 9).toBeGreaterThanOrEqual(190);
  });
  it('shows an owned car only when it was paid for and otherwise the starter car', async () => {
    const { verifier } = setup({ rows: [row('rich', ['car-cybertruck']), row('poor', ['car-cybertruck'])], tips: [tip('a', 'rich', 2500), tip('b', 'rich', 2500), tip('c', 'rich', 500)] });
    await verifier.refresh();
    // rich: 3550 + 3550 + 590 = 7690 Marks.
    expect(verifier.look('rich', 'CAR-02', paint({})).car).toBe('CAR-02');
    expect(verifier.look('poor', 'CAR-02', paint({})).car).toBe('CAR-01');
    expect(verifier.look('stranger', 'CAR-02', paint({})).car).toBe('CAR-01');
    expect(verifier.look('rich', 'CAR-99' as never, paint({})).car).toBe('CAR-01');
  });
  it('rate limits the tip index: one fetch for a crowd, a retry only after the gap, and a refresh only after it is stale', async () => {
    let t = NOW, failing = true;
    const { verifier, fetchJson } = setup({ rows: [row('bob', ['rim-gold'])], tips: [tip('a', 'bob', 2000)], fail: () => failing, now: () => t, minFetchGapMs: 45_000 });
    const wanted = paint({ rim: 'rim-gold' });
    for (let i = 0; i < 200; i++) verifier.look('bob', 'CAR-01', wanted);
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 200; i++) verifier.look('bob', 'CAR-01', wanted);
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wanted).paint)?.rim).toBeUndefined();
    t += 46_000; failing = false;
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wanted).paint)?.rim).toBe('rim-gold');
    t += 60_000;
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    t += 6 * 60_000;
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });
  it('ignores junk: unknown ids, wrong slots, oversized wallet JSON and hostile names', async () => {
    const { verifier } = setup({ rows: [row('bob', [], 0, 'x'.repeat(MAX_WALLET_JSON + 1)), row('eve', [], 0, '{"owned":"nope"}')], tips: [tip('a', 'bob', 5000)] });
    await verifier.refresh();
    expect(verifier.allowed('bob')!.size).toBe(0);
    expect(parsePresencePaint('~rim-gold.harbor-slate.<script>')).toEqual({});
    expect(parsePresencePaint('rim-gold')).toEqual({});
    expect(parsePresencePaint(`~${'a'.repeat(500)}`)).toEqual({});
    expect(parsePresencePaint({ evil: 1 })).toEqual({});
    expect(parsePresencePaint('carbon')).toEqual({ paint: 'carbon' });
    const look = verifier.look('x'.repeat(500), 'CAR-01', paint({ paint: 'gold-chrome' }));
    expect(decodeLoadout(look.paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged' });
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', 'carbon').paint)?.paint).toBe('harbor-slate');
    expect(verifier.look(undefined as never, 'CAR-01', 'carbon').paint).toBeTruthy();
  });
  it('re-evaluates when the wallet collection changes (invalidate) and merges duplicate rows without exceeding the budget', async () => {
    const { verifier, state } = setup({ tips: [tip('a', 'bob', 1000)], rows: [row('bob', ['rim-bronze'], 0), row('bob', ['gold-chrome', 'rim-gold'], 0)] });
    await verifier.refresh();
    expect([...verifier.allowed('bob')!]).toEqual(['rim-bronze']);
    const changed = vi.fn();
    verifier.subscribe(changed);
    state.rows = [row('bob', ['rim-bronze', 'horn-twotone'], 0)];
    verifier.invalidate();
    expect(changed).toHaveBeenCalled();
    expect([...verifier.allowed('bob')!].sort()).toEqual(['horn-twotone', 'rim-bronze']);
  });
  it('does nothing without a project id and after dispose', async () => {
    const fetchJson = vi.fn(async () => page([]));
    const verifier = createRemoteVerifier({ fetchJson, projectId: () => null, wallets: () => [], now: () => NOW });
    await verifier.refresh();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(decodeLoadout(verifier.look('bob', 'CAR-02', paint({ paint: 'gold-chrome' })).paint)).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged' });
    verifier.dispose();
    await verifier.refresh();
  });
});
