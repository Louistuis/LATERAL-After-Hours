import type { AdRequest, AdResult, PlatformAdapter, PlatformCapabilities, PlatformTarget, SemanticEvent } from '../../contracts/runtime-contracts';

/** Offline owner/standalone adapter: no scripts, SDK globals, ads, or remote calls. */
export function createOfflinePlatformAdapter(target: Extract<PlatformTarget, 'owner-review' | 'standalone' | 'selfhost'>): PlatformAdapter {
  return {
    target,
    async initialize(): Promise<PlatformCapabilities> {
      return { interstitialAds: false, rewardedAds: false, authoritativeStore: 'guarded-browser' };
    },
    handle(_event: SemanticEvent) { /* No platform service is connected. */ },
    async requestAd(request: AdRequest): Promise<AdResult> {
      return { operationId: request.operationId, status: 'unavailable', rewardEligible: false, errorCode: 'offline-target' };
    },
    dispose() { /* No external resources to release. */ },
  };
}

export function isOfflineTarget(target: PlatformTarget): target is 'owner-review' | 'standalone' | 'selfhost' {
  return target === 'owner-review' || target === 'standalone' || target === 'selfhost';
}
