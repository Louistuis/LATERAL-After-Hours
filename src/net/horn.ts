/**
 * Two-tone synthesised horn. Each honk builds a short-lived node graph that
 * cleans itself up; nothing runs per frame. Remote horns are panned and
 * attenuated from the honking car's position when the honk arrives.
 */
export class HornAudio {
  private context: AudioContext | null = null;
  private disposed = false;
  private readonly unlock = (): void => {
    const context = this.ensure();
    if (context && context.state !== 'running') void context.resume().catch(() => undefined);
  };

  constructor(private readonly volume: () => number = () => 1) {
    if (typeof window === 'undefined') return;
    window.addEventListener('pointerdown', this.unlock, { passive: true });
    window.addEventListener('keydown', this.unlock);
  }

  /** pan in [-1, 1] (left to right), gain in [0, 1]. */
  play(pan: number, gain: number): void {
    const context = this.ensure();
    if (!context || context.state !== 'running') return;
    const level = Math.max(0, Math.min(1, gain)) * Math.max(0, Math.min(1, this.volume()));
    if (level < 0.01) return;
    const t = context.currentTime, peak = 0.2 * level;
    const out = context.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.015);
    out.gain.setValueAtTime(peak, t + 0.4);
    out.gain.linearRampToValueAtTime(0, t + 0.48);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 2200; filter.Q.value = 0.8;
    let tail: AudioNode = filter;
    if (typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan || 0));
      filter.connect(panner); tail = panner;
    }
    tail.connect(out); out.connect(context.destination);
    const nodes: AudioNode[] = [filter, tail, out];
    let live = 2;
    for (const frequency of [415, 523]) {
      const osc = context.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = frequency;
      osc.connect(filter); osc.start(t); osc.stop(t + 0.5);
      osc.onended = () => { osc.disconnect(); if (--live === 0) for (const node of nodes) node.disconnect(); };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.unlock);
      window.removeEventListener('keydown', this.unlock);
    }
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private ensure(): AudioContext | null {
    if (this.disposed) return null;
    if (this.context) return this.context;
    const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    try { this.context = new Context(); } catch { return null; }
    return this.context;
  }
}
