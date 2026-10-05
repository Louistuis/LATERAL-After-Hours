import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflinePlatformAdapter } from '../../src/platform/offline';

afterEach(() => vi.unstubAllGlobals());

describe('offline platform adapter', () => {
  it('treats the self-hosted build as an offline target (no portal SDK, no ads)', async () => {
    const { isOfflineTarget } = await import('../../src/platform/offline');
    expect(isOfflineTarget('selfhost')).toBe(true);
    expect(isOfflineTarget('standalone')).toBe(true);
    expect(isOfflineTarget('poki')).toBe(false);
    expect(isOfflineTarget('crazygames-full')).toBe(false);
  });

  it('exposes no ad capability and does not synthesize an ad-start callback', async () => {
    const adapter = createOfflinePlatformAdapter('owner-review');
    expect(await adapter.initialize()).toEqual({ interstitialAds: false, rewardedAds: false, authoritativeStore: 'guarded-browser' });
    const onStarted = vi.fn();
    await expect(adapter.requestAd({ operationId: 'op-1', kind: 'rewarded', placement: 'event-results-return', reward: { id: 'credit', kind: 'garage-credits', amount: 10 } }, { onStarted })).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false, operationId: 'op-1' });
    expect(onStarted).not.toHaveBeenCalled();
  });
});
