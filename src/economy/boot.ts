/**
 * Picks the earn sources and wallet store for this build. The only file in src/economy that branches on
 * platform. Portal builds (poki, crazygames-*) never touch websim globals; they pass their own adapters
 * (rewarded ads, missions, platform data store) through `portal`.
 */
import type { PlatformTarget } from '../../contracts/runtime-contracts';
import { createEconomy } from './economy';
import { createGameplaySource, GAMEPLAY_DAILY_CAP } from './gameplay';
import { createDeferredStore, createLayeredStore, createLocalWalletStore, createWebsimCollectionStore } from './stores';
import { createCreatorSource } from './creator';
import type { MissionContext } from './mission-catalog';
import { createMissionsSource } from './missions';
import { createTipSource } from './tips';
import { createWelcomeSource } from './welcome';
import { createDailyChallengeSource } from './daily-challenge';
import type { EarnSource, Economy, EconomyGameEvents, WalletStore } from './types';
import { websimHost, withTimeout } from './websim-host';
import { SELFHOST } from '../core/target';
import { bootSelfhostEconomy } from '../selfhost/boot';

export type EconomyPlatform = 'websim' | 'portal' | 'offline' | 'selfhost';

export interface PortalAdapters {
  /** Rewarded ad, missions, ... Added after the gameplay source. */
  readonly sources?: readonly EarnSource[];
  /** Platform data API store. Defaults to localStorage keyed by target. */
  readonly store?: WalletStore;
  /** False drops the built-in capped gameplay source. Default true. */
  readonly gameplay?: boolean;
}

export interface EconomyBootOptions {
  readonly target: PlatformTarget;
  readonly game: EconomyGameEvents;
  readonly portal?: PortalAdapters;
  readonly creatorName?: string;
  /**
   * The creator's websim user id. When set, only tip comments addressed to this user count as Marks, so tipping an
   * alternate account (which refunds nearly all of the credits) can not mint Marks. Leave unset until the id is known;
   * self-tips are rejected either way.
   */
  readonly creatorId?: string | null;
  /** What the build can do right now (playable routes, online, rival, cars). Missions only offer what is possible with it. */
  readonly missionContext?: () => Partial<MissionContext>;
}

export interface BootedEconomy {
  readonly economy: Economy;
  readonly platform: EconomyPlatform;
}

const LOCAL_KEY = 'lateral:wallet:v1';
/** Louis's websim user id (public, not a secret). null = not configured yet; see EconomyBootOptions.creatorId. */
export const LATERAL_CREATOR_ID: string | null = "47085852-a3b9-4326-88a0-d06f5f891aba";

export function platformFor(target: PlatformTarget): EconomyPlatform {
  if (SELFHOST) return 'selfhost';
  if (target === 'poki' || target === 'crazygames-basic' || target === 'crazygames-full') return 'portal';
  return websimHost() ? 'websim' : 'offline';
}

export function bootEconomy(options: EconomyBootOptions): BootedEconomy {
  // The self-hosted build has its own sources and its own server wallet (src/selfhost/boot.ts); nothing below runs there.
  if (SELFHOST) return bootSelfhostEconomy({ game: options.game, missionContext: options.missionContext });
  const platform = platformFor(options.target);
  if (platform === 'portal') {
    const portal = options.portal ?? {};
    const sources = [...(portal.gameplay === false ? [] : [createGameplaySource(GAMEPLAY_DAILY_CAP)]), createMissionsSource({ context: options.missionContext }), createWelcomeSource(), createDailyChallengeSource(), ...(portal.sources ?? [])];
    const store = portal.store ?? createLocalWalletStore(`${LOCAL_KEY}:${options.target}`);
    return { platform, economy: createEconomy({ store, sources, game: options.game }) };
  }
  const host = platform === 'websim' ? websimHost() : null;
  if (!host) {
    // Offline / standalone outside websim: gameplay Marks on this device only, no tips.
    const store = createLocalWalletStore(`${LOCAL_KEY}:${options.target}`);
    return { platform: 'offline', economy: createEconomy({ store, sources: [createGameplaySource(), createMissionsSource({ context: options.missionContext }), createWelcomeSource(), createDailyChallengeSource()], game: options.game }) };
  }
  const tips = createTipSource({ host, creatorName: options.creatorName ?? 'Louis', creatorId: options.creatorId ?? LATERAL_CREATOR_ID });
  const store = createDeferredStore('websim', true, async () => {
    const user = await withTimeout(host.getCurrentUser(), 6000);
    const local = createLocalWalletStore(`${LOCAL_KEY}:websim:${user?.id ?? 'guest'}`);
    if (!user?.id || !user.username) return local;
    const remote = createWebsimCollectionStore(user.username);
    return remote ? createLayeredStore(remote, local) : local;
  });
  return { platform, economy: createEconomy({ store, sources: [tips, createCreatorSource({ host, creatorId: options.creatorId ?? LATERAL_CREATOR_ID }), createGameplaySource(), createMissionsSource({ context: options.missionContext }), createWelcomeSource(), createDailyChallengeSource()], game: options.game }) };
}
