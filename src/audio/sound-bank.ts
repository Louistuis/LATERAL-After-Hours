import type { CombustionBuffers } from './engine-graph';
import type { EngineVoice } from './engine-voices';
import {
  renderBlowOff, renderCombustionLayer, renderCrackle, renderCue, renderGravelLoop, renderHandbrake, renderImpact,
  renderNoiseLoop, renderScrapeLoop, renderShift, renderSquealLoop, type CueKind,
} from './synth-buffers';

/**
 * Turns the generated waveforms into AudioBuffers on first use and keeps them for the context's lifetime.
 * Every sound is synthesized here at runtime: there is nothing to download.
 */
export class SoundBank {
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly engines = new Map<string, CombustionBuffers>();

  /**
   * Sounds are synthesized at up to 32 kHz: content stays below 12 kHz, the resampling images land above 20 kHz,
   * and generation costs a third less than at 48 kHz.
   */
  readonly rate: number;
  /** Cues and impacts carry nothing above 8 kHz, so they are made at 24 kHz. */
  readonly cueRate: number;
  constructor(private readonly context: BaseAudioContext) { this.rate = Math.min(context.sampleRate, 32000); this.cueRate = Math.min(context.sampleRate, 24000); }

  get size(): number { return this.cache.size; }
  has(key: string): boolean { return this.cache.has(key); }

  private make(key: string, render: () => readonly Float32Array[], rate = this.rate): AudioBuffer {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const channels = render();
    const buffer = this.context.createBuffer(channels.length, channels[0]!.length, rate);
    channels.forEach((data, channel) => buffer.getChannelData(channel).set(data.subarray(0, buffer.length)));
    this.cache.set(key, buffer);
    return buffer;
  }

  noise(): AudioBuffer { return this.make('noise', () => [renderNoiseLoop(this.rate, 0x51f15e)]); }
  ambience(): AudioBuffer { return this.make('ambience', () => [renderNoiseLoop(this.rate, 0x0a11ce)]); }
  squeal(): AudioBuffer { return this.make('squeal', () => [renderSquealLoop(this.rate, 0x5c4ea1)]); }
  gravel(): AudioBuffer { return this.make('gravel', () => [renderGravelLoop(this.rate, 0x9a7e1)]); }
  scrape(): AudioBuffer { return this.make('scrape', () => [renderScrapeLoop(this.rate, 0x5c7a9e)]); }
  impact(level: 0 | 1 | 2): AudioBuffer { return this.make(`impact-${level}`, () => [renderImpact(level, this.cueRate, 0x1b9ac7)], this.cueRate); }
  shift(): AudioBuffer { return this.make('shift', () => [renderShift(this.rate, 0x5f1f7)]); }
  handbrake(): AudioBuffer { return this.make('handbrake', () => [renderHandbrake(this.rate, 0x4a6db)]); }
  cue(kind: CueKind): AudioBuffer { return this.make(`cue-${kind}`, () => [renderCue(kind, this.cueRate)], this.cueRate); }

  private seed(voice: EngineVoice): number { return [...voice.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7); }

  /** One generated rpm layer (the costliest buffers); exposed so prewarming can spread a car over several slices. */
  engineLayer(voice: EngineVoice, index: 0 | 1): AudioBuffer | null {
    if (voice.kind !== 'combustion') return null;
    return this.make(`engine-${voice.id}-${index}`, () => renderCombustionLayer(voice, voice.layerRpm[index], this.rate, this.seed(voice) + index * 7919).channels);
  }

  /** Engine layers for a voice (combustion) or just the shared noise (electric). */
  engine(voice: EngineVoice): CombustionBuffers {
    const cached = this.engines.get(voice.id);
    if (cached) return cached;
    const noise = this.noise();
    let buffers: CombustionBuffers;
    if (voice.kind === 'electric') {
      // The electric motor only needs noise; layers are unused placeholders that cost nothing.
      buffers = { layers: [noise, noise], crackle: null, blowOff: null, noise };
    } else {
      const seed = this.seed(voice);
      const layers = [this.engineLayer(voice, 0)!, this.engineLayer(voice, 1)!] as const;
      const crackle = voice.crackle > 0 ? this.make(`crackle-${voice.id}`, () => [renderCrackle(voice, this.rate, seed ^ 0xc4ac)]) : null;
      const blowOff = voice.turbo ? this.make(`blowoff-${voice.id}`, () => [renderBlowOff(voice.cylinders <= 4 ? 'flutter' : 'chuff', this.rate, seed ^ 0xb0f)]) : null;
      buffers = { layers, crackle, blowOff, noise };
    }
    this.engines.set(voice.id, buffers);
    return buffers;
  }
}
