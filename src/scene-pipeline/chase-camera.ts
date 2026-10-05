import * as THREE from 'three';
import type { VisualVehicleState } from './interpolate';

/** Temporary gameplay camera seam; L5 can take ownership without changing snapshots. */
export class ChaseCamera {
  private readonly forward = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly previousVehicle = new THREE.Vector3();
  private initialized = false;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  reset(): void { this.initialized = false; }

  update(vehicle: VisualVehicleState, dtSeconds: number): void {
    this.forward.set(0, 0, -1).applyQuaternion(vehicle.rotation);
    this.forward.y = 0;
    this.forward.normalize();
    if (this.forward.lengthSq() < 0.5) this.forward.set(0, 0, -1);
    const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
    const distance = 7.2 + Math.min(2.2, speed * 0.045);
    this.desired.copy(vehicle.position).addScaledVector(this.forward, -distance);
    this.desired.y += 3.25 + Math.min(0.8, speed * 0.014);
    this.target.copy(vehicle.position).addScaledVector(this.forward, 4.2);
    this.target.y += 0.7;
    const teleported = this.initialized && this.previousVehicle.distanceToSquared(vehicle.position) > 144;
    if (!this.initialized || teleported) {
      this.camera.position.copy(this.desired);
      this.look.copy(this.target);
      this.initialized = true;
    } else {
      const dt = Math.max(0, Math.min(0.1, dtSeconds));
      this.camera.position.lerp(this.desired, 1 - Math.exp(-dt * 5.5));
      this.look.lerp(this.target, 1 - Math.exp(-dt * 8.5));
    }
    this.camera.lookAt(this.look);
    this.camera.fov = 56 + Math.min(10, speed * 0.24);
    this.camera.updateProjectionMatrix();
    this.previousVehicle.copy(vehicle.position);
  }
}
