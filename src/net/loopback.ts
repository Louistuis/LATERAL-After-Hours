import { emptyCarState, packCarState, unpackCarState } from './quantize';
import { fillCarState, SEND_INTERVAL_MS, type NetLocalView } from './session';
import type { RemoteCars } from './remote-cars';

export const LOOPBACK_ID = 'loopback';

/**
 * Owner-review debug: renders the local car again as a remote car, 3 m to its
 * right, through the full send path (state, quantize, interpolation buffer,
 * remote presentation). Steer and wheel spin on the copy must match the real car.
 */
export class NetLoopback {
  private readonly state = emptyCarState();
  private readonly echo = emptyCarState();
  private readonly packed: number[] = [];
  private lastSend = -Infinity;
  private lastFrame = 0;
  private carId = '';

  constructor(private readonly remote: RemoteCars, private readonly paint: () => string, private readonly offsetRightM = 3) {}

  tick(view: NetLocalView & { readonly carId: string }, nowMs: number): void {
    if (view.carId !== this.carId) { this.carId = view.carId; this.remote.upsert(LOOPBACK_ID, view.carId as never, this.paint(), 'Loopback'); }
    if (nowMs - this.lastSend >= SEND_INTERVAL_MS) {
      this.lastSend = nowMs;
      const s = fillCarState(view, nowMs, this.state);
      // Body right axis: rotate +X by the body quaternion.
      const { qx: x, qy: y, qz: z, qw: w } = s;
      s.px += (1 - 2 * (y * y + z * z)) * this.offsetRightM;
      s.py += 2 * (x * y + z * w) * this.offsetRightM;
      s.pz += 2 * (x * z - y * w) * this.offsetRightM;
      packCarState(s, this.packed);
      if (unpackCarState(this.packed, this.echo)) this.remote.push(LOOPBACK_ID, this.echo, nowMs);
    }
    const dt = this.lastFrame ? Math.min(Math.max((nowMs - this.lastFrame) / 1000, 0), 0.1) : 0;
    this.lastFrame = nowMs;
    this.remote.update(nowMs, dt);
  }

  dispose(): void { this.remote.dispose(); }
}
