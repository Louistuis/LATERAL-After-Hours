import type { AdRequest, AdResult, CarId, LightingPreset, PlatformAdapter, QualitySelection, RouteId, RunResult, SavedGhost } from '../../contracts/runtime-contracts';
import type { OwnerProfile } from '../../contracts/owner-review-contracts';
import type { EventSelection, GameRuntime, RuntimeView } from '../core/game-runtime';
import { ASSIST_SETTINGS_VERSION, DEFAULT_PLAYER_ASSIST, migrateAssistLevel, validateVehicleTune, VEHICLE_PHYSICS_VERSION, type AssistLevel, type TunePresetId, type VehicleTune } from '../physics';
import { STARTER_CAR } from '../vehicle/starter-car';
import { VEHICLE_CONFIGS } from '../vehicle/configs';
import { validateSavedGhost, type GhostTransform } from '../ghosts/recording';
import { getRecordedRival } from '../events';
import { EVENTS } from '../../content/events/catalog';
import { DrivingTutorial, type TutorialState } from './tutorial';
import { detectDeviceProfile } from '../platform/device-profile';

export type ExperienceScreen = 'drive' | 'pause' | 'garage' | 'settings' | 'results' | 'replay' | 'photo';
export interface ProfileSelection {
  car: CarId;
  route: RouteId;
  tune: TunePresetId;
  lighting: LightingPreset;
  quality: QualitySelection;
  customTune?: VehicleTune;
}
export interface ProfileRecord {
  readonly profile: OwnerProfile;
  readonly selection: ProfileSelection;
  readonly cosmetics?: Readonly<{ paint?: string; wheelStyle?: string; livery?: string }>;
  readonly settings?: Partial<ExperienceSettings>;
}
export interface ExperienceSettings {
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  /** Engine sound level on its own slider; 0 turns the engine sound fully off. Older saves get the default. */
  readonly engineVolume: number;
  readonly muted: boolean;
  readonly reducedMotion: boolean;
  readonly cameraFovDeg: number;
  readonly cameraShakeEnabled: boolean;
  readonly uiScale: number;
  readonly ghostVisible: boolean;
  readonly keyboardBindings: string;
  readonly gamepadBindings: string;
  readonly tutorialCompleted: boolean;
  readonly tutorialSkipped: boolean;
  /** Driving assists. New players, and anyone without a saved choice, start on the Drift level ('medium'). */
  readonly assistLevel: AssistLevel;
  /** Assist settings version (see migrateAssistLevel); optional so older records and fixtures still load. */
  readonly assistVersion?: number;
  /** The one-line first-run assist hint has been shown. */
  readonly assistHintSeen: boolean;
}
const DEFAULT_SETTINGS: ExperienceSettings = {
  masterVolume: 1, musicVolume: .5, sfxVolume: 1, engineVolume: .45, muted: false,
  reducedMotion: false, cameraFovDeg: 58, cameraShakeEnabled: false, uiScale: 1, ghostVisible: true,
  keyboardBindings: '', gamepadBindings: '', tutorialCompleted: false, tutorialSkipped: false,
  assistLevel: DEFAULT_PLAYER_ASSIST, assistHintSeen: false, assistVersion: ASSIST_SETTINGS_VERSION,
};
/** The repository must use distinct persistent namespaces for career and sandbox. */
export interface ProfileRepository {
  load(profile: OwnerProfile): Promise<ProfileRecord | null>;
  save(record: ProfileRecord): Promise<void>;
  getProgression(profile: OwnerProfile): { garageCredits: number; unlockedCars: readonly CarId[]; bestResults: readonly RunResult[] };
  getSavedGhost(profile: OwnerProfile, route: RouteId): SavedGhost | null;
  getPersistenceStatus?(profile?: OwnerProfile): { state: 'persistent' | 'session-only'; warning: string | null };
}
/**
 * Car ownership gate (the economy installs it, see src/ui/shop-feature.ts). While a gate is installed the career
 * profile may only select and drive cars it allows; the garage list shows the others as locked. Without a gate
 * (tests, owner-review sandbox) the old progression unlocks apply.
 */
export interface CarGate {
  allowed(car: CarId): boolean;
  /** Resolves once ownership is known (bounded by the implementation); drive and events wait for it. */
  settled?(): Promise<unknown>;
}

/**
 * Blocks starting to drive until the player has opened the starter gift (src/ui/starter-gift.ts). `require()` shows the gift and
 * resolves true when the player carries on to drive, false when they went elsewhere (the shop). Menus stay reachable.
 */
export interface PlayGate {
  allowed(): boolean;
  require(): Promise<boolean>;
}
const ROSTER = Object.keys(VEHICLE_CONFIGS) as CarId[];
export interface ExperienceAudio {
  setTemporaryMute(reason: 'hidden' | 'ad', muted: boolean): void;
  resumeFromGesture(): Promise<void>;
  setUserMute(muted: boolean): void;
  setVolumes(volumes: { master: number; music: number; sfx: number; engine: number }): void;
}
export interface ExperienceRewards {
  recordCareerResult(result: RunResult): Promise<void>;
  applyCareerReward(request: AdRequest, result: AdResult): Promise<void>;
}
export interface ExperienceState {
  readonly screen: ExperienceScreen;
  readonly profile: OwnerProfile;
  readonly selection: ProfileSelection;
  readonly tuning: VehicleTune;
  readonly progression: ReturnType<ProfileRepository['getProgression']>;
  readonly rivalAvailable: boolean;
  readonly cosmetics: ProfileRecord['cosmetics'];
  readonly settings: ExperienceSettings;
  readonly tutorial: TutorialState;
  readonly persistence: { state: 'persistent' | 'session-only'; warning: string | null };
  readonly busy: boolean;
  readonly ad: 'none' | 'requested' | 'playing';
  readonly error: string | null;
  readonly runtime: RuntimeView;
}

/** Owns menu/presentation transitions while GameRuntime owns the fixed-step driving loop. */
export class ExperienceCoordinator {
  private readonly listeners = new Set<(state: ExperienceState) => void>();
  private readonly runtime: GameRuntime;
  private readonly profiles: ProfileRepository;
  private readonly audio: ExperienceAudio;
  private readonly rewards: ExperienceRewards;
  private readonly platform: PlatformAdapter;
  private readonly detachRuntime: () => void;
  private readonly visibility: () => void;
  private screen: ExperienceScreen = 'pause';
  private profile: OwnerProfile = 'career';
  private selection: ProfileSelection;
  private readonly defaults: ProfileSelection;
  private cosmetics: NonNullable<ProfileRecord['cosmetics']> = {};
  private settings: ExperienceSettings = { ...DEFAULT_SETTINGS };
  private readonly tutorial = new DrivingTutorial();
  private carGate: CarGate | null = null;
  private playGate: PlayGate | null = null;
  private tutorialWrite: Promise<void> | null = null;
  private busy = false;
  private ad: ExperienceState['ad'] = 'none';
  private error: string | null = null;
  private initialized = false;
  private disposed = false;
  private adOperation: string | null = null;
  private runGeneration = 0;
  private activeRunGeneration = 0;
  private activeRunProfile: OwnerProfile = 'career';
  private pendingResult: { result: RunResult; profile: OwnerProfile; generation: number } | null = null;
  private resultWrite: Promise<void> | null = null;
  private resultPersistence: 'none' | 'pending' | 'saved' | 'failed' = 'none';
  private lastResult: RunResult | null = null;
  private platformActiveContext: 'drive' | 'event' | null = null;
  private rivalCache: { key: string; source: SavedGhost | null; validation: ReturnType<typeof validateSavedGhost> | null } | null = null;
  /** Daily challenge loaner: this car may be selected and driven although the gate does not allow it (src/ui/feature-hub.ts). */
  private carLoan: CarId | null = null;
  /** One-shot rival for the next time trial (leaderboard ghost challenges). */
  private nextRival: readonly GhostTransform[] | null = null;

  constructor(runtime: GameRuntime, ports: { profiles: ProfileRepository; audio: ExperienceAudio; rewards: ExperienceRewards; platform: PlatformAdapter }) {
    this.runtime = runtime;
    this.profiles = ports.profiles;
    this.audio = ports.audio;
    this.rewards = ports.rewards;
    this.platform = ports.platform;
    const initial = runtime.view();
    this.selection = { car: initial.carId, route: initial.route.id, tune: initial.tune, lighting: 'golden-hour', quality: detectDeviceProfile().defaultSelection };
    this.defaults = { ...this.selection };
    runtime.pause('menu');
    runtime.onRunFinished(result => this.queueFinishedRun(result));
    this.detachRuntime = runtime.subscribe(view => {
      const previous = this.tutorial.state().status;
      const current = this.tutorial.observe(view);
      if (previous !== 'completed' && current.status === 'completed') {
        this.settings = { ...this.settings, tutorialCompleted: true, tutorialSkipped: false };
        const write = this.persist().catch(error => { this.error = message(error); this.emit(); });
        const tracked = write.finally(() => { if (this.tutorialWrite === tracked) this.tutorialWrite = null; });
        this.tutorialWrite = tracked;
      }
      this.emit();
    });
    this.visibility = () => {
      const hidden = document.hidden;
      this.audio.setTemporaryMute('hidden', hidden);
      this.platform.handle({ type: 'visibility', hidden });
      this.emit();
    };
    document.addEventListener('visibilitychange', this.visibility);
  }

  /** Installs (or removes) the car ownership gate. */
  setCarGate(gate: CarGate | null): void { this.carGate = gate; this.emit(); }
  /** Installs (or removes) the gate that holds back driving until the starter gift is opened. */
  setPlayGate(gate: PlayGate | null): void { this.playGate = gate; this.emit(); }
  /** True when starting to drive is allowed right now (no gate, or the gift is opened). */
  playAllowed(): boolean { return !this.playGate || this.profile === 'sandbox' || this.playGate.allowed(); }
  /** Waits for the gate (it shows the gift). True when the action may go on. */
  private async passPlayGate(): Promise<boolean> {
    const gate = this.playGate;
    if (!gate || this.profile === 'sandbox' || gate.allowed()) return true;
    const go = await gate.require();
    return !this.disposed && go && gate.allowed();
  }
  /** Lends one car for the daily challenge (null ends the loan). The loaner passes the car gate until the loan ends. */
  setCarLoan(car: CarId | null): void { this.carLoan = car; this.emit(); }
  carLoaned(): CarId | null { return this.carLoan; }
  /** The next time trial races these ghost samples instead of the personal best ghost (consumed by beginEvent). */
  setNextRival(samples: readonly GhostTransform[] | null): void { this.nextRival = samples && samples.length > 1 ? samples : null; }
  /** True when the player may select and drive this car now. */
  carAllowed(car: CarId): boolean {
    if (!this.carGate || this.profile === 'sandbox') return true;
    if (this.carLoan === car) return true;
    return this.carGate.allowed(car);
  }
  private gatedProgression(): ExperienceState['progression'] {
    const progression = this.profiles.getProgression(this.profile);
    if (!this.carGate || this.profile === 'sandbox') return progression;
    return { ...progression, unlockedCars: ROSTER.filter(car => this.carGate!.allowed(car) || car === this.carLoan) };
  }
  /** Waits for ownership, then puts the starter car under the player if the selected car is not allowed. */
  private async ensureCarAllowed(): Promise<void> {
    const gate = this.carGate;
    if (!gate || this.profile === 'sandbox') return;
    if (gate.settled) await gate.settled();
    if (gate.allowed(this.selection.car) || this.selection.car === this.carLoan) return;
    this.runGeneration++;
    this.invalidateResult();
    await this.runtime.selectCar(STARTER_CAR);
    if (this.selection.customTune) this.runtime.selectCustomTune(this.selection.customTune);
    this.selection = { ...this.selection, car: STARTER_CAR };
    await this.persist();
  }
  /** Call when ownership changed or finished loading: moves a locked selection back to the starter (menus only). */
  async reconcileCar(): Promise<void> {
    if (this.disposed || this.busy || this.adOperation || !this.initialized || this.screen === 'drive' || !this.carGate || this.profile === 'sandbox') { this.emit(); return; }
    if (this.carGate.allowed(this.selection.car) || this.selection.car === this.carLoan) { this.emit(); return; }
    try { await this.transition(() => this.ensureCarAllowed()); } catch { /* Surfaced through state().error. */ }
  }

  state(): ExperienceState {
    const rivalEvent = EVENTS.find(event => event.routeId === this.selection.route && event.mode === 'rival-ghost');
    const rival = rivalEvent && this.recordedRival(rivalEvent.rulesVersion);
    return { screen: this.screen, profile: this.profile, selection: { ...this.selection }, tuning: this.runtime.tuning(), progression: this.gatedProgression(), rivalAvailable: rival?.compatible === true, cosmetics: { ...this.cosmetics }, settings: { ...this.settings }, tutorial: this.tutorial.state(), persistence: this.profiles.getPersistenceStatus?.(this.profile) ?? { state: 'persistent', warning: null }, busy: this.busy, ad: this.ad, error: this.error, runtime: this.runtime.view() };
  }
  subscribe(listener: (state: ExperienceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.transition(async () => {
      const record = await this.profiles.load('career');
      if (record) await this.applyRecord(record, 'career');
      else {
        // First run: the renderer booted on the fixed device tier; hand it the first-run Graphics setting (Auto on desktop).
        this.runtime.setQuality(this.selection.quality);
        await this.persist();
      }
      this.runtime.setGhostVisible(this.settings.ghostVisible);
      this.initialized = true;
      this.runtime.start();
      this.screen = 'pause';
    });
  }

  async drive(): Promise<void> {
    this.ensureInteractive();
    if (!(await this.passPlayGate())) return;
    this.ensureInteractive();
    await this.transition(async () => {
      await this.audio.resumeFromGesture();
      await this.ensureCarAllowed();
      const returningFromFinishedRun = this.lastResult !== null || this.runtime.view().result !== null;
      this.runtime.leavePresentation();
      if (returningFromFinishedRun) {
        this.runGeneration++;
        this.invalidateResult();
        this.runtime.freeDrive();
      }
      this.runtime.resume('menu');
      this.screen = 'drive';
      if (this.runtime.view().mode === 'free-drive') this.tutorial.start();
    });
  }

  async startTutorial(): Promise<void> {
    if (!(await this.passPlayGate())) return;
    await this.transition(async () => {
      await this.audio.resumeFromGesture();
      await this.ensureCarAllowed();
      this.runtime.leavePresentation();
      this.runtime.freeDrive();
      this.runtime.resetVehicle();
      this.tutorial.replay();
      this.settings = { ...this.settings, tutorialCompleted: false, tutorialSkipped: false };
      await this.persist();
      this.runtime.resume('menu');
      this.screen = 'drive';
    });
  }

  async skipTutorial(): Promise<void> {
    await this.transition(async () => {
      this.tutorial.skip();
      this.settings = { ...this.settings, tutorialCompleted: false, tutorialSkipped: true };
      await this.persist();
    });
  }

  open(screen: 'pause' | 'garage' | 'settings'): void {
    this.ensureInteractive();
    this.runtime.pause('menu');
    this.screen = screen;
    this.emit();
  }

  /**
   * Where a selection change lands. The main menu (pause) stays put: its solo picker changes route and car in place,
   * and the showroom opens on the garage screen, so jumping there from the menu would pop the garage over the picker.
   * Anywhere else keeps the old behaviour (garage).
   */
  private selectionScreen(): ExperienceScreen { return this.screen === 'pause' ? 'pause' : 'garage'; }
  async selectCar(car: CarId): Promise<void> {
    await this.transition(async () => {
      if (this.profile === 'career') {
        if (this.carGate) { if (!this.carGate.allowed(car) && car !== this.carLoan) throw new Error(`${car} is locked. Buy it in the shop.`); }
        else if (!this.profiles.getProgression('career').unlockedCars.includes(car)) throw new Error(`${car} is locked in career`);
      }
      this.runGeneration++;
      this.invalidateResult();
      await this.runtime.selectCar(car);
      if (this.selection.customTune) this.runtime.selectCustomTune(this.selection.customTune);
      this.selection = { ...this.selection, car };
      await this.persist();
      this.runtime.pause('menu');
      this.screen = this.selectionScreen();
    });
  }
  async selectRoute(route: RouteId): Promise<void> {
    await this.transition(async () => {
      this.runGeneration++;
      this.invalidateResult();
      this.runtime.selectRoute(route);
      this.selection = { ...this.selection, route };
      await this.persist();
      this.runtime.pause('menu');
      this.screen = this.selectionScreen();
    });
  }
  async selectTune(tune: TunePresetId): Promise<void> {
    await this.transition(async () => {
      this.runGeneration++;
      this.invalidateResult();
      this.runtime.selectTune(tune);
      this.selection = { ...this.selection, tune, customTune: undefined };
      await this.persist();
      this.runtime.pause('menu');
      this.screen = this.selectionScreen();
    });
  }
  async selectCustomTune(tune: VehicleTune): Promise<void> {
    await this.transition(async () => {
      this.runGeneration++;
      this.invalidateResult();
      const custom = validateVehicleTune({ ...tune, id: 'Custom' });
      this.runtime.selectCustomTune(custom);
      this.selection = { ...this.selection, customTune: custom };
      await this.persist();
      this.screen = this.selectionScreen();
    });
  }
  async restoreFactoryTune(): Promise<void> {
    await this.transition(async () => {
      this.runGeneration++;
      this.invalidateResult();
      this.runtime.restoreFactoryTune();
      this.selection = { ...this.selection, customTune: undefined };
      await this.persist();
      this.screen = this.selectionScreen();
    });
  }
  async setPresentation(lighting: LightingPreset, quality: QualitySelection): Promise<void> {
    await this.transition(async () => {
      this.runtime.scene.setLighting(lighting);
      this.runtime.setQuality(quality);
      this.selection = { ...this.selection, lighting, quality };
      await this.persist();
    });
  }
  async setCosmetics(cosmetics: NonNullable<ProfileRecord['cosmetics']>): Promise<void> {
    await this.transition(async () => {
      this.runtime.scene.setCosmetics(cosmetics);
      this.cosmetics = { ...cosmetics };
      await this.persist();
    });
  }
  async setSettings(patch: Partial<Omit<ExperienceSettings, 'tutorialCompleted' | 'tutorialSkipped'>>): Promise<void> {
    await this.transition(async () => {
      const next = normalizeSettings({ ...this.settings, ...patch,
        tutorialCompleted: this.settings.tutorialCompleted, tutorialSkipped: this.settings.tutorialSkipped });
      this.audio.setUserMute(next.muted);
      this.audio.setVolumes({ master: next.masterVolume, music: next.musicVolume, sfx: next.sfxVolume, engine: next.engineVolume });
      this.runtime.setGhostVisible(next.ghostVisible);
      this.runtime.setAssist(next.assistLevel);
      this.settings = next;
      await this.persist();
    });
  }
  async switchProfile(next: OwnerProfile): Promise<void> {
    if (!(typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__)) throw new Error('Profile switching is unavailable in this build');
    await this.transition(async () => {
      if (next === this.profile) return;
      this.runGeneration++;
      this.invalidateResult();
      if (this.resultWrite) await this.resultWrite;
      const previous = this.record();
      const target = await this.profiles.load(next);
      const record: ProfileRecord = target ?? { profile: next, selection: { ...this.defaults } };
      await this.persist();
      this.runtime.pause('menu');
      this.runtime.leavePresentation();
      try { await this.applyRecord(record, next); }
      catch (error) {
        try { await this.applyRecord(previous, previous.profile); }
        catch (rollbackError) { throw new Error(`Profile change failed (${message(error)}) and previous scene could not be restored`, { cause: rollbackError }); }
        throw error;
      }
      this.runtime.freeDrive();
      this.runtime.pause('menu');
      if (!target) await this.persist();
      this.screen = 'garage';
    });
  }
  async reloadProfile(): Promise<void> {
    if (!(typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__)) throw new Error('Profile reload is unavailable in this build');
    await this.transition(async () => {
      this.runGeneration++;
      this.invalidateResult();
      const record = await this.profiles.load(this.profile);
      if (!record) throw new Error('Profile is unavailable after reset or import');
      this.runtime.leavePresentation();
      await this.applyRecord(record, this.profile);
      this.runtime.freeDrive();
      this.runtime.pause('menu');
      this.screen = 'garage';
    });
  }
  async beginEvent(event: EventSelection): Promise<void> {
    if (!(await this.passPlayGate())) throw new Error('Open your starter gift to start driving.');
    await this.transition(async () => {
      await this.audio.resumeFromGesture();
      await this.ensureCarAllowed();
      let nextRival: readonly GhostTransform[] = [];
      const challengeRival = this.nextRival;
      this.nextRival = null;
      if (event.mode === 'time-trial' && challengeRival) {
        nextRival = challengeRival;
      } else if (event.mode === 'rival-ghost') {
        const recorded = this.recordedRival(event.rulesVersion);
        if (!recorded?.compatible) throw new Error(`Recorded rival is unavailable: ${recorded?.reason ?? 'no approved recording for this route'}`);
        nextRival = recorded.samples;
      } else if (event.mode === 'time-trial') {
        const saved = this.profiles.getSavedGhost(this.profile, this.selection.route);
        const validated = saved && this.validateGhost(saved, event.rulesVersion);
        nextRival = validated?.compatible ? validated.samples : [];
        if (validated && !validated.compatible) this.error = `Personal best ghost ignored: ${validated.reason}`;
      }
      this.runGeneration++;
      this.invalidateResult();
      this.activeRunGeneration = this.runGeneration;
      this.activeRunProfile = this.profile;
      this.runtime.beginEvent(event);
      this.runtime.setRival(nextRival);
      this.runtime.resume('menu');
      this.screen = 'drive';
    });
  }
  async retry(): Promise<void> {
    await this.transition(async () => {
      await this.audio.resumeFromGesture();
      this.runGeneration++;
      this.invalidateResult();
      this.activeRunGeneration = this.runGeneration;
      this.activeRunProfile = this.profile;
      this.runtime.retry();
      this.runtime.resume('menu');
      this.screen = 'drive';
    });
  }
  freeDrive(): void {
    this.ensureInteractive();
    this.runGeneration++;
    this.invalidateResult();
    this.runtime.freeDrive();
    this.runtime.pause('menu');
    this.screen = 'pause';
    this.emit();
  }
  resetVehicle(): void { this.ensureInteractive(); this.runtime.resetVehicle(); this.emit(); }
  replay(): boolean {
    this.ensureInteractive();
    const available = this.runtime.enterReplay();
    if (available) this.screen = 'replay';
    this.emit();
    return available;
  }
  photo(): void {
    this.ensureInteractive();
    this.runtime.enterPhoto();
    this.screen = 'photo';
    this.emit();
  }
  screenshot(): Promise<Blob> { this.ensureInteractive(); return this.runtime.screenshot(); }
  /** Replays these recorded poses (a whole finished run) with the replay presentation. */
  replayRun(samples: readonly GhostTransform[]): boolean {
    this.ensureInteractive();
    const available = this.runtime.enterReplayWith?.(samples) ?? false;
    if (available) this.screen = 'replay';
    this.emit();
    return available;
  }
  /** Leaves replay or photo back to where they were opened from: the results of a finished run, else the menu. */
  leavePresentation(): void {
    this.ensureInteractive();
    this.runtime.leavePresentation();
    this.runtime.pause('menu');
    this.screen = this.runtime.view().result ? 'results' : 'pause';
    this.emit();
  }

  /** A live ad remains locked until the adapter returns a terminal SDK result. */
  async requestAd(request: AdRequest): Promise<AdResult> {
    this.ensureReady();
    if (this.adOperation || this.busy) throw new Error('Another operation is active');
    if (this.screen !== 'results') throw new Error('Ads are only available after an event');
    if (request.kind === 'rewarded' && this.profile === 'sandbox') throw new Error('Sandbox cannot earn career rewards');
    this.adOperation = request.operationId;
    this.ad = 'requested';
    this.runtime.pause('ad');
    this.emit();
    let terminal = false;
    let started = false;
    try {
      const result = await this.platform.requestAd(request, { onStarted: id => {
        if (this.adOperation !== id || this.ad !== 'requested') return;
        started = true;
        this.ad = 'playing';
        this.audio.setTemporaryMute('ad', true);
        this.emit();
      } });
      if (result.operationId !== request.operationId) throw new Error('Ad operation ID mismatch');
      terminal = true;
      if (request.kind === 'rewarded' && result.status === 'finished' && result.rewardEligible && this.profile === 'career') {
        if (!started) throw new Error('Reward completion arrived without an ad-start signal');
        if (this.resultWrite) await this.resultWrite;
        if (!this.lastResult?.valid || this.resultPersistence !== 'saved') throw new Error('Career result was not saved; reward cannot be applied');
        await this.rewards.applyCareerReward(request, result);
      }
      return result;
    } finally {
      // A rejected promise after SDK start is not proof that the overlay closed.
      if (terminal || this.ad === 'requested') {
        this.audio.setTemporaryMute('ad', false);
        this.runtime.resume('ad');
        this.adOperation = null;
        this.ad = 'none';
      }
      this.emit();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.platformActiveContext) {
      this.platform.handle({ type: 'activity', active: false, context: this.platformActiveContext });
      this.platformActiveContext = null;
    }
    this.disposed = true;
    this.detachRuntime();
    document.removeEventListener('visibilitychange', this.visibility);
    this.listeners.clear();
  }
  private queueFinishedRun(result: RunResult): void {
    if (this.disposed) return;
    const transaction = { result, profile: this.activeRunProfile, generation: this.activeRunGeneration };
    if (this.busy) { this.pendingResult = transaction; return; }
    this.finishRun(transaction);
  }
  private finishRun(transaction: { result: RunResult; profile: OwnerProfile; generation: number }): void {
    if (this.disposed || transaction.generation !== this.runGeneration) return;
    const { result } = transaction;
    this.lastResult = result;
    this.screen = 'results';
    this.syncPlatformActivity();
    this.platform.handle({ type: 'run-finished', runId: result.runId, result });
    this.emit();
    if (transaction.profile === 'career') {
      this.resultPersistence = 'pending';
      const write = this.rewards.recordCareerResult(result).then(() => { this.resultPersistence = 'saved'; }).catch(error => { this.resultPersistence = 'failed'; this.error = message(error); this.emit(); });
      const tracked = write.finally(() => { if (this.resultWrite === tracked) this.resultWrite = null; });
      this.resultWrite = tracked;
    } else this.resultPersistence = 'none';
  }
  private async applyRecord(record: ProfileRecord, expected: OwnerProfile): Promise<void> {
    if (record.profile !== expected) throw new Error('Profile repository returned the wrong namespace');
    const selection = { ...record.selection, customTune: record.selection.customTune && validateVehicleTune({ ...record.selection.customTune, id: 'Custom' }) };
    if (!this.runtime.routes().some(route => route.id === selection.route)) throw new Error(`Route ${selection.route} is unavailable`);
    if (this.runtime.view().route.id !== selection.route) this.runtime.selectRoute(selection.route);
    if (this.runtime.view().carId !== selection.car) await this.runtime.selectCar(selection.car);
    // Without a saved custom tune, always re-apply the preset: a live custom tuning shares the preset id,
    // so a factory reset to the same preset would otherwise leave the custom values active.
    if (selection.customTune) this.runtime.selectCustomTune(selection.customTune);
    else this.runtime.selectTune(selection.tune);
    this.runtime.scene.setLighting(selection.lighting);
    this.runtime.setQuality(selection.quality);
    const cosmetics = { ...record.cosmetics };
    const settings = normalizeSettings(record.settings);
    this.runtime.scene.setCosmetics(cosmetics);
    this.audio.setUserMute(settings.muted);
    this.audio.setVolumes({ master: settings.masterVolume, music: settings.musicVolume, sfx: settings.sfxVolume, engine: settings.engineVolume });
    this.runtime.setGhostVisible(settings.ghostVisible);
    this.runtime.setAssist(settings.assistLevel);
    this.profile = expected;
    this.selection = selection;
    this.cosmetics = cosmetics;
    this.settings = settings;
    this.tutorial.restore(settings.tutorialCompleted ? 'completed' : settings.tutorialSkipped ? 'skipped' : 'not-started');
  }
  private record(): ProfileRecord { return { profile: this.profile, selection: { ...this.selection, customTune: this.selection.customTune && { ...this.selection.customTune } }, cosmetics: { ...this.cosmetics }, settings: { ...this.settings } }; }
  private validateGhost(saved: SavedGhost, rulesVersion: string): ReturnType<typeof validateSavedGhost> {
    const route = this.runtime.view().route;
    return validateSavedGhost(saved, { routeId: route.id, routeVersion: route.version, rulesVersion,
      physicsVersion: VEHICLE_PHYSICS_VERSION, carId: this.selection.car, tuneHash: this.runtime.tuneHash() });
  }
  private recordedRival(rulesVersion: string): ReturnType<typeof validateSavedGhost> | null {
    const route = this.runtime.view().route;
    const source = getRecordedRival(route.id);
    const key = `${route.id}|${route.version}|${rulesVersion}|${VEHICLE_PHYSICS_VERSION}`;
    if (this.rivalCache?.key === key && this.rivalCache.source === source) return this.rivalCache.validation;
    const validation = source ? validateSavedGhost(source, {
      routeId: route.id, routeVersion: route.version, rulesVersion, physicsVersion: VEHICLE_PHYSICS_VERSION,
      carId: source.header.carId, tuneHash: source.header.tuneHash,
    }) : null;
    this.rivalCache = { key, source, validation };
    return validation;
  }
  private invalidateResult(): void { this.lastResult = null; this.resultPersistence = 'none'; }
  private persist(): Promise<void> { return this.profiles.save(this.record()); }
  private ensureReady(): void {
    if (this.disposed) throw new Error('Experience is disposed');
    if (!this.initialized) throw new Error('Experience is not initialized');
    if (this.busy) throw new Error('Experience transition is active');
  }
  private ensureInteractive(): void {
    this.ensureReady();
    if (this.ad !== 'none') throw new Error('An ad operation is still active');
  }
  private async transition(action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.busy || this.adOperation) throw new Error('Experience transition is unavailable');
    this.busy = true;
    this.error = null;
    this.runtime.pause('recovery');
    this.runtime.pause('menu');
    this.emit();
    try {
      if (this.tutorialWrite) await this.tutorialWrite;
      await action();
    }
    catch (error) { this.error = message(error); this.screen = 'pause'; throw error; }
    finally {
      if (this.screen === 'drive') this.runtime.resume('menu');
      else this.runtime.pause('menu');
      this.runtime.resume('recovery');
      this.busy = false;
      const pending = this.pendingResult;
      this.pendingResult = null;
      if (pending) this.finishRun(pending);
      this.emit();
    }
  }
  private syncPlatformActivity(): void {
    if (this.disposed) return;
    const view = this.runtime.view();
    const active = this.initialized && !this.busy && this.screen === 'drive' && view.presentation === 'drive' &&
      !view.paused && document.hidden !== true && this.ad === 'none';
    if (active && !this.platformActiveContext) {
      const context = view.mode === 'free-drive' ? 'drive' : 'event';
      this.platformActiveContext = context;
      this.platform.handle({ type: 'activity', active: true, context });
    } else if (!active && this.platformActiveContext) {
      const context = this.platformActiveContext;
      this.platformActiveContext = null;
      this.platform.handle({ type: 'activity', active: false, context });
    }
  }
  private emit(): void { if (!this.disposed) { this.syncPlatformActivity(); const state = this.state(); for (const listener of this.listeners) listener(state); } }
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Unexpected experience error'; }
function normalizeSettings(value: Partial<ExperienceSettings> = {}): ExperienceSettings {
  const volume = (candidate: number | undefined, fallback: number) => Number.isFinite(candidate) ? Math.max(0, Math.min(1, candidate!)) : fallback;
  const scale = Number.isFinite(value.uiScale) ? Math.max(.8, Math.min(1.5, value.uiScale!)) : 1;
  return {
    masterVolume: volume(value.masterVolume, DEFAULT_SETTINGS.masterVolume),
    musicVolume: volume(value.musicVolume, DEFAULT_SETTINGS.musicVolume),
    sfxVolume: volume(value.sfxVolume, DEFAULT_SETTINGS.sfxVolume),
    engineVolume: volume(value.engineVolume, DEFAULT_SETTINGS.engineVolume),
    muted: value.muted === true,
    reducedMotion: value.reducedMotion === true,
    cameraFovDeg: Number.isFinite(value.cameraFovDeg) ? Math.max(50, Math.min(75, value.cameraFovDeg!)) : DEFAULT_SETTINGS.cameraFovDeg,
    cameraShakeEnabled: value.cameraShakeEnabled === true,
    uiScale: scale,
    ghostVisible: value.ghostVisible !== false,
    keyboardBindings: typeof value.keyboardBindings === 'string' && value.keyboardBindings.length <= 2048 ? value.keyboardBindings : '',
    gamepadBindings: typeof value.gamepadBindings === 'string' && value.gamepadBindings.length <= 2048 ? value.gamepadBindings : '',
    tutorialCompleted: value.tutorialCompleted === true,
    tutorialSkipped: value.tutorialCompleted !== true && value.tutorialSkipped === true,
    assistLevel: migrateAssistLevel(value.assistLevel, value.assistVersion),
    assistHintSeen: value.assistHintSeen === true,
    assistVersion: ASSIST_SETTINGS_VERSION,
  };
}
