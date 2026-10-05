/**
 * The testing bonus: one tap, once per account, 20,000 Marks (the amount and whether it is open come from the server,
 * GET /api/v1/config). It is the only thing in the "Earn Marks" sheet that pays out; everything else is missions.
 *
 * Sheet states, decided by `offerState`:
 *   hidden    the server says the bonus is closed (or switched off): the sheet shows only the missions button
 *   claimable one tap
 *   claimed   shows "Claimed" and nothing to tap
 * The amount is never chosen here: the server writes it into the wallet (earned.testgrant, claim key test:grant).
 */
import type { EarnOffer, EarnSource, EarnSourceContext, RedeemResult } from '../economy/types';
import type { ServerWallet, TestGrantConfig } from './wallet-store';

export const TEST_GRANT_SOURCE = 'testgrant';
export const TEST_GRANT_CLAIM = 'testgrant:test:grant';
export const TEST_GRANT_OFFER = 'claim';

export type TestGrantState = 'hidden' | 'claimable' | 'claimed';

export function offerState(config: TestGrantConfig | null, claimed: boolean): TestGrantState {
  if (!config || !config.open || config.marks <= 0) return 'hidden';
  return claimed ? 'claimed' : 'claimable';
}

export interface TestGrantSource extends EarnSource { state(): TestGrantState }

export function createTestGrantSource(wallet: Pick<ServerWallet, 'config' | 'onConfig' | 'loadConfig' | 'claimTestGrant'>, signedIn: () => boolean = () => true): TestGrantSource {
  const listeners = new Set<() => void>();
  let context: EarnSourceContext | null = null;
  let claimedHere = false;
  let busy = false;
  const emit = (): void => { for (const listener of [...listeners]) listener(); };
  // The economy calls walletChanged() after every change it makes, and listens to this source: only a real change may emit.
  let shown = '';
  const emitIfChanged = (): void => { const key = `${state()}|${busy}|${wallet.config()?.marks ?? 0}`; if (key !== shown) { shown = key; emit(); } };
  const offConfig = wallet.onConfig(() => emitIfChanged());
  const claimed = (): boolean => claimedHere || Boolean(context?.wallet.claimed?.(TEST_GRANT_CLAIM));
  // The bonus is written into an account's wallet on the server, so a player without an account does not see it.
  const state = (): TestGrantState => (signedIn() ? offerState(wallet.config(), claimed()) : 'hidden');
  const fmt = (n: number): string => n.toLocaleString('en-US');
  void wallet.loadConfig().catch(() => null);
  return {
    id: TEST_GRANT_SOURCE, kind: 'accrued', label: 'Testing bonus',
    // The server writes this source (the amount is not the client's to choose); the client never grants it.
    maxGrant: 0,
    disclosure: 'This is a testing bonus while the game is being tried out. Everything else is earned from missions.',
    available: () => state() === 'claimable',
    attach(next) { context = next; emitIfChanged(); return () => { context = null; }; },
    walletChanged() { emitIfChanged(); },
    state,
    offers(): readonly EarnOffer[] {
      const s = state();
      const marks = wallet.config()?.marks ?? 0;
      if (s === 'hidden') return [];
      return [{
        id: TEST_GRANT_OFFER, title: `Testing bonus: claim ${fmt(marks)} Marks`, detail: 'A thank you for testing. One time only.',
        marks, cta: `Claim ${fmt(marks)} Marks`, unavailable: s === 'claimed' ? 'Claimed' : busy ? 'Claiming' : null,
      }];
    },
    async redeem(offerId): Promise<RedeemResult> {
      if (offerId !== TEST_GRANT_OFFER || busy) return { status: 'cancelled' };
      if (state() !== 'claimable') return { status: 'failed', message: state() === 'claimed' ? 'Already claimed.' : 'The testing bonus is closed.' };
      busy = true; emitIfChanged();
      try {
        const result = await wallet.claimTestGrant();
        if (!result.ok) {
          // The server may say it was already taken (another device): that is the Claimed state, not an error.
          if (/already|claimed/i.test(result.code + result.message)) { claimedHere = true; emitIfChanged(); return { status: 'failed', message: 'Already claimed.' }; }
          return { status: 'failed', message: result.message };
        }
        claimedHere = true;
        // The server answers 0 when this account had already taken it (another device, another tab).
        if (result.marks <= 0) { emitIfChanged(); return { status: 'failed', message: 'Already claimed.' }; }
        return { status: 'granted', marks: result.marks, message: result.marks > 0 ? `+${fmt(result.marks)} Marks added. Enjoy testing.` : 'Marks added.' };
      } finally { busy = false; emitIfChanged(); }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { offConfig(); listeners.clear(); context = null; },
  };
}
