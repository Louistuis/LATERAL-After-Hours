import type { FrameSnapshot, InputFrame } from '../../contracts/runtime-contracts';
import type { ExperienceAudio } from '../experience/coordinator';
import { VEHICLE_CONFIGS } from '../vehicle/configs';
import { DrivingBed } from './driving-graph';
import {
  calculateImpactSeverity, gearChange, impactVoice, isHandbrakePull, RaceCueTracker, scrapeLevel, surfaceParams, tyreParams,
  type RaceCueInput,
} from './driving-sfx';
import { createEngineSynth, type EngineSynth } from './engine-graph';
import { selectEngineVoice } from './engine-voices';
import { SoundBank } from './sound-bank';
import type { CueKind } from './synth-buffers';

export { calculateImpactSeverity } from './driving-sfx';

export interface AudioVolumes { master: number; music: number; sfx: number; engine?: number }
/** Default engine slider position (0 is fully off). Matches DEFAULT_SETTINGS.engineVolume. */
export const DEFAULT_ENGINE_VOLUME = 0.45;
const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
type TransientCategory = 'collision' | 'cue' | 'other';
interface TransientVoice { readonly source: AudioBufferSourceNode; readonly gain: GainNode; readonly category: TransientCategory; readonly endsAt: number }

/** Minimum spacing per cue so menu hover, balance ticks and repeated clicks never machine-gun. */
const CUE_SPACING: Partial<Record<CueKind, number>> = { hover: 0.06, tick: 0.045, select: 0.05, back: 0.05, deny: 0.12, count: 0.2 };
/** Bus trims under the player's sliders. */
const MIX = { impact: 0.75, ui: 0.6, race: 0.65, shift: 0.2, handbrake: 0.3 } as const;

/**
 * LATERAL's sound: a procedural engine per car on its own Engine slider, tyres, surfaces, impacts, race and menu
 * cues on the SFX slider, ambience on the Music slider, and a gentle limiter on the master. Every sound is
 * generated locally (see synth-buffers.ts); the context starts on a user gesture.
 */
export class PlayerAudio implements ExperienceAudio {
  private context: AudioContext | null = null;
  private bank: SoundBank | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private engineBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private impactBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private duck: GainNode | null = null;
  private engine: EngineSynth | null = null;
  private bed: DrivingBed | null = null;
  private userMuted = false;
  private readonly temporaryMutes = new Set<'hidden' | 'ad'>();
  private volumes: Required<AudioVolumes> = { master: 0.8, music: 0.45, sfx: 0.8, engine: DEFAULT_ENGINE_VOLUME };
  private transientVoices: TransientVoice[] = [];
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceWindFilter: BiquadFilterNode | null = null;
  private ambienceIndustrialFilter: BiquadFilterNode | null = null;
  private ambienceWindGain: GainNode | null = null;
  private ambienceIndustrialGain: GainNode | null = null;
  private lastImpactTick: number | null = null;
  private readonly impactTicks: number[] = [];
  private previousGear: number | null = null;
  private previousHandbrake: number | null = null;
  private readonly raceCues = new RaceCueTracker();
  private readonly lastCueTime = new Map<CueKind, number>();
  private prewarmQueue: Array<() => void> = [];
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a frame was driven audibly in the last half second; background generation waits for menus and pauses. */
  private lastDrivingTime = Number.NEGATIVE_INFINITY;
  private prewarmedCar: string | null = null;
  private disposed = false;

  async resumeFromGesture(): Promise<void> {
    if (this.disposed) return;
    try {
      const context = this.ensureContext();
      if (context.state !== 'running') await context.resume();
      this.applyMute();
    } catch {
      // Autoplay policy, missing Web Audio or a blocked context: play silently, retry on the next gesture.
    }
  }

  /**
   * iOS Safari (and Chrome's autoplay policy) only start Web Audio inside a user gesture, and iOS parks a
   * running context as "interrupted" after a call, Siri or backgrounding. Listening in the capture phase
   * for the first touch, click or key and on every later one while the context is not running makes the
   * first tap anywhere unlock sound, and the next tap after an interruption bring it back.
   */
  armGestureUnlock(target: EventTarget = document): () => void {
    const unlock = (): void => { if (!this.disposed && this.context?.state !== 'running') void this.resumeFromGesture(); };
    const events = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
    for (const type of events) target.addEventListener(type, unlock, { capture: true, passive: true });
    return () => { for (const type of events) target.removeEventListener(type, unlock, { capture: true }); };
  }

  setTemporaryMute(reason: 'hidden' | 'ad', muted: boolean): void {
    if (muted) this.temporaryMutes.add(reason); else this.temporaryMutes.delete(reason);
    if (muted) { this.clearCollisionVoices(); this.silenceContinuousSources(); }
    this.applyMute();
  }

  setUserMute(muted: boolean): void { this.userMuted = muted; if (muted) { this.clearCollisionVoices(); this.silenceContinuousSources(); } this.applyMute(); }
  setVolumes(volumes: AudioVolumes): void {
    this.volumes = { master: clamp(volumes.master), music: clamp(volumes.music), sfx: clamp(volumes.sfx), engine: clamp(volumes.engine ?? this.volumes.engine) };
    // Engine at 0 is fully off: the synth is torn down, not just turned down.
    if (this.volumes.engine === 0) this.dropEngine();
    this.applyLevels();
  }
  get isUserMuted(): boolean { return this.userMuted; }
  get levels(): Readonly<Required<AudioVolumes>> { return this.volumes; }
  private district = 'harbor';
  /** Ambience bed follows the location: harbour wind and machinery, or mountain gusts over a distant city hum. */
  setDistrict(district: string): void { this.district = district; }

  update(frame: FrameSnapshot, input?: InputFrame, paused = false, race?: RaceCueInput): void {
    let collisionSeverity = 0;
    const hit = frame.impact;
    if (hit && Number.isSafeInteger(hit.simulationTick) && hit.simulationTick !== this.lastImpactTick) {
      this.lastImpactTick = hit.simulationTick;
      collisionSeverity = calculateImpactSeverity(hit);
      this.impactTicks.push(hit.simulationTick);
      if (this.impactTicks.length > 12) this.impactTicks.shift();
    }
    const cues = race ? this.raceCues.update(race) : [];
    if (paused) { collisionSeverity = 0; this.clearCollisionVoices(); this.silenceContinuousSources(); }
    const context = this.context;
    if (!context || context.state !== 'running') { this.silenceContinuousSources(); return; }
    // Generate the selected car's engine while still in the menus, so the first drive frame never waits for it.
    this.prewarmCar(frame.current.carId);
    const audible = !this.userMuted && this.temporaryMutes.size === 0;
    for (const { cue, delay } of cues) if (audible) this.playCue(cue, delay);
    if (paused || !audible) return;
    const now = context.currentTime;
    this.lastDrivingTime = now;
    const car = frame.current;
    const speedMS = Math.hypot(car.linearVelocityMS.x, car.linearVelocityMS.z);
    const config = VEHICLE_CONFIGS[car.carId] ?? VEHICLE_CONFIGS['CAR-01'];
    const voice = selectEngineVoice(car.carId);

    // Engine (own bus). Reverse with swapped pedals is driven by the brake pedal.
    const throttle = clamp(input ? (car.gear < 0 ? Math.max(input.throttle, input.brake) : input.throttle) : 0);
    if (this.volumes.engine > 0) {
      if (this.engine?.voice.id !== voice.id) { this.dropEngine(); this.engine = createEngineSynth(context, voice, this.bank!.engine(voice), this.engineBus!); }
      this.engine.update({ rpm: car.engineRpm, throttle, speedMS, gear: car.gear, idleRpm: config.engine.idleRpm, redlineRpm: config.engine.redlineRpm }, now);
    }

    // Gear change clunk and handbrake chirp (SFX bus). An electric drive has no gearbox to hear.
    const change = gearChange(this.previousGear, car.gear);
    this.previousGear = car.gear;
    if (change && voice.kind === 'combustion') this.playBuffer(this.bank!.shift(), MIX.shift * (change === 'up' ? 1 : 0.8), this.impactBus!, 'other', 0, change === 'down' ? 0.92 : 1);
    const handbrake = input ? clamp(input.handbrake) : 0;
    if (isHandbrakePull(this.previousHandbrake, handbrake, speedMS)) this.playBuffer(this.bank!.handbrake(), MIX.handbrake * Math.min(1, 0.5 + speedMS / 30), this.impactBus!, 'other');
    this.previousHandbrake = input ? handbrake : null;

    // Tyres, surfaces and barrier scrape.
    this.bed ??= new DrivingBed(context, { squeal: this.bank!.squeal(), noise: this.bank!.noise(), gravel: this.bank!.gravel(), scrape: this.bank!.scrape() }, this.sfxBus!);
    this.bed.update({ tyres: tyreParams(car.wheels, speedMS), surface: surfaceParams(car.wheels, speedMS), scrape: scrapeLevel(this.impactTicks, car.simulationTick, speedMS), speedMS }, now);

    const ambience = calculateDistrictAmbience(this.district, now, true);
    this.ambienceWindGain?.gain.setTargetAtTime(ambience.wind, now, 0.8);
    this.ambienceIndustrialGain?.gain.setTargetAtTime(ambience.industrial, now, 1.2);
    this.ambienceWindFilter?.frequency.setTargetAtTime(260 + ambience.wind * 3600, now, 1.1);
    this.ambienceIndustrialFilter?.frequency.setTargetAtTime(115 + ambience.industrial * 1800, now, 1.5);
    if (collisionSeverity > 0) this.playImpact(collisionSeverity);
  }

  /** Plays a generated cue on the SFX bus; false when audio is locked, muted or the cue is rate limited. */
  playCue(kind: CueKind, delay = 0): boolean {
    const context = this.context;
    if (!context || context.state !== 'running' || this.disposed || this.userMuted || this.temporaryMutes.size) return false;
    const spacing = CUE_SPACING[kind] ?? 0;
    const last = this.lastCueTime.get(kind) ?? Number.NEGATIVE_INFINITY;
    if (context.currentTime - last < spacing) return true;
    this.lastCueTime.set(kind, context.currentTime);
    const race = kind === 'count' || kind === 'go' || kind === 'checkpoint' || kind === 'finish' || kind.startsWith('medal');
    if (kind === 'finish') this.duckMusic(0.5, 1.6);
    this.playBuffer(this.bank!.cue(kind), race ? MIX.race : MIX.ui, this.uiBus!, 'cue', Math.max(0, delay));
    return true;
  }

  /** Legacy menu cue names. */
  playUiCue(kind: 'confirm' | 'back' | 'error' = 'confirm'): void {
    this.playCue(kind === 'error' ? 'deny' : kind === 'back' ? 'back' : 'select');
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.prewarmTimer !== null) clearTimeout(this.prewarmTimer);
    this.prewarmQueue = [];
    this.dropEngine();
    this.bed?.dispose(); this.bed = null;
    if (this.ambienceSource) { try { this.ambienceSource.stop(); } catch { /* not started */ } this.ambienceSource.disconnect(); }
    for (const voice of [...this.transientVoices]) this.disposeTransient(voice);
    for (const node of [this.ambienceWindFilter, this.ambienceIndustrialFilter, this.ambienceWindGain, this.ambienceIndustrialGain, this.engineBus, this.impactBus, this.uiBus, this.sfxBus, this.duck, this.musicBus, this.limiter, this.master]) node?.disconnect();
    void this.context?.close(); this.context = null; this.ambienceSource = null; this.bank = null;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    // Safari before 14.1 only ships the prefixed constructor.
    const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable');
    const context = new Context({ latencyHint: 'interactive' }); this.context = context;
    this.bank = new SoundBank(context);
    const master = context.createGain(); this.master = master;
    // A gentle limiter: transparent in normal play, catches stacked crashes and cues before they clip.
    if (typeof context.createDynamicsCompressor === 'function') {
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.22;
      master.connect(limiter); limiter.connect(context.destination); this.limiter = limiter;
    } else master.connect(context.destination);
    const engine = context.createGain(); engine.connect(master); this.engineBus = engine;
    const sfx = context.createGain(); sfx.connect(master); this.sfxBus = sfx;
    const impact = context.createGain(); impact.gain.value = MIX.impact; impact.connect(sfx); this.impactBus = impact;
    const ui = context.createGain(); ui.connect(sfx); this.uiBus = ui;
    const duck = context.createGain(); duck.connect(master); this.duck = duck;
    const music = context.createGain(); music.connect(duck); this.musicBus = music;
    const ambienceSource = context.createBufferSource(); ambienceSource.buffer = this.bank.ambience(); ambienceSource.loop = true;
    const windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 260; windFilter.Q.value = 0.5;
    const industrialFilter = context.createBiquadFilter(); industrialFilter.type = 'bandpass'; industrialFilter.frequency.value = 115; industrialFilter.Q.value = 2.4;
    const windGain = context.createGain(); windGain.gain.value = 0;
    const industrialGain = context.createGain(); industrialGain.gain.value = 0;
    ambienceSource.connect(windFilter); windFilter.connect(windGain); windGain.connect(music);
    ambienceSource.connect(industrialFilter); industrialFilter.connect(industrialGain); industrialGain.connect(music); ambienceSource.start();
    this.ambienceSource = ambienceSource; this.ambienceWindFilter = windFilter; this.ambienceIndustrialFilter = industrialFilter; this.ambienceWindGain = windGain; this.ambienceIndustrialGain = industrialGain;
    this.applyLevels(); this.applyMute();
    this.queuePrewarm();
    return context;
  }

  /** Generates the common buffers a few milliseconds at a time after unlock, so the first drift or crash never hitches. */
  private queuePrewarm(): void {
    const bank = this.bank!;
    this.prewarmQueue.push(
      () => bank.noise(), () => bank.squeal(), () => bank.gravel(), () => bank.scrape(),
      () => bank.impact(0), () => bank.impact(1), () => bank.impact(2), () => bank.shift(), () => bank.handbrake(),
      ...(['hover', 'select', 'back', 'count', 'go', 'checkpoint', 'finish', 'marks', 'purchase', 'tick', 'deny', 'medal-gold', 'medal-silver', 'medal-bronze'] as const).map(kind => () => bank.cue(kind)),
    );
    this.pumpPrewarm();
  }

  private prewarmCar(carId: string): void {
    if (carId === this.prewarmedCar || !this.bank) return;
    this.prewarmedCar = carId;
    const bank = this.bank, voice = selectEngineVoice(carId);
    this.prewarmQueue.unshift(() => bank.engineLayer(voice, 0), () => bank.engineLayer(voice, 1), () => bank.engine(voice));
    this.pumpPrewarm();
  }

  private pumpPrewarm(delay = 24): void {
    if (this.prewarmTimer !== null || this.disposed || typeof setTimeout !== 'function') return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      if (this.disposed || !this.bank) return;
      // Never generate in the background while driving: anything still missing is made on first use instead.
      const driving = this.context !== null && this.context.currentTime - this.lastDrivingTime < 0.5;
      if (driving) { this.pumpPrewarm(400); return; }
      this.prewarmQueue.shift()?.();
      if (this.prewarmQueue.length) this.pumpPrewarm();
    }, delay);
  }

  private dropEngine(): void {
    this.engine?.dispose();
    this.engine = null;
  }

  private playImpact(severity: number): void {
    const voice = impactVoice(severity);
    if (!voice || !this.bank || !this.impactBus) return;
    const rate = 0.93 + (this.lastImpactTick ?? 0) % 7 * 0.02;
    this.playBuffer(this.bank.impact(voice.level), voice.gain, this.impactBus, 'collision', 0, rate);
    if (voice.level === 2) this.duckMusic(0.55, 1.1);
  }

  private playBuffer(buffer: AudioBuffer, gain: number, destination: AudioNode, category: TransientCategory, delay = 0, rate = 1): void {
    const context = this.context;
    if (!context) return;
    // Finished voices leave the list by their scheduled end as well as by onended, so the cap only ever evicts live
    // sounds. They are not stopped here: onended disconnects them.
    this.transientVoices = this.transientVoices.filter(voice => voice.endsAt > context.currentTime);
    while (this.transientVoices.length >= 12) this.disposeTransient(this.transientVoices[0]!);
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = rate;
    const level = context.createGain(); level.gain.value = gain;
    source.connect(level); level.connect(destination);
    const voice: TransientVoice = { source, gain: level, category, endsAt: context.currentTime + delay + buffer.duration / rate };
    this.transientVoices.push(voice);
    source.onended = () => {
      source.onended = null; source.disconnect(); level.disconnect();
      const index = this.transientVoices.indexOf(voice); if (index >= 0) this.transientVoices.splice(index, 1);
    };
    source.start(context.currentTime + delay);
  }

  private duckMusic(depth: number, seconds: number): void {
    const context = this.context;
    if (!context || !this.duck) return;
    const now = context.currentTime;
    this.duck.gain.setTargetAtTime(depth, now, 0.03);
    this.duck.gain.setTargetAtTime(1, now + seconds * 0.4, seconds * 0.3);
  }

  private disposeTransient(voice: TransientVoice): void {
    voice.source.onended = null;
    try { voice.source.stop(); } catch { /* already stopped */ }
    voice.source.disconnect(); voice.gain.disconnect();
    const index = this.transientVoices.indexOf(voice); if (index >= 0) this.transientVoices.splice(index, 1);
  }

  private clearCollisionVoices(): void {
    for (const voice of [...this.transientVoices]) if (voice.category === 'collision') this.disposeTransient(voice);
  }

  private silenceContinuousSources(): void {
    const now = this.context?.currentTime ?? 0;
    this.engine?.silence(now);
    this.bed?.silence(now);
    this.ambienceWindGain?.gain.setTargetAtTime(0, now, 0.04);
    this.ambienceIndustrialGain?.gain.setTargetAtTime(0, now, 0.04);
    this.previousGear = null;
    this.previousHandbrake = null;
  }

  private applyLevels(): void {
    if (!this.master || !this.context) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.userMuted || this.temporaryMutes.size ? 0 : this.volumes.master, now, 0.025);
    this.engineBus?.gain.setTargetAtTime(this.volumes.engine, now, 0.03);
    this.sfxBus?.gain.setTargetAtTime(this.volumes.sfx, now, 0.03);
    this.musicBus?.gain.setTargetAtTime(this.volumes.music, now, 0.03);
  }
  private applyMute(): void { if (this.master && this.context) this.master.gain.setTargetAtTime(this.userMuted || this.temporaryMutes.size ? 0 : this.volumes.master, this.context.currentTime, 0.025); }
}

export function createPlayerAudio(): PlayerAudio { return new PlayerAudio(); }

export function calculateHarborAmbience(timeSeconds: number, enabled: boolean): { wind: number; industrial: number } {
  if (!enabled || !Number.isFinite(timeSeconds)) return { wind: 0, industrial: 0 };
  const time = Math.max(0, timeSeconds);
  return {
    wind: 0.016 + 0.006 * Math.sin(time * 0.23) + 0.003 * Math.sin(time * 0.071),
    industrial: 0.003 + 0.0015 * (0.5 + 0.5 * Math.sin(time * 0.11)),
  };
}

/** Ridge Pass: gusting mountain wind and a faint valley hum. Neon Bay: sea breeze and a city traffic drone. */
export function calculateDistrictAmbience(district: string, timeSeconds: number, enabled: boolean): { wind: number; industrial: number } {
  if (district !== 'ridge' && district !== 'coast') return calculateHarborAmbience(timeSeconds, enabled);
  if (!enabled || !Number.isFinite(timeSeconds)) return { wind: 0, industrial: 0 };
  if (district === 'coast') {
    // Neon Bay: a light sea breeze over a steady city drone that swells as traffic passes underneath.
    const t = Math.max(0, timeSeconds);
    const swell = Math.max(0, Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.83 + 0.7));
    return { wind: 0.011 + 0.004 * Math.sin(t * 0.19), industrial: 0.0042 + 0.0022 * swell };
  }
  const time = Math.max(0, timeSeconds);
  const gust = Math.max(0, Math.sin(time * 0.17) + 0.6 * Math.sin(time * 0.53 + 1.3) + 0.3 * Math.sin(time * 1.31));
  return { wind: 0.024 + 0.014 * gust, industrial: 0.0016 + 0.0006 * Math.sin(time * 0.07) };
}
