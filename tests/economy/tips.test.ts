import { describe, expect, it, vi } from 'vitest';
import { createTipSource, fetchTipLedger, marksForTipCredits, roundUpToPriceEnding, parseTipComment, tipsUrl, TIP_PACKS } from '../../src/economy/tips';
import type { WebsimHost } from '../../src/economy/websim-host';

const ME = 'user-me';
const PROJECT = 'proj-1';

function tip(id: string, author: string, credits: number, extra: Record<string, unknown> = {}) {
  return { comment: { id, author: { id: author, username: author }, created_at: '2026-10-01T00:00:00Z', card_data: { type: 'tip_comment', credits_spent: credits, ...extra } }, cursor: `c-${id}` };
}
function page(rows: unknown[], next: string | null) {
  return { comments: { data: rows, meta: { has_next_page: next !== null, end_cursor: next } } };
}
/** Fake comments API keyed by the `after` cursor. */
function api(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchJson = vi.fn(async (url: string) => {
    calls.push(url);
    const after = new URL(url, 'https://x.test').searchParams.get('after') ?? '';
    const body = pages[after];
    if (!body) throw new Error(`no page for ${after}`);
    return body;
  });
  return { fetchJson, calls };
}

describe('tip parsing', () => {
  it('accepts only tip comments by the current user', () => {
    expect(parseTipComment(tip('a', ME, 50), ME)).toEqual({ id: 'a', credits: 50, createdAt: '2026-10-01T00:00:00Z' });
    expect(parseTipComment(tip('b', 'someone-else', 50), ME)).toBeNull();
    expect(parseTipComment({ comment: { id: 'c', author: { id: ME }, card_data: { type: 'project_post' } } }, ME)).toBeNull();
    expect(parseTipComment({ comment: { id: 'd', author: { id: ME }, card_data: null } }, ME)).toBeNull();
    expect(parseTipComment(tip('e', ME, -5), ME)).toBeNull();
    expect(parseTipComment(tip('f', ME, Number.NaN), ME)).toBeNull();
    expect(parseTipComment(null, ME)).toBeNull();
  });
  it('falls back to tip_amount and accepts a bare comment', () => {
    const bare = { id: 'g', author: { id: ME }, card_data: { type: 'tip_comment', tip_amount: 25 } };
    expect(parseTipComment(bare, ME)?.credits).toBe(25);
    expect(parseTipComment(tip('h', ME, 100, { tip_amount: 50 }), ME)?.credits).toBe(100);
  });
  it('builds the verified query', () => {
    const url = new URL(tipsUrl(PROJECT, ME, 'cur'), 'https://x.test');
    expect(url.pathname).toBe('/api/v1/projects/proj-1/comments');
    expect(Object.fromEntries(url.searchParams)).toEqual({ first: '100', sort_by: 'created_at', only_tips: 'true', author_id: ME, after: 'cur' });
  });
  it('pays a bonus on big single tips', () => {
    expect(marksForTipCredits(200)).toBe(200);
    expect(marksForTipCredits(500)).toBe(590);
    expect(marksForTipCredits(1000)).toBe(1250);
    expect(marksForTipCredits(2500)).toBe(3550);
    expect(roundUpToPriceEnding(591)).toBe(650);
    expect(roundUpToPriceEnding(690)).toBe(690);
    expect(marksForTipCredits(0)).toBe(0);
    expect(TIP_PACKS.map(pack => pack.credits)).toEqual([200, 350, 500, 750, 1000, 1500, 2500, 5000, 10000, 25000]);
    expect(TIP_PACKS.map(pack => marksForTipCredits(pack.credits))).toEqual([200, 390, 590, 950, 1250, 1950, 3550, 8050, 18050, 50050]);
    for (const pack of TIP_PACKS.filter(entry => entry.sale)) {
      const save = Math.round((1 - pack.credits / marksForTipCredits(pack.credits)) * 100);
      expect(pack.badge).toContain(`save ${save}%`);
    }
  });
});

describe('tip ledger', () => {
  it('walks every page, ignores other users and dedupes by comment id', async () => {
    const { fetchJson, calls } = api({
      '': page([tip('t1', ME, 10), tip('x1', 'other', 250), tip('t2', ME, 50)], 'p2'),
      p2: page([tip('t2', ME, 50), { comment: { id: 'n1', author: { id: ME }, card_data: { type: 'poll' } } }, tip('t3', ME, 100)], 'p3'),
      p3: page([tip('t3', ME, 100), tip('x2', 'other', 10)], null),
    });
    const ledger = await fetchTipLedger(fetchJson, PROJECT, ME);
    expect(calls).toHaveLength(3);
    expect(ledger.tips.map(entry => entry.id)).toEqual(['t1', 't2', 't3']);
    expect(ledger.credits).toBe(160);
    expect(ledger.marks).toBe(10 + 50 + 100);
    expect(ledger.complete).toBe(true);
  });
  it('marks the ledger incomplete at the page cap and stops on a repeated cursor', async () => {
    const capped = api({ '': page([tip('a', ME, 10)], 'p2'), p2: page([tip('b', ME, 10)], 'p3') });
    const partial = await fetchTipLedger(capped.fetchJson, PROJECT, ME, 2);
    expect(partial.complete).toBe(false);
    expect(partial.marks).toBe(20);
    const loop = api({ '': page([tip('a', ME, 10)], 'p2'), p2: page([tip('b', ME, 10)], 'p2') });
    const looped = await fetchTipLedger(loop.fetchJson, PROJECT, ME);
    expect(loop.calls).toHaveLength(2);
    expect(looped.complete).toBe(true);
  });
  it('returns an incomplete, failed ledger on a malformed response so the caller keeps its last total', async () => {
    expect(await fetchTipLedger(async () => ({ error: 'nope' }), PROJECT, ME)).toMatchObject({ complete: false, failed: true, marks: 0 });
  });
});

function host(overrides: Partial<WebsimHost> = {}): WebsimHost & { fire(data: unknown): void } {
  let listener: ((data: unknown) => void) | null = null;
  return {
    getCurrentUser: async () => ({ id: ME, username: 'me' }),
    getCurrentProject: async () => ({ id: PROJECT }),
    postComment: vi.fn(async () => ({})),
    addEventListener: (_type, cb) => { listener = cb; return () => { listener = null; }; },
    fire(data) { listener?.(data); },
    ...overrides,
  };
}

describe('tip source', () => {
  it('derives its total from the API and refreshes on the player\'s own comment event only', async () => {
    let rows = [tip('t1', ME, 10)];
    const fetchJson = vi.fn(async () => page(rows, null));
    const fake = host();
    const source = createTipSource({ host: fake, fetchJson, schedule: () => 0 });
    await source.refresh!();
    expect(source.available()).toBe(true);
    expect(source.total!()).toBe(10);
    const changed = vi.fn();
    source.subscribe(changed);
    rows = [tip('t1', ME, 10), tip('t2', ME, 50)];
    fake.fire({ comment: { author: { id: 'other' } } });
    await Promise.resolve();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    fake.fire({ comment: { author: { id: ME }, card_data: { type: 'tip_comment', credits_spent: 999999 } } });
    await vi.waitFor(() => expect(source.total!()).toBe(60));
    expect(changed).toHaveBeenCalled();
    source.dispose();
  });
  it('opens the websim tip composer and never credits on its own', async () => {
    const fake = host();
    const source = createTipSource({ host: fake, fetchJson: async () => page([], null), schedule: () => 0 });
    await source.refresh!();
    const result = await source.redeem!('tip-500');
    expect(result.status).toBe('pending');
    expect(fake.postComment).toHaveBeenCalledWith(expect.objectContaining({ credits: 500 }));
    expect(source.total!()).toBe(0);
    const failing = createTipSource({ host: host({ postComment: async () => ({ error: 'User has not interacted with the page' }) }), fetchJson: async () => page([], null), schedule: () => 0 });
    // A websim error is not a dead end: the tip flow gives the manual steps (see tip-flow.test.ts), and still credits nothing.
    expect((await failing.redeem!('tip-200')).status).toBe('pending');
    expect(failing.total!()).toBe(0);
    expect((await failing.redeem!('nope')).status).toBe('failed');
  });
  it('is unavailable when signed out but its offers stay clickable (websim opens its own sign in)', async () => {
    const source = createTipSource({ host: host({ getCurrentUser: async () => null }), fetchJson: async () => page([], null), schedule: () => 0 });
    await source.refresh!();
    expect(source.available()).toBe(false);
    expect(source.offers!()[0]!.unavailable).toBeNull();
  });
  it('keeps the last total when a refresh fails', async () => {
    let fail = false;
    const source = createTipSource({ host: host(), fetchJson: async () => { if (fail) throw new Error('down'); return page([tip('t1', ME, 10)], null); }, schedule: () => 0 });
    await source.refresh!();
    fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await source.refresh!();
    warn.mockRestore();
    expect(source.total!()).toBe(10);
  });
});
