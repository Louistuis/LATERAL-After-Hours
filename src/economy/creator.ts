/**
 * Creator grant ("derived"): the creator of LATERAL gets a fixed 100,000 Marks, so they can try every item.
 *
 * The local check is the websim user id from getCurrentUser(), never the username, so renaming (or spoofing a username
 * on another id) gains nothing. It is a client-side check, so it only ever affects the cheater's own screen: other players
 * verify the creator by the server-set websim username on the wallet row (src/economy/remote-verify.ts), and a forged
 * local grant can not spend credits, take money or make anyone else see unpaid items.
 *
 * The source is silent: the economy counts its total, but it never appears in the Get Marks sheet.
 */
import type { EarnSource } from './types';
import type { WebsimHost } from './websim-host';

export const CREATOR_GRANT_MARKS = 100_000;
/** The creator's websim username. Server-set, so remote players are verified by it. */
export const LATERAL_CREATOR_USERNAME = 'Louis';

const RETRY_MS = [5000, 20000, 60000, 180000] as const;
const TIMEOUT = Symbol('timeout');

export interface CreatorSourceOptions {
  readonly host: WebsimHost;
  /** The creator's websim user id. null = no creator configured (the grant is never paid). */
  readonly creatorId: string | null;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
}

export function createCreatorSource(options: CreatorSourceOptions): EarnSource {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const listeners = new Set<() => void>();
  let state: 'loading' | 'ready' | 'signed-out' | 'error' = options.creatorId ? 'loading' : 'ready';
  let isCreator = false, disposed = false, inflight: Promise<void> | null = null, retry = 0;
  const emit = (): void => { for (const listener of listeners) listener(); };

  const resolve = async (): Promise<void> => {
    if (!options.creatorId) return;
    try {
      const user = await new Promise<Awaited<ReturnType<WebsimHost['getCurrentUser']>> | typeof TIMEOUT>(done => {
        const timer = setTimeout(() => done(TIMEOUT), 6000);
        options.host.getCurrentUser().then(value => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done(TIMEOUT); });
      });
      if (user === TIMEOUT) { state = 'error'; return; }
      const anonymous = !user || typeof user.id !== 'string' || !user.id || (user as { is_anonymous?: boolean }).is_anonymous;
      if (anonymous) { state = 'signed-out'; isCreator = false; return; }
      isCreator = user.id === options.creatorId;
      state = 'ready';
    } catch { state = 'error'; }
  };
  const refresh = (): Promise<void> => {
    if (disposed || state === 'ready' && options.creatorId === null) return Promise.resolve();
    if (inflight) return inflight;
    inflight = resolve().finally(() => {
      inflight = null;
      if (state === 'error' && !disposed) schedule(() => { void refresh(); }, RETRY_MS[Math.min(retry++, RETRY_MS.length - 1)]!);
      else retry = 0;
      emit();
    });
    return inflight;
  };
  void refresh();

  return {
    id: 'creator', kind: 'derived', label: 'Creator', silent: true,
    available: () => false,
    total: () => (isCreator ? CREATOR_GRANT_MARKS : 0),
    settled: () => state === 'ready' || state === 'signed-out',
    status: () => (state === 'loading' ? 'loading' : state === 'error' ? 'error' : state === 'signed-out' ? 'signed-out' : 'ready'),
    refresh,
    offers: () => [],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; listeners.clear(); },
  };
}
