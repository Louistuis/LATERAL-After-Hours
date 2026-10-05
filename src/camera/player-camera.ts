import * as THREE from 'three';
import type { FrameSnapshot } from '../../contracts/runtime-contracts';
import type { GameScene, RuntimeView } from '../core/game-runtime';

export type CameraView = 'chase' | 'close' | 'hood';

/** Time-based third-person camera with a bounded obstruction pull-in and reset recovery. */
export class PlayerCamera {
  private readonly raycaster = new THREE.Raycaster();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly focus = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly previousPosition = new THREE.Vector3();
  private readonly yawForward = new THREE.Vector3();
  private readonly occlusionOffset = new THREE.Vector3();
  private readonly occlusionDirection = new THREE.Vector3();
  private readonly sourceRotation = new THREE.Quaternion();
  private readonly targetRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly intersections: THREE.Intersection[] = [];
  private initialized = false;
  private cameraView: CameraView = 'chase';
  private driftYaw = 0;
  private roll = 0;
  private showcaseBlend = 0;
  private showcaseClock = 0;
  /** 'title' = slow full orbit for the title screen, 'pause' = gentle sway. Blended, never cut. */
  private showcaseStyle: 'title' | 'pause' = 'pause';
  private titleMix = 0;
  /** Extra vertical FOV for a portrait title screen, where a tele lens would fill the narrow frame with the car. */
  private showcaseFovBoost = 0;
  private readonly alongStep = new THREE.Vector3();
  private readonly lateralStep = new THREE.Vector3();
  private readonly showcaseDesired = new THREE.Vector3();
  private readonly showcaseLook = new THREE.Vector3();
  private readonly showcaseRight = new THREE.Vector3();
  private readonly priorPosition = new THREE.Vector3();
  private baseFov: number;
  private collisionScale = 1;
  private collisionTarget = 1;
  private collisionCheckTimer = 1;
  private photoYaw = 0;
  private photoHeight = 3.4;
  private photoDistance = 8;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private readonly canvas: HTMLCanvasElement;
  private photoMode = false;
  private reducedMotion = false;
  private shakeEnabled = false;
  private impactTick: number | null = null;
  private shakeAge = Number.POSITIVE_INFINITY;
  private shakeAmplitude = 0;
  private readonly cameraRight = new THREE.Vector3();
  private readonly shakeOffset = new THREE.Vector3();
  private readonly lastAppliedShake = new THREE.Vector3();
  /** Clock for the high-speed buzz (seconds of unpaused driving). */
  private buzzClock = 0;
  private readonly buzzOffset = new THREE.Vector3();

  constructor(private readonly gameScene: GameScene) {
    this.baseFov = 58; this.canvas = gameScene.renderer.domElement;
    this.canvas.addEventListener('pointerdown', this.pointerDown); this.canvas.addEventListener('pointermove', this.pointerMove);
    this.canvas.addEventListener('pointerup', this.pointerUp); this.canvas.addEventListener('pointercancel', this.pointerUp);
    this.canvas.addEventListener('wheel', this.wheel, { passive: false });
  }

  cycleView(): CameraView {
    this.cameraView = this.cameraView === 'chase' ? 'close' : this.cameraView === 'close' ? 'hood' : 'chase';
    this.reset(); return this.cameraView;
  }

  setShowcaseStyle(style: 'title' | 'pause'): void { this.showcaseStyle = style; }

  setReducedMotion(reduced: boolean): void { this.reducedMotion = reduced; if (reduced) { this.shakeAge = Number.POSITIVE_INFINITY; this.shakeAmplitude = 0; } }

  setPreferences(preferences: { readonly baseFovDeg: number; readonly shakeEnabled: boolean; readonly reducedMotion: boolean }): void {
    this.baseFov = clamp(Number.isFinite(preferences.baseFovDeg) ? preferences.baseFovDeg : 58, 50, 75);
    this.shakeEnabled = preferences.shakeEnabled === true;
    this.reducedMotion = preferences.reducedMotion === true;
    if (!this.shakeEnabled || this.reducedMotion) { this.shakeAge = Number.POSITIVE_INFINITY; this.shakeAmplitude = 0; }
  }

  reset(): void { this.initialized = false; this.driftYaw = 0; this.roll = 0; this.showcaseBlend = 0; this.collisionScale = this.collisionTarget = 1; this.collisionCheckTimer = 1; this.impactTick = null; this.shakeAge = Number.POSITIVE_INFINITY; this.shakeAmplitude = 0; this.lastAppliedShake.set(0, 0, 0); this.gameScene.resetCamera(); }

  update(frame: FrameSnapshot, dtSeconds: number, presentation: RuntimeView['presentation'], paused = false): void {
    this.gameScene.camera.position.sub(this.lastAppliedShake);
    this.lastAppliedShake.set(0, 0, 0);
    this.photoMode = presentation === 'photo';
    if (presentation !== 'drive' || paused) {
      if (frame.impact) this.impactTick = frame.impact.simulationTick;
      this.shakeAge = Number.POSITIVE_INFINITY; this.shakeAmplitude = 0;
    }
    const vehicle = frame.current;
    const previous = frame.previous;
    const deltaX = previous.position.x - vehicle.position.x, deltaY = previous.position.y - vehicle.position.y, deltaZ = previous.position.z - vehicle.position.z;
    const jumped = previous.carId !== vehicle.carId || deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ > 144;
    const alpha = jumped ? 1 : THREE.MathUtils.clamp(frame.interpolationAlpha, 0, 1);
    this.previousPosition.set(previous.position.x, previous.position.y, previous.position.z);
    this.position.copy(this.previousPosition)
      .lerp(this.occlusionOffset.set(vehicle.position.x, vehicle.position.y, vehicle.position.z), alpha);
    this.sourceRotation.set(previous.rotation.x, previous.rotation.y, previous.rotation.z, previous.rotation.w).normalize();
    this.targetRotation.set(vehicle.rotation.x, vehicle.rotation.y, vehicle.rotation.z, vehicle.rotation.w).normalize();
    this.rotation.copy(this.sourceRotation).slerp(this.targetRotation, alpha);
    // Reversing reads as a ~180 degree "drift" whose sign flickers at +/-pi; keep the camera square behind the car instead.
    const driftAngle = vehicle.gear < 0 ? 0 : THREE.MathUtils.lerp(previous.driftAngleRad, vehicle.driftAngleRad, alpha);
    this.forward.set(0, 0, -1).applyQuaternion(this.rotation).setY(0).normalize();
    if (this.forward.lengthSq() < 0.5) this.forward.set(0, 0, -1);
    const speed = Math.hypot(vehicle.linearVelocityMS.x, vehicle.linearVelocityMS.z);
    const dt = Math.max(0, Math.min(0.1, dtSeconds));
    if (presentation === 'drive' && frame.impact && (paused || !this.shakeEnabled || this.reducedMotion)) this.impactTick = frame.impact.simulationTick;
    if (presentation === 'drive' && !paused && this.shakeEnabled && !this.reducedMotion && frame.impact && frame.impact.simulationTick !== this.impactTick) {
      this.impactTick = frame.impact.simulationTick;
      const strength = Math.max(Math.abs(frame.impact.speedDeltaMS) / 12, frame.impact.impulseNs / 5000);
      this.shakeAmplitude = Math.min(0.11, Math.max(0, strength) * 0.11);
      this.shakeAge = this.shakeAmplitude > 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    if (this.shakeAge !== Number.POSITIVE_INFINITY) {
      this.shakeAge += dt;
      if (this.shakeAge >= 0.32) { this.shakeAge = Number.POSITIVE_INFINITY; this.shakeAmplitude = 0; }
    }
    const speedT = smoothstep(speed / 45);
    const targetDriftYaw = this.reducedMotion ? 0 : Math.max(-0.32, Math.min(0.32, driftAngle * 0.24));
    if (!this.initialized) this.driftYaw = targetDriftYaw;
    else this.driftYaw += (targetDriftYaw - this.driftYaw) * (1 - Math.exp(-dt * 4.2));
    // Bank slightly into slides and fast turns; fades out at walking pace so a parked car never tilts the horizon.
    const yawRate = THREE.MathUtils.lerp(previous.angularVelocityRadS.y, vehicle.angularVelocityRadS.y, alpha);
    const targetRoll = this.reducedMotion || this.cameraView === 'hood' ? 0 : clamp(driftAngle * 0.09 + yawRate * 0.035, -0.11, 0.11) * smoothstep(speed / 8);
    if (!this.initialized) this.roll = targetRoll;
    else this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt * 6));
    this.focus.copy(this.position).addScaledVector(this.up, this.cameraView === 'hood' ? 1.1 : 1.25);
    // Trial a tighter default composition; later-build captures must confirm scale and road lookahead.
    const distance = this.cameraView === 'chase' ? 4.0 + 1.45 * speedT : this.cameraView === 'close' ? 3.25 : 0.35;
    this.yawForward.copy(this.forward).applyAxisAngle(this.up, this.driftYaw);
    if (this.cameraView === 'hood') this.desired.copy(this.position).addScaledVector(this.yawForward, 1.0).addScaledVector(this.up, 1.75);
    else this.desired.copy(this.position).addScaledVector(this.yawForward, -distance).addScaledVector(this.up, 2.8 + 0.55 * speedT);
    const lookAhead = this.cameraView === 'hood' ? 12 : this.cameraView === 'chase' ? 3.2 + 4.2 * speedT : 3.2;
    const aimHeight = this.cameraView === 'chase' && presentation !== 'photo' ? 0.2 : 0.8;
    this.targetLook.copy(this.position).addScaledVector(this.forward, lookAhead).addScaledVector(this.up, aimHeight);

    // The photo camera keeps a calm position while still tracking the selected car.
    if (presentation === 'photo' && this.cameraView === 'chase') {
      this.yawForward.applyAxisAngle(this.up, this.photoYaw);
      this.desired.copy(this.position).addScaledVector(this.yawForward, -this.photoDistance);
      this.desired.y += this.photoHeight;
    }
    // Paused menus: a calm three-quarter orbit sway instead of a frozen chase view.
    const showcase = presentation === 'drive' && paused && this.cameraView === 'chase' && !this.reducedMotion;
    this.showcaseBlend += ((showcase ? 1 : 0) - this.showcaseBlend) * (1 - Math.exp(-dt * 3.5));
    if (this.showcaseBlend < 0.002) { this.showcaseBlend = 0; this.showcaseClock = 0; this.showcaseFovBoost = 0; }
    else {
      this.showcaseClock += dt;
      this.titleMix += ((this.showcaseStyle === 'title' ? 1 : 0) - this.titleMix) * (1 - Math.exp(-dt * 0.9));
      const title = this.titleMix * this.titleMix * (3 - 2 * this.titleMix);
      // Title: one slow lap around the car every ~60 s, with a slight crane. Pause: the original three-quarter sway.
      const angle = THREE.MathUtils.lerp(0.62 + Math.sin(this.showcaseClock * 0.23) * 0.42, 0.62 + this.showcaseClock * 0.105, title);
      // Frame by footprint: wheel spread stands in for the body bounding box, so larger cars back the camera off.
      const w = vehicle.wheels;
      const wheelbase = w.length >= 4 ? Math.hypot(w[0]!.position.x - w[2]!.position.x, w[0]!.position.z - w[2]!.position.z) : 2.45;
      const size = THREE.MathUtils.clamp(wheelbase / 2.45, 1, 1.6);
      const portrait = this.gameScene.camera.aspect < 1;
      this.showcaseDesired.copy(this.forward).applyAxisAngle(this.up, angle).multiplyScalar(-(6.4 + 1.5 * title + (portrait ? 3 : 0) * title) * size).add(this.position);
      this.showcaseDesired.y += THREE.MathUtils.lerp(1.55, 1.15 + Math.sin(this.showcaseClock * 0.17) * 0.35, title) * (0.4 + 0.6 * size);
      this.showcaseLook.copy(this.position).addScaledVector(this.up, (0.62 - (portrait ? 0.5 : 0) * title) * size);
      this.showcaseFovBoost = portrait ? title * Math.max(0, 70 - this.baseFov * 0.72) : 0;
      this.showcaseRight.crossVectors(this.alongStep.copy(this.showcaseLook).sub(this.showcaseDesired).setY(0).normalize(), this.up);
      // Landscape: the car sits right of centre, clear of the menu column. Portrait: centred between hero and buttons.
      this.showcaseLook.addScaledVector(this.showcaseRight, THREE.MathUtils.lerp(-1.5, portrait ? 0 : -2.3 * size, title));
      const blend = this.showcaseBlend * this.showcaseBlend * (3 - 2 * this.showcaseBlend);
      this.desired.lerp(this.showcaseDesired, blend); this.targetLook.lerp(this.showcaseLook, blend);
    }
    this.avoidOcclusion(dt);
    const teleported = this.initialized && this.priorPosition.distanceToSquared(this.position) > 100;
    if (!this.initialized || teleported) { this.gameScene.camera.position.copy(this.desired); this.look.copy(this.targetLook); this.initialized = true; }
    else {
      const response = 1 - Math.exp(-dt * (this.cameraView === 'hood' ? 10 : 5.2));
      if (this.cameraView === 'chase' && speedT > 0) {
        // Tighter along the car's heading at speed (less trailing distance), softer sideways for a sense of weight.
        const along = 1 - Math.exp(-dt * (5.2 + 4.3 * speedT));
        this.lateralStep.copy(this.desired).sub(this.gameScene.camera.position);
        this.alongStep.copy(this.forward).multiplyScalar(this.lateralStep.dot(this.forward));
        this.lateralStep.sub(this.alongStep);
        this.gameScene.camera.position.addScaledVector(this.lateralStep, response).addScaledVector(this.alongStep, along);
      } else this.gameScene.camera.position.lerp(this.desired, response);
      this.look.lerp(this.targetLook, 1 - Math.exp(-dt * 7.5));
    }
    if (this.shakeAge !== Number.POSITIVE_INFINITY && presentation === 'drive' && !paused && this.shakeEnabled && !this.reducedMotion) {
      const envelope = Math.max(0, 1 - this.shakeAge / 0.32);
      const phase = ((this.impactTick ?? 0) % 997) * 0.013 + this.shakeAge * 42;
      this.cameraRight.crossVectors(this.forward, this.up).normalize();
      this.shakeOffset.copy(this.cameraRight).multiplyScalar(Math.sin(phase) * this.shakeAmplitude * envelope);
      this.shakeOffset.y += Math.sin(phase * 1.37) * this.shakeAmplitude * 0.42 * envelope;
      this.gameScene.camera.position.add(this.shakeOffset);
      this.lastAppliedShake.copy(this.shakeOffset);
    }
    // High-speed buzz: a very small, fast tremor that only starts above ~200 km/h and grows to 360 km/h, so only a
    // genuinely fast car ever feels it. Keyed to speed (never to the car) and off with reduced motion.
    const hyperT = smoothstep((speed - 55) / 45);
    if (hyperT > 0 && presentation === 'drive' && !paused && !this.reducedMotion) {
      this.buzzClock += dt;
      const amp = (this.cameraView === 'hood' ? 0.008 : 0.016) * hyperT, t = this.buzzClock;
      this.cameraRight.crossVectors(this.forward, this.up).normalize();
      this.buzzOffset.copy(this.cameraRight).multiplyScalar((Math.sin(t * 37) + 0.5 * Math.sin(t * 61 + 0.7)) * amp / 1.5);
      this.buzzOffset.y += (Math.sin(t * 43 + 1.3) + 0.5 * Math.sin(t * 71)) * amp * 0.6 / 1.5;
      this.gameScene.camera.position.add(this.buzzOffset);
      this.lastAppliedShake.add(this.buzzOffset);
    }
    this.gameScene.camera.lookAt(this.look);
    if (this.roll !== 0) this.gameScene.camera.rotateZ(this.roll);
    // Widening up to 162 km/h for every car, then a second stage from ~200 to 360 km/h that only hypercars reach.
    const widening = this.cameraView === 'hood' || this.reducedMotion ? 0 : 8 * smoothstep(speed / 45) + 7 * smoothstep((speed - 55) / 45);
    this.gameScene.camera.fov = this.baseFov + widening - this.showcaseBlend * this.baseFov * 0.28 + this.showcaseBlend * this.showcaseFovBoost;
    this.gameScene.camera.updateProjectionMatrix();
    this.priorPosition.copy(this.position);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.pointerDown); this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp); this.canvas.removeEventListener('pointercancel', this.pointerUp);
    this.canvas.removeEventListener('wheel', this.wheel);
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.photoMode || event.button !== 0) return; this.dragging = true; this.lastPointer = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };
  private pointerMove = (event: PointerEvent): void => {
    if (!this.photoMode || !this.dragging) return;
    this.photoYaw += (event.clientX - this.lastPointer.x) * 0.008;
    this.photoHeight = Math.max(1, Math.min(9, this.photoHeight - (event.clientY - this.lastPointer.y) * 0.025));
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };
  private pointerUp = (): void => { this.dragging = false; };
  private wheel = (event: WheelEvent): void => { if (!this.photoMode) return; this.photoDistance = Math.max(3, Math.min(18, this.photoDistance + event.deltaY * 0.008)); event.preventDefault(); };

  private avoidOcclusion(dt: number): void {
    this.occlusionOffset.copy(this.desired).sub(this.focus);
    const length = this.occlusionOffset.length(); if (length < 0.2) return;
    this.collisionCheckTimer += dt;
    if (this.collisionCheckTimer >= .08) {
      this.collisionCheckTimer = 0;
      this.occlusionDirection.copy(this.occlusionOffset).normalize();
      this.raycaster.set(this.focus, this.occlusionDirection); this.raycaster.far = length;
      this.intersections.length = 0;
      const candidates = this.gameScene.cameraOccluders;
      if (candidates !== undefined) {
        if (candidates.length) this.raycaster.intersectObjects([...candidates], false, this.intersections);
        else this.collisionTarget = 1;
      } else this.raycaster.intersectObjects(this.gameScene.scene.children, true, this.intersections);
      const hit = this.intersections.find(item => item.distance > 0.1 && isCameraOccluder(item.object));
      if (candidates === undefined || candidates.length) this.collisionTarget = hit ? Math.max(.1, Math.min(1,(hit.distance-.5)/length)) : 1;
    }
    this.collisionScale += (this.collisionTarget-this.collisionScale)*(1-Math.exp(-dt*14));
    this.desired.copy(this.focus).addScaledVector(this.occlusionOffset,this.collisionScale);
  }
}

function isRoadSurface(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (/ground|road|asphalt|terrain|apron/i.test(node.name)) return true;
  return false;
}
function isVehiclePart(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (node.name === 'body' || node.name.startsWith('wheel-')) return true;
  return false;
}
function isCameraOccluder(object: THREE.Object3D): boolean {
  if (isRoadSurface(object) || isVehiclePart(object)) return false;
  let designated = false;
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible || node.userData.cameraCollision === false) return false;
    if (node.userData.cameraCollision === true) designated = true;
  }
  return designated && (object as THREE.Mesh).isMesh === true;
}

export function createPlayerCamera(gameScene: GameScene): PlayerCamera { return new PlayerCamera(gameScene); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function smoothstep(value: number): number { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); }
