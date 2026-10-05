import type { InputFrame, Quat, Vec3, VehicleSnapshot } from '../../contracts/runtime-contracts.js';

/**
 * Crash recovery: remembers the last place the car was grounded on the road and upright, and puts
 * it back a few metres behind that point, on the route line, facing the route direction, at rest.
 * Because the pose is never ahead of road the car physically reached, a recovery cannot gain
 * ground or carry the car through a gate. It also watches for the three automatic triggers:
 * flipped, stuck against something with the throttle held, and fallen out of the world.
 */
export type RecoveryReason = 'manual' | 'flipped' | 'stuck' | 'fallen';

export interface RecoveryRoute {
  readonly centerline: readonly Vec3[];
  readonly widthM: number;
  readonly spawn: Readonly<{ position: Vec3; rotation: Quat }>;
}

export interface RecoveryOptions {
  /** Collision surface ids that count as road for safe-point recording. */
  readonly isRoadSurface: (surfaceId: string) => boolean;
  /** Distance behind the last safe point, metres. */
  readonly behindM?: number;
  /** Minimum time between two recoveries, seconds. */
  readonly cooldownSeconds?: number;
  readonly stuckSeconds?: number;
  readonly flippedSeconds?: number;
  /** Fall this far below the last safe road height and the car is recovered at once. */
  readonly fallDepthM?: number;
}

export interface RecoveryPose { readonly position: Vec3; readonly rotation: Quat }

export const RECOVERY_PENALTY_SECONDS = 3;
/** Below this planar speed with the throttle held the car counts as stuck (and as making no headway at all). */
export const STUCK_SPEED_MS = 0.8;

const FIXED = 1 / 60;
const yawQuat = (x: number, z: number): Quat => {
  const yaw = Math.atan2(-x, -z);
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
};
/** World Y of the body's local up axis. */
export function uprightness(rotation: Quat): number {
  const { x, z } = rotation;
  return 1 - 2 * (x * x + z * z);
}

export class RecoveryTracker {
  private readonly cumulative: number[] = [0];
  private readonly lift: number;
  private readonly behindM: number;
  private readonly cooldown: number;
  private readonly stuckLimit: number;
  private readonly flippedLimit: number;
  private readonly fallDepth: number;
  private safeProgress: number | null = null;
  private safeY = -Infinity;
  private segment = 0;
  private cooldownLeft = 0;
  private stuckSeconds = 0;
  private flippedSeconds = 0;

  constructor(private readonly route: RecoveryRoute, private readonly options: RecoveryOptions) {
    const points = route.centerline;
    if (points.length < 2) throw new Error('Recovery needs a route polyline');
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      this.cumulative.push(this.cumulative[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    // Spawn height above the route line, so recovered cars drop onto the road exactly like a fresh start.
    this.lift = Math.max(0.4, Math.min(2, route.spawn.position.y - points[0]!.y));
    this.behindM = options.behindM ?? 4;
    this.cooldown = options.cooldownSeconds ?? 2;
    this.stuckLimit = options.stuckSeconds ?? 3;
    this.flippedLimit = options.flippedSeconds ?? 1.5;
    this.fallDepth = options.fallDepthM ?? 12;
  }

  get hasSafePoint(): boolean { return this.safeProgress !== null; }
  get ready(): boolean { return this.cooldownLeft <= 0; }

  /** Nearest route point to `position`, searched near the last match first so parallel legs cannot steal it. */
  project(position: Vec3): { progressM: number; distanceM: number; segment: number } {
    const points = this.route.centerline;
    const scan = (from: number, to: number): { progressM: number; distanceM: number; segment: number } => {
      let best = { progressM: 0, distanceM: Infinity, segment: 0 };
      for (let k = from; k < to; k++) {
        const i = ((k % (points.length - 1)) + (points.length - 1)) % (points.length - 1);
        const a = points[i]!, b = points[i + 1]!;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dy * dy + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy + (position.z - a.z) * dz) / l2)) : 0;
        const d = Math.hypot(position.x - a.x - t * dx, position.y - a.y - t * dy, position.z - a.z - t * dz);
        if (d < best.distanceM) best = { progressM: this.cumulative[i]! + t * Math.sqrt(l2), distanceM: d, segment: i };
      }
      return best;
    };
    const local = scan(this.segment - 4, this.segment + 6);
    if (local.distanceM <= this.route.widthM) return local;
    const global = scan(0, points.length - 1);
    return global.distanceM < local.distanceM ? global : local;
  }

  /**
   * Feed one completed physics tick. Returns an automatic recovery reason, or null.
   * `active` is false while the car is held at the start (countdown) so nothing triggers there.
   */
  observe(snapshot: VehicleSnapshot, input: InputFrame, active = true): RecoveryReason | null {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - FIXED);
    const up = uprightness(snapshot.rotation);
    const roadWheels = snapshot.wheels.filter(wheel => wheel.contact && wheel.surfaceId !== null && this.options.isRoadSurface(wheel.surfaceId)).length;
    const speed = Math.hypot(snapshot.linearVelocityMS.x, snapshot.linearVelocityMS.y, snapshot.linearVelocityMS.z);
    if (roadWheels >= 3 && up > 0.85) {
      const projection = this.project(snapshot.position);
      if (projection.distanceM <= this.route.widthM / 2 + 1) {
        this.segment = projection.segment;
        this.safeProgress = projection.progressM;
        this.safeY = snapshot.position.y;
      }
    }
    if (!active) { this.stuckSeconds = 0; this.flippedSeconds = 0; return null; }
    if (Number.isFinite(this.safeY) && snapshot.position.y < this.safeY - this.fallDepth) return this.trigger('fallen');
    this.flippedSeconds = up < 0.35 && speed < 4 ? this.flippedSeconds + FIXED : 0;
    if (this.flippedSeconds >= this.flippedLimit) return this.trigger('flipped');
    const pushing = input.throttle > 0.5 || (snapshot.gear < 0 && input.brake > 0.5);
    this.stuckSeconds = pushing && speed < STUCK_SPEED_MS ? this.stuckSeconds + FIXED : 0;
    if (this.stuckSeconds >= this.stuckLimit) return this.trigger('stuck');
    return null;
  }

  private trigger(reason: RecoveryReason): RecoveryReason | null {
    return this.ready ? reason : null;
  }

  /** Pose for the next recovery; falls back to the route spawn before any safe point exists. */
  safePose(): RecoveryPose {
    if (this.safeProgress === null) return { position: { ...this.route.spawn.position }, rotation: { ...this.route.spawn.rotation } };
    const points = this.route.centerline;
    const total = this.cumulative.at(-1)!;
    // Never wrap past the start line: that would hand the tracker a full-lap jump.
    const target = Math.max(0, Math.min(total, this.safeProgress - this.behindM));
    let i = 1;
    while (i < points.length - 1 && this.cumulative[i]! < target) i++;
    const a = points[i - 1]!, b = points[i]!;
    const span = this.cumulative[i]! - this.cumulative[i - 1]!;
    const t = span > 0 ? Math.max(0, Math.min(1, (target - this.cumulative[i - 1]!) / span)) : 0;
    return {
      position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + this.lift + 0.15, z: a.z + (b.z - a.z) * t },
      rotation: yawQuat(b.x - a.x, b.z - a.z),
    };
  }

  /** Call after the car has been placed: starts the cooldown and clears the trigger timers. */
  markRecovered(pose: RecoveryPose): void {
    this.cooldownLeft = this.cooldown;
    this.stuckSeconds = 0;
    this.flippedSeconds = 0;
    const projection = this.project(pose.position);
    this.segment = projection.segment;
  }
}
