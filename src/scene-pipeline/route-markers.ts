import * as THREE from 'three';
import type { RouteDefinition } from '../../contracts/world-contracts';

/** Event waypoints share two instanced meshes regardless of route length. */
export class RouteMarkers {
  readonly root = new THREE.Group();
  private readonly shaftGeometry = new THREE.CylinderGeometry(0.055, 0.085, 1.05, 8);
  private readonly capGeometry = new THREE.BoxGeometry(0.25, 0.14, 0.25);
  private readonly shaftMaterial = new THREE.MeshStandardMaterial({
    color: '#e3d9bc', roughness: 0.78, metalness: 0.08,
  });
  private readonly capMaterial = new THREE.MeshStandardMaterial({
    color: '#67cbce', emissive: '#24858d', emissiveIntensity: 0.65,
    roughness: 0.28, metalness: 0.2,
  });
  private readonly clipGeometry = new THREE.RingGeometry(0.55, 0.78, 20);
  private readonly clipMaterial = new THREE.MeshBasicMaterial({
    color: '#efae63', side: THREE.DoubleSide, transparent: true, opacity: 0.78,
    depthWrite: false,
  });
  private shafts: THREE.InstancedMesh | null = null;
  private caps: THREE.InstancedMesh | null = null;
  private clips: THREE.InstancedMesh | null = null;
  private readonly dummy = new THREE.Object3D();
  private readonly forward = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();

  setRoute(route: RouteDefinition | null): void {
    this.clearInstances();
    if (!route || route.checkpoints.length === 0) return;
    const count = route.checkpoints.length * 2;
    this.shafts = new THREE.InstancedMesh(this.shaftGeometry, this.shaftMaterial, count);
    this.caps = new THREE.InstancedMesh(this.capGeometry, this.capMaterial, count);
    this.shafts.castShadow = false;
    this.shafts.receiveShadow = true;
    for (let i = 0; i < route.checkpoints.length; i++) {
      const checkpoint = route.checkpoints[i]!;
      this.forward.set(checkpoint.forward.x, 0, checkpoint.forward.z).normalize();
      this.lateral.set(-this.forward.z, 0, this.forward.x);
      for (let side = 0; side < 2; side++) {
        const index = i * 2 + side;
        const sign = side === 0 ? -1 : 1;
        const offset = Math.max(1, checkpoint.halfWidthM - 0.6) * sign;
        this.dummy.position.set(
          checkpoint.center.x + this.lateral.x * offset,
          checkpoint.center.y + 0.53,
          checkpoint.center.z + this.lateral.z * offset,
        );
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.shafts.setMatrixAt(index, this.dummy.matrix);
        this.dummy.position.y += 0.58;
        this.dummy.scale.setScalar(checkpoint.finish ? 1.35 : 1);
        this.dummy.updateMatrix();
        this.caps.setMatrixAt(index, this.dummy.matrix);
      }
    }
    this.shafts.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.root.add(this.shafts, this.caps);
    const zones = route.clippingZones ?? [];
    if (zones.length > 0) {
      this.clips = new THREE.InstancedMesh(this.clipGeometry, this.clipMaterial, zones.length);
      this.clips.name = 'clip-zone-rings';
      this.clips.renderOrder = 3;
      this.clips.castShadow = false;
      for (const [index, zone] of zones.entries()) {
        const target = sampleClipTarget(route, zone.progressM, zone.preferredOffsetM);
        this.dummy.position.set(target.x, target.y + 0.12, target.z);
        this.dummy.rotation.set(-Math.PI / 2, 0, 0);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.clips.setMatrixAt(index, this.dummy.matrix);
      }
      this.clips.instanceMatrix.needsUpdate = true;
      this.root.add(this.clips);
    }
  }

  dispose(): void {
    this.clearInstances();
    this.shaftGeometry.dispose();
    this.capGeometry.dispose();
    this.clipGeometry.dispose();
    this.shaftMaterial.dispose();
    this.capMaterial.dispose();
    this.clipMaterial.dispose();
  }

  private clearInstances(): void {
    if (this.shafts) this.root.remove(this.shafts);
    if (this.caps) this.root.remove(this.caps);
    if (this.clips) this.root.remove(this.clips);
    this.shafts?.dispose();
    this.caps?.dispose();
    this.clips?.dispose();
    this.shafts = null;
    this.caps = null;
    this.clips = null;
  }
}

/** Uses the same ordered polyline arc-distance convention as RouteProgressTracker. */
export function sampleClipTarget(route: RouteDefinition, progressM: number, offsetM: number): THREE.Vector3 {
  let traversed = 0;
  for (let index = 1; index < route.centerline.length; index++) {
    const from = route.centerline[index - 1]!;
    const to = route.centerline[index]!;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-5) continue;
    if (traversed + length >= progressM || index === route.centerline.length - 1) {
      const t = THREE.MathUtils.clamp((progressM - traversed) / length, 0, 1);
      const horizontal = Math.hypot(dx, dz);
      const rightX = horizontal > 1e-5 ? -dz / horizontal : 0;
      const rightZ = horizontal > 1e-5 ? dx / horizontal : 0;
      return new THREE.Vector3(
        from.x + dx * t + rightX * offsetM,
        from.y + dy * t,
        from.z + dz * t + rightZ * offsetM,
      );
    }
    traversed += length;
  }
  throw new Error(`Route ${route.id} has no nondegenerate centerline segment for clip marker`);
}
