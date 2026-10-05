/** Bounded actual wall-frame measurements. CPU metrics are not GPU timings. */
export class FrameMetrics {
  private readonly intervals = new Float64Array(10800);
  private cursor = 0;
  private count = 0;
  record(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.intervals[this.cursor] = intervalMs;
    this.cursor = (this.cursor + 1) % this.intervals.length;
    this.count = Math.min(this.count + 1, this.intervals.length);
  }
  samples(): number[] {
    if(this.count<this.intervals.length)return Array.from(this.intervals.subarray(0,this.count));
    return [...this.intervals.subarray(this.cursor),...this.intervals.subarray(0,this.cursor)];
  }
  summary(): { frames:number; fps:number; p95:number; p99:number; max:number; gpuMs:null } {
    const sorted = this.samples().sort((a,b)=>a-b);
    const sum = sorted.reduce((a,b)=>a+b,0);
    const percentile = (p:number) => sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] || 0;
    return { frames:this.count, fps:sum ? 1000*this.count/sum : 0, p95:percentile(.95), p99:percentile(.99), max:sorted.at(-1)||0, gpuMs:null };
  }
}
