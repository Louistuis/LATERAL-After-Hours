/**
 * The gift screens: opening a gift from the inbox (the menu badge), redeeming a code, and opening the gift of a
 * `?gift=` link as soon as the account exists. They all use the same reveal as the starter gift (src/ui/gift-reveal.ts):
 * "A gift from Louis", his message, the items and the Marks counting up.
 */
import { catalogEntry } from '../economy/catalog';
import type { Economy, GiftOpenResult } from '../economy/types';
import { describeGiftItems, openGiftReveal, type GiftOutcome } from '../ui/gift-reveal';
import { noticeDialog } from './account-ui';
import type { SelfhostServices } from './boot';
import type { ActionResult, ServerGift } from './wallet-store';

export interface GiftsUiDeps {
  readonly shell: HTMLElement;
  readonly services: SelfhostServices;
  readonly economy: Economy;
  openShop(): void;
  drive(): void;
  /** The coordinator's screen ('drive' while driving). Reveals never open over the driving view. */
  screen(): string;
  subscribeScreen(listener: () => void): () => void;
}

export interface GiftsUi {
  /** Gifts waiting in the inbox (the menu badge). */
  count(): number;
  /** Opens the first waiting gift with the reveal. */
  openInbox(): void;
  /** Redeems a code and shows the reveal. Resolves with the server's answer. */
  redeemCode(code: string): Promise<ActionResult>;
  dispose(): void;
}

interface Shown { readonly from: string; readonly message: string; readonly marks: number; readonly items: readonly string[] }

/** Text for items the player already owned: they are not added twice and turn into nothing. */
export function skippedNote(skipped: readonly string[]): string {
  const names = skipped.map(id => catalogEntry(id)?.name).filter((name): name is string => Boolean(name));
  if (!names.length) return '';
  return names.length === 1 ? `You already had ${names[0]}, so it was not added twice.` : `You already had ${names.length} of these items (${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and more' : ''}), so they were not added twice.`;
}

export function mountGiftsUi(deps: GiftsUiDeps): GiftsUi {
  const { shell, services, economy } = deps;
  let showing = false;
  let disposed = false;

  /** Plays the reveal. `open` is called on the tap (or at once with autoOpen) and decides what the player gets. */
  function reveal(gift: Shown, open: () => Promise<GiftOpenResult>, autoOpen = false): Promise<GiftOutcome> {
    if (showing) return Promise.resolve('closed');
    showing = true;
    const made = openGiftReveal(shell, { marks: gift.marks, items: describeGiftItems(gift.items) }, {
      open, from: gift.from, message: gift.message || undefined, autoOpen,
      copy: { kicker: 'A gift for you', sub: gift.message ? '' : 'Something to keep.', boxLabel: 'Open your gift', hint: 'Tap the box to open it', revealKicker: `From ${gift.from}`, revealTitle: 'Your gift', revealSub: 'Yours to keep.' },
    });
    return made.done.then(outcome => {
      showing = false;
      if (outcome === 'shop') deps.openShop(); else if (outcome === 'drive') deps.drive();
      void economy.refresh();
      return outcome;
    });
  }
  const shownOf = (gift: ServerGift): Shown => ({ from: gift.from, message: gift.message, marks: gift.marks, items: gift.items });

  function openInbox(): void {
    const gift = services.gifts.inbox()[0];
    if (!gift || showing || disposed) return;
    void reveal(shownOf(gift), async () => {
      const result = await services.gifts.claim(gift.id);
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, granted: result.marks, pending: false, ...(result.skipped.length ? { note: skippedNote(result.skipped) } : {}) };
    });
  }

  async function redeemCode(code: string): Promise<ActionResult> {
    const result = await services.gifts.redeem(code);
    if (!result.ok) return result;
    const gift = result.gift;
    // The server already credited it; the reveal is the moment the player sees what it was.
    void reveal({ from: gift?.from ?? 'Louis', message: gift?.message ?? '', marks: result.marks, items: result.items }, async () => ({ ok: true, granted: result.marks, pending: false, ...(result.skipped.length ? { note: skippedNote(result.skipped) } : {}) }));
    return result;
  }

  /* ---- a `?gift=` link: claimed automatically once an account exists and the menu is ready ---- */
  let pendingTimer: ReturnType<typeof setInterval> | null = null;
  let pendingBusy = false;
  const settled = (): boolean => deps.screen() !== 'drive' && !showing && !shell.querySelector('.lf-layer,.lp-gf,.sh-layer,.lp-sr:not([hidden]),.lp-ms');
  const ready = (): boolean => {
    if (!services.account.current() || !services.gifts.pendingCode()) return false;
    const view = economy.view();
    // The required starter gift comes first, and nothing opens over the driving view or another reveal.
    return view.ready && (!view.gift || view.gift.state === 'opened') && settled();
  };
  async function tryPending(): Promise<void> {
    if (pendingBusy || disposed || !ready()) return;
    pendingBusy = true;
    try {
      const outcome = await services.gifts.redeemPending();
      if (outcome.status === 'opened') {
        const { result } = outcome;
        void reveal({ from: result.gift?.from ?? 'Louis', message: result.gift?.message ?? '', marks: result.marks, items: result.items }, async () => ({ ok: true, granted: result.marks, pending: false, ...(result.skipped.length ? { note: skippedNote(result.skipped) } : {}) }));
      } else if (outcome.status === 'already') await noticeDialog(shell, { kicker: 'Gift link', title: 'This gift was already opened', text: 'Each gift link works once. Ask Louis for a new one if you think this is a mistake.' });
      else if (outcome.status === 'invalid') await noticeDialog(shell, { kicker: 'Gift link', title: 'That gift link did not work', text: outcome.message || 'The link may be incomplete. Check it and try again.' });
      // 'retry': the server was not reachable; the code stays stored and the next check tries again.
    } finally { pendingBusy = false; }
  }
  /* ---- plain notices: what happened to the progress made before the account, and a token the server dropped ---- */
  let noticeBusy = false;
  async function tryNotices(): Promise<void> {
    if (noticeBusy || disposed || !settled()) return;
    const view = economy.view();
    if (!services.account.current() || !view.ready || (view.gift && view.gift.state !== 'opened')) return;
    const outcome = services.takeOfferResult();
    if (!outcome) return;
    noticeBusy = true;
    try {
      await noticeDialog(shell, outcome === 'moved'
        ? { kicker: 'Your account', title: 'Your progress moved over', text: 'The Marks and items you collected on this device before you made an account are saved to your driver now.' }
        : { kicker: 'Your account', title: 'Your account starts fresh', text: 'The server did not take over the progress from before you had an account, so your driver starts from the beginning. Nothing else was lost.' });
    } finally { noticeBusy = false; }
  }
  // The server stopped accepting this device's token (signed in on too many devices, or the account was closed): say so once and start over at the sign in step.
  const wasSignedIn = services.account.current() !== null;
  const offAccount = services.account.subscribe(account => {
    if (account || !wasSignedIn || disposed || !services.account.takeExpiredNotice()) return;
    void noticeDialog(shell, { kicker: 'Signed out', title: 'You were signed out on this device', text: 'Sign in again with your driver name and recovery code. Your Marks and items are safe on the server.' }).then(() => { window.location.reload(); });
  });
  const check = (): void => { void tryPending(); void tryNotices(); };
  const offEconomy = economy.subscribe(check);
  const offScreen = deps.subscribeScreen(check);
  pendingTimer = setInterval(check, 4000);
  check();

  return {
    count: () => services.gifts.count(),
    openInbox, redeemCode,
    dispose() { disposed = true; offEconomy(); offScreen(); offAccount(); if (pendingTimer) clearInterval(pendingTimer); },
  };
}
