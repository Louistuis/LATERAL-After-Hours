import { describe, expect, it, vi } from 'vitest';
import { createTipSource, fetchTipIndex, fetchTipLedger, marksForTipCredits, parseTipComment, MAX_TIP_CREDITS } from '../../src/economy/tips';
import type { WebsimHost } from '../../src/economy/websim-host';

const ME = 'user-me';
const PROJECT = 'proj-1';
const tip = (id: string, author: string, credits: unknown, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  comment: { id, author: { id: author, username: author }, created_at: '2026-10-01T00:00:00Z', ...top, card_data: { type: 'tip_comment', credits_spent: credits, ...extra } },
});
const page = (rows: unknown[], next: string | null) => ({ comments: { data: rows, meta: { has_next_page: next !== null, end_cursor: next } } });
function api(pages: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const after = new URL(url, 'https://x.test').searchParams.get('after') ?? '';
    const body = pages[after];
    if (body instanceof Error) throw body;
    if (!body) throw new Error(`no page for ${after}`);
    return body;
  });
}
const host = (overrides: Partial<WebsimHost> = {}): WebsimHost => ({
  getCurrentUser: async () => ({ id: ME, username: 'me' }),
  getCurrentProject: async () => ({ id: PROJECT }),
  postComment: vi.fn(async () => ({})),
  addEventListener: () => () => {},
  ...overrides,
});

describe('tip rows are only counted when websim says they are real tips by this player', () => {
  it('rejects self-tips, foreign recipients (when the creator is known), other projects, NaN and absurd amounts', () => {
    expect(parseTipComment(tip('a', ME, 100), ME)).not.toBeNull();
    expect(parseTipComment(tip('a', ME, 100, { tip_recipient_user_id: ME }), ME)).toBeNull();
    expect(parseTipComment(tip('a', ME, 100, { tip_recipient_user_id: 'creator' }), ME, { creatorId: 'creator' })).not.toBeNull();
    expect(parseTipComment(tip('a', ME, 100, { tip_recipient_user_id: 'my-alt' }), ME, { creatorId: 'creator' })).toBeNull();
    expect(parseTipComment(tip('a', ME, 100, {}, { project_id: 'other-project' }), ME, { projectId: PROJECT })).toBeNull();
    for (const bad of [Number.NaN, Infinity, -5, 0, '100', null, MAX_TIP_CREDITS + 1]) expect(parseTipComment(tip('a', ME, bad), ME)).toBeNull();
    expect(parseTipComment({ comment: { id: '', author: { id: ME }, card_data: { type: 'tip_comment', credits_spent: 5 } } }, ME)).toBeNull();
    expect(parseTipComment({ comment: { id: 'x', author: { id: ME }, card_data: { type: 'poll', credits_spent: 5 } } }, ME)).toBeNull();
    expect(marksForTipCredits(Number.NaN)).toBe(0);
    expect(marksForTipCredits(-1)).toBe(0);
  });
  it('a failed or truncated read is partial, never shrinks a total and is reported as not settled', async () => {
    const pages: Record<string, unknown> = { '': page([tip('t1', ME, 200)], 'p2'), p2: new Error('503') };
    const fetchJson = api(pages);
    const ledger = await fetchTipLedger(fetchJson, PROJECT, ME);
    expect(ledger).toMatchObject({ complete: false, failed: true, marks: 200 });
    const source = createTipSource({ host: host(), fetchJson, schedule: () => 0 });
    expect(source.settled!()).toBe(false);
    await source.refresh!();
    expect(source.total!()).toBe(200);
    expect(source.status!()).toBe('error');
    expect(source.settled!()).toBe(false);
    pages.p2 = page([tip('t2', ME, 200)], null);
    await source.refresh!();
    expect(source.total!()).toBe(400);
    expect(source.settled!()).toBe(true);
    // The API now shows fewer tips (a deleted comment) or fails: the total never goes down or negative in the session.
    pages[''] = page([], null);
    await source.refresh!();
    expect(source.total!()).toBe(400);
    pages[''] = new Error('down');
    await source.refresh!();
    expect(source.total!()).toBe(400);
    expect(source.settled!()).toBe(false);
  });
  it('hitting the page cap is partial: settled stays false so purchases stay refused', async () => {
    const fetchJson = api({ '': page([tip('a', ME, 100)], 'p2'), p2: page([tip('b', ME, 100)], 'p3'), p3: page([tip('c', ME, 100)], null) });
    const source = createTipSource({ host: host(), fetchJson, schedule: () => 0, pageCap: 2 });
    await source.refresh!();
    expect(source.total!()).toBe(200);
    expect(source.status!()).toBe('partial');
    expect(source.settled!()).toBe(false);
  });
  it('posting a tip comment never credits Marks, whatever postComment returns', async () => {
    for (const result of [{}, { ok: true, credits: 99999 }, undefined]) {
      const source = createTipSource({ host: host({ postComment: async () => result as never }), fetchJson: api({ '': page([], null) }), schedule: () => 0 });
      await source.refresh!();
      await source.redeem!('tip-2500');
      expect(source.total!()).toBe(0);
    }
  });
  it('a comment:created event is only a hint: nothing is credited until the API lists the row', async () => {
    let listener: ((data: unknown) => void) | null = null;
    const rows: unknown[] = [];
    const source = createTipSource({
      host: host({ addEventListener: (_t, cb) => { listener = cb; return () => {}; } }),
      fetchJson: vi.fn(async () => page(rows, null)), schedule: () => 0,
    });
    await source.refresh!();
    listener!({ comment: { author: { id: ME }, card_data: { type: 'tip_comment', credits_spent: 5000 } } });
    await Promise.resolve();
    expect(source.total!()).toBe(0);
  });
  it('signed out is settled with zero; an identity failure is not settled', async () => {
    const out = createTipSource({ host: host({ getCurrentUser: async () => null }), fetchJson: api({}), schedule: () => 0 });
    await out.refresh!();
    expect(out.settled!()).toBe(true);
    expect(out.status!()).toBe('signed-out');
    expect(out.total!()).toBe(0);
    const failing = createTipSource({ host: host({ getCurrentUser: async () => { throw new Error('rpc'); } }), fetchJson: api({}), schedule: () => 0 });
    await failing.refresh!();
    expect(failing.settled!()).toBe(false);
    expect(failing.status!()).toBe('error');
  });
  it('the tip index groups tips by author for verifying other players, deduped, and flags incompleteness', async () => {
    const fetchJson = api({ '': page([tip('a', 'u1', 200), tip('a', 'u1', 200), tip('b', 'u2', 500), tip('c', 'u1', 100, { tip_recipient_user_id: 'u1' })], 'p2'), p2: page([tip('d', 'u1', 200)], null) });
    const index = await fetchTipIndex(fetchJson, PROJECT);
    expect(index.complete).toBe(true);
    expect(index.byId.get('u1')).toMatchObject({ credits: 400, marks: 400, tips: 2 });
    expect(index.byName.get('u2')?.marks).toBe(590);
    const cut = await fetchTipIndex(api({ '': page([tip('a', 'u1', 200)], 'p2'), p2: page([], null) }), PROJECT, 1);
    expect(cut.complete).toBe(false);
  });
});
