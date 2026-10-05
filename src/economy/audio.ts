/**
 * Synthesised economy sounds: horns, the purchase stamp, the balance counter tick. No samples to load.
 * The context is created on first use (always inside a user gesture: a key, a tap or a shop click).
 */
export interface EconomyAudio {
  horn(hornId: string | undefined): void;
  purchase(): void;
  tick(): void;
  credit(): void;
  deny(): void;
  dispose(): void;
}

type Volume = () => number;
/** The game's audio facade (src/audio). When it accepts a cue, the economy does not synthesize its own copy. */
export interface EconomyCueSink { playCue(kind: 'purchase' | 'marks' | 'tick' | 'deny'): boolean }

export function createEconomyAudio(volume: Volume = () => 0.8, cues?: EconomyCueSink): EconomyAudio {
  let context: AudioContext | null = null;
  let out: GainNode | null = null;
  let hornVoice: { stop(): void } | null = null;
  let lastTick = 0;

  const ctx = (): AudioContext | null => {
    if (context) {
      if (context.state === 'suspended') void context.resume().catch(() => {});
      return context;
    }
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
      out = context.createGain();
      const comp = context.createDynamicsCompressor();
      out.connect(comp).connect(context.destination);
      return context;
    } catch { return null; }
  };
  const level = (): number => Math.max(0, Math.min(1, volume()));

  /** One enveloped oscillator into `dest`. */
  const tone = (ac: AudioContext, dest: AudioNode, type: OscillatorType, freq: number, start: number, dur: number, gain: number, attack = 0.01, release = 0.08): OscillatorNode => {
    const osc = ac.createOscillator(), env = ac.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, start);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + attack);
    env.gain.setValueAtTime(gain, Math.max(start + attack, start + dur - release));
    env.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(env).connect(dest);
    osc.start(start); osc.stop(start + dur + 0.02);
    return osc;
  };
  const bus = (ac: AudioContext, gain: number, cutoff: number): GainNode => {
    const g = ac.createGain(), lp = ac.createBiquadFilter();
    g.gain.value = gain * level();
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    g.connect(lp).connect(out!);
    return g;
  };

  const horns: Readonly<Record<string, (ac: AudioContext, t: number) => OscillatorNode[]>> = {
    'horn-stock': (ac, t) => { const b = bus(ac, 0.16, 2600); return [tone(ac, b, 'sawtooth', 415, t, 0.42, 1), tone(ac, b, 'sawtooth', 349, t, 0.42, 0.9)]; },
    'horn-twotone': (ac, t) => {
      const b = bus(ac, 0.15, 3000), list: OscillatorNode[] = [];
      for (let i = 0; i < 4; i++) list.push(tone(ac, b, 'square', i % 2 ? 440 : 587, t + i * 0.24, 0.23, 0.8, 0.005, 0.02));
      return list;
    },
    'horn-foghorn': (ac, t) => { const b = bus(ac, 0.34, 700); return [tone(ac, b, 'sawtooth', 98, t, 1.5, 1, 0.12, 0.5), tone(ac, b, 'sawtooth', 49, t, 1.5, 0.7, 0.15, 0.5), tone(ac, b, 'square', 147, t, 1.5, 0.25, 0.2, 0.5)]; },
    'horn-airhorn': (ac, t) => { const b = bus(ac, 0.13, 3200); return [311, 370, 466].map(f => tone(ac, b, 'sawtooth', f, t, 1.0, 0.9, 0.04, 0.2)); },
    'horn-chirp': (ac, t) => { const b = bus(ac, 0.14, 5000); return [523, 659, 784, 1047, 1319].map((f, i) => tone(ac, b, 'square', f, t + i * 0.065, 0.08, 0.8, 0.004, 0.03)); },
    'horn-bell': (ac, t) => {
      const b = bus(ac, 0.22, 8000), list: OscillatorNode[] = [];
      for (const strike of [0, 0.42]) for (const [ratio, gain] of [[1, 1], [2.76, 0.45], [5.4, 0.22]] as const) list.push(tone(ac, b, 'sine', 880 * ratio, t + strike, 1.1, gain, 0.003, 1.0));
      return list;
    },
  };

  return {
    horn(hornId) {
      const ac = ctx();
      if (!ac || !out) return;
      hornVoice?.stop();
      const play = horns[hornId ?? ''] ?? horns['horn-stock']!;
      const voices = play(ac, ac.currentTime + 0.01);
      hornVoice = { stop: () => { for (const voice of voices) { try { voice.stop(); } catch { /* already stopped */ } } } };
    },
    purchase() {
      if (cues?.playCue('purchase')) return;
      const ac = ctx();
      if (!ac || !out) return;
      const t = ac.currentTime + 0.01, b = bus(ac, 0.2, 6000);
      // Stamp thud, then a bright two-note chime.
      tone(ac, b, 'triangle', 90, t, 0.12, 1, 0.002, 0.1);
      tone(ac, b, 'sine', 1046, t + 0.08, 0.35, 0.6, 0.005, 0.3);
      tone(ac, b, 'sine', 1568, t + 0.16, 0.5, 0.5, 0.005, 0.45);
    },
    tick() {
      if (cues?.playCue('tick')) return;
      const ac = ctx();
      if (!ac || !out || ac.currentTime - lastTick < 0.045) return;
      lastTick = ac.currentTime;
      tone(ac, bus(ac, 0.06, 9000), 'square', 1900 + Math.random() * 300, ac.currentTime, 0.025, 1, 0.001, 0.02);
    },
    credit() {
      if (cues?.playCue('marks')) return;
      const ac = ctx();
      if (!ac || !out) return;
      const t = ac.currentTime + 0.01, b = bus(ac, 0.14, 7000);
      [784, 988, 1175, 1568].forEach((f, i) => tone(ac, b, 'triangle', f, t + i * 0.07, 0.2, 0.8, 0.004, 0.15));
    },
    deny() {
      if (cues?.playCue('deny')) return;
      const ac = ctx();
      if (!ac || !out) return;
      tone(ac, bus(ac, 0.12, 1200), 'square', 140, ac.currentTime + 0.01, 0.18, 1, 0.005, 0.06);
    },
    dispose() {
      hornVoice?.stop();
      void context?.close().catch(() => {});
      context = null; out = null;
    },
  };
}
