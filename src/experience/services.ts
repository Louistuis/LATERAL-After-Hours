import type { AdRequest, AdResult, DataStore, PlatformAdapter, PlatformTarget, RewardSpec, RunResult, SaveEnvelope } from '../../contracts/runtime-contracts';
import type { CandidateIdentity, OwnerProfile, OwnerSelection } from '../../contracts/owner-review-contracts';
import { EVENTS } from '../../content/events/catalog';
import { applyRunReward, isPersonalBestResult, MAX_REWARD_PER_RUN_CREDITS } from '../progression/rewards';
import { storePersonalBestGhost } from '../ghosts/storage';
import { VEHICLE_PHYSICS_VERSION } from '../physics';
import { createGuardedBrowserDataStore } from '../platform/browser-store';
import { createOfflinePlatformAdapter, isOfflineTarget } from '../platform/offline';
import { createPokiPlatformAdapter } from '../platform/poki';
import { createCrazyGamesDataStore, createCrazyGamesPlatformAdapter } from '../platform/crazygames';
import { createProfileRepository, exportBugReport, type BugDiagnostic, type BugReportDetails, type ProfileRepositoryWithStatus, type RecoveryInspection } from '../save/profile-repository';
import type { GameRuntime } from '../core/game-runtime';
import type { ExperienceCoordinator, ExperienceRewards } from './coordinator';

export interface ExperienceServices {
  readonly profiles: ProfileRepositoryWithStatus;
  readonly platform: PlatformAdapter;
  readonly rewards: ExperienceRewards;
  readonly store: DataStore;
  ownerTools?(coordinator: ExperienceCoordinator): {
    onExportSave(): Promise<Blob>;
    onExportBugReport(details: BugReportDetails): Promise<Blob>;
    onResetCareer(): Promise<void>;
    inspectProfileRecovery(profile: OwnerProfile): Promise<RecoveryInspection>;
    onExportRawBackup(profile: OwnerProfile): Promise<Blob>;
    onPlayProfileForSession(profile: OwnerProfile): Promise<void>;
  };
  dispose(): Promise<void>;
}

/** One repository owns profile, result, and reward writes for this running build. */
export async function createExperienceServices(_runtime: GameRuntime, target: PlatformTarget): Promise<ExperienceServices> {
  const store = target === 'crazygames-full' ? createCrazyGamesDataStore() : createGuardedBrowserDataStore(target);
  const platform = isOfflineTarget(target) ? createOfflinePlatformAdapter(target)
    : target === 'poki' ? createPokiPlatformAdapter()
      : createCrazyGamesPlatformAdapter(target);
  await store.initialize();
  await platform.initialize();
  const profiles = createProfileRepository(store, target);
  const ownerReview = typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__;
  const diagnostics: BugDiagnostic[] = [];
  let lastDiagnosticAt = 0;
  const detachDiagnostics = ownerReview ? _runtime.subscribe(view => {
    const now = Date.now();
    if (now - lastDiagnosticAt < 1000) return;
    lastDiagnosticAt = now;
    diagnostics.push({ timestampMs: now, message: `tick=${view.frame.current.simulationTick} route=${view.route.id} car=${view.carId} paused=${view.paused} fps=${view.metrics.fps.toFixed(1)}` });
    while (diagnostics.length > 60) diagnostics.shift();
  }) : () => {};
  const rewards: ExperienceRewards = {
    async recordCareerResult(result: RunResult): Promise<void> {
      if (!result.valid) return;
      const event = EVENTS.find(candidate => candidate.routeId === result.routeId && candidate.mode === result.mode);
      if (!event || result.rulesVersion !== event.rulesVersion) throw new Error('Run rules do not match the authored event catalog');
      const route = _runtime.routes().find(candidate => candidate.id === result.routeId);
      if (!route || (result.routeVersion && result.routeVersion !== route.version) ||
          (result.physicsVersion && result.physicsVersion !== VEHICLE_PHYSICS_VERSION)) {
        throw new Error('Run route or physics version does not match the current build');
      }
      // The envelope stores one ghost per route. Reserve it for Time Trial so a
      // Drift Attack score-best cannot be presented as a time-best lap.
      const currentGhostIdentity = result.routeVersion === route.version && result.physicsVersion === VEHICLE_PHYSICS_VERSION && Boolean(result.tuneHash);
      const candidate = result.mode === 'time-trial' && currentGhostIdentity ? _runtime.ghostRecording().toSavedGhost({
        routeId: route.id, routeVersion: route.version, rulesVersion: result.rulesVersion,
        physicsVersion: VEHICLE_PHYSICS_VERSION, carId: result.carId, tuneHash: result.tuneHash!,
      }, 128 * 1024) : null;
      // The current catalog has no measured payouts. Zero credits records a valid best without inventing an award.
      const reward: RewardSpec = { id: `${event.eventId}:completion`, kind: 'garage-credits', amount: event.rewardCredits ?? 0 };
      await profiles.applyCareerTransaction(envelope => {
        const personalBest = isPersonalBestResult(envelope, result);
        const rewarded = applyRunReward(envelope, result, reward).save;
        return candidate && personalBest
          ? storePersonalBestGhost(rewarded, candidate, { result, qualifiesAsPersonalBest: personalBest }).save
          : rewarded;
      });
    },
    async applyCareerReward(request: AdRequest, result: AdResult): Promise<void> {
      if (request.kind !== 'rewarded' || !request.reward || result.status !== 'finished' || !result.rewardEligible || result.operationId !== request.operationId) {
        throw new Error('Invalid rewarded-ad completion');
      }
      if (!Number.isSafeInteger(request.reward.amount) || request.reward.amount < 0 || request.reward.amount > MAX_REWARD_PER_RUN_CREDITS || request.reward.kind !== 'garage-credits') {
        throw new Error('Invalid reward specification');
      }
      await profiles.applyCareerTransaction(envelope => applyAdReward(envelope, request));
    },
  };
  let careerBackupExported = false;
  const ownerTools: ExperienceServices['ownerTools'] = ownerReview ? coordinator => {
      return {
        async onExportSave() {
          const profile = coordinator.state().profile;
          const blob = await profiles.exportProfileSave(profile);
          if (profile === 'career') careerBackupExported = true;
          return blob;
        },
        async onResetCareer() {
          if (!careerBackupExported) throw new Error('Export your career save before resetting it');
          await profiles.resetProfile('career', true, true);
          careerBackupExported = false;
          if (coordinator.state().profile === 'career') await coordinator.reloadProfile();
        },
        async onExportBugReport(details) {
          const state = coordinator.state();
          const identity: CandidateIdentity = {
            version: __BUILD__.version, buildId: __BUILD__.buildId, commit: __BUILD__.commit,
            contentHash: __BUILD__.contentHash, target: __BUILD__.target,
          };
          const selection: OwnerSelection = {
            car: state.selection.car, route: state.selection.route,
            eventId: state.runtime.mode === 'free-drive' ? null : `${state.selection.route}:${state.runtime.mode}`,
            lighting: state.selection.lighting, quality: state.selection.quality,
          };
          return exportBugReport(state.profile, identity, selection, details, diagnostics, state.settings);
        },
        inspectProfileRecovery: profile => profiles.inspectRecovery(profile),
        onExportRawBackup: profile => profiles.exportRawBackup(profile),
        async onPlayProfileForSession(profile) {
          await profiles.startSessionOnlyRecovery(profile, true);
          if (coordinator.state().profile === profile) await coordinator.reloadProfile();
          else await coordinator.switchProfile(profile);
        },
      };
    } : undefined;
  return {
    profiles, platform, rewards, store,
    ...(ownerTools ? { ownerTools } : {}),
    async dispose() { detachDiagnostics(); await store.flushPending(); platform.dispose(); },
  };
}

function applyAdReward(envelope: SaveEnvelope, request: AdRequest): SaveEnvelope {
  if (envelope.appliedRewardOperationIds.includes(request.operationId)) return envelope;
  if (envelope.appliedRewardOperationIds.length >= 4096) throw new Error('Reward ledger is full');
  const reward = request.reward!;
  const credits = envelope.garageCredits + reward.amount;
  if (!Number.isSafeInteger(credits)) throw new Error('Reward credits exceed the supported range');
  return { ...envelope, garageCredits: credits, appliedRewardOperationIds: [...envelope.appliedRewardOperationIds, request.operationId] };
}
