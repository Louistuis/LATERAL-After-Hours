/**
 * Offline review renderer (browser side). Drives the real PlayerAudio through an OfflineAudioContext with
 * scripted driving telemetry, so the clips are exactly what the game's audio code produces. Run by run.mjs in
 * headless Chromium on nc2; never in the game build.
 */
import type { FrameSnapshot, InputFrame, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import { PlayerAudio, DEFAULT_ENGINE_VOLUME } from '../../src/audio/player-audio';
import type { CueKind } from '../../src/audio/synth-buffers';
import type { RaceCueInput } from '../../src/audio/driving-sfx';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';

export interface Telemetry {
  rpm?: number; throttle?: number; brake?: number; handbrake?: number; gear?: number; speedMS?: number;
  slipAngleRad?: number; slipRatio?: number; surfaceId?: string; impact?: { speedDeltaMS: number; impulseNs: number } | null;
  paused?: boolean; race?: RaceCueInput;
}
export interface Scenario {
  car: VehicleSnapshot['carId'];
  seconds: number;
  volumes?: { master?: number; music?: number; sfx?: number; engine?: number };
  /** Telemetry at time t (s), sampled at 60 Hz like the game. */
  at(t: number, tick: number): Telemetry;
  /** Cues fired directly at given times (menu and economy cues). */
  cues?: Array<{ time: number; kind: CueKind }>;
}

function frameFor(car: VehicleSnapshot['carId'], tick: number, telemetry: Telemetry, previousImpactTick: { value: number | null }): FrameSnapshot {
  const wheel = (): WheelSnapshot => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0.1, normalLoadN: 3000, angularVelocityRadS: 0, slipRatio: telemetry.slipRatio ?? 0, slipAngleRad: telemetry.slipAngleRad ?? 0, surfaceId: telemetry.surfaceId ?? 'road:harbor' });
  const config = VEHICLE_CONFIGS[car].engine;
  const current: VehicleSnapshot = {
    simulationTick: tick, carId: car, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocityMS: { x: 0, y: 0, z: -(telemetry.speedMS ?? 0) }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [wheel(), wheel(), wheel(), wheel()], engineRpm: telemetry.rpm ?? config.idleRpm, gear: telemetry.gear ?? 1, driftAngleRad: 0,
  };
  const impact = telemetry.impact ? { simulationTick: tick, ...telemetry.impact } : undefined;
  if (impact) previousImpactTick.value = tick;
  return { previous: current, current, interpolationAlpha: 1, score: { banked: 0, unbanked: 0, multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: 0 }, ...(impact ? { impact } : {}) };
}

interface ReviewAudio {
  resumeFromGesture(): Promise<void>;
  setVolumes(volumes: { master: number; music: number; sfx: number; engine?: number }): void;
  update(frame: FrameSnapshot, input?: InputFrame, paused?: boolean, race?: RaceCueInput): void;
  playCue?(kind: CueKind): boolean;
  dispose(): void;
}

export async function renderScenario(scenario: Scenario, sampleRate = 48000, create: () => ReviewAudio = () => new PlayerAudio()): Promise<Float32Array> {
  const offline = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(scenario.seconds * sampleRate), sampleRate });
  let now = 0;
  // PlayerAudio sees a running context whose clock is the scripted time.
  const proxy = new Proxy(offline, {
    get(target, key) {
      if (key === 'state') return 'running';
      if (key === 'currentTime') return now;
      if (key === 'resume' || key === 'close') return async () => {};
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const globals = globalThis as unknown as { AudioContext: unknown };
  const saved = globals.AudioContext;
  globals.AudioContext = function FakeContext() { return proxy; } as unknown;
  const audio = create();
  try {
    await audio.resumeFromGesture();
    audio.setVolumes({ master: 1, music: 0.5, sfx: 1, engine: DEFAULT_ENGINE_VOLUME, ...scenario.volumes });
    const impactTick = { value: null as number | null };
    const cues = [...(scenario.cues ?? [])].sort((a, b) => a.time - b.time);
    const ticks = Math.floor(scenario.seconds * 60);
    for (let tick = 0; tick < ticks; tick++) {
      now = tick / 60;
      const telemetry = scenario.at(now, tick);
      const input: InputFrame = { simulationTick: tick, throttle: telemetry.throttle ?? 0, brake: telemetry.brake ?? 0, steering: 0, handbrake: telemetry.handbrake ?? 0, shift: 0, resetPressed: false };
      audio.update(frameFor(scenario.car, tick, telemetry, impactTick), input, telemetry.paused ?? false, telemetry.race);
      while (cues.length && cues[0]!.time <= now) audio.playCue?.(cues.shift()!.kind);
    }
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    audio.dispose();
    globals.AudioContext = saved;
  }
}

function toBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Entry point for run.mjs: scenario source is evaluated here so run.mjs stays a thin driver. */
(window as unknown as { renderNamed: (name: string) => Promise<string> }).renderNamed = async (name: string) => {
  const { SCENARIOS, OLD_SCENARIOS } = await import('./scenarios');
  if (OLD_SCENARIOS[name]) {
    const { OldPlayerAudio } = await import('./old-player-audio');
    return toBase64(await renderScenario({ ...OLD_SCENARIOS[name]!, volumes: { master: 1, music: 0.5, sfx: 1 } }, 48000, () => new OldPlayerAudio()));
  }
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}`);
  return toBase64(await renderScenario(scenario));
};
(window as unknown as { scenarioNames: () => Promise<string[]> }).scenarioNames = async () => {
  const { SCENARIOS, OLD_SCENARIOS } = await import('./scenarios');
  return [...Object.keys(SCENARIOS), ...Object.keys(OLD_SCENARIOS)];
};

/** Times every generated buffer once (cold), to check the prewarm slices stay small. */
(window as unknown as { benchGeneration: () => Promise<Record<string, number>> }).benchGeneration = async () => {
  const { SoundBank } = await import('../../src/audio/sound-bank');
  const { ENGINE_VOICES } = await import('../../src/audio/engine-voices');
  const { CUE_KINDS } = await import('../../src/audio/synth-buffers');
  const times: Record<string, number> = {};
  for (let round = 0; round < 3; round++) {
  const bank = new SoundBank(new OfflineAudioContext({ numberOfChannels: 1, length: 48000, sampleRate: 48000 }));
  const time = (name: string, run: () => unknown) => { const start = performance.now(); run(); const ms = +(performance.now() - start).toFixed(1); times[name] = Math.min(times[name] ?? Infinity, ms); };
  time('noise', () => bank.noise()); time('squeal', () => bank.squeal()); time('gravel', () => bank.gravel()); time('scrape', () => bank.scrape());
  for (const level of [0, 1, 2] as const) time(`impact-${level}`, () => bank.impact(level));
  time('shift', () => bank.shift()); time('handbrake', () => bank.handbrake());
  for (const kind of CUE_KINDS) time(`cue-${kind}`, () => bank.cue(kind));
  for (const [car, voice] of Object.entries(ENGINE_VOICES)) { time(`engine-${car}-layer0`, () => bank.engineLayer(voice, 0)); time(`engine-${car}-layer1`, () => bank.engineLayer(voice, 1)); time(`engine-${car}-rest`, () => bank.engine(voice)); }
  }
  return times;
};

/** Per-frame cost of PlayerAudio.update on a real AudioContext (needs --autoplay-policy=no-user-gesture-required). */
(window as unknown as { benchUpdate: () => Promise<Record<string, number>> }).benchUpdate = async () => {
  const { SCENARIOS } = await import('./scenarios');
  const audio = new PlayerAudio();
  await audio.resumeFromGesture();
  audio.setVolumes({ master: 0, music: 0.5, sfx: 1, engine: DEFAULT_ENGINE_VOLUME });
  const scenario = SCENARIOS['mix-delta-drive']!;
  const impactTick = { value: null as number | null };
  const samples: number[] = [];
  for (let tick = 0; tick < 1200; tick++) {
    const telemetry = scenario.at((tick % 600) / 60, tick % 600);
    const input: InputFrame = { simulationTick: tick, throttle: telemetry.throttle ?? 0, brake: 0, steering: 0, handbrake: telemetry.handbrake ?? 0, shift: 0, resetPressed: false };
    const frame = frameFor(scenario.car, tick, telemetry, impactTick);
    const start = performance.now();
    audio.update(frame, input, false);
    samples.push(performance.now() - start);
    if (tick % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  audio.dispose();
  const sorted = samples.slice(200).sort((a, b) => a - b);
  return { medianUs: +(sorted[Math.floor(sorted.length / 2)]! * 1000).toFixed(1), p95Us: +(sorted[Math.floor(sorted.length * 0.95)]! * 1000).toFixed(1), maxUs: +(sorted[sorted.length - 1]! * 1000).toFixed(1) };
};
