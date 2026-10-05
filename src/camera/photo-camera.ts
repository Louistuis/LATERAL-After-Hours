/**
 * Photo mode camera. Two ways to frame: Orbit circles the car (drag to swing, pinch or wheel to dolly, two fingers or
 * right drag to slide the aim point), Free flies a detached camera (drag to look, WASD / arrows plus Q and E to move,
 * pinch or wheel to push in). FOV and roll are free; the camera stays within MAX_RANGE of the car so it can not be
 * lost in the void. Starts from wherever the game camera was, so entering photo mode never jumps.
 * No per-frame allocation.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../contracts/runtime-contracts';

export type PhotoCameraMode = 'orbit' | 'free';
export const PHOTO_FOV_RANGE = [18, 100] as const;
export const PHOTO_ROLL_RANGE = [-35, 35] as const;
const MAX_RANGE = 60;
const PITCH_LIMIT = 1.45;

const clamp = (value: number, lo: number, hi: number): number => (Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo);

export class PhotoCamera {
  mode: PhotoCameraMode = 'orbit';
  fov = 50;
  /** Degrees. */
  roll = 0;
  private yaw = 0;
  private pitch = 0.2;
  private distance = 7;
  private readonly offset = new THREE.Vector3(0, 0.8, 0);
  private readonly position = new THREE.Vector3();
  private readonly car = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly target = new THREE.Vector3();

  /** Takes over from the current game camera without a jump. */
  begin(camera: THREE.PerspectiveCamera, car: Vec3): void {
    this.car.set(car.x, car.y, car.z);
    this.fov = clamp(camera.fov, PHOTO_FOV_RANGE[0], PHOTO_FOV_RANGE[1]);
    this.roll = 0;
    this.offset.set(0, 0.8, 0);
    this.position.copy(camera.position);
    this.target.copy(this.car).add(this.offset);
    this.dir.copy(this.position).sub(this.target);
    this.distance = clamp(this.dir.length(), 2, 30);
    this.yaw = Math.atan2(this.dir.x, this.dir.z);
    this.pitch = clamp(Math.asin(clamp(this.dir.y / Math.max(1e-6, this.dir.length()), -1, 1)), -0.2, PITCH_LIMIT);
  }

  setMode(mode: PhotoCameraMode): void {
    if (mode === this.mode) return;
    if (mode === 'free') {
      // Keep the view: free look points where the orbit camera looked.
      this.dir.copy(this.target).sub(this.position).normalize();
      this.yaw = Math.atan2(-this.dir.x, -this.dir.z);
      this.pitch = clamp(Math.asin(clamp(this.dir.y, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
    } else {
      this.target.copy(this.car).add(this.offset);
      this.dir.copy(this.position).sub(this.target);
      this.distance = clamp(this.dir.length(), 2, 30);
      this.yaw = Math.atan2(this.dir.x, this.dir.z);
      this.pitch = clamp(Math.asin(clamp(this.dir.y / Math.max(1e-6, this.dir.length()), -1, 1)), -0.2, PITCH_LIMIT);
    }
    this.mode = mode;
  }

  setFov(value: number): void { this.fov = clamp(value, PHOTO_FOV_RANGE[0], PHOTO_FOV_RANGE[1]); }
  setRoll(value: number): void { this.roll = clamp(value, PHOTO_ROLL_RANGE[0], PHOTO_ROLL_RANGE[1]); }

  /** Pointer drag in CSS pixels. */
  drag(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (this.mode === 'orbit') { this.yaw -= dx * 0.008; this.pitch = clamp(this.pitch + dy * 0.006, -0.2, PITCH_LIMIT); }
    else { this.yaw -= dx * 0.004; this.pitch = clamp(this.pitch - dy * 0.004, -PITCH_LIMIT, PITCH_LIMIT); }
  }
  /** Wheel or pinch: positive pulls back (orbit) or moves backwards (free). */
  zoom(delta: number): void {
    if (!Number.isFinite(delta)) return;
    if (this.mode === 'orbit') this.distance = clamp(this.distance * Math.exp(delta * 0.0015), 1.6, 30);
    else this.move(-delta * 0.02, 0, 0);
  }
  /** Two-finger or right drag: slides the aim point (orbit) or strafes (free). */
  pan(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.basis();
    const k = this.mode === 'orbit' ? this.distance * 0.0016 : 0.03;
    if (this.mode === 'orbit') {
      this.offset.addScaledVector(this.right, -dx * k).addScaledVector(this.up, dy * k);
      this.offset.clampLength(0, 6);
    } else this.move(0, -dx * k, dy * k);
  }
  /** Free fly in metres along the view (forward), sideways (right) and up. */
  move(forward: number, right: number, up: number): void {
    if (this.mode !== 'free') return;
    this.basis();
    this.position.addScaledVector(this.dir, forward).addScaledVector(this.right, right).addScaledVector(this.up, up);
    this.dir.copy(this.position).sub(this.car);
    if (this.dir.length() > MAX_RANGE) this.position.copy(this.car).add(this.dir.setLength(MAX_RANGE));
  }

  /** Writes the camera for this frame. `car` follows the (possibly replaying) car in orbit mode. */
  apply(camera: THREE.PerspectiveCamera, car: Vec3): void {
    this.car.set(car.x, car.y, car.z);
    if (this.mode === 'orbit') {
      this.target.copy(this.car).add(this.offset);
      const c = Math.cos(this.pitch);
      this.position.set(Math.sin(this.yaw) * c, Math.sin(this.pitch), Math.cos(this.yaw) * c).multiplyScalar(this.distance).add(this.target);
    } else {
      this.basis();
      this.target.copy(this.position).add(this.dir);
    }
    camera.position.copy(this.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    if (this.roll) camera.rotateZ(THREE.MathUtils.degToRad(this.roll));
    if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
  }

  /** View direction and right vector from yaw and pitch (free) or from the orbit geometry. */
  private basis(): void {
    if (this.mode === 'free') {
      const c = Math.cos(this.pitch);
      this.dir.set(-Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c);
    } else this.dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.crossVectors(this.dir, this.up);
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0);
    this.right.normalize();
  }
}
