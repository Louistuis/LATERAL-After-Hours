/** Minimal Web Audio stand-in for unit tests: records the node graph and parameter targets. */
export class FakeParam {
  value = 0;
  readonly targets: Array<{ value: number; time: number; constant: number }> = [];
  setTargetAtTime(value: number, time = 0, constant = 0): this { this.value = value; this.targets.push({ value, time, constant }); return this; }
  setValueAtTime(value: number): this { this.value = value; return this; }
  linearRampToValueAtTime(value: number): this { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number): this { this.value = value; return this; }
  cancelScheduledValues(): this { return this; }
}

export class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnected = false;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  type = '';
  buffer: FakeBuffer | null = null;
  loop = false;
  curve: Float32Array | null = null;
  oversample = 'none';
  gain = new FakeParam(); frequency = new FakeParam(); Q = new FakeParam(); playbackRate = new FakeParam();
  threshold = new FakeParam(); knee = new FakeParam(); ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam();
  constructor(readonly kind: string) { this.playbackRate.value = 1; this.gain.value = 1; }
  connect(target: FakeNode): FakeNode { this.connections.push(target); return target; }
  disconnect(): void { this.disconnected = true; }
  start(): void { this.started = true; }
  stop(when?: number): void { this.stopped = true; if (when === undefined) this.onended?.(); }
}

export class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(channel: number): Float32Array { return this.data[channel]!; }
}

export class FakeAudioContext {
  state = 'running'; currentTime = 0; sampleRate = 8000;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
  private make(kind: string): FakeNode { const node = new FakeNode(kind); this.nodes.push(node); return node; }
  createGain(): FakeNode { return this.make('gain'); }
  createBiquadFilter(): FakeNode { return this.make('filter'); }
  createBufferSource(): FakeNode { return this.make('source'); }
  createOscillator(): FakeNode { return this.make('oscillator'); }
  createChannelSplitter(): FakeNode { return this.make('splitter'); }
  createWaveShaper(): FakeNode { return this.make('shaper'); }
  createDynamicsCompressor(): FakeNode { return this.make('compressor'); }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer { return new FakeBuffer(channels, length, sampleRate); }
  of(kind: string): FakeNode[] { return this.nodes.filter(node => node.kind === kind); }
}

/** Every gain value along the first path from `node` to the destination (empty when it never reaches it). */
export function gainsToDestination(context: FakeAudioContext, node: FakeNode, seen = new Set<FakeNode>()): number[] | null {
  if (node === context.destination) return [];
  if (seen.has(node)) return null;
  seen.add(node);
  for (const next of node.connections) {
    const rest = gainsToDestination(context, next, seen);
    if (rest) return next.kind === 'gain' ? [next.gain.value, ...rest] : rest;
  }
  return null;
}

/** Installs FakeAudioContext as the global AudioContext and returns the created contexts. */
export function fakeContexts(stub: (name: string, value: unknown) => void): FakeAudioContext[] {
  const contexts: FakeAudioContext[] = [];
  stub('AudioContext', class extends FakeAudioContext { constructor() { super(); contexts.push(this); } });
  return contexts;
}
