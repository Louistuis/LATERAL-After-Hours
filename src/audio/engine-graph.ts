import { saturationCurve, saturationMakeup } from './dsp';
import {
  blowOffStrength, combustionParams, crackleStrength, electricParams, isThrottleLift, rpmNorm, turboParams, turboStep,
  type CombustionVoice, type ElectricVoice, type EngineVoice,
} from './engine-voices';
import { gearChange } from './driving-sfx';

/**
 * WebAudio engine synths. They run on any BaseAudioContext, so the same code drives the game (AudioContext) and the
 * offline review renders (OfflineAudioContext). Per frame they only retarget a handful of AudioParams: no nodes are
 * created per frame except the rare crackle or blow-off one-shot.
 */

export interface EngineFrame {
  readonly rpm: number;
  readonly throttle: number;
  readonly speedMS: number;
  readonly gear: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
}

export interface CombustionBuffers {
  /** Two generated rpm layers, three channels each: on-load exhaust, coasting exhaust, intake. */
  readonly layers: readonly [AudioBuffer, AudioBuffer];
  readonly crackle: AudioBuffer | null;
  readonly blowOff: AudioBuffer | null;
  readonly noise: AudioBuffer;
}
export interface ElectricBuffers { readonly noise: AudioBuffer }

export interface EngineSynth {
  readonly voice: EngineVoice;
  update(frame: EngineFrame, time: number): void;
  /** Fades everything out (pause, menus, mute); state resets so nothing fires on resume. */
  silence(time: number): void;
  dispose(): void;
}

/** Overall engine trim before the engine bus; tuned so default settings sit under the effects. */
export const ENGINE_OUTPUT_TRIM = 0.27;

function stopSafely(node: AudioScheduledSourceNode): void {
  try { node.stop(); } catch { /* never started or already stopped */ }
}

export class CombustionEngine implements EngineSynth {
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly layerGains: GainNode[][] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly pre: GainNode;
  private readonly makeup: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly intakeFilter: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly output: GainNode;
  private readonly whistle: OscillatorNode | null = null;
  private readonly whistleGain: GainNode | null = null;
  private readonly whooshFilter: BiquadFilterNode | null = null;
  private readonly whooshGain: GainNode | null = null;
  /** Live crackle and blow-off one-shots with their scheduled end, pruned by time (no reliance on onended). */
  private readonly oneShots = new Map<AudioBufferSourceNode, number>();
  private boost = 0;
  private previousThrottle: number | null = null;
  private previousGear: number | null = null;
  private lastTime: number | null = null;
  private shiftTime = Number.NEGATIVE_INFINITY;
  private shiftDepth = 0;
  private lastCrackle = Number.NEGATIVE_INFINITY;
  private lastBlowOff = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly context: BaseAudioContext, readonly voice: CombustionVoice, private readonly buffers: CombustionBuffers, destination: AudioNode) {
    const ctx = context;
    this.output = ctx.createGain(); this.output.gain.value = 0; this.output.connect(destination);
    const exhaustSum = ctx.createGain();
    this.pre = ctx.createGain(); this.pre.gain.value = voice.drive[0];
    const shaper = ctx.createWaveShaper(); shaper.curve = saturationCurve(); shaper.oversample = '2x';
    this.makeup = ctx.createGain(); this.makeup.gain.value = 0;
    this.lowpass = ctx.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.Q.value = 0.7; this.lowpass.frequency.value = voice.cutoffHz[0];
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = voice.bodyHz; body.Q.value = 1.1; body.gain.value = 4;
    exhaustSum.connect(this.pre); this.pre.connect(shaper); shaper.connect(this.makeup); this.makeup.connect(this.lowpass); this.lowpass.connect(body); body.connect(this.output);
    this.intakeFilter = ctx.createBiquadFilter(); this.intakeFilter.type = 'bandpass'; this.intakeFilter.Q.value = 0.9; this.intakeFilter.frequency.value = voice.intakeHz;
    this.intakeGain = ctx.createGain(); this.intakeGain.gain.value = 0;
    this.intakeFilter.connect(this.intakeGain); this.intakeGain.connect(this.output);
    this.nodes.push(exhaustSum, this.pre, shaper, this.makeup, this.lowpass, body, this.intakeFilter, this.intakeGain);
    buffers.layers.forEach((buffer, layer) => {
      const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      source.playbackRate.value = 1000 / voice.layerRpm[layer]!;
      const splitter = ctx.createChannelSplitter(3);
      source.connect(splitter);
      const gains = [0, 1, 2].map(channel => {
        const gain = ctx.createGain(); gain.gain.value = 0;
        splitter.connect(gain, channel);
        gain.connect(channel === 2 ? this.intakeFilter : exhaustSum);
        return gain;
      });
      this.sources.push(source); this.layerGains.push(gains); this.nodes.push(splitter, ...gains);
    });
    if (voice.turbo) {
      const whistle = ctx.createOscillator(); whistle.type = 'sine'; whistle.frequency.value = voice.turbo.whistleHz[0];
      const whistleGain = ctx.createGain(); whistleGain.gain.value = 0;
      whistle.connect(whistleGain); whistleGain.connect(this.output);
      const noise = ctx.createBufferSource(); noise.buffer = buffers.noise; noise.loop = true;
      const whooshFilter = ctx.createBiquadFilter(); whooshFilter.type = 'bandpass'; whooshFilter.Q.value = 1.4; whooshFilter.frequency.value = 900;
      const whooshGain = ctx.createGain(); whooshGain.gain.value = 0;
      noise.connect(whooshFilter); whooshFilter.connect(whooshGain); whooshGain.connect(this.output);
      this.whistle = whistle; this.whistleGain = whistleGain; this.whooshFilter = whooshFilter; this.whooshGain = whooshGain;
      this.sources.push(noise); this.nodes.push(whistleGain, whooshFilter, whooshGain);
      whistle.start();
    }
    for (const source of this.sources) source.start();
  }

  update(frame: EngineFrame, time: number): void {
    if (this.disposed) return;
    const voice = this.voice;
    const p = combustionParams(voice, frame);
    const norm = rpmNorm(frame);
    const dt = this.lastTime === null ? 1 / 60 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    const loadRising = frame.throttle >= (this.previousThrottle ?? 0);
    for (let layer = 0; layer < 2; layer++) {
      this.sources[layer]!.playbackRate.setTargetAtTime(p.rates[layer]!, time, 0.03);
      const gains = this.layerGains[layer]!;
      const weight = p.layerGains[layer]!;
      gains[0]!.gain.setTargetAtTime(weight * p.loadGains[0], time, loadRising ? 0.06 : 0.12);
      gains[1]!.gain.setTargetAtTime(weight * p.loadGains[1] * 0.85, time, loadRising ? 0.06 : 0.12);
      gains[2]!.gain.setTargetAtTime(weight, time, 0.05);
    }
    this.pre.gain.setTargetAtTime(p.drive, time, 0.08);
    this.makeup.gain.setTargetAtTime(saturationMakeup(p.drive) * p.exhaustGain, time, 0.07);
    this.intakeFilter.frequency.setTargetAtTime(p.intakeHz, time, 0.08);
    this.intakeGain.gain.setTargetAtTime(p.intakeGain, time, 0.07);

    // Gear changes: the torque cut dips level and tone; a sharp lift on the change also counts as a lift.
    const change = gearChange(this.previousGear, frame.gear);
    this.previousGear = frame.gear;
    if (change === 'up' || change === 'down') { this.shiftTime = time; this.shiftDepth = voice.shiftDip * (change === 'up' ? 1 : 0.45); }
    const sinceShift = time - this.shiftTime;
    const dip = sinceShift < 0 ? 0 : sinceShift < 0.075 ? this.shiftDepth : this.shiftDepth * Math.exp(-(sinceShift - 0.075) / 0.07);
    this.lowpass.frequency.setTargetAtTime(p.cutoffHz * (1 - dip * 0.45), time, 0.04);
    const limiterChop = p.limiter && Math.floor(time * 17) % 2 === 1 ? 0.4 : 1;
    this.output.gain.setTargetAtTime(ENGINE_OUTPUT_TRIM * (1 - dip) * limiterChop, time, dip > 0.05 ? 0.012 : 0.03);

    // Turbo spool, whistle and whoosh.
    const turbo = voice.turbo;
    const lifted = isThrottleLift(this.previousThrottle, frame.throttle) || (change === 'up' && frame.throttle > 0.4 && this.boost > 0.4);
    if (turbo && this.whistle && this.whistleGain && this.whooshGain && this.whooshFilter) {
      const boostBeforeLift = this.boost;
      this.boost = turboStep(this.boost, change === 'up' ? 0 : frame.throttle, norm, dt, turbo.spoolSeconds);
      const t = turboParams(turbo, this.boost, frame.throttle);
      this.whistle.frequency.setTargetAtTime(t.whistleHz, time, 0.12);
      this.whistleGain.gain.setTargetAtTime(t.whistleGain * 0.18, time, 0.08);
      this.whooshFilter.frequency.setTargetAtTime(600 + 1800 * this.boost, time, 0.1);
      this.whooshGain.gain.setTargetAtTime(t.whooshGain * 0.5, time, 0.08);
      if (lifted) {
        const strength = blowOffStrength(voice, boostBeforeLift);
        if (strength > 0 && time - this.lastBlowOff > 0.5) { this.lastBlowOff = time; this.playOneShot(this.buffers.blowOff, time, strength * 0.9, 1); }
        this.boost *= 0.3;
      }
    }
    if (lifted && time - this.lastCrackle > 0.7) {
      const strength = crackleStrength(voice, norm);
      // A full lift spits properly; the brief cut of an upshift only pops.
      const shiftPop = change === 'up' && !isThrottleLift(this.previousThrottle, frame.throttle);
      if (strength > 0) { this.lastCrackle = time; this.playOneShot(this.buffers.crackle, time + 0.04, strength * (shiftPop ? 0.4 : 0.75), shiftPop ? 0.45 : 1.15); }
    }
    this.previousThrottle = frame.throttle;
  }

  silence(time: number): void {
    if (this.disposed) return;
    this.output.gain.setTargetAtTime(0, time, 0.04);
    for (const source of this.oneShots.keys()) stopSafely(source);
    this.previousThrottle = null; this.previousGear = null; this.lastTime = null; this.boost = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of [...this.sources, ...this.oneShots.keys()]) { stopSafely(source); source.disconnect(); }
    if (this.whistle) { stopSafely(this.whistle); this.whistle.disconnect(); }
    for (const node of this.nodes) node.disconnect();
    this.output.disconnect();
    this.oneShots.clear();
  }

  private playOneShot(buffer: AudioBuffer | null, time: number, gain: number, fadeSeconds: number): void {
    if (!buffer) return;
    // Ended one-shots only leave the count here; onended disconnects them (touching them now could cut a scheduled one).
    for (const [live, endsAt] of this.oneShots) if (endsAt <= time) this.oneShots.delete(live);
    if (this.oneShots.size >= 4) return;
    const source = this.context.createBufferSource(); source.buffer = buffer;
    source.playbackRate.value = 0.94 + Math.random() * 0.12;
    const level = this.context.createGain();
    level.gain.setValueAtTime(gain, time);
    level.gain.setTargetAtTime(0, time + fadeSeconds * 0.35, fadeSeconds * 0.3);
    source.connect(level); level.connect(this.output);
    const endsAt = time + Math.min(buffer.duration, fadeSeconds * 2.2);
    this.oneShots.set(source, endsAt);
    source.onended = () => { source.onended = null; source.disconnect(); level.disconnect(); this.oneShots.delete(source); };
    source.start(time); source.stop(endsAt);
  }
}

/** Cybertruck: motor whine, gear mesh, stepping inverter tone and a soft hum. No combustion, no shift dips. */
export class ElectricMotor implements EngineSynth {
  private readonly whine: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly mesh: OscillatorNode;
  private readonly inverter: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly whineGain: GainNode;
  private readonly meshGain: GainNode;
  private readonly inverterGain: GainNode;
  private readonly humGain: GainNode;
  private readonly inverterBand: BiquadFilterNode;
  private readonly output: GainNode;
  private readonly nodes: AudioNode[] = [];
  private disposed = false;

  constructor(context: BaseAudioContext, readonly voice: ElectricVoice, buffers: ElectricBuffers, destination: AudioNode) {
    const ctx = context;
    this.output = ctx.createGain(); this.output.gain.value = 0; this.output.connect(destination);
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 3800; tone.Q.value = 0.5; tone.connect(this.output);
    this.whine = ctx.createOscillator(); this.whine.type = 'sine';
    this.sub = ctx.createOscillator(); this.sub.type = 'triangle';
    this.mesh = ctx.createOscillator(); this.mesh.type = 'sine';
    this.inverter = ctx.createOscillator(); this.inverter.type = 'square';
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    const subGain = ctx.createGain(); subGain.gain.value = 0.35;
    this.meshGain = ctx.createGain(); this.meshGain.gain.value = 0;
    this.inverterGain = ctx.createGain(); this.inverterGain.gain.value = 0;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
    const inverterBand = ctx.createBiquadFilter(); inverterBand.type = 'bandpass'; inverterBand.Q.value = 9; inverterBand.frequency.value = voice.inverterSteps[0]!.hz;
    const hum = ctx.createBiquadFilter(); hum.type = 'lowpass'; hum.frequency.value = 260; hum.Q.value = 0.9;
    this.noise = ctx.createBufferSource(); this.noise.buffer = buffers.noise; this.noise.loop = true;
    this.whine.connect(this.whineGain); this.sub.connect(subGain); subGain.connect(this.whineGain); this.whineGain.connect(tone);
    this.mesh.connect(this.meshGain); this.meshGain.connect(tone);
    this.inverter.connect(inverterBand); inverterBand.connect(this.inverterGain); this.inverterGain.connect(tone);
    this.noise.connect(hum); hum.connect(this.humGain); this.humGain.connect(this.output);
    this.nodes.push(tone, this.whineGain, subGain, this.meshGain, this.inverterGain, this.humGain, inverterBand, hum);
    this.inverterBand = inverterBand;
    for (const source of [this.whine, this.sub, this.mesh, this.inverter, this.noise]) source.start();
  }

  update(frame: EngineFrame, time: number): void {
    if (this.disposed) return;
    const p = electricParams(this.voice, frame);
    this.whine.frequency.setTargetAtTime(p.whineHz, time, 0.05);
    this.sub.frequency.setTargetAtTime(p.whineHz / 2, time, 0.05);
    this.mesh.frequency.setTargetAtTime(p.whineHz * this.voice.meshRatio, time, 0.05);
    this.inverter.frequency.setTargetAtTime(p.inverterHz, time, 0.03);
    this.inverterBand.frequency.setTargetAtTime(p.inverterHz, time, 0.03);
    this.whineGain.gain.setTargetAtTime(p.whineGain * 0.55, time, 0.07);
    this.meshGain.gain.setTargetAtTime(p.meshGain * 0.3, time, 0.07);
    this.inverterGain.gain.setTargetAtTime(p.inverterGain * 0.5, time, 0.05);
    this.humGain.gain.setTargetAtTime(p.humGain * 0.9, time, 0.2);
    this.output.gain.setTargetAtTime(ENGINE_OUTPUT_TRIM, time, 0.04);
  }

  silence(time: number): void { if (!this.disposed) this.output.gain.setTargetAtTime(0, time, 0.04); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of [this.whine, this.sub, this.mesh, this.inverter, this.noise]) { stopSafely(source); source.disconnect(); }
    for (const node of this.nodes) node.disconnect();
    this.output.disconnect();
  }
}

export function createEngineSynth(context: BaseAudioContext, voice: EngineVoice, buffers: CombustionBuffers, destination: AudioNode): EngineSynth {
  return voice.kind === 'electric' ? new ElectricMotor(context, voice, buffers, destination) : new CombustionEngine(context, voice, buffers, destination);
}
