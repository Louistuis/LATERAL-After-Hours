/**
 * Boot of the self-hosted build: one place that owns the account, the server wallet, the gifts and the earn sources.
 *
 * Earn sources here: missions, the starter gift, the daily challenge, the server gift source and the testing bonus.
 * There is no per-run gameplay source, no tips and no creator grant: Marks cannot be bought and are not paid for
 * driving around. (A paid source would be added here later, next to the gift source, and judged by the server.)
 */
import { createDailyChallengeSource } from '../economy/daily-challenge';
import { createMissionsSource } from '../economy/missions';
import { createDeferredStore, createLocalWalletStore } from '../economy/stores';
import type { EarnSource, Economy, EconomyGameEvents, WalletStore } from '../economy/types';
import type { MissionContext } from '../economy/mission-catalog';
import { createEconomy } from '../economy/economy';
import { createWelcomeSource } from '../economy/welcome';
import { createAccountService, type AccountService, type AccountStorage } from './account';
import { captureGiftLink, createGiftsController, createServerGiftSource, type GiftsController } from './gifts';
import { createTestGrantSource } from './testgrant';
import { createServerWallet, type ServerWallet } from './wallet-store';

export const SELFHOST_WALLET_KEY = 'lateral:wallet:v1:selfhost';
const OFFERED_KEY = 'lateral:wallet:offered:v1';
export const OFFER_RESULT_KEY = 'lateral:wallet:offer-result:v1';

export type OfferOutcome = 'moved' | 'fresh';

export interface SelfhostServices {
  readonly account: AccountService;
  readonly wallet: ServerWallet;
  readonly gifts: GiftsController;
  /** Resolves once the first-run choice is made (an account exists, or the player plays without one). */
  readonly decided: Promise<void>;
  /** Called by the first-run step once the player has an account (and saved the recovery code) or chose to play without one. */
  decide(): void;
  /** True once the first-run choice has been made. */
  isDecided(): boolean;
  /** What happened to the progress the player made before they had an account, once. Null when nothing to say. */
  takeOfferResult(): OfferOutcome | null;
  dispose(): void;
}

export interface SelfhostServiceOptions {
  readonly account?: AccountService;
  readonly storage?: (AccountStorage & Storage) | null;
  readonly fetch?: typeof fetch;
}

function pickStorage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }

export function createSelfhostServices(options: SelfhostServiceOptions = {}): SelfhostServices {
  const storage = options.storage === undefined ? pickStorage() : options.storage;
  const account = options.account ?? createAccountService({ storage, fetch: options.fetch });
  const guestStore = createLocalWalletStore(`${SELFHOST_WALLET_KEY}:guest`, storage);
  const caches = new Map<string, WalletStore>();
  const cacheFor = (): WalletStore => {
    const id = account.current()?.accountId ?? 'guest';
    if (id === 'guest') return guestStore;
    let cache = caches.get(id);
    if (!cache) { cache = createLocalWalletStore(`${SELFHOST_WALLET_KEY}:${id}`, storage); caches.set(id, cache); }
    return cache;
  };
  const get = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const set = (key: string, value: string | null): void => { try { if (value === null) storage?.removeItem(key); else storage?.setItem(key, value); } catch { /* Not remembered. */ } };
  const offered = (): boolean => { const id = account.current()?.accountId; return !id || get(`${OFFERED_KEY}:${id}`) === '1'; };

  const wallet = createServerWallet({
    api: account.api,
    cache: cacheFor,
    // The wallet this device used before there was an account is offered once to the new account's wallet.
    get guest() { return offered() ? null : guestStore; },
    onGuestOutcome: outcome => { const id = account.current()?.accountId; if (id) set(`${OFFERED_KEY}:${id}`, '1'); set(OFFER_RESULT_KEY, outcome); },
  });
  const gifts = createGiftsController(wallet, storage);
  // A gift link must survive the driver name step: capture it before anything else can navigate.
  captureGiftLink(storage);

  let decide!: () => void;
  const decided = account.needsChoice() ? new Promise<void>(resolve => { decide = resolve; }) : Promise.resolve();
  if (!account.needsChoice()) decide = () => {};
  let settled = !account.needsChoice();
  void decided.then(() => { settled = true; });
  // A signed in player whose token the server no longer accepts is signed out in the background.
  void account.refresh();

  return {
    account, wallet, gifts, decided,
    decide: () => decide(),
    isDecided: () => settled,
    takeOfferResult() { const value = get(OFFER_RESULT_KEY); if (value === 'moved' || value === 'fresh') { set(OFFER_RESULT_KEY, null); return value; } return null; },
    dispose() { wallet.dispose(); },
  };
}

let shared: SelfhostServices | null = null;
/** The one set of services for this page. */
export function selfhostServices(): SelfhostServices { return (shared ??= createSelfhostServices()); }
export function resetSelfhostServices(): void { shared?.dispose(); shared = null; }

export interface SelfhostEconomyOptions {
  readonly game: EconomyGameEvents;
  readonly missionContext?: () => Partial<MissionContext>;
  readonly services?: SelfhostServices;
}

/** Sources of the self-hosted economy, in the order the sheet lists them. Exported for tests. */
export function selfhostSources(services: SelfhostServices, missionContext?: () => Partial<MissionContext>): EarnSource[] {
  return [
    createMissionsSource({ context: missionContext }),
    createWelcomeSource(),
    createDailyChallengeSource(),
    createServerGiftSource(services.gifts),
    createTestGrantSource(services.wallet, () => services.account.current() !== null),
  ];
}

export function bootSelfhostEconomy(options: SelfhostEconomyOptions): { economy: Economy; platform: 'selfhost' } {
  const services = options.services ?? selfhostServices();
  const store = createDeferredStore('selfhost', true, async () => {
    await services.decided;
    // No account: this device's own wallet, no server. With one: the server wallet (cache per account).
    return services.account.current() ? services.wallet.store : createLocalWalletStore(`${SELFHOST_WALLET_KEY}:guest`);
  });
  return { platform: 'selfhost', economy: createEconomy({ store, sources: selfhostSources(services, options.missionContext), game: options.game }) };
}
