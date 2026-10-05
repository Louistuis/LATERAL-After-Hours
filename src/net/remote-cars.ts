import * as THREE from 'three';
import type { CarId } from '../../contracts/runtime-contracts';
import type { CarPresentation } from '../scene-pipeline/ports';
import { SnapshotBuffer } from './interpolation';
import { emptyCarState, type NetCarState } from './quantize';

export type CarLoader = (carId: CarId) => Promise<CarPresentation>;
const WHEEL_RADIUS = 0.33;
const STALE_MS = 3000;

interface RemoteCar {
  readonly id: string;
  readonly buffer: SnapshotBuffer;
  carId: CarId;
  paint: string;
  name: string;
  presentation: CarPresentation | null;
  loadSerial: number;
  tag: THREE.Sprite | null;
  spin: number;
}

/**
 * Visual-only remote cars: real car models with the owner's paint, a name tag,
 * and buffered interpolation. They are never added to the physics world.
 */
export class RemoteCars {
  private readonly cars = new Map<string, RemoteCar>();
  private readonly state: NetCarState = emptyCarState();
  private readonly q = new THREE.Quaternion();
  private readonly steerQ = new THREE.Quaternion();
  private readonly spinQ = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private static readonly Y = new THREE.Vector3(0, 1, 0);
  private static readonly X = new THREE.Vector3(1, 0, 0);
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly load: CarLoader) {}

  has(id: string): boolean { return this.cars.has(id); }
  ids(): IterableIterator<string> { return this.cars.keys(); }

  /** Adds the peer or updates its look; reloads the model only when the car changes. */
  upsert(id: string, carId: CarId, paint: string, name: string): void {
    let car = this.cars.get(id);
    if (!car) {
      car = { id, buffer: new SnapshotBuffer(), carId, paint, name, presentation: null, loadSerial: 0, tag: null, spin: 0 };
      this.cars.set(id, car);
      this.loadModel(car);
    } else if (car.carId !== carId) {
      car.carId = carId;
      this.loadModel(car);
    }
    if (car.paint !== paint) { car.paint = paint; car.presentation?.setCosmetics({ paint }); }
    if (car.name !== name || !car.tag) { car.name = name; this.setTag(car); }
  }

  push(id: string, state: NetCarState, nowMs: number): void { this.cars.get(id)?.buffer.push(state, nowMs); }

  /** Last rendered position of a visible remote car (for spatial sounds). */
  positionOf(id: string, out: THREE.Vector3): boolean {
    const body = this.cars.get(id)?.presentation?.body;
    if (!body?.visible) return false;
    out.copy(body.position);
    return true;
  }

  remove(id: string): void {
    const car = this.cars.get(id);
    if (!car) return;
    car.loadSerial++;
    this.detach(car);
    this.cars.delete(id);
  }

  /** Per frame; allocation free. */
  update(nowMs: number, dtSeconds: number): void {
    for (const car of this.cars.values()) {
      const p = car.presentation;
      const visible = nowMs - car.buffer.lastReceiveMs < STALE_MS && car.buffer.sample(nowMs, this.state);
      if (car.tag) car.tag.visible = Boolean(visible);
      if (!p) continue;
      p.body.visible = Boolean(visible);
      for (const wheel of p.wheels) wheel.visible = Boolean(visible);
      if (!visible) continue;
      const s = this.state;
      p.body.position.set(s.px, s.py, s.pz);
      this.q.set(s.qx, s.qy, s.qz, s.qw);
      p.body.quaternion.copy(this.q);
      // Local -Z is forward; a positive roll about +X is a forward-rolling wheel, as in the physics snapshot.
      this.fwd.set(0, 0, -1).applyQuaternion(this.q);
      const forwardSpeed = s.vx * this.fwd.x + s.vy * this.fwd.y + s.vz * this.fwd.z;
      car.spin = (car.spin + forwardSpeed / WHEEL_RADIUS * dtSeconds) % (Math.PI * 2);
      this.spinQ.setFromAxisAngle(RemoteCars.X, car.spin);
      this.steerQ.setFromAxisAngle(RemoteCars.Y, s.steer);
      for (let i = 0; i < 4; i++) {
        const wheel = p.wheels[i]!;
        const rest = wheel.userData.restPosition as THREE.Vector3 | undefined;
        if (rest) this.v.copy(rest).applyQuaternion(this.q).add(p.body.position);
        else this.v.copy(p.body.position);
        wheel.position.copy(this.v);
        wheel.quaternion.copy(this.q);
        if (i < 2) wheel.quaternion.multiply(this.steerQ);
        wheel.quaternion.multiply(this.spinQ);
      }
      p.setLights?.({ braking: s.brake || s.handbrake ? 1 : 0, reversing: s.reverse });
      if (car.tag) car.tag.position.set(s.px, s.py + 2.1, s.pz);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.cars.keys()]) this.remove(id);
  }

  private loadModel(car: RemoteCar): void {
    const serial = ++car.loadSerial;
    this.load(car.carId).then(presentation => {
      if (this.disposed || serial !== car.loadSerial || !this.cars.has(car.id)) { presentation.dispose(); return; }
      if (car.presentation) { this.scene.remove(car.presentation.body, ...car.presentation.wheels); car.presentation.dispose(); }
      car.presentation = presentation;
      presentation.setCosmetics({ paint: car.paint });
      presentation.body.visible = false;
      for (const wheel of presentation.wheels) wheel.visible = false;
      this.scene.add(presentation.body, ...presentation.wheels);
    }).catch(error => console.warn('Remote car model failed to load', error));
  }

  private setTag(car: RemoteCar): void {
    if (car.tag) { this.scene.remove(car.tag); disposeTag(car.tag); car.tag = null; }
    if (typeof document === 'undefined') return;
    car.tag = makeNameTag(car.name);
    car.tag.visible = false;
    this.scene.add(car.tag);
  }

  private detach(car: RemoteCar): void {
    if (car.presentation) { this.scene.remove(car.presentation.body, ...car.presentation.wheels); car.presentation.dispose(); car.presentation = null; }
    if (car.tag) { this.scene.remove(car.tag); disposeTag(car.tag); car.tag = null; }
  }
}

function makeNameTag(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 112;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const label = name.length > 18 ? `${name.slice(0, 17)}…` : name;
    ctx.font = '600 52px "Chakra Petch", ui-monospace, "SF Mono", system-ui, sans-serif';
    const width = Math.min(500, ctx.measureText(label).width + 56);
    const x = (512 - width) / 2;
    ctx.fillStyle = 'rgba(5,11,13,.78)';
    ctx.fillRect(x, 14, width, 84);
    ctx.fillStyle = '#d8fa72';
    ctx.fillRect(x, 14, 8, 84);
    ctx.fillStyle = '#f4f7f1';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 256 + 4, 58);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, fog: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.6, 0.57, 1);
  sprite.renderOrder = 10;
  sprite.name = 'net-name-tag';
  return sprite;
}

function disposeTag(tag: THREE.Sprite): void {
  tag.material.map?.dispose();
  tag.material.dispose();
}
