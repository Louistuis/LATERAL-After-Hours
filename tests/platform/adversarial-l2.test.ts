import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdLifecycle, AdRequest, PlatformCapabilities } from '../../contracts/runtime-contracts';
import { createCrazyGamesPlatformAdapter, type CrazyGamesSdk } from '../../src/platform/crazygames';
import { createPokiPlatformAdapter, type PokiSdk } from '../../src/platform/poki';

const request = (operationId: string): AdRequest => ({ operationId, kind: 'rewarded', placement: 'event-results-return', reward: { id: 'credits', kind: 'garage-credits', amount: 10 } });
type CrazyCallbacks = Parameters<CrazyGamesSdk['ad']['requestAd']>[1];
const lifecycle = (): AdLifecycle => ({ onStarted: vi.fn() });
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeCrazy(overrides: Partial<CrazyGamesSdk> = {}) {
  const callbacks: CrazyCallbacks[] = [];
  const requestAd = vi.fn((_kind: 'midgame' | 'rewarded', value: CrazyCallbacks) => { callbacks.push(value); });
  const sdk: CrazyGamesSdk = {
    init: async () => {}, environment: 'local', game: { gameplayStart() {}, gameplayStop() {} }, ad: { requestAd },
    ...overrides,
  };
  return { sdk, callbacks, requestAd };
}

function fakePoki(overrides: Partial<PokiSdk> = {}): PokiSdk {
  return { init: async () => {}, gameLoadingFinished() {}, gameplayStart() {}, gameplayStop() {},
    commercialBreak: async () => {}, rewardedBreak: async () => true, ...overrides };
}

describe('L2 adversarial portal SDK lifecycle', () => {
  it('times out a never-settling Poki initialization to unavailable', async () => {
    vi.useFakeTimers();
    const init = deferred<void>();
    const adapter = createPokiPlatformAdapter(fakePoki({ init: () => init.promise }));
    let capabilities: PlatformCapabilities | undefined;
    let settled = false;
    const pendingInit = adapter.initialize().then(value => { capabilities = value; settled = true; });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(true);
    expect(capabilities).toMatchObject({ interstitialAds: false, rewardedAds: false });
    await expect(adapter.requestAd(request('poki-init-pending'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
    adapter.dispose();
    init.resolve();
    await pendingInit;
  });

  it('times out a never-settling CrazyGames initialization to unavailable', async () => {
    vi.useFakeTimers();
    const init = deferred<void>();
    const adapter = createCrazyGamesPlatformAdapter('crazygames-full', fakeCrazy({ init: () => init.promise }).sdk);
    let capabilities: PlatformCapabilities | undefined;
    let settled = false;
    const pendingInit = adapter.initialize().then(value => { capabilities = value; settled = true; });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(true);
    expect(capabilities).toMatchObject({ interstitialAds: false, rewardedAds: false });
    await expect(adapter.requestAd(request('cg-init-pending'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
    adapter.dispose();
    init.resolve();
    await pendingInit;
  });

  it.each(['poki', 'crazygames'] as const)('does not advertise initialized capabilities after dispose during pending %s init', async target => {
    const init = deferred<void>();
    const adapter = target === 'poki'
      ? createPokiPlatformAdapter(fakePoki({ init: () => init.promise }))
      : createCrazyGamesPlatformAdapter('crazygames-full', fakeCrazy({ init: () => init.promise }).sdk);
    const pendingInit = adapter.initialize();
    adapter.dispose();
    await expect(pendingInit).resolves.toMatchObject({ interstitialAds: false, rewardedAds: false });
    init.resolve();
    await expect(adapter.requestAd(request(`${target}-after-dispose-init`), lifecycle())).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
  });

  it('returns a failed Poki request for rejection before start and clears its mutex', async () => {
    const adapter = createPokiPlatformAdapter(fakePoki({ rewardedBreak: async () => { throw new Error('pre-start'); } }));
    await adapter.initialize();
    await expect(adapter.requestAd(request('poki-pre-start-failure'), lifecycle())).resolves.toMatchObject({ status: 'failed', rewardEligible: false });
    await expect(adapter.requestAd(request('poki-after-pre-start-failure'), lifecycle())).resolves.toMatchObject({ status: 'failed', rewardEligible: false });
    adapter.dispose();
  });

  it('returns a failed CrazyGames request for synchronous rejection before start and clears its mutex', async () => {
    const fake = fakeCrazy();
    fake.requestAd.mockImplementationOnce(() => { throw new Error('pre-start'); });
    const adapter = createCrazyGamesPlatformAdapter('crazygames-full', fake.sdk);
    await adapter.initialize();
    await expect(adapter.requestAd(request('cg-pre-start-failure'), lifecycle())).resolves.toMatchObject({ status: 'failed', rewardEligible: false });
    const pending = adapter.requestAd(request('cg-after-pre-start-failure'), lifecycle());
    fake.callbacks[0]?.adFinished();
    await expect(pending).resolves.toMatchObject({ status: 'finished', rewardEligible: false });
    adapter.dispose();
  });

  it('keeps a Poki request locked after rejection following actual start until dispose', async () => {
    const ad = deferred<boolean>();
    let onStart: (() => void) | undefined;
    const sdk = fakePoki({ rewardedBreak: start => { onStart = start; return ad.promise; } });
    const adapter = createPokiPlatformAdapter(sdk);
    await adapter.initialize();
    const life = lifecycle();
    const pending = adapter.requestAd(request('poki-post-start-rejection'), life);
    onStart?.();
    ad.reject(new Error('rejected after start'));
    await expect(pending).rejects.toThrow('rejected after start');
    expect(life.onStarted).toHaveBeenCalledOnce();
    await expect(adapter.requestAd(request('poki-still-live'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', errorCode: 'ad-operation-active' });
    adapter.dispose();
  });

  it('keeps CrazyGames pending after throw following actual start, then ignores stale callbacks on dispose', async () => {
    let callbacks: CrazyCallbacks | undefined;
    const sdk = fakeCrazy();
    sdk.requestAd.mockImplementationOnce((_kind, received) => { callbacks = received; received.adStarted(); throw new Error('throw after start'); });
    const adapter = createCrazyGamesPlatformAdapter('crazygames-full', sdk.sdk);
    await adapter.initialize();
    const life = lifecycle();
    const pending = adapter.requestAd(request('cg-post-start-throw'), life);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(life.onStarted).toHaveBeenCalledOnce();
    await expect(adapter.requestAd(request('cg-still-live'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', errorCode: 'ad-operation-active' });
    adapter.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    callbacks?.adFinished();
    callbacks?.adError('late');
  });

  it('requires Poki actual start as well as successful completion before marking reward eligible', async () => {
    const adapter = createPokiPlatformAdapter(fakePoki({ rewardedBreak: async () => true }));
    await adapter.initialize();
    const life = lifecycle();
    await expect(adapter.requestAd(request('poki-finish-without-start'), life)).resolves.toMatchObject({ status: 'finished', rewardEligible: false });
    expect(life.onStarted).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('does not reward CrazyGames finish without start or error after start; only start plus finish qualifies', async () => {
    const fake = fakeCrazy();
    const adapter = createCrazyGamesPlatformAdapter('crazygames-full', fake.sdk);
    await adapter.initialize();
    const noStart = adapter.requestAd(request('cg-finish-without-start'), lifecycle());
    fake.callbacks[0]!.adFinished();
    await expect(noStart).resolves.toMatchObject({ status: 'finished', rewardEligible: false });
    const failed = adapter.requestAd(request('cg-start-then-error'), lifecycle());
    fake.callbacks[1]!.adStarted();
    fake.callbacks[1]!.adError({ code: 'playback-error' });
    await expect(failed).resolves.toMatchObject({ status: 'failed', rewardEligible: false });
    const successLife = lifecycle();
    const success = adapter.requestAd(request('cg-start-and-finish'), successLife);
    let successSettled = false;
    void success.then(() => { successSettled = true; });
    fake.callbacks[0]!.adStarted();
    fake.callbacks[0]!.adFinished();
    fake.callbacks[0]!.adError({ code: 'stale' });
    await Promise.resolve();
    expect(successSettled).toBe(false);
    expect(successLife.onStarted).not.toHaveBeenCalled();
    fake.callbacks[2]!.adStarted();
    fake.callbacks[2]!.adFinished();
    fake.callbacks[2]!.adFinished();
    await expect(success).resolves.toMatchObject({ status: 'finished', rewardEligible: true });
    expect(successLife.onStarted).toHaveBeenCalledOnce();
    await expect(adapter.requestAd(request('cg-start-and-finish'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', errorCode: 'duplicate-operation-id' });
    adapter.dispose();
  });

  it('disposal during a pending Poki ad fails without reward and ignores later start/completion callbacks', async () => {
    const ad = deferred<boolean>();
    let onStart: (() => void) | undefined;
    const adapter = createPokiPlatformAdapter(fakePoki({ rewardedBreak: start => { onStart = start; return ad.promise; } }));
    await adapter.initialize();
    const life = lifecycle();
    const pending = adapter.requestAd(request('poki-dispose-pending-ad'), life);
    adapter.dispose();
    await expect(pending).resolves.toMatchObject({ status: 'failed', rewardEligible: false });
    onStart?.();
    ad.resolve(true);
    expect(life.onStarted).not.toHaveBeenCalled();
    await expect(adapter.requestAd(request('poki-after-dispose'), lifecycle())).resolves.toMatchObject({ status: 'unavailable', errorCode: 'adapter-disposed' });
  });
});
