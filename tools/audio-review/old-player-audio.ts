import type { FrameSnapshot, InputFrame, VehicleSnapshot } from '../../contracts/runtime-contracts';
import type { ExperienceAudio } from '../../src/experience/coordinator';

export interface AudioVolumes { master: number; music: number; sfx: number }
const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
type TransientCategory = 'collision' | 'other';

/** Small synthesized soundscape; all sources are generated locally and unlocked by a user gesture. */
/** Revision 16 oscillator engine, kept only for the review loudness comparison. */
export class OldPlayerAudio implements ExperienceAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private tireGain: GainNode | null = null;
  private impactGain: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private tireBus: GainNode | null = null;
  private impactBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private userMuted = false;
  private readonly temporaryMutes = new Set<'hidden' | 'ad'>();
  private volumes: AudioVolumes = { master: 0.8, music: 0.45, sfx: 0.8 };
  private oscillators: OscillatorNode[] = [];
  private musicOscillators: OscillatorNode[] = [];
  private transientVoices: Array<{ oscillator: OscillatorNode; gain: GainNode; category: TransientCategory }> = [];
  private noise: AudioBufferSourceNode | null = null;
  private tireFilter: BiquadFilterNode | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceWindFilter: BiquadFilterNode | null = null;
  private ambienceIndustrialFilter: BiquadFilterNode | null = null;
  private ambienceWindGain: GainNode | null = null;
  private ambienceIndustrialGain: GainNode | null = null;
  private liftOscillator: OscillatorNode | null = null;
  private liftGain: GainNode | null = null;
  private tireGainTarget = 0;
  private previousInputThrottle: number | null = null;
  private lastLiftCueTime = Number.NEGATIVE_INFINITY;
  private lastImpactTick: number | null = null;
  private previousGear = 1;
  private currentCar: string | null = null;
  private readonly carTone: Record<string, number> = { 'CAR-01': 0.92, 'CAR-02': 1.12, 'CAR-04': 1.42, 'CAR-05': 1.18, 'CAR-06': 1.3 };
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
  setVolumes(volumes: AudioVolumes): void { this.volumes = { master: clamp(volumes.master), music: clamp(volumes.music), sfx: clamp(volumes.sfx) }; this.applyLevels(); }
  get isUserMuted(): boolean { return this.userMuted; }
  private district = 'harbor';
  /** Ambience bed follows the location: harbour wind and machinery, or mountain gusts over a distant city hum. */
  setDistrict(district: string): void { this.district = district; }

  update(frame: FrameSnapshot, input?: InputFrame, paused = false): void {
    let collisionSeverity = 0;
    const hit = frame.impact;
    if (hit && Number.isSafeInteger(hit.simulationTick) && hit.simulationTick !== this.lastImpactTick) {
      this.lastImpactTick = hit.simulationTick;
      collisionSeverity = calculateImpactSeverity(hit);
    }
    if (paused) { collisionSeverity = 0; this.clearCollisionVoices(); this.silenceContinuousSources(); }
    const context = this.context;
    if (!context || context.state !== 'running') { this.silenceContinuousSources(); return; }
    const canPlayCollision = !paused && !this.userMuted && this.temporaryMutes.size === 0;
    const canPlayBed = !paused && !this.userMuted && this.temporaryMutes.size === 0;
    const car = frame.current;
    if (car.carId !== this.currentCar) {
      const timbre = car.carId === 'CAR-02' ? ['square','sawtooth','triangle'] : car.carId === 'CAR-04' || car.carId === 'CAR-06' ? ['sawtooth','square','sawtooth'] : ['sawtooth','triangle','sine'];
      this.oscillators.forEach((oscillator,index) => { oscillator.type = timbre[index] as OscillatorType; }); this.currentCar = car.carId;
    }
    if (car.gear !== this.previousGear) { if (canPlayBed) this.playShift(); this.previousGear = car.gear; }
    const tone = this.carTone[car.carId] ?? 1;
    const normalizedRpm = Math.max(0, Math.min(1, (car.engineRpm - 800) / 6200));
    const fundamental = (48 + normalizedRpm * 168) * tone;
    this.oscillators.forEach((oscillator, index) => oscillator.frequency.setTargetAtTime(fundamental * (index + 1), context.currentTime, 0.055));
    const throttle = paused ? 0 : clamp(input?.throttle ?? normalizedRpm);
    const speedMS = Math.hypot(car.linearVelocityMS.x, car.linearVelocityMS.z);
    if (input && !paused && canPlayBed && speedMS >= 5 && this.previousInputThrottle !== null && this.previousInputThrottle >= 0.45 && throttle <= 0.08) this.playThrottleLift();
    this.previousInputThrottle = canPlayBed && input ? throttle : null;
    // RPM supplies the idle pitch; consumed throttle adds load, and lift gets a short separate falling tone.
    this.engineGain?.gain.setTargetAtTime(canPlayBed ? 0.08 + normalizedRpm * 0.2 + throttle * 0.5 : 0, context.currentTime, !canPlayBed ? 0.04 : throttle < 0.05 ? 0.14 : 0.08);
    const skidTarget = canPlayBed ? calculateSkidGain(car.wheels, speedMS, false) : 0;
    this.tireGain?.gain.setTargetAtTime(skidTarget, context.currentTime, !canPlayBed ? 0.04 : skidTarget > this.tireGainTarget ? 0.13 : 0.28);
    this.tireGainTarget = skidTarget;
    this.tireFilter?.frequency.setTargetAtTime(500 + skidTarget * 7000, context.currentTime, 0.06);
    const ambience = calculateDistrictAmbience(this.district, context.currentTime, canPlayBed);
    this.ambienceWindGain?.gain.setTargetAtTime(ambience.wind, context.currentTime, canPlayBed ? 0.8 : 0.04);
    this.ambienceIndustrialGain?.gain.setTargetAtTime(ambience.industrial, context.currentTime, canPlayBed ? 1.2 : 0.04);
    this.ambienceWindFilter?.frequency.setTargetAtTime(260 + ambience.wind * 3600, context.currentTime, 1.1);
    this.ambienceIndustrialFilter?.frequency.setTargetAtTime(115 + ambience.industrial * 1800, context.currentTime, 1.5);
    if (canPlayCollision && collisionSeverity > 0) this.playImpact(collisionSeverity);
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const node of [...this.oscillators, ...this.musicOscillators, this.liftOscillator, this.noise, this.ambienceSource]) {
      if (!node) continue;
      try { node.stop(); } catch (error) { if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error; }
      node.disconnect();
    }
    for (const voice of this.transientVoices.splice(0)) this.disposeTransient(voice);
    for (const node of [this.tireFilter, this.ambienceWindFilter, this.ambienceIndustrialFilter, this.engineGain, this.tireGain, this.impactGain, this.ambienceWindGain, this.ambienceIndustrialGain, this.liftGain, this.engineBus, this.tireBus, this.impactBus, this.musicBus, this.master]) node?.disconnect();
    void this.context?.close(); this.context = null; this.oscillators = []; this.musicOscillators = []; this.noise = null; this.ambienceSource = null;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    // Safari before 14.1 only ships the prefixed constructor.
    const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable');
    const context = new Context({ latencyHint: 'interactive' }); this.context = context;
    const master = context.createGain(); master.connect(context.destination); this.master = master;
    const engine = context.createGain(); engine.connect(master); this.engineBus = engine;
    const engineLevel = context.createGain(); engineLevel.gain.value = 0.25; engineLevel.connect(engine); this.engineGain = engineLevel;
    const tire = context.createGain(); tire.connect(master); this.tireBus = tire;
    const tireLevel = context.createGain(); tireLevel.gain.value = 0; tireLevel.connect(tire); this.tireGain = tireLevel;
    const impact = context.createGain(); impact.connect(master); this.impactBus = impact;
    const impactLevel = context.createGain(); impactLevel.gain.value = 1; impactLevel.connect(impact); this.impactGain = impactLevel;
    const music = context.createGain(); music.connect(master); this.musicBus = music;
    const filter = context.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = 0.6; filter.frequency.value = 800;
    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    fillDeterministicNoise(noiseBuffer, 0x51f15e);
    const noise = context.createBufferSource(); noise.buffer = noiseBuffer; noise.loop = true; noise.connect(filter); filter.connect(tireLevel); noise.start();
    this.noise = noise; this.tireFilter = filter;
    const ambienceBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    fillDeterministicNoise(ambienceBuffer, 0x0a11ce);
    const ambienceSource = context.createBufferSource(); ambienceSource.buffer = ambienceBuffer; ambienceSource.loop = true;
    const windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 260; windFilter.Q.value = 0.5;
    const industrialFilter = context.createBiquadFilter(); industrialFilter.type = 'bandpass'; industrialFilter.frequency.value = 115; industrialFilter.Q.value = 2.4;
    const windGain = context.createGain(); windGain.gain.value = 0;
    const industrialGain = context.createGain(); industrialGain.gain.value = 0;
    ambienceSource.connect(windFilter); windFilter.connect(windGain); windGain.connect(music);
    ambienceSource.connect(industrialFilter); industrialFilter.connect(industrialGain); industrialGain.connect(music); ambienceSource.start();
    this.ambienceSource = ambienceSource; this.ambienceWindFilter = windFilter; this.ambienceIndustrialFilter = industrialFilter; this.ambienceWindGain = windGain; this.ambienceIndustrialGain = industrialGain;
    // A fundamental with two quiet harmonics creates a layered motor timbre without loop seams.
    for (const [index, type] of (['sawtooth', 'triangle', 'sine'] as const).entries()) {
      const oscillator = context.createOscillator(); const harmonicGain = context.createGain();
      harmonicGain.gain.value = [1, 0.32, 0.14][index]!;
      oscillator.type = type; oscillator.frequency.value = 60 * (index + 1); oscillator.connect(harmonicGain); harmonicGain.connect(engineLevel); oscillator.start(); this.oscillators.push(oscillator);
    }
    const liftOscillator = context.createOscillator(), liftGain = context.createGain();
    liftOscillator.type = 'triangle'; liftOscillator.frequency.value = 175; liftGain.gain.value = 0;
    liftOscillator.connect(liftGain); liftGain.connect(engine); liftOscillator.start(); this.liftOscillator = liftOscillator; this.liftGain = liftGain;
    this.applyLevels(); this.applyMute(); return context;
  }

  private playImpact(severity: number): void {
    const context = this.context; if (!context || severity < 0.02) return;
    const osc = context.createOscillator(); const gain = context.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(180 + severity * 170, context.currentTime); osc.frequency.exponentialRampToValueAtTime(65, context.currentTime + 0.11);
    gain.gain.setValueAtTime(Math.min(0.14, severity * 0.12), context.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.14);
    osc.connect(gain); gain.connect(this.impactGain!); this.startTransient(osc, gain, context.currentTime + 0.15, 'collision');
  }

  private playShift(): void {
    const context = this.context; if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(500,context.currentTime); oscillator.frequency.exponentialRampToValueAtTime(170,context.currentTime+.07);
    gain.gain.setValueAtTime(.028,context.currentTime); gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.08);
    oscillator.connect(gain); gain.connect(this.impactGain!); this.startTransient(oscillator, gain, context.currentTime+.09);
  }

  playUiCue(kind: 'confirm'|'back'|'error' = 'confirm'): void {
    const context = this.context; if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator(), gain = context.createGain(); const start = kind === 'error' ? 175 : kind === 'back' ? 330 : 520;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(start,context.currentTime); oscillator.frequency.exponentialRampToValueAtTime(start*.72,context.currentTime+.09);
    gain.gain.setValueAtTime(.035,context.currentTime); gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.1);
    oscillator.connect(gain); gain.connect(this.impactGain!); this.startTransient(oscillator, gain, context.currentTime+.11);
  }

  private startTransient(oscillator: OscillatorNode, gain: GainNode, stopAt: number, category: TransientCategory = 'other'): void {
    while (this.transientVoices.length >= 12) this.disposeTransient(this.transientVoices[0]!);
    const voice = { oscillator, gain, category };
    this.transientVoices.push(voice);
    oscillator.onended = () => {
      oscillator.onended = null; oscillator.disconnect(); gain.disconnect();
      const index = this.transientVoices.indexOf(voice); if (index >= 0) this.transientVoices.splice(index, 1);
    };
    oscillator.start(this.context!.currentTime); oscillator.stop(stopAt); // review harness: explicit start time
  }

  private disposeTransient(voice: { oscillator: OscillatorNode; gain: GainNode; category: TransientCategory }): void {
    voice.oscillator.onended = null;
    try { voice.oscillator.stop(); }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error; }
    voice.oscillator.disconnect(); voice.gain.disconnect();
    const index = this.transientVoices.indexOf(voice); if (index >= 0) this.transientVoices.splice(index, 1);
  }

  private clearCollisionVoices(): void {
    for (const voice of [...this.transientVoices]) if (voice.category === 'collision') this.disposeTransient(voice);
  }

  private silenceContinuousSources(): void {
    const now = this.context?.currentTime ?? 0;
    this.engineGain?.gain.setTargetAtTime(0, now, 0.04);
    this.tireGain?.gain.setTargetAtTime(0, now, 0.04);
    this.ambienceWindGain?.gain.setTargetAtTime(0, now, 0.04);
    this.ambienceIndustrialGain?.gain.setTargetAtTime(0, now, 0.04);
    this.liftGain?.gain.setTargetAtTime(0, now, 0.02);
    this.tireGainTarget = 0;
    this.previousInputThrottle = null;
  }

  private playThrottleLift(): void {
    const context = this.context;
    if (!context || !this.liftOscillator || !this.liftGain || context.currentTime - this.lastLiftCueTime < 0.22) return;
    this.lastLiftCueTime = context.currentTime;
    this.liftOscillator.frequency.setTargetAtTime(125, context.currentTime, 0.015);
    this.liftGain.gain.setTargetAtTime(0.05, context.currentTime, 0.015);
    this.liftGain.gain.setTargetAtTime(0, context.currentTime + 0.055, 0.075);
  }

  private applyLevels(): void {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(this.userMuted || this.temporaryMutes.size ? 0 : this.volumes.master, this.context!.currentTime, 0.025);
    if (this.engineBus) this.engineBus.gain.value = this.volumes.sfx * 0.24;
    if (this.tireBus) this.tireBus.gain.value = this.volumes.sfx * 0.2;
    if (this.impactBus) this.impactBus.gain.value = this.volumes.sfx;
    if (this.musicBus) this.musicBus.gain.value = this.volumes.music;
  }
  private applyMute(): void { if (this.master && this.context) this.master.gain.setTargetAtTime(this.userMuted || this.temporaryMutes.size ? 0 : this.volumes.master, this.context.currentTime, 0.025); }
}

export function createPlayerAudio(): PlayerAudio { return new PlayerAudio(); }

export function calculateTireGain(slip: number, paused: boolean): number {
  return paused ? 0 : clamp(slip) * 0.36;
}

/** Sustained skid layer: require movement and at least two grounded wheels, then attack/release in WebAudio. */
export function calculateSkidGain(wheels: VehicleSnapshot['wheels'], speedMS: number, paused: boolean): number {
  if (paused || !Number.isFinite(speedMS) || speedMS < 4) return 0;
  let total = 0, grounded = 0;
  for (const wheel of wheels) {
    if (!wheel.contact) continue;
    const ratio = Number.isFinite(wheel.slipRatio) ? Math.abs(wheel.slipRatio) : 0;
    const angle = Number.isFinite(wheel.slipAngleRad) ? Math.abs(wheel.slipAngleRad) : 0;
    total += clamp(ratio * 0.32 + angle * 1.5);
    grounded++;
  }
  if (grounded < 2) return 0;
  const meanSlip = total / grounded;
  const normalized = clamp((meanSlip - 0.08) / 0.62);
  return calculateTireGain(normalized, false);
}

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

function fillDeterministicNoise(buffer: Pick<AudioBuffer, 'getChannelData'>, initialSeed: number): void {
  const samples = buffer.getChannelData(0);
  let seed = initialSeed >>> 0;
  for (let index = 0; index < samples.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[index] = seed / 0xffffffff * 2 - 1;
  }
}

/**
 * Collision cue threshold/curve uses actual frame impact telemetry, never wheel load.
 * With both positive finite fields present, 0.32 m/s or 400 N·s reaches the quiet threshold.
 * Both scales saturate at a strong 4 m/s or 5000 N·s event.
 */
export function calculateImpactSeverity(impact: Pick<NonNullable<FrameSnapshot['impact']>, 'speedDeltaMS' | 'impulseNs'>): number {
  if (!Number.isFinite(impact.speedDeltaMS) || !Number.isFinite(impact.impulseNs) || impact.speedDeltaMS <= 0 || impact.impulseNs <= 0) return 0;
  const normalized = Math.max(impact.speedDeltaMS / 4, impact.impulseNs / 5000);
  const threshold = 0.08;
  return normalized <= threshold ? 0 : clamp((normalized - threshold) / (1 - threshold));
}
