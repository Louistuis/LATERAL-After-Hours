/**
 * Showroom sounds, synthesised (no samples): camera whoosh, select blip, and the unlock sequence
 * (riser, impact, chime). The context starts on first use, which is always inside a click or tap.
 */
export interface ShowroomSfx {
  whoosh(): void;
  select(): void;
  riser(seconds: number): void;
  impact(): void;
  chime(): void;
  dispose(): void;
}

export function createShowroomSfx(volume: () => number): ShowroomSfx {
  let context: AudioContext | null = null;
  let out: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  const ctx = (): AudioContext | null => {
    if (context) { if (context.state === 'suspended') void context.resume().catch(() => {}); return context; }
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
      out = context.createGain();
      out.connect(context.createDynamicsCompressor()).connect(context.destination);
      noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return context;
    } catch { return null; }
  };
  const level = (): number => Math.max(0, Math.min(1, volume()));
  const env = (ac: AudioContext, gain: number, start: number, attack: number, dur: number): GainNode => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * level()), start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    g.connect(out!);
    return g;
  };
  const noiseBurst = (ac: AudioContext, start: number, dur: number, gain: number, f0: number, f1: number, attack = 0.02, q = 1.2): void => {
    const src = ac.createBufferSource(); src.buffer = noise; src.loop = true;
    const filter = ac.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, start); filter.frequency.exponentialRampToValueAtTime(f1, start + dur);
    src.connect(filter).connect(env(ac, gain, start, attack, dur));
    src.start(start); src.stop(start + dur + 0.05);
  };
  const tone = (ac: AudioContext, type: OscillatorType, f0: number, f1: number, start: number, dur: number, gain: number, attack = 0.01): void => {
    const osc = ac.createOscillator(); osc.type = type;
    osc.frequency.setValueAtTime(f0, start); osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
    osc.connect(env(ac, gain, start, attack, dur));
    osc.start(start); osc.stop(start + dur + 0.05);
  };
  const run = (play: (ac: AudioContext, now: number) => void): void => {
    if (level() <= 0) return;
    const ac = ctx();
    if (ac && out) play(ac, ac.currentTime + 0.01);
  };
  return {
    whoosh: () => run((ac, t) => noiseBurst(ac, t, 0.7, 0.16, 300, 2400, 0.25, 0.8)),
    select: () => run((ac, t) => { tone(ac, 'triangle', 1400, 1100, t, 0.07, 0.08); tone(ac, 'sine', 2800, 2600, t, 0.04, 0.03); }),
    riser: seconds => run((ac, t) => {
      noiseBurst(ac, t, seconds, 0.22, 400, 6000, seconds * 0.9, 2);
      tone(ac, 'sawtooth', 90, 360, t, seconds, 0.07, seconds * 0.9);
      tone(ac, 'sine', 180, 720, t, seconds, 0.08, seconds * 0.9);
    }),
    impact: () => run((ac, t) => {
      tone(ac, 'sine', 120, 38, t, 0.9, 0.55, 0.005);
      tone(ac, 'square', 70, 40, t, 0.25, 0.12, 0.005);
      noiseBurst(ac, t, 0.6, 0.35, 3200, 400, 0.005, 0.6);
    }),
    chime: () => run((ac, t) => {
      [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => { tone(ac, 'triangle', f, f, t + i * 0.07, 0.9, 0.09); tone(ac, 'sine', f * 2, f * 2, t + i * 0.07, 0.5, 0.03); });
    }),
    dispose: () => { void context?.close().catch(() => {}); context = null; out = null; },
  };
}
