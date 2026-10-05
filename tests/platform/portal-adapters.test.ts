import { describe, expect, it, vi } from 'vitest';
import type { AdLifecycle, AdRequest } from '../../contracts/runtime-contracts';
import { createCrazyGamesDataStore, createCrazyGamesPlatformAdapter, type CrazyGamesSdk } from '../../src/platform/crazygames';
import { createPokiPlatformAdapter, type PokiSdk } from '../../src/platform/poki';

const rewarded: AdRequest = { operationId: 'reward-1', kind: 'rewarded', placement: 'event-results-return', reward: { id: 'credits', kind: 'garage-credits', amount: 10 } };

describe('portal adapter callback guards', () => {
  it('deduplicates Poki activity and ad-start notifications and ignores callbacks from settled requests', async () => {
    let adStarted: (() => void) | undefined;
    const sdk: PokiSdk = {
      init: vi.fn(async () => {}), gameLoadingFinished: vi.fn(), gameplayStart: vi.fn(), gameplayStop: vi.fn(),
      commercialBreak: vi.fn(async start => { adStarted = start; start?.(); start?.(); }),
      rewardedBreak: vi.fn(async start => { adStarted = start; start?.(); start?.(); return true; }),
    };
    const adapter = createPokiPlatformAdapter(sdk);
    expect((await adapter.initialize()).rewardedAds).toBe(true);
    adapter.handle({ type: 'activity', active: true, context: 'drive' });
    adapter.handle({ type: 'activity', active: true, context: 'drive' });
    adapter.handle({ type: 'first-playable', firstPlayableTransferBytes: 1 });
    adapter.handle({ type: 'first-playable', firstPlayableTransferBytes: 1 });
    expect(sdk.gameplayStart).toHaveBeenCalledTimes(1);
    expect(sdk.gameLoadingFinished).toHaveBeenCalledTimes(1);
    const lifecycle: AdLifecycle = { onStarted: vi.fn() };
    await expect(adapter.requestAd(rewarded, lifecycle)).resolves.toMatchObject({ status: 'finished', rewardEligible: true });
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(1);
    await expect(adapter.requestAd(rewarded, lifecycle)).resolves.toMatchObject({ status: 'unavailable', errorCode: 'duplicate-operation-id' });
    const oldStarted = adStarted;
    const nextSdkRequest = adapter.requestAd({ ...rewarded, operationId: 'reward-2' }, lifecycle);
    oldStarted?.();
    await expect(nextSdkRequest).resolves.toMatchObject({ status: 'finished', rewardEligible: true });
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(2);
  });

  it('keeps CrazyGames Basic ads unavailable and ignores duplicate/stale Full callbacks', async () => {
    const basicSdk = fakeCrazySdk();
    const basic = createCrazyGamesPlatformAdapter('crazygames-basic', basicSdk.sdk);
    await basic.initialize();
    await expect(basic.requestAd(rewarded, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
    expect(basicSdk.requestAd).not.toHaveBeenCalled();

    const fullSdk = fakeCrazySdk();
    const full = createCrazyGamesPlatformAdapter('crazygames-full', fullSdk.sdk);
    expect((await full.initialize()).rewardedAds).toBe(true);
    const lifecycle: AdLifecycle = { onStarted: vi.fn() };
    const first = full.requestAd(rewarded, lifecycle);
    fullSdk.adCallbacks[0].adStarted();
    fullSdk.adCallbacks[0].adStarted();
    fullSdk.adCallbacks[0].adFinished();
    fullSdk.adCallbacks[0].adFinished();
    await expect(first).resolves.toMatchObject({ status: 'finished', rewardEligible: true });
    await expect(full.requestAd(rewarded, lifecycle)).resolves.toMatchObject({ status: 'unavailable', errorCode: 'duplicate-operation-id' });
    const second = full.requestAd({ ...rewarded, operationId: 'reward-2' }, lifecycle);
    fullSdk.adCallbacks[0].adError({ code: 'late-error' });
    fullSdk.adCallbacks[1].adError({ code: 'unfilled' });
    await expect(second).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false, errorCode: 'unfilled' });
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing-callback request locked without a timeout and rejects it only on teardown', async () => {
    let callbacks: { adStarted(): void; adFinished(): void; adError(error?: unknown, data?: unknown): void } | undefined;
    const fullSdk = fakeCrazySdk();
    const sdk: CrazyGamesSdk = { ...fullSdk.sdk, ad: { requestAd: (_kind, value) => { callbacks = value; } } };
    const adapter = createCrazyGamesPlatformAdapter('crazygames-full', sdk);
    await adapter.initialize();
    const pending = adapter.requestAd(rewarded, { onStarted: vi.fn() });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(adapter.requestAd({ ...rewarded, operationId: 'another-op' }, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'unavailable', errorCode: 'ad-operation-active' });
    adapter.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    callbacks?.adFinished();
    await expect(adapter.requestAd({ ...rewarded, operationId: 'after-dispose' }, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'unavailable', errorCode: 'adapter-disposed' });
  });

  it('holds the Poki adapter lock if the SDK rejects after a genuine ad start, until teardown', async () => {
    let started: (() => void) | undefined;
    let rejectAd!: (error: Error) => void;
    const sdk: PokiSdk = {
      ...fakePoki(),
      rewardedBreak: onStart => {
        started = onStart;
        return new Promise<boolean>((_resolve, reject) => { rejectAd = reject; });
      },
    };
    const adapter = createPokiPlatformAdapter(sdk);
    await adapter.initialize();
    const pending = adapter.requestAd(rewarded, { onStarted: vi.fn() });
    started?.();
    rejectAd(new Error('ambiguous SDK rejection'));
    await expect(pending).rejects.toThrow(/ambiguous SDK rejection/);
    await expect(adapter.requestAd({ ...rewarded, operationId: 'next-op' }, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'unavailable', errorCode: 'ad-operation-active' });
    adapter.dispose();
  });

  it('fails open to normal gameplay if Poki initialization rejects', async () => {
    const sdk = { ...fakePoki(), init: vi.fn(async () => { throw new Error('offline'); }) } as PokiSdk;
    const adapter = createPokiPlatformAdapter(sdk);
    expect(await adapter.initialize()).toMatchObject({ interstitialAds: false, rewardedAds: false });
    await expect(adapter.requestAd(rewarded, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
  });

  it('never grants Poki reward eligibility without a genuine onStart callback', async () => {
    const sdk: PokiSdk = { ...fakePoki(), rewardedBreak: async () => true };
    const adapter = createPokiPlatformAdapter(sdk);
    await adapter.initialize();
    await expect(adapter.requestAd(rewarded, { onStarted: vi.fn() })).resolves.toMatchObject({ status: 'finished', rewardEligible: false });
  });

  it.each(['poki', 'crazygames'] as const)('does not let a late %s init reactivate a disposed adapter', async target => {
    let finishInit!: () => void;
    const pendingInit = new Promise<void>(resolve => { finishInit = resolve; });
    const adapter = target === 'poki'
      ? createPokiPlatformAdapter({ ...fakePoki(), init: () => pendingInit })
      : createCrazyGamesPlatformAdapter('crazygames-full', { ...fakeCrazySdk().sdk, init: () => pendingInit });
    const initialized = adapter.initialize();
    adapter.dispose();
    await expect(initialized).resolves.toMatchObject({ interstitialAds: false, rewardedAds: false });
    finishInit();
    await Promise.resolve();
    await expect(adapter.initialize()).resolves.toMatchObject({ interstitialAds: false, rewardedAds: false });
    await expect(adapter.requestAd({ ...rewarded, operationId: `${target}-late-init` }, { onStarted: vi.fn() }))
      .resolves.toMatchObject({ status: 'unavailable', rewardEligible: false });
  });

  it('bounds a never-settling portal initialization', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createPokiPlatformAdapter({ ...fakePoki(), init: () => new Promise<void>(() => {}) });
      const pending = adapter.initialize();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ interstitialAds: false, rewardedAds: false });
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('uses CrazyGames Data only after SDK initialization and never falls back when disabled', async () => {
    const available = fakeCrazySdk();
    const store = createCrazyGamesDataStore(available.sdk);
    await store.initialize();
    expect(await store.write('career', '{"progress":1}')).toEqual({ status: 'written' });
    expect(await store.read('career')).toEqual({ status: 'missing' });
    expect(available.sdk.data?.setItem).toHaveBeenCalledWith('career', '{"progress":1}');

    const disabled = fakeCrazySdk();
    (disabled.sdk as { environment: 'disabled' }).environment = 'disabled';
    const unavailableStore = createCrazyGamesDataStore(disabled.sdk);
    await unavailableStore.initialize();
    expect(await unavailableStore.read('career')).toMatchObject({ status: 'unavailable', reason: /disabled/ });
    expect(await unavailableStore.write('career', '{}')).toMatchObject({ status: 'unavailable' });
    expect(disabled.sdk.data?.setItem).not.toHaveBeenCalled();
  });
});

function fakeCrazySdk() {
  const adCallbacks: Array<{ adStarted(): void; adFinished(): void; adError(error?: unknown, data?: unknown): void }> = [];
  const requestAd = vi.fn((_kind: 'midgame' | 'rewarded', callbacks: typeof adCallbacks[number]) => { adCallbacks.push(callbacks); });
  const sdk: CrazyGamesSdk = {
    init: async () => {}, environment: 'local', game: { gameplayStart() {}, gameplayStop() {} }, ad: { requestAd },
    data: { getItem: vi.fn(() => null), setItem: vi.fn() },
  };
  return { sdk, adCallbacks, requestAd };
}

function fakePoki(): PokiSdk {
  return { init: async () => {}, gameLoadingFinished() {}, gameplayStart() {}, gameplayStop() {}, commercialBreak: async () => {}, rewardedBreak: async () => true };
}
