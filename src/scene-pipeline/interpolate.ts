import * as THREE from 'three';
import type { FrameSnapshot, VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';

/** Mutable visual state is owned by the scene, never by the simulation. */
export interface VisualVehicleState {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  readonly wheels: readonly VisualWheelState[];
  readonly source: VehicleSnapshot;
}

export interface VisualWheelState {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly source: WheelSnapshot;
}

const setVec = (target: THREE.Vector3, source: Readonly<{ x: number; y: number; z: number }>) =>
  target.set(source.x, source.y, source.z);
const setQuat = (target: THREE.Quaternion, source: Readonly<{ x: number; y: number; z: number; w: number }>) =>
  target.set(source.x, source.y, source.z, source.w).normalize();

/** Keeps interpolation scratch storage stable across every rendered frame. */
export class VehicleInterpolator {
  private readonly previousRotation = new THREE.Quaternion();
  private readonly targetRotation = new THREE.Quaternion();
  private readonly previousWheelRotation = new THREE.Quaternion();
  private readonly targetWheelRotation = new THREE.Quaternion();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetVelocity = new THREE.Vector3();
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly wheels = Array.from({ length: 4 }, () => ({
    position: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    source: null as unknown as WheelSnapshot,
  }));
  private readonly state = {
    position: this.position,
    rotation: this.rotation,
    velocity: this.velocity,
    wheels: this.wheels,
    source: null as unknown as VehicleSnapshot,
  };

  apply(frame: FrameSnapshot): VisualVehicleState {
    const { previous, current } = frame;
    // A reset, respawn, or car switch must never interpolate across the map.
    const jumped = previous.carId !== current.carId ||
      Math.hypot(
        previous.position.x - current.position.x,
        previous.position.y - current.position.y,
        previous.position.z - current.position.z,
      ) > 12;
    const alpha = jumped ? 1 : THREE.MathUtils.clamp(frame.interpolationAlpha, 0, 1);
    setVec(this.position, previous.position).lerp(setVec(this.targetPosition, current.position), alpha);
    setQuat(this.previousRotation, previous.rotation);
    setQuat(this.targetRotation, current.rotation);
    this.rotation.copy(this.previousRotation).slerp(this.targetRotation, alpha);
    setVec(this.velocity, previous.linearVelocityMS)
      .lerp(setVec(this.targetVelocity, current.linearVelocityMS), alpha);
    for (let i = 0; i < 4; i++) {
      const from = previous.wheels[i]!;
      const to = current.wheels[i]!;
      const visual = this.wheels[i]!;
      setVec(visual.position, from.position).lerp(
        // Set the target in a scratch vector owned by this wheel.
        this.wheelTargets[i]!.set(to.position.x, to.position.y, to.position.z), alpha,
      );
      setQuat(this.previousWheelRotation, from.rotation);
      setQuat(this.targetWheelRotation, to.rotation);
      visual.rotation.copy(this.previousWheelRotation).slerp(this.targetWheelRotation, alpha);
      visual.source = to;
    }
    this.state.source = current;
    return this.state;
  }

  private readonly wheelTargets = Array.from({ length: 4 }, () => new THREE.Vector3());
}
