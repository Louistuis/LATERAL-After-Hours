import type { AdRequest, AdResult, PlatformAdapter, PlatformCapabilities, SemanticEvent } from '../../contracts/runtime-contracts';

export interface PokiSdk {
  init(): Promise<void>;
  gameLoadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  commercialBreak(onStart?: () => void): Promise<void>;
  rewardedBreak(onStart?: () => void): Promise<boolean>;
}
const SDK_INIT_TIMEOUT_MS = 5_000;

/** Uses an SDK supplied by the target HTML. This module never downloads or injects SDK code. */
export function createPokiPlatformAdapter(sdk: PokiSdk | null = readPokiSdk()): PlatformAdapter {
  let initialized = false;
  let failed = false;
  let playing = false;
  let loadingFinished = false;
  let active: { id: string; settled: boolean; cancel(error: Error): void } | null = null;
  let disposed = false;
  let initialization: Promise<boolean> | null = null;
  let cancelInitialization: (() => void) | null = null;
  const seenOperationIds = new Set<string>();
  return {
    target: 'poki',
    async initialize(): Promise<PlatformCapabilities> {
      if (!sdk || disposed) { failed = true; return capabilities(false); }
      if (!initialization) {
        initialization = new Promise<boolean>(resolve => {
          let settled = false;
          const finish = (available: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancelInitialization = null;
            resolve(available && !disposed);
          };
          const timer = setTimeout(() => finish(false), SDK_INIT_TIMEOUT_MS);
          cancelInitialization = () => finish(false);
          void Promise.resolve().then(() => sdk.init()).then(() => finish(true), () => finish(false));
        }).then(available => {
          initialized = available && !disposed;
          failed = !initialized;
          return initialized;
        });
      }
      return capabilities(await initialization);
    },
    handle(event: SemanticEvent) {
      if (disposed || !initialized || failed) return;
      try {
        if (event.type === 'first-playable' && !loadingFinished) {
          loadingFinished = true;
          sdk!.gameLoadingFinished();
        } else if (event.type === 'activity' && event.active !== playing) {
          playing = event.active;
          if (playing) sdk!.gameplayStart(); else sdk!.gameplayStop();
        } else if (event.type === 'run-finished' && playing) {
          playing = false;
          sdk!.gameplayStop();
        }
      } catch { /* SDK failure must not prevent offline play. */ }
    },
    async requestAd(request: AdRequest, lifecycle): Promise<AdResult> {
      if (disposed) return unavailable(request.operationId, 'adapter-disposed');
      if (!initialized || failed) return unavailable(request.operationId, 'sdk-unavailable');
      if (active) return unavailable(request.operationId, 'ad-operation-active');
      if (seenOperationIds.has(request.operationId)) return unavailable(request.operationId, 'duplicate-operation-id');
      if ((request.kind === 'rewarded') !== (request.reward !== null)) return unavailable(request.operationId, 'invalid-reward-request');
      rememberOperationId(request.operationId, seenOperationIds);
      let cancel!: (error: Error) => void;
      const disposedPromise = new Promise<never>((_resolve, reject) => { cancel = reject; });
      const operation = { id: request.operationId, settled: false, cancel: (error: Error) => cancel(error) };
      active = operation;
      let started = false;
      const onStart = () => {
        if (active !== operation || operation.settled || started) return;
        started = true;
        lifecycle.onStarted(operation.id);
      };
      try {
        if (request.kind === 'interstitial') {
          await Promise.race([sdk!.commercialBreak(onStart), disposedPromise]);
          if (active !== operation || operation.settled) return unavailable(request.operationId, 'stale-operation');
          operation.settled = true;
          active = null;
          return { operationId: request.operationId, status: 'finished', rewardEligible: false };
        }
        const eligible = await Promise.race([sdk!.rewardedBreak(onStart), disposedPromise]);
        if (active !== operation || operation.settled) return unavailable(request.operationId, 'stale-operation');
        operation.settled = true;
        active = null;
        return { operationId: request.operationId, status: 'finished', rewardEligible: started && eligible === true };
      } catch (error) {
        if (started) throw error;
        if (active === operation) { operation.settled = true; active = null; }
        return { operationId: request.operationId, status: 'failed', rewardEligible: false, errorCode: 'sdk-error' };
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelInitialization?.();
      initialized = false;
      failed = true;
      playing = false;
      const pending = active;
      active = null;
      if (pending && !pending.settled) { pending.settled = true; pending.cancel(new Error('Poki adapter disposed')); }
    },
  };
}

function readPokiSdk(): PokiSdk | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { PokiSDK?: PokiSdk }).PokiSDK ?? null;
}
function capabilities(available: boolean): PlatformCapabilities {
  return { interstitialAds: available, rewardedAds: available, authoritativeStore: 'guarded-browser' };
}
function unavailable(operationId: string, errorCode: string): AdResult {
  return { operationId, status: 'unavailable', rewardEligible: false, errorCode };
}
function rememberOperationId(id: string, seen: Set<string>): void {
  seen.add(id);
  if (seen.size > 4096) seen.delete(seen.values().next().value as string);
}
