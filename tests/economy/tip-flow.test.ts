import { describe, expect, it, vi } from 'vitest';
import { createEconomy } from '../../src/economy/economy';
import { createTipSource, parseTipComment } from '../../src/economy/tips';
import type { WalletRecord, WalletStore } from '../../src/economy/types';
import type { WebsimHost } from '../../src/economy/websim-host';

const ME = 'user-me';
const CREATOR = '47085852-a3b9-4326-88a0-d06f5f891aba';
const tip = (id: string, credits: number, extra: Record<string, unknown> = {}) => ({ comment: { id, project_id: 'proj', author: { id: ME, username: 'me' }, created_at: '2026-10-02T15:45:11.747+00:00', card_data: { type: 'tip_comment', credits_spent: credits, tip_amount: credits / 2, ...extra } } });
const page = (rows: unknown[]) => ({ comments: { data: rows, meta: { has_next_page: false, end_cursor: null } } });
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function rig(opts: { rows?: unknown[]; user?: () => unknown; post?: WebsimHost['postComment']; creatorId?: string | null } = {}) {
  const state = { rows: opts.rows ?? [], failing: false, clock: 1_000_000 };
  const tasks: (() => void)[] = [];
  let listener: ((data: unknown) => void) | null = null;
  const postComment = vi.fn(opts.post ?? (async () => ({})));
  const host: WebsimHost = {
    getCurrentUser: async () => (opts.user ? opts.user() : { id: ME, username: 'me' }) as never,
    getCurrentProject: async () => ({ id: 'proj' }),
    postComment: postComment as never,
    addEventListener: (_t, cb) => { listener = cb; return () => { listener = null; }; },
  };
  const fetchJson = vi.fn(async () => { if (state.failing) throw new Error('503'); return page(state.rows); });
  const source = createTipSource({ host, fetchJson, schedule: fn => { tasks.push(fn); return 0; }, now: () => state.clock, creatorId: opts.creatorId ?? null });
  /** Runs one scheduled poll and lets it finish. */
  const poll = async (): Promise<void> => { const next = tasks.shift(); next?.(); await flush(); };
  return { source, state, postComment, fetchJson, poll, tasks, fire: (data: unknown) => listener?.(data) };
}

describe('tip flow: opening the websim tip box', () => {
  it('calls postComment synchronously with the exact message and credits, inside the click', async () => {
    const r = rig();
    await r.source.refresh!();
    void r.source.startFlow!('tip-500');
    expect(r.postComment).toHaveBeenCalledTimes(1);
    expect(r.postComment).toHaveBeenCalledWith({ content: 'Tipping the LATERAL garage. See you after hours.', credits: 500 });
    expect(r.source.flow!()).toMatchObject({ phase: 'opening', credits: 500, marks: 590, composer: 'pending', confirmed: null });
    await flush();
    expect(r.source.flow!()).toMatchObject({ phase: 'waiting', composer: 'opened' });
    expect(r.source.flow!()!.steps.join(' ')).toMatch(/500 credits/);
    expect(r.source.flow!()!.copyText).toContain('LATERAL');
  });
  it('maps every websim result to a clear state and always keeps the manual steps', async () => {
    const cases: [unknown, string, RegExp][] = [
      [{ error: 'User has not interacted with the page' }, 'needs-interaction', /tap/i],
      [{ error: 'User was not logged in' }, 'needs-login', /signed in/i],
      [{ error: 'Comments are closed on this project' }, 'unavailable', /closed/i],
      [{ error: 'Rate limited: too many comments, try again soon' }, 'error', /too fast/i],
      [{ error: 'something odd' }, 'error', /steps below/i],
    ];
    for (const [result, composer, notice] of cases) {
      const r = rig({ post: async () => result as never });
      await r.source.refresh!();
      await r.source.startFlow!('tip-200');
      const flow = r.source.flow!()!;
      expect(flow.composer).toBe(composer);
      expect(flow.notice).toMatch(notice);
      expect(flow.phase).toBe('waiting');
      expect(flow.steps.length).toBeGreaterThanOrEqual(4);
    }
    const thrown = rig({ post: async () => { throw new Error('rpc'); } });
    await thrown.source.refresh!();
    await thrown.source.startFlow!('tip-200');
    expect(thrown.source.flow!()).toMatchObject({ composer: 'error', phase: 'waiting' });
    const sync = rig({ post: () => { throw new Error('sync'); } });
    await sync.source.refresh!();
    await sync.source.startFlow!('tip-200');
    expect(sync.source.flow!()).toMatchObject({ composer: 'error', phase: 'waiting' });
    expect(await rig().source.startFlow!('nope')).toBeNull();
  });
  it('offers stay available when signed out (websim opens its login) and a later sign in is picked up', async () => {
    let user: unknown = null;
    const r = rig({ user: () => user, post: async () => ({ error: 'User was not logged in' }) });
    await r.source.refresh!();
    expect(r.source.offers!().every(offer => !offer.unavailable)).toBe(true);
    await r.source.startFlow!('tip-200');
    expect(r.source.flow!()!.composer).toBe('needs-login');
    user = { id: ME, username: 'me' };
    await r.poll();
    r.state.rows = [tip('t1', 200)];
    await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'confirmed', confirmed: { marks: 200 } });
  });
});

describe('tip flow: Marks only after websim records the tip', () => {
  it('stays waiting while nothing new is listed, then confirms from the record with the real amount', async () => {
    const r = rig({ rows: [tip('old', 200)] });
    await r.source.refresh!();
    expect(r.source.total!()).toBe(200);
    await r.source.startFlow!('tip-500');
    await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'waiting', confirmed: null });
    expect(r.source.total!()).toBe(200);
    r.state.rows = [tip('old', 200), tip('new', 500)];
    await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'confirmed', confirmed: { credits: 500, marks: 590, count: 1 } });
    expect(r.source.total!()).toBe(200 + 590);
  });
  it('confirms the amount websim recorded even when the player chose a different one', async () => {
    const r = rig();
    await r.source.refresh!();
    await r.source.startFlow!('tip-2500');
    r.state.rows = [tip('t', 200)];
    await r.poll();
    expect(r.source.flow!()!.confirmed).toMatchObject({ credits: 200, marks: 200 });
  });
  it('postComment success, a comment:created event and an old tip never confirm on their own', async () => {
    const r = rig({ rows: [tip('old', 500)] });
    await r.source.refresh!();
    await r.source.startFlow!('tip-500');
    expect(r.source.flow!()!.phase).toBe('waiting');
    r.fire({ comment: { author: { id: ME }, card_data: { type: 'tip_comment', credits_spent: 99999 } } });
    await flush();
    expect(r.source.flow!()).toMatchObject({ phase: 'waiting', posted: true, confirmed: null });
    expect(r.source.total!()).toBe(590);
    r.fire({ comment: { author: { id: 'someone-else' } } });
    await flush();
    expect(r.source.flow!()!.confirmed).toBeNull();
  });
  it('the event followed by the record confirms once and credits the wallet exactly once', async () => {
    const store: WalletStore = { id: 'm', durable: true, load: async () => null as WalletRecord | null, save: async () => {} };
    const r = rig();
    const economy = createEconomy({ store, sources: [r.source], game: { onRunFinished: () => () => {} }, now: () => 1_000_000 });
    await economy.refresh();
    await r.source.startFlow!('tip-1000');
    r.state.rows = [tip('t', 1000)];
    r.fire({ comment: { author: { id: ME } } });
    await flush();
    await r.poll(); await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'confirmed', confirmed: { marks: 1250, count: 1 } });
    expect(economy.view().balance).toBe(1250);
    expect(economy.view().lastCredit).toMatchObject({ amount: 1250, source: 'tips' });
  });
  it('shows an API error state while websim is unreachable and recovers without losing the tip', async () => {
    const r = rig();
    await r.source.refresh!();
    await r.source.startFlow!('tip-200');
    r.state.failing = true;
    await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'waiting', apiError: true });
    expect(r.source.flow!()!.confirmed).toBeNull();
    r.state.failing = false; r.state.rows = [tip('t', 200)];
    await r.poll();
    expect(r.source.flow!()).toMatchObject({ phase: 'confirmed', apiError: false });
  });
  it('times out into a "not seen yet" state, can be checked again, cancelled, and stops polling', async () => {
    const r = rig();
    await r.source.refresh!();
    await r.source.startFlow!('tip-200');
    r.state.clock += 6 * 60_000;
    await r.poll();
    expect(r.source.flow!()!.phase).toBe('timeout');
    r.state.rows = [tip('late', 200)];
    await r.source.checkFlow!();
    expect(r.source.flow!()!.phase).toBe('confirmed');
    const again = rig();
    await again.source.refresh!();
    await again.source.startFlow!('tip-200');
    again.source.cancelFlow!();
    expect(again.source.flow!()).toBeNull();
    const calls = again.fetchJson.mock.calls.length;
    await again.poll(); await again.poll();
    expect(again.fetchJson.mock.calls.length).toBe(calls);
  });
  it('redeem still never credits and reports pending with the notice', async () => {
    const r = rig({ post: async () => ({ error: 'User has not interacted with the page' }) });
    await r.source.refresh!();
    const result = await r.source.redeem!('tip-500');
    expect(result.status).toBe('pending');
    expect(result.message).toMatch(/tap/i);
    expect(r.source.total!()).toBe(0);
    expect((await r.source.redeem!('nope')).status).toBe('failed');
  });
});

describe('real websim tip rows', () => {
  const live = { id: '01a0fd4a-7a43-720e-aa35-3f66693de295', project_id: '2pe1wzob25j7go5xslvm', created_at: '2026-10-02T15:45:11.747+00:00', author: { id: CREATOR, username: 'Louis' }, deleted: false, parent_comment_id: null,
    card_data: { type: 'tip_comment', tip_amount: 250, credits_spent: 500, tip_recipient_user_id: CREATOR } };
  it('counts the creator\'s own tip comments (addressed to themself) but nobody else\'s self-addressed tips', () => {
    expect(parseTipComment({ comment: live, cursor: 'x' }, CREATOR, { projectId: '2pe1wzob25j7go5xslvm', creatorId: CREATOR })).toMatchObject({ credits: 500 });
    const other = { ...live, author: { id: 'u2', username: 'u2' }, card_data: { ...live.card_data, tip_recipient_user_id: 'u2' } };
    expect(parseTipComment({ comment: other }, 'u2', { creatorId: CREATOR })).toBeNull();
    expect(parseTipComment({ comment: other }, 'u2')).toBeNull();
    const tipToCreator = { ...live, author: { id: 'u3', username: 'u3' } };
    expect(parseTipComment({ comment: tipToCreator }, 'u3', { creatorId: CREATOR })).toMatchObject({ credits: 500 });
  });
});
