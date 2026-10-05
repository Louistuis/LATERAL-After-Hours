/**
 * Starter gift: a gift "from Louis" that every wallet opens once. It holds WELCOME_MARKS (1,500 Marks) and every free
 * item a new player starts with (the stock car, paint, wheels and horn: starterGiftItems()).
 *
 * States per wallet: 'unopened' then 'opened'.
 *   - Opening is what pays the Marks, not loading the game. The Marks go through the wallet like any accrued grant, so the
 *     same rules apply: idempotent (the permanent claim `welcome:gift` is the opened flag, so a reload, a second tab or a
 *     copy of the wallet can not pay it twice and wallets that were already paid count as opened), bounded (the source
 *     ceiling is WELCOME_MARKS for every wallet age, so a forged `earned.welcome` above it is ignored) and part of the
 *     budget every player is verified against (remote-verify.ts), so purchases made with the gift are never locked.
 *   - The stock items stay usable before the gift is opened (they cost nothing, so the wallet always allows them). The
 *     gift is presentation: until it is opened the shop and garage show them as "in your gift".
 *   - Once opened on a device it never shows again, whatever the wallet does: open() writes a device flag (localStorage,
 *     GIFT_FLAG_KEY) before anything async, and the flag is also written whenever the wallet is seen to hold the claim.
 *     state() is 'opened' when the flag OR the claim says so, so a slow, offline or failing wallet (or a failed remote save)
 *     can not bring the reveal back. A flagged device whose wallet lacks the claim is paid in the background.
 *   - Never a soft lock: open() marks the gift opened on this device at once, then keeps retrying the Marks grant in the
 *     background if the wallet is slow or unreachable (`pending()` says so). The player never waits on the network.
 * The source is silent: it never appears in Get Marks.
 */
import { ITEMS } from './catalog';
import type { EarnSource, EarnSourceContext, GiftOpenResult } from './types';

export const WELCOME_MARKS = 1500;
/** Grant key inside the `welcome` source (the wallet stores it as `welcome:gift`). */
export const WELCOME_KEY = 'gift';
/** The permanent claim key kept in the wallet record: its presence means the gift was opened. */
export const WELCOME_CLAIM = `welcome:${WELCOME_KEY}`;
/** Device flag (localStorage): the gift was opened on this device. Kept apart from the wallet so no wallet state can undo it. */
export const GIFT_FLAG_KEY = 'lateral:starter-gift:v1';

/** Every free (price 0, shown in the shop) catalog id: the car first, then the cosmetics in catalog order. */
export function starterGiftItems(): readonly string[] {
  const free = ITEMS.filter(entry => entry.price === 0 && !entry.hidden);
  return [...free.filter(entry => entry.kind === 'car'), ...free.filter(entry => entry.kind !== 'car')].map(entry => entry.id);
}

export interface WelcomeSource extends EarnSource {
  /** 'opened' once the wallet holds the claim, or the player opened the gift on this device. */
  state(): 'unopened' | 'opened';
  /** Opened on this device but the wallet has not paid the Marks yet (the grant keeps retrying). */
  pending(): boolean;
  /** The wallet was seen to hold the claim: remember it on this device too (idempotent, cheap). */
  markOpened(): void;
  /** Opens the gift: marks it opened at once and pays the Marks (idempotent; safe to call twice). */
  open(): Promise<GiftOpenResult>;
}

export interface WelcomeOptions {
  /** Retry delays in ms after a failed grant (the last one repeats). Default 5 s, 20 s, 60 s. */
  readonly retryMs?: readonly number[];
  /** How long open() waits for the wallet before it reports `pending` and carries on. Default 2500 ms. */
  readonly waitMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  /** Where the device flag lives. Default: localStorage (null when blocked). Tests pass a fake; null disables it. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function deviceStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function createWelcomeSource(options: WelcomeOptions = {}): WelcomeSource {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const retryMs = options.retryMs?.length ? options.retryMs : [5000, 20000, 60000];
  const waitMs = options.waitMs ?? 2500;
  const storage = options.storage === undefined ? deviceStorage() : options.storage;
  const readFlag = (): boolean => { try { return storage?.getItem(GIFT_FLAG_KEY) === '1'; } catch { return false; } };
  let flagged = readFlag();
  /** Remembers on this device that the gift was opened (before anything async). */
  const remember = (): void => {
    if (flagged) return;
    flagged = true;
    try { storage?.setItem(GIFT_FLAG_KEY, '1'); } catch { /* Blocked storage: the wallet claim and this session still hold it. */ }
  };
  const listeners = new Set<() => void>();
  let context: EarnSourceContext | null = null;
  let openedHere = false, disposed = false, paying: Promise<boolean> | null = null, retry = 0;
  let attachedNow!: (context: EarnSourceContext) => void;
  const attached = new Promise<EarnSourceContext>(resolve => { attachedNow = resolve; });
  const emit = (): void => { for (const listener of listeners) listener(); };
  const claimed = (): boolean => Boolean(context?.wallet.claimed?.(WELCOME_CLAIM));

  /** Asks the wallet to pay once. Resolves true when the wallet holds the claim afterwards. */
  const pay = (): Promise<boolean> => {
    if (paying) return paying;
    paying = (async () => {
      try {
        const ctx = context ?? await attached;
        const result = await ctx.wallet.grant({ source: 'welcome', key: WELCOME_KEY, amount: WELCOME_MARKS, reason: 'Starter gift', permanent: true });
        if (result.granted > 0 || result.duplicate) { retry = 0; return true; }
        return claimed();
      } catch { return false; }
    })().finally(() => { paying = null; emit(); });
    return paying;
  };
  const keepTrying = (): void => {
    if (disposed || claimed()) return;
    schedule(() => {
      if (disposed || claimed()) return;
      void pay().then(done => { if (!done) keepTrying(); });
    }, retryMs[Math.min(retry++, retryMs.length - 1)]!);
  };

  return {
    id: 'welcome', kind: 'accrued', label: 'Starter gift', silent: true,
    maxGrant: WELCOME_MARKS,
    ceiling: () => WELCOME_MARKS,
    available: () => false,
    attach(next: EarnSourceContext) {
      context = next;
      attachedNow(next);
      // Opened here before the wallet was ready: pay as soon as it is.
      if ((openedHere || flagged) && !claimed()) void pay().then(done => { if (!done) keepTrying(); });
      emit();
      return () => { disposed = true; context = null; };
    },
    offers: () => [],
    state: () => (openedHere || flagged || claimed() ? 'opened' : 'unopened'),
    pending: () => (openedHere || flagged) && !claimed(),
    markOpened: remember,
    async open(): Promise<GiftOpenResult> {
      if (disposed) return { ok: false, message: 'The game is closing.' };
      const first = !openedHere && !flagged && !claimed();
      openedHere = true;
      remember();
      if (first) emit();
      if (claimed()) return { ok: true, granted: 0, pending: false };
      const settled = await Promise.race([pay(), new Promise<'wait'>(resolve => { schedule(() => resolve('wait'), waitMs); })]);
      if (settled === true) return { ok: true, granted: first ? WELCOME_MARKS : 0, pending: false };
      if (!claimed()) keepTrying();
      return { ok: true, granted: 0, pending: !claimed() };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; listeners.clear(); context = null; },
  };
}
