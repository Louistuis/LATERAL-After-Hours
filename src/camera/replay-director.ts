/**
 * Cinematic replay cameras. A director cuts between shots the way a broadcast does: chase, trackside (a fixed
 * telephoto camera on the shoulder ahead that pans with the car), helicopter, side tracking, bumper and a slow orbit.
 * Auto mode cuts on a deterministic rhythm; a fixed mode holds one shot.
 *
 * All vectors are preallocated: update() does not allocate. The route centreline places trackside cameras on the
 * road shoulder, so they sit on open ground instead of inside buildings.
 */
import * as THREE from 'three';
import type { Quat, Vec3 } from '../../contracts/runtime-contracts';

export type ShotKind = 'chase' | 'trackside' | 'heli' | 'side' | 'bumper' | 'orbit';
export type DirectorMode = 'auto' | ShotKind;
export const SHOT_NAMES: Readonly<Record<ShotKind, string>> = { chase: 'Chase', trackside: 'Trackside', heli: 'Helicopter', side: 'Side', bumper: 'Bumper', orbit: 'Orbit' };
/** Auto rhythm: shot and how long it holds (s). Trackside cuts early once the car has passed the camera. */
export const AUTO_SEQUENCE: readonly (readonly [ShotKind, number])[] = [
  ['chase', 4.5], ['trackside', 7], ['heli', 5], ['side', 4], ['trackside', 7], ['bumper', 3.5], ['orbit', 5], ['trackside', 7],
];

export interface ShotOutput { readonly position: THREE.Vector3; readonly target: THREE.Vector3; fov: number; roll: number }
export interface RouteLine { readonly centerline: readonly Vec3[]; readonly widthM: number; readonly closed?: boolean }

export class ReplayDirector {
  mode: DirectorMode = 'auto';
  private route: RouteLine | null = null;
  private current: ShotKind = 'chase';
  private sequenceIndex = 0;
  private shotTime = 0;
  private clock = 0;
  private fresh = true;
  private side = 1;
  private readonly car = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly desired = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  readonly out: ShotOutput = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50, roll: 0 };

  setRoute(route: RouteLine | null): void { this.route = route && route.centerline.length >= 2 ? route : null; }
  shot(): ShotKind { return this.current; }
  /** Next update snaps to its shot instead of easing (call on a seek or a jump). */
  cut(): void { this.fresh = true; }
  reset(): void { this.sequenceIndex = 0; this.shotTime = 0; this.clock = 0; this.current = this.mode === 'auto' ? AUTO_SEQUENCE[0]![0] : this.mode; this.fresh = true; }
  setMode(mode: DirectorMode): void { if (mode === this.mode) return; this.mode = mode; this.reset(); }

  /** Advances the director and writes the camera for this frame into `out`. */
  update(dtSeconds: number, position: Vec3, rotation: Quat): ShotOutput {
    const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(0.1, dtSeconds)) : 0;
    this.clock += dt; this.shotTime += dt;
    this.car.set(position.x, position.y, position.z);
    this.quat.set(rotation.x, rotation.y, rotation.z, rotation.w).normalize();
    this.forward.set(0, 0, -1).applyQuaternion(this.quat).setY(0);
    if (this.forward.lengthSq() < 1e-4) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.right.crossVectors(this.forward, this.up).normalize();
    if (this.mode === 'auto') this.advanceAuto();
    else if (this.current !== this.mode) { this.current = this.mode; this.shotTime = 0; this.fresh = true; }
    if (this.fresh && this.current === 'trackside') this.placeTrackside();
    const out = this.out;
    out.roll = 0;
    switch (this.current) {
      case 'chase':
        this.desired.copy(this.car).addScaledVector(this.forward, -7.2).addScaledVector(this.up, 2.3);
        this.look.copy(this.car).addScaledVector(this.forward, 4).addScaledVector(this.up, 0.6);
        out.fov = 56; this.ease(dt, 4.5); break;
      case 'trackside': {
        if (this.trackPassed()) this.placeTrackside();
        this.desired.copy(this.anchor);
        this.look.copy(this.car).addScaledVector(this.up, 0.5);
        const distance = this.anchor.distanceTo(this.car);
        out.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5.5 / Math.max(1, distance))), 16, 52);
        this.ease(dt, 1e3); break;
      }
      case 'heli': {
        const angle = this.clock * 0.18;
        this.desired.copy(this.car).add(this.tmp.set(Math.cos(angle) * 30, 20, Math.sin(angle) * 30));
        this.look.copy(this.car);
        out.fov = 34; this.ease(dt, 2.2); break;
      }
      case 'side':
        this.desired.copy(this.car).addScaledVector(this.right, 6.5 * this.side).addScaledVector(this.up, 1.1).addScaledVector(this.forward, 1.2);
        this.look.copy(this.car).addScaledVector(this.forward, 1.5).addScaledVector(this.up, 0.5);
        out.fov = 44; out.roll = -0.03 * this.side; this.ease(dt, 6); break;
      case 'bumper':
        this.desired.copy(this.car).addScaledVector(this.forward, 2.7).addScaledVector(this.up, 0.62);
        this.look.copy(this.car).addScaledVector(this.forward, 24).addScaledVector(this.up, 0.4);
        out.fov = 72; this.ease(dt, 1e3); break;
      case 'orbit': {
        const angle = this.clock * 0.42;
        this.tmp.copy(this.forward).applyAxisAngle(this.up, angle).multiplyScalar(-9.5);
        this.desired.copy(this.car).add(this.tmp).addScaledVector(this.up, 2.6);
        this.look.copy(this.car).addScaledVector(this.up, 0.5);
        out.fov = 48; this.ease(dt, 5); break;
      }
    }
    this.fresh = false;
    return out;
  }

  /** Applies the shot to a camera (FOV only re-projects when it changed). */
  apply(camera: THREE.PerspectiveCamera, shot: ShotOutput = this.out): void {
    camera.position.copy(shot.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(shot.target);
    if (shot.roll) camera.rotateZ(shot.roll);
    if (Math.abs(camera.fov - shot.fov) > 0.01) { camera.fov = shot.fov; camera.updateProjectionMatrix(); }
  }

  private ease(dt: number, rate: number): void {
    const out = this.out;
    if (this.fresh) { out.position.copy(this.desired); out.target.copy(this.look); return; }
    const k = 1 - Math.exp(-dt * rate);
    out.position.lerp(this.desired, k);
    out.target.lerp(this.look, Math.min(1, k * 1.6 + 0.08));
  }

  private advanceAuto(): void {
    const [kind, hold] = AUTO_SEQUENCE[this.sequenceIndex % AUTO_SEQUENCE.length]!;
    const passed = kind === 'trackside' && this.shotTime > 2.5 && this.trackPassed(20);
    if (this.shotTime >= hold || passed) {
      this.sequenceIndex = (this.sequenceIndex + 1) % AUTO_SEQUENCE.length;
      this.current = AUTO_SEQUENCE[this.sequenceIndex]![0];
      this.shotTime = 0; this.fresh = true; this.side = -this.side;
    }
  }

  /** True once the car is this far past the trackside camera (measured along its heading). */
  private trackPassed(beyond = 28): boolean {
    this.tmp2.copy(this.car).sub(this.anchor);
    return this.tmp2.dot(this.forward) > beyond;
  }

  /** Puts the trackside camera on the road shoulder ~45 m ahead of the car (or ahead along its heading off route). */
  private placeTrackside(): void {
    const route = this.route;
    this.side = -this.side;
    if (!route) { this.anchor.copy(this.car).addScaledVector(this.forward, 40).addScaledVector(this.right, 9 * this.side).addScaledVector(this.up, 1.6); return; }
    const line = route.centerline;
    let nearest = 0, best = Infinity;
    for (let i = 0; i < line.length; i++) {
      const p = line[i]!, dx = p.x - this.car.x, dz = p.z - this.car.z, d = dx * dx + dz * dz;
      if (d < best) { best = d; nearest = i; }
    }
    // Which way along the line is the car going?
    const nextIndex = Math.min(line.length - 1, nearest + 1), prevIndex = Math.max(0, nearest - 1);
    this.tmp.set(line[nextIndex]!.x - line[prevIndex]!.x, 0, line[nextIndex]!.z - line[prevIndex]!.z);
    const step = this.tmp.dot(this.forward) >= 0 ? 1 : -1;
    let walked = 0, index = nearest;
    while (walked < 45) {
      let next = index + step;
      if (next < 0 || next >= line.length) { if (!route.closed) break; next = (next + line.length) % line.length; }
      walked += Math.hypot(line[next]!.x - line[index]!.x, line[next]!.z - line[index]!.z);
      index = next;
      if (index === nearest) break;
    }
    const a = line[index]!, b = line[Math.min(line.length - 1, Math.max(0, index + step))] ?? a;
    this.tmp.set(b.x - a.x, 0, b.z - a.z);
    if (this.tmp.lengthSq() < 1e-6) this.tmp.copy(this.forward);
    this.tmp.normalize();
    this.tmp2.crossVectors(this.tmp, this.up).normalize();
    const offset = Math.max(4, route.widthM / 2 + 2.5);
    this.anchor.set(a.x, a.y, a.z).addScaledVector(this.tmp2, offset * this.side).addScaledVector(this.up, 1.5);
  }
}
