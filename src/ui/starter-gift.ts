/**
 * The starter gift controller: when the reveal appears, how driving is gated until the gift is opened, and the
 * single place the rest of the UI asks "is the gift open?".
 *
 *   - The reveal is a required step. It shows by itself on the first menu visit (never while driving) once the wallet
 *     has loaded, or after `waitMs` if the wallet is slow, so a broken wallet can not hide it or hold the game back.
 *   - allowed()/require() are the play gate the coordinator calls before it starts driving (Play, Solo, Online, Drive).
 *     require() shows the reveal if needed and resolves true when the player carries on with "Let's drive".
 *   - Opening is local first (economy.openGift marks the gift opened at once and keeps retrying the Marks in the
 *     background), so the player is never stuck behind the network.
 * Menus (Settings, Controls, Garage, Shop) stay reachable the whole time.
 */
import type { Economy, EconomyView, GiftView } from '../economy/types';
import { describeGiftItems, openGiftReveal, type GiftOutcome, type GiftReveal, type GiftRevealHooks } from './gift-reveal';

export interface StarterGiftOptions {
  readonly economy: Economy;
  readonly shell: HTMLElement | null;
  /** Start driving (after "Let's drive" when nothing else was waiting). */
  drive(): void;
  openShop(): void;
  /** The coordinator's current screen ('pause' is the menu). The reveal never opens while it is 'drive'. */
  screen(): string;
  /** False while the game is still starting up or in a transition: the reveal waits for the menu to be ready. Default: always ready. */
  menuReady?(): boolean;
  /** Called when what the menus show about the gift or the balance changed (they redraw). */
  onChange?(): void;
  /** Called whenever the screen may have changed. Returns an unsubscribe. */
  subscribeScreen(listener: () => void): () => void;
  from?: string;
  /** How long to wait for a slow wallet before showing the gift anyway. Default 5000 ms. */
  waitMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /** Test seams for the reveal. */
  readonly reveal?: Partial<GiftRevealHooks>;
}

export interface StarterGift {
  /** 'loading' until the wallet is ready (or the wait ran out), then 'unopened' or 'opened'. 'none' in builds without a gift. */
  state(): 'none' | 'loading' | 'unopened' | 'opened';
  /** True when driving may start (no gift in this build, or the gift is opened). */
  allowed(): boolean;
  /** Shows the reveal if the gift is closed. Resolves true when the player carries on to drive, false otherwise. */
  require(): Promise<boolean>;
  /** Shows the reveal now (the gift buttons). A no-op when the gift is already open. */
  open(): void;
  /** Marks inside a closed gift, or null (nothing to hint at). */
  hint(): number | null;
  readonly isShowing: boolean;
  dispose(): void;
}

export function mountStarterGift(options: StarterGiftOptions): StarterGift {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { economy } = options;
  let view: EconomyView = economy.view();
  let waited = false, disposed = false, reveal: GiftReveal | null = null, closedByWallet = false;
  const waiters: ((go: boolean) => void)[] = [];
  const gift = (): GiftView | null => view.gift ?? null;
  const pokes = new Set<() => void>();
  const waitTimer = schedule(() => { waited = true; for (const poke of [...pokes]) poke(); maybeAuto(); }, options.waitMs ?? 5000);
  let lastKey = '';

  const state = (): ReturnType<StarterGift['state']> => {
    const current = gift();
    if (!current) return 'none';
    if (current.state === 'opened') return 'opened';
    return view.ready || waited ? 'unopened' : 'loading';
  };
  const allowed = (): boolean => { const current = gift(); return !current || current.state === 'opened'; };

  function show(): Promise<GiftOutcome> {
    if (reveal) return reveal.done;
    const current = gift();
    if (!options.shell || !current || disposed) return Promise.resolve('closed');
    const hooks: GiftRevealHooks = { open: () => economy.openGift?.() ?? Promise.resolve({ ok: true, granted: 0, pending: false } as const), from: options.from, ...options.reveal };
    const made = openGiftReveal(options.shell, { marks: current.marks, items: describeGiftItems(current.items) }, hooks);
    reveal = made;
    void made.done.then(outcome => {
      if (reveal === made) reveal = null;
      const waiting = waiters.splice(0);
      // The wallet said the gift was already opened (a slow wallet, another device): whatever was waiting on the gate may go on.
      if (closedByWallet) { closedByWallet = false; for (const go of waiting) go(true); return; }
      if (outcome === 'drive') { if (waiting.length) for (const go of waiting) go(true); else options.drive(); }
      else { for (const go of waiting) go(false); if (outcome === 'shop') options.openShop(); }
    });
    return made.done;
  }

  function maybeAuto(): void {
    if (disposed || reveal) return;
    if (state() !== 'unopened') return;
    if (options.screen() === 'drive' || options.menuReady?.() === false) return;
    void show();
  }

  const offEconomy = economy.subscribe(next => {
    view = next;
    // The reveal was shown on a guess (slow wallet) and the wallet now says it was opened before: take it away, unless the player already tapped the box.
    if (reveal && next.gift?.state === 'opened' && reveal.stage() === 'box') { closedByWallet = true; reveal.close('closed'); }
    const key = `${next.gift?.state}|${next.gift?.pending}|${next.balance}`;
    if (key !== lastKey) { lastKey = key; try { options.onChange?.(); } catch { /* A menu redraw must not break the gift. */ } }
    maybeAuto();
  });
  const offScreen = options.subscribeScreen(() => maybeAuto());
  maybeAuto();

  return {
    state, allowed,
    async require() {
      if (allowed()) return true;
      // A slow wallet may still say "opened" a moment from now: give it until the wait runs out, then show the gift.
      if (state() === 'loading') {
        await new Promise<void>(resolve => {
          const check = (): void => { if (state() !== 'loading') { off(); pokes.delete(check); resolve(); } };
          const off = economy.subscribe(check);
          pokes.add(check);
          check();
        });
        if (allowed()) return true;
      }
      const result = new Promise<boolean>(resolve => { waiters.push(resolve); });
      void show();
      return result;
    },
    open() { if (!allowed()) void show(); },
    hint: () => { const current = gift(); return current && current.state === 'unopened' ? current.marks : null; },
    get isShowing() { return reveal !== null; },
    dispose() {
      disposed = true;
      cancel(waitTimer);
      offEconomy(); offScreen();
      reveal?.close('closed'); reveal = null;
      for (const go of waiters.splice(0)) go(false);
    },
  };
}
