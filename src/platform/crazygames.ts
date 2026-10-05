import type { AdRequest, AdResult, DataStore, PlatformAdapter, PlatformCapabilities, SemanticEvent, StoreRead, StoreWrite } from '../../contracts/runtime-contracts';
import { MAX_SAVE_BYTES, utf8Bytes } from '../save/envelope';

export type CrazyEnvironment = 'local' | 'crazygames' | 'disabled';
export interface CrazyGamesSdk {
  init(): Promise<void>;
  environment: CrazyEnvironment;
  game: { gameplayStart(): void; gameplayStop(): void };
  ad: { requestAd(kind: 'midgame' | 'rewarded', callbacks: { adStarted(): void; adFinished(): void; adError(error?: unknown, errorData?: unknown): void }): void };
  data?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}
const SDK_INIT_TIMEOUT_MS = 5_000;
const initialization = new WeakMap<CrazyGamesSdk, Promise<boolean>>();

/** Target-isolated v3 SDK adapter. It expects the build HTML to supply the SDK script. */
export function createCrazyGamesPlatformAdapter(target: 'crazygames-basic' | 'crazygames-full', sdk: CrazyGamesSdk | null = readCrazyGamesSdk()): PlatformAdapter {
  let available = false;
  let playing = false;
  let active: { id: string; settled: boolean; started: boolean; cancel(error: Error): void } | null = null;
  let disposed = false;
  let initializationResult: Promise<boolean> | null = null;
  let cancelInitialization: (() => void) | null = null;
  const seenOperationIds = new Set<string>();
  return {
    target,
    async initialize(): Promise<PlatformCapabilities> {
      if (!sdk || disposed) return capabilities(target, false);
      if (!initializationResult) {
        const cancelled = new Promise<boolean>(resolve => { cancelInitialization = () => resolve(false); });
        initializationResult = Promise.race([initializeCrazyGamesSdk(sdk), cancelled]).then(result => {
          cancelInitialization = null;
          available = result && !disposed;
          return available;
        });
      }
      return capabilities(target, await initializationResult);
    },
    handle(event: SemanticEvent) {
      if (disposed || !available || !sdk) return;
      if (event.type === 'activity' && event.active !== playing) {
        playing = event.active;
        try { if (playing) sdk.game.gameplayStart(); else sdk.game.gameplayStop(); } catch { /* Gameplay remains available if the host SDK fails. */ }
      } else if (event.type === 'run-finished' && playing) {
        playing = false;
        try { sdk.game.gameplayStop(); } catch { /* No-op after host SDK failure. */ }
      }
    },
    async requestAd(request: AdRequest, lifecycle): Promise<AdResult> {
      if (disposed) return unavailable(request.operationId, 'adapter-disposed');
      if (target !== 'crazygames-full') return unavailable(request.operationId, 'ads-disabled-basic-launch');
      if (!available || !sdk) return unavailable(request.operationId, 'sdk-unavailable');
      if (active) return unavailable(request.operationId, 'ad-operation-active');
      if (seenOperationIds.has(request.operationId)) return unavailable(request.operationId, 'duplicate-operation-id');
      if ((request.kind === 'rewarded') !== (request.reward !== null)) return unavailable(request.operationId, 'invalid-reward-request');
      return new Promise((resolve, reject) => {
        rememberOperationId(request.operationId, seenOperationIds);
        const operation = { id: request.operationId, settled: false, started: false, cancel: (error: Error) => reject(error) };
        active = operation;
        const terminal = (result: AdResult) => {
          if (active !== operation || operation.settled) return;
          operation.settled = true;
          active = null;
          resolve(result);
        };
        const callbacks = {
          adStarted() {
            if (active !== operation || operation.settled || operation.started) return;
            operation.started = true;
            lifecycle.onStarted(operation.id);
          },
          adFinished() {
            terminal({ operationId: operation.id, status: 'finished', rewardEligible: request.kind === 'rewarded' && operation.started });
          },
          adError(error?: unknown, errorData?: unknown) {
            const code = errorCode(errorData) ?? errorCode(error) ?? 'sdk-error';
            const unavailableCode = ['unfilled', 'adblock', 'adCooldown', 'adsDisabledBasicLaunch'].includes(code);
            terminal({ operationId: operation.id, status: unavailableCode ? 'unavailable' : 'failed', rewardEligible: false, errorCode: code });
          },
        };
        try { sdk.ad.requestAd(request.kind === 'rewarded' ? 'rewarded' : 'midgame', callbacks); }
        catch (error) {
          if (operation.started) return; // A thrown SDK call after adStarted is not proof that the overlay ended.
          terminal({ operationId: operation.id, status: 'failed', rewardEligible: false, errorCode: errorCode(error) ?? 'sdk-error' });
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelInitialization?.();
      available = false;
      playing = false;
      const pending = active;
      active = null;
      if (pending && !pending.settled) { pending.settled = true; pending.cancel(new Error('CrazyGames adapter disposed')); }
    },
  };
}

/** Full target uses only the initialized CrazyGames Data module; it never falls back to localStorage. */
export function createCrazyGamesDataStore(sdk: CrazyGamesSdk | null = readCrazyGamesSdk()): DataStore {
  let ready = false;
  let reason = 'CrazyGames SDK is unavailable';
  return {
    async initialize() {
      if (!sdk || !sdk.data) { ready = false; reason = 'CrazyGames Data module is unavailable'; return; }
      ready = await initializeCrazyGamesSdk(sdk);
      reason = ready ? '' : 'CrazyGames SDK initialization failed or is disabled in this environment';
    },
    async read(key): Promise<StoreRead> {
      if (!ready || !sdk?.data) return { status: 'unavailable', reason };
      try {
        const value = sdk.data.getItem(key);
        return value === null ? { status: 'missing' } : { status: 'found', serialized: value };
      } catch (error) { return { status: 'unavailable', reason: errorCode(error) ?? 'CrazyGames Data read failed' }; }
    },
    async write(key, serialized): Promise<StoreWrite> {
      if (!ready || !sdk?.data) return { status: 'unavailable', reason };
      if (utf8Bytes(serialized) > MAX_SAVE_BYTES) return { status: 'unavailable', reason: 'Save exceeds the 512 KiB limit' };
      try { sdk.data.setItem(key, serialized); return { status: 'written' }; }
      catch (error) { return { status: 'unavailable', reason: errorCode(error) ?? 'CrazyGames Data write failed' }; }
    },
    async flushPending() { /* SDK write acceptance does not guarantee remote synchronization. */ },
  };
}

function readCrazyGamesSdk(): CrazyGamesSdk | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { CrazyGames?: { SDK?: CrazyGamesSdk } }).CrazyGames?.SDK ?? null;
}
function initializeCrazyGamesSdk(sdk: CrazyGamesSdk): Promise<boolean> {
  let pending = initialization.get(sdk);
  if (!pending) {
    pending = new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };
      const timer = setTimeout(() => finish(false), SDK_INIT_TIMEOUT_MS);
      void Promise.resolve().then(() => sdk.init())
        .then(() => finish(sdk.environment === 'crazygames' || sdk.environment === 'local'), () => finish(false));
    });
    initialization.set(sdk, pending);
  }
  return pending;
}
function capabilities(target: 'crazygames-basic' | 'crazygames-full', available: boolean): PlatformCapabilities {
  return {
    interstitialAds: target === 'crazygames-full' && available,
    rewardedAds: target === 'crazygames-full' && available,
    authoritativeStore: target === 'crazygames-full' ? 'crazygames-data' : 'guarded-browser',
  };
}
function errorCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string') return value.code.slice(0, 80);
  return undefined;
}
function unavailable(operationId: string, errorCode: string): AdResult {
  return { operationId, status: 'unavailable', rewardEligible: false, errorCode };
}
function rememberOperationId(id: string, seen: Set<string>): void {
  seen.add(id);
  if (seen.size > 4096) seen.delete(seen.values().next().value as string);
}
