import { describe, expect, it } from 'vitest';
import { peak, rms } from '../../src/audio/dsp';
import { ENGINE_VOICES, type CombustionVoice } from '../../src/audio/engine-voices';
import {
  CUE_KINDS, CUE_PEAKS, renderBlowOff, renderCombustionLayer, renderCrackle, renderCue, renderGravelLoop, renderHandbrake, renderImpact,
  renderScrapeLoop, renderShift, renderSquealLoop,
} from '../../src/audio/synth-buffers';

const SR = 16000;
const finite = (data: Float32Array): boolean => data.every(Number.isFinite);
/** A loop is seamless when its wrap-around step is no bigger than the largest step inside it. */
function seamless(data: Float32Array): boolean {
  let largest = 0;
  for (let i = 1; i < data.length; i++) largest = Math.max(largest, Math.abs(data[i]! - data[i - 1]!));
  return Math.abs(data[0]! - data[data.length - 1]!) <= largest + 1e-6;
}

describe('generated engine layers', () => {
  for (const car of ['CAR-01', 'CAR-04', 'CAR-05', 'CAR-06'] as const) {
    it(`${car} renders whole cycles of on-load, coasting and intake channels that loop seamlessly`, () => {
      const voice = ENGINE_VOICES[car] as CombustionVoice;
      for (const rpm of voice.layerRpm) {
        const layer = renderCombustionLayer(voice, rpm, SR, 42);
        const [on, off, intake] = layer.channels;
        expect(on.length).toBe(Math.round(layer.cycles * 120 / rpm * SR));
        for (const channel of layer.channels) { expect(finite(channel)).toBe(true); expect(peak(channel)).toBeLessThanOrEqual(0.93); expect(seamless(channel)).toBe(true); }
        // Coasting is clearly quieter than pulling.
        expect(rms(off)).toBeLessThan(rms(on) * 0.8);
        expect(rms(intake)).toBeGreaterThan(0);
      }
    });
  }
  it('is deterministic per seed', () => {
    const voice = ENGINE_VOICES['CAR-01'] as CombustionVoice;
    expect(renderCombustionLayer(voice, 1100, SR, 7).channels[0]).toEqual(renderCombustionLayer(voice, 1100, SR, 7).channels[0]);
    expect(renderCombustionLayer(voice, 1100, SR, 7).channels[0]).not.toEqual(renderCombustionLayer(voice, 1100, SR, 8).channels[0]);
  });
});

describe('generated effects', () => {
  it('keeps every loop and one-shot finite and below full scale', () => {
    const lancia = ENGINE_VOICES['CAR-05'] as CombustionVoice;
    const sounds = [renderSquealLoop(SR, 1), renderGravelLoop(SR, 2), renderScrapeLoop(SR, 3), renderShift(SR, 4), renderHandbrake(SR, 5),
      renderCrackle(lancia, SR, 6), renderBlowOff('flutter', SR, 7), renderBlowOff('chuff', SR, 8), renderImpact(0, SR, 9), renderImpact(1, SR, 9), renderImpact(2, SR, 9)];
    for (const sound of sounds) { expect(finite(sound)).toBe(true); expect(peak(sound)).toBeLessThanOrEqual(0.96); expect(peak(sound)).toBeGreaterThan(0.1); }
    for (const loop of sounds.slice(0, 3)) expect(seamless(loop)).toBe(true);
  });
  it('makes heavier impacts longer and denser', () => {
    const [light, medium, heavy] = ([0, 1, 2] as const).map(level => renderImpact(level, SR, 1));
    expect(heavy!.length).toBeGreaterThan(medium!.length);
    expect(medium!.length).toBeGreaterThan(light!.length);
    expect(rms(heavy!) * heavy!.length).toBeGreaterThan(rms(light!) * light!.length);
  });
  it('renders every cue at its peak, with menu ticks far quieter and shorter than race cues', () => {
    for (const kind of CUE_KINDS) {
      const cue = renderCue(kind, SR);
      expect(finite(cue)).toBe(true);
      expect(peak(cue)).toBeCloseTo(CUE_PEAKS[kind], 2);
    }
    expect(CUE_PEAKS.hover).toBeLessThan(CUE_PEAKS.select / 2);
    expect(CUE_PEAKS.select).toBeLessThan(CUE_PEAKS.count);
    expect(renderCue('hover', SR).length).toBeLessThan(SR * 0.05);
    expect(renderCue('finish', SR).length).toBeGreaterThan(renderCue('checkpoint', SR).length);
  });
});
