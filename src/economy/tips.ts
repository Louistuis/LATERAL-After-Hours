/**
 * websim tip source ("derived"): the player's Marks from tips are recomputed from the project's comments,
 * which only websim can write. A client can not fabricate a tip, so it can not fabricate these Marks.
 *
 * Verified 2026-10-01 against the live API:
 *   GET /api/v1/projects/{id}/comments?first<=100&sort_by=created_at|best&only_tips=true&author_id={uuid}&after={cursor}
 *   -> { comments: { data: [{ comment, cursor }], meta: { has_next_page, end_cursor } } }
 *   tip comments carry card_data { type: 'tip_comment', credits_spent, tip_amount?, tip_recipient_user_id? }.
 *   credits_spent is always present (what the tipper paid); tip_amount (the creator's share) is not.
 * The server filters by author and tip type, but every row is still checked here so a filter change can
 * never credit someone else's tip.
 *
 * Safety rules (tests/economy/tips-security.test.ts):
 *   - Marks are only ever counted from rows websim returned. postComment success credits nothing.
 *   - Rows are deduped by comment id and must be authored by the signed-in user.
 *   - A tip addressed to the tipper themself never counts, except for the creator (whose own tips are always self-addressed).
 *   - A truncated or failed read is a lower bound: it never shrinks a total and the source reports settled() = false,
 *     so the economy refuses purchases until a complete read lands.
 */
import type { EarnFlow, EarnOffer, EarnSource, RedeemResult } from './types';
import type { WebsimHost } from './websim-host';

export const MARKS_PER_CREDIT = 1;
export const TIP_PAGE_SIZE = 100;
export const TIP_MAX_PAGES = 50;
/** One tip above this is not a real tip (websim packs are far smaller); the row is ignored. */
export const MAX_TIP_CREDITS = 10_000_000;

export interface TipPack { readonly id: string; readonly credits: number; readonly badge?: string; readonly sale?: boolean }
/** Bonus tiers: a single tip of at least `min` credits earns `multiplier` Marks per credit (then rounded up to a 50/90 ending). */
export const TIP_BONUS_TIERS: readonly { readonly min: number; readonly multiplier: number }[] = [
  { min: 25000, multiplier: 2 },
  { min: 10000, multiplier: 1.8 },
  { min: 5000, multiplier: 1.6 },
  { min: 2500, multiplier: 1.4 },
  { min: 1500, multiplier: 1.3 },
  { min: 1000, multiplier: 1.25 },
  { min: 750, multiplier: 1.2 },
  { min: 500, multiplier: 1.15 },
  { min: 350, multiplier: 1.05 },
];

export const TIP_PACKS: readonly TipPack[] = [
  { id: 'tip-200', credits: 200 },
  { id: 'tip-350', credits: 350, badge: '+5%' },
  { id: 'tip-500', credits: 500, badge: '+15%' },
  { id: 'tip-750', credits: 750, badge: '+20%' },
  { id: 'tip-1000', credits: 1000, badge: '+25% popular' },
  { id: 'tip-1500', credits: 1500, badge: '+30%' },
  { id: 'tip-2500', credits: 2500, badge: '+40% best seller' },
  { id: 'tip-5000', credits: 5000, badge: 'SALE: save 38%', sale: true },
  { id: 'tip-10000', credits: 10000, badge: 'MEGA SALE: save 45%', sale: true },
  { id: 'tip-25000', credits: 25000, badge: 'LEGEND SALE: save 50%', sale: true },
];

/** Marks for one tip comment. Bigger single tips earn a bonus. */
export function marksForTipCredits(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  const whole = Math.floor(Math.min(credits, MAX_TIP_CREDITS));
  const multiplier = TIP_BONUS_TIERS.find(tier => whole >= tier.min)?.multiplier ?? 1;
  const marks = Math.round(whole * MARKS_PER_CREDIT * multiplier);
  return multiplier > 1 ? roundUpToPriceEnding(marks) : marks;
}

/** Smallest value >= n ending in 50 or 90 (575 -> 590, 1250 -> 1250, 3500 -> 3550). */
export function roundUpToPriceEnding(n: number): number {
  const base = Math.floor(n / 100) * 100;
  for (const candidate of [base + 50, base + 90, base + 150]) if (candidate >= n) return candidate;
  return base + 150;
}

export interface TipRecord { readonly id: string; readonly credits: number; readonly createdAt: string }
export interface TipRow extends TipRecord { readonly authorId: string; readonly authorName: string }

export interface TipParseOptions {
  /** Ignore rows that name another project. */
  readonly projectId?: string | null;
  /** When set, a tip that names a different recipient is not a tip to the creator and does not count. */
  readonly creatorId?: string | null;
}

/** Parses one row into a tip, or null. Does not check who wrote it. */
export function readTipRow(raw: unknown, options: TipParseOptions = {}): TipRow | null {
  const comment = (raw && typeof raw === 'object' && 'comment' in raw ? (raw as { comment: unknown }).comment : raw) as Record<string, unknown> | null;
  if (!comment || typeof comment !== 'object') return null;
  const id = comment.id, author = comment.author as { id?: unknown; username?: unknown } | undefined, card = comment.card_data as Record<string, unknown> | undefined;
  if (typeof id !== 'string' || !id || id.length > 120 || !author || typeof author.id !== 'string' || !author.id || !card || card.type !== 'tip_comment') return null;
  const projectId = options.projectId;
  if (projectId && typeof comment.project_id === 'string' && comment.project_id !== projectId) return null;
  const recipient = card.tip_recipient_user_id;
  if (typeof recipient === 'string' && recipient) {
    // The creator's own tip comments are addressed to themselves (the real data on this project); nobody else's can be.
    if (recipient === author.id && author.id !== options.creatorId) return null;
    if (options.creatorId && recipient !== options.creatorId) return null;
  }
  const spent = typeof card.credits_spent === 'number' ? card.credits_spent : typeof card.tip_amount === 'number' ? card.tip_amount : 0;
  if (!Number.isFinite(spent) || spent <= 0 || spent > MAX_TIP_CREDITS) return null;
  return {
    id, credits: Math.floor(spent), createdAt: typeof comment.created_at === 'string' ? comment.created_at.slice(0, 40) : '',
    authorId: author.id, authorName: typeof author.username === 'string' ? author.username.slice(0, 64) : '',
  };
}

/** Returns the tip if `raw` is a tip comment written by `userId`, else null. */
export function parseTipComment(raw: unknown, userId: string, options: TipParseOptions = {}): TipRecord | null {
  const row = readTipRow(raw, options);
  if (!row || row.authorId !== userId) return null;
  return { id: row.id, credits: row.credits, createdAt: row.createdAt };
}

export interface TipLedger {
  readonly tips: readonly TipRecord[];
  readonly credits: number;
  readonly marks: number;
  /** False when the page cap was hit or a page failed; the total is then a lower bound. */
  readonly complete: boolean;
  /** True when a page request failed or returned an unexpected shape (as opposed to simply hitting the page cap). */
  readonly failed?: boolean;
}

export type JsonFetcher = (url: string) => Promise<unknown>;

export function tipsUrl(projectId: string, userId: string | null, after?: string | null): string {
  const query = new URLSearchParams({ first: String(TIP_PAGE_SIZE), sort_by: 'created_at', only_tips: 'true' });
  if (userId) query.set('author_id', userId);
  if (after) query.set('after', after);
  return `/api/v1/projects/${encodeURIComponent(projectId)}/comments?${query.toString()}`;
}

interface Page { readonly rows: unknown[]; readonly next: string | null }
function readPage(body: unknown, after: string | null): Page {
  const comments = (body as { comments?: { data?: unknown[]; meta?: { has_next_page?: boolean; end_cursor?: unknown } } } | null)?.comments;
  const rows = comments?.data;
  if (!Array.isArray(rows)) throw new Error('Unexpected comments response');
  const meta = comments?.meta;
  const cursor = meta?.has_next_page && typeof meta.end_cursor === 'string' && meta.end_cursor ? meta.end_cursor : null;
  return { rows: rows.slice(0, TIP_PAGE_SIZE * 2), next: cursor && cursor !== after && rows.length > 0 ? cursor : null };
}

/** Walks every page of the player's tip comments. Dedupes by comment id across pages. A failed page yields a partial (incomplete) ledger. */
export async function fetchTipLedger(fetchJson: JsonFetcher, projectId: string, userId: string, maxPages = TIP_MAX_PAGES, options: TipParseOptions = {}): Promise<TipLedger> {
  const byId = new Map<string, TipRecord>();
  let after: string | null = null, complete = false, failed = false;
  const opts = { projectId, ...options };
  for (let page = 0; page < maxPages; page++) {
    let read: Page;
    try { read = readPage(await fetchJson(tipsUrl(projectId, userId, after)), after); } catch { failed = true; break; }
    for (const row of read.rows) {
      const tip = parseTipComment(row, userId, opts);
      if (tip && !byId.has(tip.id)) byId.set(tip.id, tip);
    }
    if (!read.next) { complete = true; break; }
    after = read.next;
  }
  const tips = [...byId.values()];
  return {
    tips, complete, ...(failed ? { failed } : {}),
    credits: tips.reduce((sum, tip) => sum + tip.credits, 0),
    marks: tips.reduce((sum, tip) => sum + marksForTipCredits(tip.credits), 0),
  };
}

export interface TipTotals { readonly credits: number; readonly marks: number; readonly tips: number }
export interface TipIndex {
  /** Per lower-cased username and per user id. */
  readonly byName: ReadonlyMap<string, TipTotals>;
  readonly byId: ReadonlyMap<string, TipTotals>;
  /** False when the page cap was hit or a page failed: a user missing from the index may simply be unread. */
  readonly complete: boolean;
}

/**
 * Every tip on the project, grouped by author. Used to verify OTHER players' cosmetics (their client can not
 * forge a websim comment). One walk covers every player; bounded by maxPages.
 */
export async function fetchTipIndex(fetchJson: JsonFetcher, projectId: string, maxPages = TIP_MAX_PAGES, options: TipParseOptions = {}): Promise<TipIndex> {
  const seen = new Set<string>(), rows: TipRow[] = [];
  let after: string | null = null, complete = false;
  for (let page = 0; page < maxPages; page++) {
    let read: Page;
    try { read = readPage(await fetchJson(tipsUrl(projectId, null, after)), after); } catch { break; }
    for (const raw of read.rows) {
      const row = readTipRow(raw, { projectId, ...options });
      if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    if (!read.next) { complete = true; break; }
    after = read.next;
  }
  const byName = new Map<string, { credits: number; marks: number; tips: number }>(), byId = new Map<string, { credits: number; marks: number; tips: number }>();
  const add = (map: Map<string, { credits: number; marks: number; tips: number }>, key: string, row: TipRow): void => {
    const entry = map.get(key) ?? { credits: 0, marks: 0, tips: 0 };
    entry.credits += row.credits; entry.marks += marksForTipCredits(row.credits); entry.tips++;
    map.set(key, entry);
  };
  for (const row of rows) {
    add(byId, row.authorId, row);
    if (row.authorName) add(byName, row.authorName.toLowerCase(), row);
  }
  return { byName, byId, complete };
}

const TIP_MESSAGE = 'Tipping the LATERAL garage. See you after hours.';
/** Retry schedule after a failed or partial read (ms); the last step repeats. */
const RETRY_MS = [5000, 20000, 60000, 180000, 600000] as const;
const VISIBLE_REFRESH_MS = 15000;
const IDENTITY_TIMEOUT = Symbol('identity-timeout');

export interface TipSourceOptions {
  readonly host: WebsimHost;
  readonly fetchJson?: JsonFetcher;
  /** Creator's display name for the disclosure. */
  readonly creatorName?: string;
  /** Creator's websim user id. When set, a tip that names another recipient does not count. */
  readonly creatorId?: string | null;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly now?: () => number;
  readonly pageCap?: number;
}

/** The websim earn source. available() stays false until the signed-in user and project are known. */
export function createTipSource(options: TipSourceOptions): EarnSource {
  const fetchJson: JsonFetcher = options.fetchJson ?? (async url => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Comments request failed (${response.status})`);
    return response.json();
  });
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const now = options.now ?? (() => Date.now());
  const pageCap = options.pageCap ?? TIP_MAX_PAGES;
  const parse: TipParseOptions = { creatorId: options.creatorId ?? null };
  const listeners = new Set<() => void>();
  let user: { id: string; username: string } | null = null;
  let projectId: string | null = null;
  const known = new Set<string>();
  let total = 0, disposed = false, inflight: Promise<void> | null = null;
  let identityState: 'loading' | 'ok' | 'signed-out' | 'error' = 'loading';
  let readState: 'idle' | 'ready' | 'partial' | 'error' = 'idle';
  let retryStep = 0, retryPending = false, lastVisible = -Infinity;
  const emit = (): void => { for (const listener of listeners) listener(); };

  const resolveIdentity = async (): Promise<void> => {
    const guarded = <T>(promise: Promise<T>): Promise<T | typeof IDENTITY_TIMEOUT | null> =>
      new Promise(resolve => {
        const timer = setTimeout(() => resolve(IDENTITY_TIMEOUT), 6000);
        promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(IDENTITY_TIMEOUT); });
      });
    const [current, project] = await Promise.all([guarded(options.host.getCurrentUser()), guarded(options.host.getCurrentProject())]);
    if (project === IDENTITY_TIMEOUT || current === IDENTITY_TIMEOUT) { identityState = 'error'; return; }
    if (project && typeof project.id === 'string' && project.id) projectId = project.id;
    const anonymous = !current || typeof current.id !== 'string' || !current.id || (current as { is_anonymous?: boolean }).is_anonymous;
    if (anonymous) { identityState = 'signed-out'; return; }
    user = { id: current.id, username: current.username };
    identityState = projectId ? 'ok' : 'error';
  };
  let identity = resolveIdentity().catch(() => { identityState = 'error'; }).then(() => emit());

  const scheduleRetry = (): void => {
    if (disposed || retryPending) return;
    retryPending = true;
    const ms = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)]!;
    retryStep++;
    schedule(() => { retryPending = false; if (!disposed) void refresh(); }, ms);
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (inflight) return inflight;
    inflight = (async () => {
      await identity;
      if (identityState === 'error') {
        // The identity call timed out or returned no project: try again rather than pretending to be signed out.
        identity = resolveIdentity().catch(() => { identityState = 'error'; }).then(() => emit());
        await identity;
      }
      if (!user || !projectId) { if (identityState === 'error') scheduleRetry(); return; }
      try {
        const ledger = await fetchTipLedger(fetchJson, projectId, user.id, pageCap, parse);
        const nextKnown = new Set(ledger.tips.map(tip => tip.id));
        noteLedger(ledger);
        // Never shrink a total: a partial read is a lower bound, and a tip comment the player later deleted
        // still spent real credits, so its Marks stay for this session.
        const next = Math.max(total, ledger.marks);
        const changed = next !== total || nextKnown.size !== known.size || readState !== (ledger.complete ? 'ready' : ledger.failed ? 'error' : 'partial');
        total = next;
        for (const id of nextKnown) known.add(id);
        readState = ledger.complete ? 'ready' : ledger.failed ? 'error' : 'partial';
        if (ledger.complete) retryStep = 0; else scheduleRetry();
        if (changed) emit();
      } catch (error) {
        console.warn('LATERAL tips unavailable', error);
        readState = 'error'; scheduleRetry(); emit();
      }
      if (flow) {
        settleFlow();
        if (flow.phase !== 'confirmed') flow = { ...flow, apiError: readState === 'error' || readState === 'partial' || identityState === 'error', checkedAt: now() };
        emit();
      }
    })().finally(() => { inflight = null; });
    return inflight;
  };

  /* ---------------------------------------------------------------- tip flow */
  const FLOW_POLL_MS = [3000, 4000, 5000, 5000, 6000, 8000, 10000] as const;
  const FLOW_TIMEOUT_MS = 5 * 60_000;
  const FLOW_STOP_MS = 20 * 60_000;
  let flow: EarnFlow | null = null, baselineReady = false, watchId = 0;
  const stepsFor = (credits: number, marks: number): string[] => [
    'Open the comments under the game.',
    'Write a comment (or paste the message below).',
    `Tap the tip icon and choose ${credits.toLocaleString('en-US')} credits.`,
    'Post the comment.',
    `Your ${marks.toLocaleString('en-US')} Marks land here a few seconds after websim records the tip.`,
  ];
  /** First complete read after a flow starts is the baseline; later tips that were not in it are the new ones. */
  let pendingFresh: TipRecord[] = [];
  const noteLedger = (ledger: TipLedger): void => {
    if (!flow || flow.phase === 'confirmed') return;
    const fresh = ledger.tips.filter(tip => !known.has(tip.id));
    if (!baselineReady) { if (ledger.complete) baselineReady = true; return; }
    for (const tip of fresh) if (!pendingFresh.some(entry => entry.id === tip.id)) pendingFresh.push(tip);
  };
  const settleFlow = (): void => {
    if (!flow || flow.phase === 'confirmed' || pendingFresh.length === 0) { pendingFresh = []; return; }
    const credits = pendingFresh.reduce((sum, tip) => sum + tip.credits, 0);
    const marks = pendingFresh.reduce((sum, tip) => sum + marksForTipCredits(tip.credits), 0);
    flow = { ...flow, phase: 'confirmed', apiError: false, confirmed: { credits, marks, count: pendingFresh.length }, checkedAt: now() };
    pendingFresh = []; watchId++;
  };
  const watch = (id: number): void => {
    let step = 0;
    const tick = (): void => {
      if (disposed || id !== watchId || !flow || flow.phase === 'confirmed') return;
      void (async () => {
        if (identityState === 'signed-out' || identityState === 'error') { identity = resolveIdentity().catch(() => { identityState = 'error'; }).then(() => emit()); await identity; }
        await refresh();
        if (id !== watchId) return;
        settleFlow();
        if (flow && flow.phase === 'waiting' && now() - flow.startedAt > FLOW_TIMEOUT_MS) flow = { ...flow, phase: 'timeout' };
        emit();
        if (flow && flow.phase !== 'confirmed' && now() - flow.startedAt < FLOW_STOP_MS) schedule(tick, step < FLOW_POLL_MS.length ? FLOW_POLL_MS[step++]! : 15000);
      })();
    };
    schedule(tick, FLOW_POLL_MS[0]);
  };
  const classify = (result: unknown): Pick<EarnFlow, 'composer' | 'notice'> => {
    const error = result && typeof result === 'object' && 'error' in result ? (result as { error?: unknown }).error : null;
    if (!error) return { composer: 'opened', notice: null };
    const text = typeof error === 'string' ? error.toLowerCase() : '';
    if (text.includes('interacted')) return { composer: 'needs-interaction', notice: 'websim needs a tap on the page first, so its tip box did not open by itself. Tap anywhere in the game and try again, or follow the steps below.' };
    if (text.includes('logged in') || text.includes('login')) return { composer: 'needs-login', notice: 'You need to be signed in to websim to tip. A sign in window should have opened. Sign in, then follow the steps below.' };
    if (text.includes('closed')) return { composer: 'unavailable', notice: 'Comments are closed on this project right now, so tips can not be posted.' };
    if (text.includes('rate')) return { composer: 'error', notice: 'websim says you are posting too fast. Wait a minute, then follow the steps below.' };
    return { composer: 'error', notice: 'The tip box did not open by itself. Follow the steps below instead.' };
  };
  /**
   * Starts a tip. Call it straight from the click: websim only opens its composer for a call made during a user gesture,
   * so postComment runs before any await. NOTHING here credits Marks: the flow only ever reaches 'confirmed' after a
   * refresh has read a NEW tip comment from websim's API.
   */
  const startFlow = (offerId: string): Promise<EarnFlow | null> => {
    const pack = TIP_PACKS.find(entry => entry.id === offerId);
    if (!pack || disposed) return Promise.resolve(null);
    const marks = marksForTipCredits(pack.credits);
    const id = ++watchId;
    baselineReady = readState === 'ready'; pendingFresh = [];
    flow = {
      phase: 'opening', offerId: pack.id, credits: pack.credits, marks, composer: 'pending', notice: null, posted: false, apiError: false,
      copyText: TIP_MESSAGE, steps: stepsFor(pack.credits, marks), confirmed: null, startedAt: now(), checkedAt: 0,
    };
    let call: Promise<unknown>;
    try { call = Promise.resolve(options.host.postComment({ content: TIP_MESSAGE, credits: pack.credits })); }
    catch (error) { call = Promise.reject(error); }
    emit();
    return call.then(result => classify(result), () => ({ composer: 'error' as const, notice: 'The tip box did not open by itself. Follow the steps below instead.' })).then(outcome => {
      if (flow && id === watchId) { flow = { ...flow, phase: 'waiting', ...outcome }; emit(); watch(id); }
      return flow;
    });
  };
  let detachEvent: (() => void) | null = null;
  try {
    const off = options.host.addEventListener('comment:created', data => {
      const comment = (data as { comment?: { author?: { id?: string }; card_data?: { type?: string } } } | null)?.comment;
      if (!comment || !user || comment.author?.id !== user.id) return;
      // The event is only a hint: the balance always comes from the API.
      if (flow && flow.phase !== 'confirmed') { flow = { ...flow, posted: true }; emit(); }
      void refresh().then(() => { settleFlow(); emit(); });
      schedule(() => { void refresh().then(() => { settleFlow(); emit(); }); }, 3000);
    });
    detachEvent = typeof off === 'function' ? off : null;
  } catch { detachEvent = null; }
  const onVisible = (): void => {
    if (typeof document === 'undefined' || document.hidden) return;
    const at = now();
    if (at - lastVisible < VISIBLE_REFRESH_MS) return;
    lastVisible = at;
    void refresh();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  const creator = options.creatorName ?? 'the creator';
  const status = (): 'loading' | 'ready' | 'partial' | 'error' | 'signed-out' =>
    identityState === 'loading' ? 'loading' : identityState === 'signed-out' ? 'signed-out' : identityState === 'error' ? 'error'
      : readState === 'idle' ? 'loading' : readState;
  return {
    id: 'tips', kind: 'derived', label: 'Support the garage',
    disclosure: `Tips are paid in websim credits through websim's own tip window and go to ${creator}, the creator of LATERAL. You choose and confirm the amount there. Every credit you tip on this project adds ${MARKS_PER_CREDIT} Mark to your wallet, and tips of 500 or more get up to 40% extra, counted from your own tip comments, so they follow your websim account to any device. Marks are only counted from tip comments that exist on this project, so please do not delete them.`,
    available: () => !disposed && Boolean(user && projectId),
    total: () => total,
    settled: () => { const s = status(); return s === 'ready' || s === 'signed-out'; },
    status,
    refresh,
    offers(): readonly EarnOffer[] {
      return TIP_PACKS.map(pack => ({
        id: pack.id,
        title: `${pack.credits.toLocaleString('en-US')} credits`,
        detail: `${marksForTipCredits(pack.credits).toLocaleString('en-US')} Marks`,
        marks: marksForTipCredits(pack.credits),
        worth: pack.credits * MARKS_PER_CREDIT,
        cta: `Tip ${pack.credits.toLocaleString('en-US')}`,
        ...(pack.badge ? { badge: pack.badge } : {}),
        ...(pack.sale ? { sale: true } : {}),
        unavailable: null,
      }));
    },
    /**
     * Starts the tip flow (see startFlow). This NEVER credits Marks: 'pending' only means the player now has to tip in
     * websim, and the Marks arrive when websim's record of the tip is read back.
     */
    async redeem(offerId: string): Promise<RedeemResult> {
      const started = await startFlow(offerId);
      if (!started) return { status: 'failed', message: 'Unknown tip pack.' };
      return { status: 'pending', message: started.notice ?? 'Post the tip in the websim comment box. Your Marks land here once websim records it.' };
    },
    flow: () => flow,
    startFlow,
    async checkFlow() { if (!flow) return; await refresh(); settleFlow(); emit(); },
    cancelFlow() { watchId++; flow = null; pendingFresh = []; emit(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true; listeners.clear(); detachEvent?.();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
