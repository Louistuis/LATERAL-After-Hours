import type { SurfaceParams, TyreParams } from './driving-sfx';
import { SQUEAL_BASE_HZ } from './synth-buffers';

/**
 * Continuous driving layers: tyre squeal and scrub, gravel, rumble strips and barrier scrape. Like the engine
 * synth it runs on any BaseAudioContext and only retargets AudioParams each frame.
 */
export interface DrivingBedBuffers {
  readonly squeal: AudioBuffer;
  readonly noise: AudioBuffer;
  readonly gravel: AudioBuffer;
  readonly scrape: AudioBuffer;
}
export interface DrivingBedFrame {
  readonly tyres: TyreParams;
  readonly surface: SurfaceParams;
  readonly scrape: number;
  readonly speedMS: number;
}

/** Layer trims under the SFX bus; chosen by ear against the impacts and the default engine level. */
export const DRIVING_TRIMS = { squeal: 0.36, scrub: 0.3, gravel: 0.55, curb: 0.45, scrape: 0.4 } as const;

export class DrivingBed {
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly squeal: AudioBufferSourceNode;
  private readonly gravel: AudioBufferSourceNode;
  private readonly scrape: AudioBufferSourceNode;
  private readonly curb: OscillatorNode;
  private readonly squealGain: GainNode;
  private readonly scrubFilter: BiquadFilterNode;
  private readonly scrubGain: GainNode;
  private readonly gravelGain: GainNode;
  private readonly curbGain: GainNode;
  private readonly scrapeGain: GainNode;
  private squealLevel = 0;
  private disposed = false;

  constructor(context: BaseAudioContext, buffers: DrivingBedBuffers, destination: AudioNode) {
    const ctx = context;
    const loop = (buffer: AudioBuffer): AudioBufferSourceNode => { const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true; this.sources.push(source); return source; };
    const gain = (): GainNode => { const node = ctx.createGain(); node.gain.value = 0; node.connect(destination); this.nodes.push(node); return node; };
    this.squeal = loop(buffers.squeal);
    this.squealGain = gain();
    const squealTone = ctx.createBiquadFilter(); squealTone.type = 'highpass'; squealTone.frequency.value = 380; squealTone.Q.value = 0.6;
    this.squeal.connect(squealTone); squealTone.connect(this.squealGain);
    const noise = loop(buffers.noise);
    this.scrubFilter = ctx.createBiquadFilter(); this.scrubFilter.type = 'bandpass'; this.scrubFilter.Q.value = 0.8; this.scrubFilter.frequency.value = 900;
    this.scrubGain = gain();
    noise.connect(this.scrubFilter); this.scrubFilter.connect(this.scrubGain);
    this.gravel = loop(buffers.gravel);
    const gravelTone = ctx.createBiquadFilter(); gravelTone.type = 'lowpass'; gravelTone.frequency.value = 2600; gravelTone.Q.value = 0.6;
    this.gravelGain = gain();
    this.gravel.connect(gravelTone); gravelTone.connect(this.gravelGain);
    this.curb = ctx.createOscillator(); this.curb.type = 'square'; this.curb.frequency.value = 20; this.sources.push(this.curb);
    const curbTone = ctx.createBiquadFilter(); curbTone.type = 'lowpass'; curbTone.frequency.value = 230; curbTone.Q.value = 1.2;
    this.curbGain = gain();
    this.curb.connect(curbTone); curbTone.connect(this.curbGain);
    this.scrape = loop(buffers.scrape);
    this.scrapeGain = gain();
    this.scrape.connect(this.scrapeGain);
    this.nodes.push(squealTone, this.scrubFilter, gravelTone, curbTone);
    for (const source of this.sources) source.start();
  }

  update(frame: DrivingBedFrame, time: number): void {
    if (this.disposed) return;
    const { tyres, surface } = frame;
    const rising = tyres.squealGain > this.squealLevel;
    this.squealLevel = tyres.squealGain;
    this.squealGain.gain.setTargetAtTime(tyres.squealGain * DRIVING_TRIMS.squeal, time, rising ? 0.05 : 0.13);
    this.squeal.playbackRate.setTargetAtTime(tyres.squealHz / SQUEAL_BASE_HZ, time, 0.09);
    this.scrubGain.gain.setTargetAtTime(tyres.scrubGain * DRIVING_TRIMS.scrub, time, rising ? 0.05 : 0.15);
    this.scrubFilter.frequency.setTargetAtTime(tyres.scrubHz, time, 0.08);
    this.gravelGain.gain.setTargetAtTime(surface.gravelGain * DRIVING_TRIMS.gravel, time, 0.07);
    this.gravel.playbackRate.setTargetAtTime(surface.gravelRate, time, 0.1);
    this.curbGain.gain.setTargetAtTime(surface.curbGain * DRIVING_TRIMS.curb, time, 0.04);
    this.curb.frequency.setTargetAtTime(surface.curbHz, time, 0.05);
    this.scrapeGain.gain.setTargetAtTime(frame.scrape * DRIVING_TRIMS.scrape, time, frame.scrape > 0 ? 0.03 : 0.12);
    this.scrape.playbackRate.setTargetAtTime(0.7 + Math.min(0.9, frame.speedMS / 45), time, 0.08);
  }

  silence(time: number): void {
    if (this.disposed) return;
    for (const node of [this.squealGain, this.scrubGain, this.gravelGain, this.curbGain, this.scrapeGain]) node.gain.setTargetAtTime(0, time, 0.04);
    this.squealLevel = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) { try { source.stop(); } catch { /* not started */ } source.disconnect(); }
    for (const node of this.nodes) node.disconnect();
  }
}
