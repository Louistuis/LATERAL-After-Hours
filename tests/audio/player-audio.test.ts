import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameSnapshot, InputFrame, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import { calculateHarborAmbience, DEFAULT_ENGINE_VOLUME, PlayerAudio } from '../../src/audio/player-audio';
import { fakeContexts, gainsToDestination, type FakeAudioContext, type FakeNode } from './fake-audio';

afterEach(() => vi.unstubAllGlobals());

type VehicleOptions = { speedMS?: number; slipRatio?: number; slipAngleRad?: number; grounded?: number; carId?: VehicleSnapshot['carId']; rpm?: number; gear?: number; surfaceId?: string; tick?: number };
function vehicle(options: VehicleOptions = {}): VehicleSnapshot {
  const wheel = (index: number): WheelSnapshot => ({ contact: index < (options.grounded ?? 4), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0.1, normalLoadN: 3000, angularVelocityRadS: 0, slipRatio: options.slipRatio ?? 0, slipAngleRad: options.slipAngleRad ?? 0, surfaceId: options.surfaceId ?? 'road:harbor' });
  return { simulationTick: options.tick ?? 10, carId: options.carId ?? 'CAR-01', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: -(options.speedMS ?? 0) }, angularVelocityRadS: { x: 0, y: 0, z: 0 }, wheels: [wheel(0), wheel(1), wheel(2), wheel(3)], engineRpm: options.rpm ?? 1200, gear: options.gear ?? 1, driftAngleRad: 0 };
}
function frame(options: VehicleOptions = {}, impact?: NonNullable<FrameSnapshot['impact']>): FrameSnapshot {
  const current = vehicle(options);
  return { previous: current, current, interpolationAlpha: 1, score: { banked: 0, unbanked: 0, multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: 0 }, ...(impact ? { impact } : {}) };
}
function controls(throttle: number, handbrake = 0): InputFrame { return { simulationTick: 10, throttle, brake: 0, steering: 0, handbrake, shift: 0, resetPressed: false }; }

async function unlocked(): Promise<{ audio: PlayerAudio; context: FakeAudioContext }> {
  const contexts = fakeContexts(vi.stubGlobal);
  const audio = new PlayerAudio();
  await audio.resumeFromGesture();
  // Distinct slider values let tests tell the buses apart along a node's path to the speakers.
  audio.setVolumes({ master: 0.83, music: 0.43, sfx: 0.29, engine: 0.61 });
  return { audio, context: contexts[0]! };
}
const engineLayerSources = (context: FakeAudioContext): FakeNode[] => context.of('source').filter(node => node.buffer?.numberOfChannels === 3);
const newSources = (context: FakeAudioContext, before: number): FakeNode[] => context.of('source').slice(before);

describe('mix and buses', () => {
  it('limits the master and keeps engine, SFX and ambience on separate sliders', async () => {
    const { audio, context } = await unlocked();
    try {
      const compressor = context.of('compressor')[0]!;
      expect(compressor.connections).toEqual([context.destination]);
      expect(compressor.threshold.value).toBeLessThan(0);
      audio.update(frame({ speedMS: 12, rpm: 4000 }), controls(0.8));
      const layers = engineLayerSources(context);
      expect(layers).toHaveLength(2);
      const enginePath = gainsToDestination(context, layers[0]!)!;
      expect(enginePath).toContain(0.61);
      expect(enginePath).not.toContain(0.29);
      expect(enginePath.at(-1)).toBe(0.83);
      const before = context.of('source').length;
      audio.update(frame({ speedMS: 12, rpm: 4000 }, { simulationTick: 22, speedDeltaMS: 2, impulseNs: 2500 }), controls(0.8));
      const impactPath = gainsToDestination(context, newSources(context, before)[0]!)!;
      expect(impactPath).toContain(0.29);
      expect(impactPath).not.toContain(0.61);
      const ambience = context.of('source').find(node => node.connections.length === 2)!;
      const ambiencePath = gainsToDestination(context, ambience)!;
      expect(ambiencePath).toContain(0.43);
      expect(ambiencePath).not.toContain(0.29);
    } finally { audio.dispose(); }
  });

  it('starts at the quieter default engine level and treats 0 as fully off', async () => {
    const contexts = fakeContexts(vi.stubGlobal);
    const audio = new PlayerAudio();
    try {
      await audio.resumeFromGesture();
      expect(audio.levels.engine).toBe(DEFAULT_ENGINE_VOLUME);
      const context = contexts[0]!;
      audio.update(frame({ speedMS: 10, rpm: 3000 }), controls(1));
      const layers = engineLayerSources(context);
      expect(layers).toHaveLength(2);
      audio.setVolumes({ master: 1, music: 0.5, sfx: 1, engine: 0 });
      expect(layers.every(source => source.disconnected && source.stopped)).toBe(true);
      audio.update(frame({ speedMS: 10, rpm: 3000 }), controls(1));
      audio.update(frame({ speedMS: 10, rpm: 5000, gear: 2 }), controls(0));
      expect(engineLayerSources(context)).toHaveLength(2); // nothing new was built while off
      audio.setVolumes({ master: 1, music: 0.5, sfx: 1, engine: 0.3 });
      audio.update(frame({ speedMS: 10, rpm: 3000 }), controls(1));
      expect(engineLayerSources(context)).toHaveLength(4);
    } finally { audio.dispose(); }
  });

  it('builds a different synth per car and an electric drive without combustion layers', async () => {
    const { audio, context } = await unlocked();
    try {
      audio.update(frame({ carId: 'CAR-01', speedMS: 10, rpm: 3000 }), controls(1));
      const v8 = engineLayerSources(context);
      const oscillatorsBefore = context.of('oscillator').length;
      audio.update(frame({ carId: 'CAR-02', speedMS: 10, rpm: 3000 }), controls(1));
      expect(v8.every(source => source.disconnected)).toBe(true);
      expect(engineLayerSources(context)).toHaveLength(2); // the Cybertruck added none
      expect(context.of('oscillator').length - oscillatorsBefore).toBeGreaterThanOrEqual(4);
      audio.update(frame({ carId: 'CAR-05', speedMS: 10, rpm: 3000 }), controls(1));
      expect(engineLayerSources(context)).toHaveLength(4);
      expect(context.of('oscillator').some(node => node.type === 'sine' && !node.disconnected)).toBe(true); // turbo whistle
    } finally { audio.dispose(); }
  });
});

describe('pause, mute and visibility', () => {
  it('silences engine and driving layers on pause and mute, and resumes them', async () => {
    const { audio, context } = await unlocked();
    try {
      audio.update(frame({ speedMS: 14, rpm: 5000, slipAngleRad: 0.6 }), controls(1));
      const engineBus = context.of('gain').find(node => node.gain.value === 0.61)!;
      const output = context.of('gain').find(node => node.connections.includes(engineBus))!;
      expect(gainsToDestinationNodes(context, engineLayerSources(context)[0]!)).toContain(output);
      expect(output.gain.value).toBeGreaterThan(0);
      audio.update(frame({ speedMS: 14, rpm: 5000 }), controls(1), true);
      expect(output.gain.value).toBe(0);
      audio.update(frame({ speedMS: 14, rpm: 5000 }), controls(1));
      expect(output.gain.value).toBeGreaterThan(0);
      audio.setUserMute(true);
      expect(output.gain.value).toBe(0);
      const master = context.of('compressor')[0]!;
      expect(context.nodes.find(node => node.connections.includes(master))!.gain.value).toBe(0);
      audio.setUserMute(false);
      audio.setTemporaryMute('hidden', true);
      expect(output.gain.value).toBe(0);
      audio.update(frame({ speedMS: 14, rpm: 5000 }), controls(1));
      expect(output.gain.value).toBe(0);
    } finally { audio.dispose(); }
  });

  it('plays an actual impact once per tick and consumes impacts during pause and ad mute', async () => {
    const { audio, context } = await unlocked();
    try {
      audio.update(frame());
      const count = (): number => context.of('source').filter(node => node.buffer && node.buffer.numberOfChannels === 1 && !node.loop).length;
      const base = count();
      audio.update(frame({}, { simulationTick: 21, speedDeltaMS: 0.015, impulseNs: 17.45 }));
      expect(count()).toBe(base);
      const hit = frame({}, { simulationTick: 22, speedDeltaMS: 0.87, impulseNs: 1009 });
      audio.update(hit); audio.update(hit);
      expect(count()).toBe(base + 1);
      const paused = frame({}, { simulationTick: 30, speedDeltaMS: 2, impulseNs: 2500 });
      audio.update(paused, undefined, true); audio.update(paused);
      expect(count()).toBe(base + 1);
      audio.setTemporaryMute('ad', true);
      const ad = frame({}, { simulationTick: 32, speedDeltaMS: 2, impulseNs: 2500 });
      audio.update(ad); audio.setTemporaryMute('ad', false); audio.update(ad);
      expect(count()).toBe(base + 1);
      audio.update(frame({}, { simulationTick: 33, speedDeltaMS: 4, impulseNs: 5000 }));
      expect(count()).toBe(base + 2);
      const crash = context.of('source').filter(node => !node.loop).at(-1)!;
      audio.update(frame(), undefined, true);
      expect(crash.disconnected).toBe(true);
    } finally { audio.dispose(); }
  });
});

describe('transient voices', () => {
  it('caps one-shots, cleans them up on end, and disconnects everything on dispose', async () => {
    const { audio, context } = await unlocked();
    audio.update(frame());
    const before = context.of('source').length;
    for (let i = 0; i < 16; i++) audio.update(frame({}, { simulationTick: 100 + i, speedDeltaMS: 1.5, impulseNs: 1500 }));
    const voices = newSources(context, before).filter(node => !node.loop);
    expect(voices).toHaveLength(16);
    expect(voices.slice(0, 4).every(voice => voice.disconnected)).toBe(true);
    expect(voices.slice(4).every(voice => !voice.disconnected)).toBe(true);
    voices[4]!.onended?.();
    expect(voices[4]!.disconnected).toBe(true);
    audio.dispose();
    expect(context.of('source').every(node => node.disconnected)).toBe(true);
    expect(context.of('oscillator').every(node => node.disconnected)).toBe(true);
    expect(context.state).toBe('closed');
  });
});

describe('cues', () => {
  it('only plays cues once unlocked and unmuted, and rate-limits menu hover ticks', async () => {
    const locked = new PlayerAudio();
    expect(locked.playCue('select')).toBe(false);
    locked.dispose();
    const { audio, context } = await unlocked();
    try {
      const before = context.of('source').length;
      expect(audio.playCue('hover')).toBe(true);
      expect(audio.playCue('hover')).toBe(true); // accepted but not repeated
      expect(newSources(context, before)).toHaveLength(1);
      context.currentTime = 1;
      audio.playCue('hover');
      expect(newSources(context, before)).toHaveLength(2);
      expect(gainsToDestination(context, newSources(context, before)[0]!)).toContain(0.29);
      audio.setUserMute(true);
      expect(audio.playCue('purchase')).toBe(false);
    } finally { audio.dispose(); }
  });

  it('plays countdown beeps, GO, a checkpoint and the finish with a delayed medal from run status', async () => {
    const { audio, context } = await unlocked();
    try {
      const before = context.of('source').length;
      const run = (state: string, checkpointIndex = 0) => ({ runId: 'r1', state, checkpointIndex });
      for (let tick = 0; tick <= 180; tick += 6) { context.currentTime = tick / 60; audio.update(frame({ tick }), controls(0), false, { run: run('COUNTDOWN'), result: null, tick }); }
      audio.update(frame(), controls(0), false, { run: run('ACTIVE'), result: null, tick: 181 });
      audio.update(frame(), controls(0), false, { run: run('ACTIVE', 1), result: null, tick: 400 });
      const cues = newSources(context, before).filter(node => !node.loop);
      expect(cues).toHaveLength(5); // 3, 2, 1, GO, checkpoint
      audio.update(frame(), controls(0), true, { run: run('RESULTS', 2), result: { runId: 'r1', medal: 'gold', valid: true }, tick: 900 });
      expect(newSources(context, before).filter(node => !node.loop)).toHaveLength(7); // finish + medal, even though paused
    } finally { audio.dispose(); }
  });
});

describe('ambience', () => {
  it('keeps the restrained time-varying Harbor bed', () => {
    const quiet = calculateHarborAmbience(0, true), later = calculateHarborAmbience(20, true);
    expect(quiet.wind).toBeGreaterThan(0); expect(later).not.toEqual(quiet);
    expect(later.wind).toBeLessThan(0.03); expect(later.industrial).toBeLessThan(0.006);
    expect(calculateHarborAmbience(5, false)).toEqual({ wind: 0, industrial: 0 });
    expect(calculateHarborAmbience(Infinity, true)).toEqual({ wind: 0, industrial: 0 });
  });
});

function gainsToDestinationNodes(context: FakeAudioContext, node: FakeNode, seen = new Set<FakeNode>()): FakeNode[] {
  return pathNodes(context, node, seen) ?? [];
}
function pathNodes(context: FakeAudioContext, node: FakeNode, seen: Set<FakeNode>): FakeNode[] | null {
  if (node === context.destination) return [];
  if (seen.has(node)) return null;
  seen.add(node);
  for (const next of node.connections) { const rest = pathNodes(context, next, seen); if (rest) return [next, ...rest]; }
  return null;
}
