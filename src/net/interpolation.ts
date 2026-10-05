import { emptyCarState, type NetCarState } from './quantize';

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 250;
const CAPACITY = 16;

function copyState(target: NetCarState, source: NetCarState): void {
  target.t = source.t;
  target.px = source.px; target.py = source.py; target.pz = source.pz;
  target.qx = source.qx; target.qy = source.qy; target.qz = source.qz; target.qw = source.qw;
  target.vx = source.vx; target.vy = source.vy; target.vz = source.vz;
  target.steer = source.steer;
  target.brake = source.brake; target.reverse = source.reverse; target.handbrake = source.handbrake;
}

/**
 * Snapshot buffer for one remote car. Samples are stamped with the sender clock;
 * the receiver keeps a running clock offset (lowest observed latency, slowly relaxed)
 * and renders a fixed delay behind, using Hermite position curves built from the
 * sent velocities. Past the newest sample it extrapolates for a short window.
 * Preallocated: push and sample never allocate.
 */
export class SnapshotBuffer {
  private readonly ring: NetCarState[] = Array.from({ length: CAPACITY }, emptyCarState);
  private start = 0;
  private count = 0;
  private offset = 0;
  private hasOffset = false;
  lastReceiveMs = -Infinity;

  constructor(private readonly delayMs = INTERP_DELAY_MS) {}

  get size(): number { return this.count; }

  push(state: NetCarState, localNowMs: number): void {
    const newest = this.count ? this.at(this.count - 1) : null;
    if (newest && state.t <= newest.t) {
      // A restarted sender clock (reload) goes backwards: start over.
      if (newest.t - state.t > 5000) { this.count = 0; this.hasOffset = false; } else return;
    }
    const sampleOffset = localNowMs - state.t;
    if (!this.hasOffset || sampleOffset < this.offset) { this.offset = sampleOffset; this.hasOffset = true; }
    else this.offset += (sampleOffset - this.offset) * 0.02;
    this.lastReceiveMs = localNowMs;
    let slot: NetCarState;
    if (this.count < CAPACITY) { slot = this.ring[(this.start + this.count) % CAPACITY]!; this.count++; }
    else { slot = this.ring[this.start]!; this.start = (this.start + 1) % CAPACITY; }
    copyState(slot, state);
  }

  /** Writes the visual state for local time into out. Returns false while empty. */
  sample(localNowMs: number, out: NetCarState): boolean {
    if (!this.count) return false;
    const renderT = localNowMs - this.offset - this.delayMs;
    const first = this.at(0);
    if (renderT <= first.t || this.count === 1) {
      copyState(out, first);
      if (this.count === 1 && renderT > first.t) this.extrapolate(first, renderT, out);
      return true;
    }
    const last = this.at(this.count - 1);
    if (renderT >= last.t) { copyState(out, last); this.extrapolate(last, renderT, out); return true; }
    let i = this.count - 2;
    while (i > 0 && this.at(i).t > renderT) i--;
    const a = this.at(i), b = this.at(i + 1);
    const spanS = (b.t - a.t) / 1000;
    const u = (renderT - a.t) / (b.t - a.t);
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out.t = renderT;
    out.px = h00 * a.px + h10 * spanS * a.vx + h01 * b.px + h11 * spanS * b.vx;
    out.py = h00 * a.py + h10 * spanS * a.vy + h01 * b.py + h11 * spanS * b.vy;
    out.pz = h00 * a.pz + h10 * spanS * a.vz + h01 * b.pz + h11 * spanS * b.vz;
    out.vx = a.vx + (b.vx - a.vx) * u; out.vy = a.vy + (b.vy - a.vy) * u; out.vz = a.vz + (b.vz - a.vz) * u;
    nlerpQuat(a, b, u, out);
    out.steer = a.steer + (b.steer - a.steer) * u;
    const near = u < 0.5 ? a : b;
    out.brake = near.brake; out.reverse = near.reverse; out.handbrake = near.handbrake;
    return true;
  }

  clear(): void { this.count = 0; this.start = 0; this.hasOffset = false; this.lastReceiveMs = -Infinity; }

  private at(index: number): NetCarState { return this.ring[(this.start + index) % CAPACITY]!; }

  private extrapolate(from: NetCarState, renderT: number, out: NetCarState): void {
    const dt = Math.min(Math.max(renderT - from.t, 0), MAX_EXTRAPOLATE_MS) / 1000;
    out.px = from.px + from.vx * dt; out.py = from.py + from.vy * dt; out.pz = from.pz + from.vz * dt;
    out.t = from.t + dt * 1000;
  }
}

/** Normalized lerp along the shorter arc; precise enough for 60-100 ms gaps. */
export function nlerpQuat(a: NetCarState, b: NetCarState, u: number, out: NetCarState): void {
  const dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw;
  const s = dot < 0 ? -1 : 1;
  const x = a.qx + (b.qx * s - a.qx) * u, y = a.qy + (b.qy * s - a.qy) * u;
  const z = a.qz + (b.qz * s - a.qz) * u, w = a.qw + (b.qw * s - a.qw) * u;
  const len = Math.hypot(x, y, z, w) || 1;
  out.qx = x / len; out.qy = y / len; out.qz = z / len; out.qw = w / len;
}
