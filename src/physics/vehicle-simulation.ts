import RAPIER, { type Collider, type ColliderDesc, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import type { InputFrame, Simulation, VehicleSnapshot, Vec3, Quat, CarId } from '../../contracts/runtime-contracts';
import { VEHICLE_CONFIGS, VEHICLE_TUNES } from '../vehicle/configs';
import type { BoxColliderOptions, ColliderHandle, CollisionTelemetry, GroundConfig, InterpolatedSnapshots, TunePresetId, VehicleConfig, VehicleDynamicsTelemetry, VehicleSimulationOptions, VehicleTune, WheelDynamicsTelemetry } from '../vehicle/types';
import { createVehicleTuneIdentity, isTunePresetId, validateVehicleTune } from '../vehicle/tune-identity';
import { assistProfile, isAssistLevel, type AssistLevel, type AssistTelemetry } from './assists';

const DT = 1 / 60;
// Arcade brake-to-reverse: below this forward speed a held brake (no gas, no handbrake) engages reverse.
const AUTO_REVERSE_STOP_MS = 0.75;
const AUTO_REVERSE_HOLD_S = 0.2;
const REVERSE_TOP_SPEED_MS = 8;
// Walls (obstacle colliders) for every assist level: low friction (min-combined with the body) so a glancing hit
// scrapes along instead of gripping and spinning the car, no bounce, and most of the contact-induced spin removed.
const WALL_FRICTION = 0.06;
const WALL_SPIN_KEEP = 0.35;
// Fraction of tangential speed a scrape costs per fixed step of wall contact (about 17% per second of grinding).
const WALL_SCRAPE_LOSS = 0.003;
const FLICK_WINDOW_TICKS = 15;
// Wheel spin bound (rad/s). 330 rad/s on a 0.33 m wheel is about 390 km/h; the old 230 capped every car at 273 km/h.
const WHEEL_OMEGA_LIMIT = 330;
/** A car geared past the bound (CAR-06, ~400 km/h) gets its top-gear redline wheel speed instead; every other car keeps 330. */
const wheelOmegaLimit = (config: VehicleConfig): number => Math.max(WHEEL_OMEGA_LIMIT,
  config.engine.redlineRpm * Math.PI / 30 / (config.engine.gearRatios[config.engine.gearRatios.length - 1]! * config.engine.finalDrive));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: number) => Number.isFinite(v) ? v : 0;
const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a: Vec3, b: Vec3) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: Vec3, n: number) => V(a.x * n, a.y * n, a.z * n);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3) => { const l = len(a) || 1; return mul(a, 1 / l); };
const cross = (a: Vec3, b: Vec3) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const qmul = (a: Quat, b: Quat): Quat => ({ x: a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y, y: a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x, z: a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w, w: a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z });
const rotate = (q: Quat, v: Vec3): Vec3 => {
  const u = V(q.x, q.y, q.z), t = mul(cross(u, v), 2);
  return add(v, add(mul(t, q.w), cross(u, t)));
};
const yawQuat = (yaw: number): Quat => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
const inertiaFor = (c: VehicleConfig): Vec3 => {
  const width = c.trackM + 0.24, height = 0.62, length = c.wheelbaseM + 0.8;
  return V(c.massKg * (height * height + length * length) / 12, c.massKg * (width * width + length * length) / 12, c.massKg * (width * width + height * height) / 12);
};
const quatCopy = (q: { x: number; y: number; z: number; w: number }): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const vecCopy = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/** Aero downforce (N) at this forward speed from config.aero; 0 for cars without aero. Sideways speed makes none. */
export function aeroDownforceN(config: VehicleConfig, forwardSpeedMS: number): number {
  const aero = config.aero;
  return aero ? Math.min(aero.maxDownforceN, aero.downforceNPerMS2 * forwardSpeedMS * forwardSpeedMS) : 0;
}

export interface VehicleSimulationHandle extends Simulation {
  setCar(carId: CarId): void;
  setTune(preset: TunePresetId | VehicleTune): void;
  setSpawn(position: Vec3, rotation?: Quat): void;
  /** Place the car at rest at an arbitrary pose without changing the spawn (crash recovery). */
  recoverTo?(position: Vec3, rotation: Quat): void;
  /** Driving assist level ('off' is the raw model). Takes effect on the next step; no state jump. */
  setAssist(level: AssistLevel): void;
  getAssist(): AssistLevel;
  assistTelemetry(): AssistTelemetry;
  addColliderBox(options: BoxColliderOptions): ColliderHandle;
  addStaticTriangleMesh(vertices: readonly Vec3[], indices: readonly number[], surfaceId?: string, friction?: number, role?: 'surface' | 'obstacle'): ColliderHandle;
  removeCollider(handle: ColliderHandle): void;
  getConfig(): VehicleConfig;
  getTuning(): VehicleTune;
  getTuneIdentity(): string;
  collisionTelemetry(): CollisionTelemetry;
  wheelDynamicsTelemetry(): VehicleDynamicsTelemetry;
  snapshots(): InterpolatedSnapshots;
}

interface WheelState {
  local: Vec3;
  contactPoint: Vec3;
  readonly front: boolean;
  omega: number;
  rollAngle: number;
  steer: number;
  contact: boolean;
  point: Vec3;
  compression: number;
  load: number;
  slipRatio: number;
  slipAngle: number;
  surfaceId: string | null;
  rotation: Quat;
  surfaceNormal: Vec3 | null;
  longitudinalVelocity: number;
  lateralVelocity: number;
  handbrakeGripScale: number;
  frictionCapacity: number;
  longitudinalForceDemand: number;
  rawLongitudinalForce: number;
  rawLateralForce: number;
  appliedLongitudinalForce: number;
  appliedLateralForce: number;
  driveTorque: number;
  availableBrakeTorque: number;
  brakeLockActive: boolean;
  brakeLockRequiredTorque: number;
  brakeLockForce: number;
}
interface ColliderRecord { readonly collider: Collider; readonly id: string; readonly surfaceId: string | null; readonly category: string; }

export async function createVehicleSimulation(options: VehicleSimulationOptions & { readonly assist?: AssistLevel } = {}): Promise<VehicleSimulationHandle> {
  await RAPIER.init();
  const gravity = options.gravity ?? V(0, -9.81, 0);
  const world: World = new RAPIER.World(gravity);
  const carId = options.carId ?? 'CAR-01';
  let config = VEHICLE_CONFIGS[carId];
  let tune = validateVehicleTune(VEHICLE_TUNES[carId][options.tune ?? 'Balanced']);
  let tick = 0;
  let gear = 1;
  // Assist state. The simulation defaults to the raw model; the game passes the player's setting.
  let assistLevel: AssistLevel = isAssistLevel(options.assist) ? options.assist : 'off';
  let prevBodySlip = 0;
  let driftMode = false;
  let driftTarget = 0;
  let driftIntentS = 0;
  let tractionScale = 1;
  const steerHistory: number[] = [];
  let assistStatus: AssistTelemetry = { level: assistLevel, driftMode: false, driftTargetRad: 0, throttleScale: 1, brakeAdded: 0, yawTorqueNm: 0, steerLimitRad: 0 };
  // True when reverse was entered by holding brake: the brake pedal then drives backwards and gas brakes.
  let reverseByBrake = false;
  let reverseHoldS = 0;
  let engineRpm = config.engine.idleRpm;
  let steerInput = 0;
  let wasShift = 0;
  let wasReset = false;
  let spawnPosition = options.spawn?.position ?? V(0, 0.78, 0);
  let spawnRotation = options.spawn?.rotation ?? yawQuat(0);
  const spawnVelocity = options.spawn?.linearVelocityMS ?? V();
  const records = new Map<number, ColliderRecord>();
  let generatedId = 1;

  if (options.ground !== false) {
    const g: GroundConfig = options.ground ?? {};
    const h = g.halfExtentsM ?? V(1000, 0.25, 1000);
    const desc = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
      .setTranslation(0, (g.heightM ?? 0) - h.y, 0)
      .setFriction(g.friction ?? 1).setRestitution(g.restitution ?? 0);
    const ground = world.createCollider(desc);
    records.set(ground.handle, { collider: ground, id: 'ground-default', surfaceId: g.surfaceId ?? 'asphalt', category: 'ground' });
  }

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
    .setRotation(spawnRotation).setLinvel(spawnVelocity.x, spawnVelocity.y, spawnVelocity.z).setCanSleep(false).setCcdEnabled(true).setLinearDamping(0.015).setAngularDamping(0.08)
    .setAdditionalMassProperties(config.massKg * 0.96, config.centerOfMassM, inertiaFor(config), { x: 0, y: 0, z: 0, w: 1 });
  const body: RigidBody = world.createRigidBody(bodyDesc);
  const bodyCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(0.88, 0.31, config.wheelbaseM * 0.37)
    .setFriction(0.65).setRestitution(0.05).setMass(config.massKg * 0.04), body);
  const wheelY = -0.12;
  const wheelX = config.trackM * 0.5;
  const frontZ = -config.wheelbaseM * 0.5;
  const rearZ = config.wheelbaseM * 0.5;
  const wheels: WheelState[] = [
    { local: V(-wheelX, wheelY, frontZ), contactPoint: V(), front: true, omega: 0, rollAngle: 0, steer: 0, contact: false, point: V(), compression: 0, load: 0, slipRatio: 0, slipAngle: 0, surfaceId: null, rotation: { x: 0, y: 0, z: 0, w: 1 }, surfaceNormal: null, longitudinalVelocity: 0, lateralVelocity: 0, handbrakeGripScale: 1, frictionCapacity: 0, longitudinalForceDemand: 0, rawLongitudinalForce: 0, rawLateralForce: 0, appliedLongitudinalForce: 0, appliedLateralForce: 0, driveTorque: 0, availableBrakeTorque: 0, brakeLockActive: false, brakeLockRequiredTorque: 0, brakeLockForce: 0 },
    { local: V(wheelX, wheelY, frontZ), contactPoint: V(), front: true, omega: 0, rollAngle: 0, steer: 0, contact: false, point: V(), compression: 0, load: 0, slipRatio: 0, slipAngle: 0, surfaceId: null, rotation: { x: 0, y: 0, z: 0, w: 1 }, surfaceNormal: null, longitudinalVelocity: 0, lateralVelocity: 0, handbrakeGripScale: 1, frictionCapacity: 0, longitudinalForceDemand: 0, rawLongitudinalForce: 0, rawLateralForce: 0, appliedLongitudinalForce: 0, appliedLateralForce: 0, driveTorque: 0, availableBrakeTorque: 0, brakeLockActive: false, brakeLockRequiredTorque: 0, brakeLockForce: 0 },
    { local: V(-wheelX, wheelY, rearZ), contactPoint: V(), front: false, omega: 0, rollAngle: 0, steer: 0, contact: false, point: V(), compression: 0, load: 0, slipRatio: 0, slipAngle: 0, surfaceId: null, rotation: { x: 0, y: 0, z: 0, w: 1 }, surfaceNormal: null, longitudinalVelocity: 0, lateralVelocity: 0, handbrakeGripScale: 1, frictionCapacity: 0, longitudinalForceDemand: 0, rawLongitudinalForce: 0, rawLateralForce: 0, appliedLongitudinalForce: 0, appliedLateralForce: 0, driveTorque: 0, availableBrakeTorque: 0, brakeLockActive: false, brakeLockRequiredTorque: 0, brakeLockForce: 0 },
    { local: V(wheelX, wheelY, rearZ), contactPoint: V(), front: false, omega: 0, rollAngle: 0, steer: 0, contact: false, point: V(), compression: 0, load: 0, slipRatio: 0, slipAngle: 0, surfaceId: null, rotation: { x: 0, y: 0, z: 0, w: 1 }, surfaceNormal: null, longitudinalVelocity: 0, lateralVelocity: 0, handbrakeGripScale: 1, frictionCapacity: 0, longitudinalForceDemand: 0, rawLongitudinalForce: 0, rawLateralForce: 0, appliedLongitudinalForce: 0, appliedLateralForce: 0, driveTorque: 0, availableBrakeTorque: 0, brakeLockActive: false, brakeLockRequiredTorque: 0, brakeLockForce: 0 },
  ];
  const initialForwardSpeed = dot(spawnVelocity, rotate(spawnRotation, V(0, 0, -1)));
  for (const wheel of wheels) wheel.omega = initialForwardSpeed / config.wheelRadiusM;
  const defaultSpawn = { position: { ...spawnPosition }, rotation: { ...spawnRotation } };
  let previous = makeSnapshot();
  let current = previous;
  let collision: CollisionTelemetry = { tick: 0, impact: false, impulseNs: 0, speedDeltaMS: 0, colliderIds: [] };
  let autoShiftCooldown = 0;

  function currentQuat(): Quat { return quatCopy(body.rotation()); }
  function worldPoint(local: Vec3): Vec3 { return add(vecCopy(body.translation()), rotate(currentQuat(), local)); }
  function makeSnapshot(): VehicleSnapshot {
    const q = currentQuat();
    const forward = rotate(q, V(0, 0, -1));
    const velocity = vecCopy(body.linvel());
    const planarForward = norm(V(forward.x, 0, forward.z));
    const planarVelocity = V(velocity.x, 0, velocity.z);
    const crossY = planarForward.z * planarVelocity.x - planarForward.x * planarVelocity.z;
    const driftAngleRad = Math.atan2(crossY, dot(planarForward, planarVelocity));
    const ws = wheels.map((w) => ({
      contact: w.contact, position: { ...w.point }, rotation: qmul(q, qmul(yawQuat(-w.steer), { x: Math.sin(w.rollAngle / 2), y: 0, z: 0, w: Math.cos(w.rollAngle / 2) })), compressionM: w.compression,
      normalLoadN: w.load, angularVelocityRadS: w.omega, slipRatio: w.slipRatio, slipAngleRad: w.slipAngle, surfaceId: w.surfaceId,
    })) as unknown as VehicleSnapshot['wheels'];
    return { simulationTick: tick, carId: config.carId, position: vecCopy(body.translation()), rotation: q,
      linearVelocityMS: velocity, angularVelocityRadS: vecCopy(body.angvel()), wheels: ws, engineRpm, gear, driftAngleRad };
  }
  function torqueAtRpm(rpm: number): number {
    const curve = config.engine.torqueCurve;
    if (rpm <= curve[0].rpm) return curve[0].torqueNm;
    for (let i = 1; i < curve.length; i++) if (rpm <= curve[i].rpm) {
      const a = curve[i - 1], b = curve[i], t = (rpm - a.rpm) / (b.rpm - a.rpm);
      return a.torqueNm + (b.torqueNm - a.torqueNm) * t;
    }
    return curve[curve.length - 1].torqueNm;
  }
  function addBox(options: BoxColliderOptions): ColliderHandle {
    const e = options.halfExtents;
    const d = RAPIER.ColliderDesc.cuboid(Math.max(0.01, e.x), Math.max(0.01, e.y), Math.max(0.01, e.z))
      .setTranslation(options.center.x, options.center.y, options.center.z)
      .setRotation(options.rotation ?? { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(options.friction ?? 0.8).setRestitution(options.restitution ?? 0.05);
    if (options.category === 'wall') wallMaterial(d);
    const c = world.createCollider(d);
    const id = options.surfaceId ?? `collider-${generatedId++}`;
    records.set(c.handle, { collider: c, id, surfaceId: options.surfaceId ?? null, category: options.category ?? 'prop' });
    return { handle: c.handle };
  }
  function wallMaterial(desc: ColliderDesc): void {
    desc.setFriction(Math.min(desc.friction, WALL_FRICTION)).setRestitution(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  }
  function reset(position = spawnPosition, rotation = spawnRotation): void {
    body.setTranslation(position, true); body.setRotation(rotation, true);
    body.setLinvel(V(), true); body.setAngvel(V(), true);
    for (const w of wheels) {
      w.omega = 0; w.rollAngle = 0; w.contact = false; w.load = 0; w.compression = 0; w.slipAngle = 0; w.slipRatio = 0;
      w.surfaceNormal = null; w.longitudinalVelocity = 0; w.lateralVelocity = 0; w.handbrakeGripScale = 1; w.frictionCapacity = 0;
      w.longitudinalForceDemand = 0; w.rawLongitudinalForce = 0; w.rawLateralForce = 0; w.appliedLongitudinalForce = 0; w.appliedLateralForce = 0;
      w.driveTorque = 0; w.availableBrakeTorque = 0; w.brakeLockActive = false; w.brakeLockRequiredTorque = 0; w.brakeLockForce = 0;
    }
    gear = 1; engineRpm = config.engine.idleRpm; steerInput = 0; wasShift = 0; wasReset = false;
    autoShiftCooldown = 0; reverseByBrake = false; reverseHoldS = 0;
    prevBodySlip = 0; driftMode = false; driftTarget = 0; driftIntentS = 0; tractionScale = 1; steerHistory.length = 0;
    assistStatus = { level: assistLevel, driftMode: false, driftTargetRad: 0, throttleScale: 1, brakeAdded: 0, yawTorqueNm: 0, steerLimitRad: 0 };
    collision = { tick, impact: false, impulseNs: 0, speedDeltaMS: 0, colliderIds: [] };
    previous = makeSnapshot(); current = previous;
  }

  const api: VehicleSimulationHandle = {
    step(input: InputFrame): void {
      if (!Number.isFinite(input.simulationTick) || input.simulationTick < tick) return;
      tick = input.simulationTick;
      if (input.resetPressed && !wasReset) reset(defaultSpawn.position, defaultSpawn.rotation);
      wasReset = input.resetPressed;
      if (input.shift !== 0 && input.shift !== wasShift) {
        // Crossing neutral is deliberate and only allowed near rest.
        if (gear === 1 && input.shift < 0 && len(body.linvel()) < 1.5) { gear = -1; reverseByBrake = false; }
        else if (gear === -1 && input.shift < 0) reverseByBrake = false;
        else if (gear === -1 && input.shift > 0 && len(body.linvel()) < 1.5) { gear = 1; reverseByBrake = false; }
        else if (gear > 0) gear = clamp(gear + input.shift, 1, config.engine.gearRatios.length);
      }
      wasShift = input.shift;
      previous = current;
      const throttleInput = clamp(finite(input.throttle), 0, 1), brakeInput = clamp(finite(input.brake), 0, 1), handbrake = clamp(finite(input.handbrake), 0, 1);
      const steering = clamp(finite(input.steering), -1, 1);
      const rotation = currentQuat();
      const velocity = vecCopy(body.linvel());
      const speed = len(velocity);
      const forwardSpeed = dot(velocity, rotate(rotation, V(0, 0, -1)));
      // Arcade reverse: brake held at (near) rest shifts into reverse after a short hold; in that mode brake is the
      // reverse pedal and gas brakes, then shifts back to drive once the car is nearly stopped again.
      const nearlyStopped = Math.abs(forwardSpeed) < AUTO_REVERSE_STOP_MS && speed < AUTO_REVERSE_STOP_MS * 1.5;
      if (gear > 0 && brakeInput > 0.1 && throttleInput < 0.05 && handbrake < 0.1 && nearlyStopped) {
        reverseHoldS += DT;
        if (reverseHoldS >= AUTO_REVERSE_HOLD_S - 1e-9) { gear = -1; reverseByBrake = true; reverseHoldS = 0; autoShiftCooldown = 0; }
      } else reverseHoldS = 0;
      if (gear < 0 && reverseByBrake && throttleInput > 0.1 && brakeInput < 0.05 && forwardSpeed > -AUTO_REVERSE_STOP_MS) {
        gear = 1; reverseByBrake = false;
      }
      const pedalsSwapped = gear < 0 && reverseByBrake;
      const throttle = pedalsSwapped ? brakeInput : throttleInput, brake = pedalsSwapped ? throttleInput : brakeInput;
      const driveDir = gear < 0 ? -1 : 1;
      autoShiftCooldown = Math.max(0, autoShiftCooldown - DT);
      const angularVelocity = vecCopy(body.angvel());
      const yawRate = dot(angularVelocity, rotate(rotation, V(0, 1, 0)));
      let targetSteer = steering * (config.steering.maxAngleLowSpeedRad + (config.steering.maxAngleHighSpeedRad - config.steering.maxAngleLowSpeedRad) * clamp(speed / config.steering.highSpeedMS, 0, 1)) * tune.steeringScale;
      let steerResponse = config.steering.responseSeconds;
      const assist = gear > 0 ? assistProfile(assistLevel) : null;
      const forwardVector = rotate(rotation, V(0, 0, -1)), rightVector = rotate(rotation, V(1, 0, 0));
      const slideForward = dot(velocity, forwardVector), slideSide = dot(velocity, rightVector);
      const bodySlip = Math.atan2(slideSide, Math.max(Math.abs(slideForward), 1));
      let assistThrottle = 1, assistBrake = 0, assistYawTorque = 0, steerLimit = 0, initiating = false, gripScale = 1;
      if (assist) {
        // Per-car scaling keyed by grip (never by car id): road-car grip (mean tuned mu up to 1.3) gets scale 1 and the
        // assists exactly as tuned; a high-grip, high-downforce car gets lighter steering lag, looser traction control
        // and a drift hold strong enough for tyres that regrip hard, so the assists help it without strangling it.
        const muEff = (config.tires.frontMu * tune.frontMuScale + config.tires.rearMu * tune.rearMuScale) / 2;
        gripScale = clamp(muEff / 1.3, 1, 2);
        // Front slip-angle limiter: the front wheels may point at most a multiple of the tyre's peak slip angle away
        // from the direction the front axle is actually travelling. Past that the front only plows (and a sudden
        // full lock at speed is what snaps the car), so lock shrinks with speed on its own, and because the window
        // follows the axle's velocity, steering toward a slide (countersteer) always gets the lock it needs.
        // Drift intent: handbrake, or a big steering flick (lock to lock) inside 0.25 s at speed.
        steerHistory.push(steering);
        if (steerHistory.length > FLICK_WINDOW_TICKS) steerHistory.shift();
        const swing = Math.max(...steerHistory) - Math.min(...steerHistory);
        if (!assist.driftIntent) driftIntentS = 0;
        else if (handbrake > 0.3 && speed > 4) driftIntentS = 0.9;
        else if (swing >= assist.flickSwing && speed > 9 && throttleInput > 0.3) driftIntentS = Math.max(driftIntentS, 0.6);
        else driftIntentS = Math.max(0, driftIntentS - DT);
        // While the driver is initiating a drift the assists step back so the slide can build.
        initiating = driftIntentS > 0 && !driftMode;
        const countersteering = steering * bodySlip > 0;
        const frontAxleAngle = Math.atan2(slideSide - yawRate * config.wheelbaseM * 0.5, Math.max(Math.abs(slideForward), 1));
        const slipWindow = config.tires.peakSlipAngleRad * assist.lockUsefulMultiple;
        const rawSteer = targetSteer;
        const limitedSteer = clamp(rawSteer, frontAxleAngle - slipWindow, frontAxleAngle + slipWindow);
        targetSteer = rawSteer + (limitedSteer - rawSteer) * clamp((speed - assist.limiterOnsetMS) / assist.limiterRampMS, 0, 1) * (initiating ? 0.2 : driftMode ? 1 / gripScale ** 2 : 1);
        steerLimit = Math.abs(targetSteer);
        const demand = rawSteer * targetSteer > 0 ? Math.abs(rawSteer) / Math.max(Math.abs(targetSteer), 0.02) : Math.abs(rawSteer) > 0.05 ? 3 : 0;
        // Slower steering at speed, except when unwinding or countersteering (those must stay quick).
        const unwinding = Math.abs(targetSteer) < Math.abs(steerInput) || countersteering;
        if (!unwinding) steerResponse *= 1 + assist.steerLagAtSpeed / gripScale * clamp((speed - 8) / 22, 0, 1);
        const absSlip = Math.abs(bodySlip);
        if (!driftMode && driftIntentS > 0 && absSlip > 0.18 && slideForward > 3) { driftMode = true; driftTarget = absSlip; }
        if (driftMode && (absSlip < 0.1 || slideForward < 2.5 || absSlip > 1.75)) { driftMode = false; driftTarget = 0; }
        // Understeer: when the driver asks for far more lock than the tyres can use at speed, ease off (and brake on High).
        if (!driftMode && !initiating && speed > 6 && demand > 1.2 && Math.abs(bodySlip) < assist.stabilitySlipRad) {
          const over = clamp((demand - 1.2) / 0.9, 0, 1) * clamp((speed - 6) / 6, 0, 1);
          assistThrottle *= 1 - assist.understeerThrottleCut * over;
          assistBrake = assist.understeerBrake * over * throttleInput;
        }
      }
      steerInput += (targetSteer - steerInput) * clamp(DT / steerResponse, 0, 1);
      const frontOmega = Math.abs((wheels[2].omega + wheels[3].omega) * 0.5);
      const ratio = config.engine.gearRatios[Math.max(0, Math.abs(gear) - 1)] * config.engine.finalDrive;
      engineRpm = clamp(Math.max(config.engine.idleRpm, frontOmega * ratio * 60 / (2 * Math.PI)), config.engine.idleRpm, config.engine.redlineRpm);
      // Rev limiter: fuel cut ramps in over the last 4% below redline so a spinning axle cannot pin the engine there.
      const limiter = clamp((config.engine.redlineRpm - engineRpm) / (config.engine.redlineRpm * 0.04), 0, 1);
      // Reverse is governed to an arcade top speed instead of running gear 1 to redline backwards.
      const reverseGovernor = gear < 0 ? clamp((REVERSE_TOP_SPEED_MS + forwardSpeed) / 1.5, 0, 1) : 1;
      if (assist) {
        // Traction control on the rear slip ratio from the previous step, plus a power-oversteer guard on growing
        // body slip. In a held drift the slip target is relaxed (wheelspin is the point) and the hold manages angle.
        const rearSlip = Math.max(wheels[2].slipRatio, wheels[3].slipRatio);
        const slipTarget = (driftMode || initiating ? assist.tractionSlipTarget * 4 : assist.tractionSlipTarget) * gripScale ** 1.5;
        const tcGate = clamp((speed - 3) / 5, 0, 1) * (Number.isFinite(assist.tractionMaxSpeedMS) ? clamp(3 - 2 * speed / assist.tractionMaxSpeedMS, 0, 1) : 1)
          * (Number.isFinite(assist.tractionMaxSlipRad) ? clamp(2 - Math.abs(bodySlip) / assist.tractionMaxSlipRad, 0, 1) : 1);
        const tcWanted = 1 - tcGate * (1 - clamp(1 - (rearSlip - slipTarget) / 0.3, assist.tractionFloor, 1));
        tractionScale = tcWanted < tractionScale ? tcWanted : Math.min(1, tractionScale + DT * 2.5);
        assistThrottle *= tractionScale;
        const slipRate = (bodySlip - prevBodySlip) / DT;
        const growing = slipRate * Math.sign(bodySlip);
        const allowed = driftMode ? driftTarget + 0.08 : assist.stabilitySlipRad;
        if (!initiating && growing > 0 && Math.abs(bodySlip) > allowed) assistThrottle *= clamp(1 - assist.powerOversteerCut * growing * 0.25, 0.1, 1);
      }
      const engineTorque = torqueAtRpm(engineRpm) * (assist ? throttle * assistThrottle : throttle) * tune.engineScale * limiter * reverseGovernor;
      // Pulling the handbrake declutches (as in a real handbrake turn), so engine torque cannot overpower the rear lock.
      const driveTorquePerWheel = engineTorque * ratio * 0.86 * driveDir / 2 * (1 - 0.6 * handbrake);
      const rearWheelSpeedDelta = Math.abs(wheels[2].omega) - Math.abs(wheels[3].omega);
      const transferMagnitude = clamp(rearWheelSpeedDelta * 6, -Math.abs(driveTorquePerWheel) * 0.5, Math.abs(driveTorquePerWheel) * 0.5) * (tune.rearDiffLock ?? 0.15);
      const signedTransfer = Math.sign(driveTorquePerWheel) * transferMagnitude;
      // Bounded countersteer assist (radians of front wheel angle, added to the driver's steering):
      //  - yaw-rate damping term (existing behaviour), and
      //  - slip-angle term: when the chassis slides past ~8 degrees while moving forward, the front wheels
      //    are turned toward the velocity vector. It fades in between 8 and 20 degrees, is capped, and is
      //    scaled down to 20% when the driver deliberately steers against it, so it makes slides catchable
      //    with digital input but cannot hold a drift angle or complete an event unattended.
      const assistBase = clamp(config.assists.countersteerStrength + config.assists.stabilityStrength * 0.5, 0, 0.25);
      const smooth = (x: number) => x * x * (3 - 2 * x);
      const gateStart = assist ? assist.counterGateRad : 0.14, gateWidth = assist ? assist.counterGateWidthRad : 0.21;
      const slipGate = (initiating ? 0.2 : 1) * smooth(clamp((Math.abs(bodySlip) - gateStart) / gateWidth, 0, 1)) * clamp((speed - 3) / 3, 0, 1) * (slideForward > 0 ? 1 : 0);
      // Only the SHORTFALL between the driver's front-wheel angle and the velocity direction is supplied, so
      // the assist can never stack on a deliberate countersteer and over-correct into the opposite slide.
      const targetWheelAngle = bodySlip * 0.85;
      const shortfall = targetWheelAngle - steerInput;
      const normalAssist = (shortfall * Math.sign(targetWheelAngle) > 0
        ? (assist
          ? clamp(shortfall * Math.max(clamp(config.assists.countersteerStrength * 5, 0, 1), assist.counterGain), -assist.counterCapRad, assist.counterCapRad)
          : clamp(shortfall * clamp(config.assists.countersteerStrength * 5, 0, 1), -0.35, 0.35)) : 0) * slipGate;
      // Late catch (Drift level): past ~50 deg the full countersteer shortfall is supplied, whichever term is larger.
      const catchGate = assist && Number.isFinite(assist.catchGateRad) && slideForward > 0
        ? smooth(clamp((Math.abs(bodySlip) - assist.catchGateRad) / assist.catchGateWidthRad, 0, 1)) * clamp((speed - 3) / 3, 0, 1) : 0;
      const catchAssist = catchGate > 0 && shortfall * Math.sign(targetWheelAngle) > 0 ? clamp(shortfall, -assist!.catchCapRad, assist!.catchCapRad) * catchGate : 0;
      const slipAssistRaw = Math.abs(catchAssist) > Math.abs(normalAssist) ? catchAssist : normalAssist;
      const opposed = Math.max(0, -Math.sign(slipAssistRaw) * steering);
      const assistSteer = yawRate * assistBase + slipAssistRaw * (assist ? 1 - (1 - assist.counterOpposedKeep) * opposed : 1 - 0.8 * opposed);
      let totalSuspensionImpulse = V();
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        w.steer = w.front ? clamp(steerInput + assistSteer, -1.2, 1.2) : 0;
        const anchor = worldPoint(w.local);
        const down = rotate(rotation, V(0, -1, 0));
        const rayLength = config.wheelRadiusM + config.suspension.restLengthM + config.suspension.travelM;
        const hit = world.castRayAndGetNormal(new RAPIER.Ray(anchor, down), rayLength, true, undefined, undefined, undefined, body);
        w.contact = hit !== null;
        w.surfaceId = hit ? records.get(hit.collider.handle)?.surfaceId ?? null : null;
        if (!hit) {
          w.compression = 0; w.load = 0; w.slipRatio = 0; w.slipAngle = 0; w.surfaceNormal = null;
          w.longitudinalVelocity = 0; w.lateralVelocity = 0; w.handbrakeGripScale = 1; w.frictionCapacity = 0;
          w.longitudinalForceDemand = 0; w.rawLongitudinalForce = 0; w.rawLateralForce = 0; w.appliedLongitudinalForce = 0; w.appliedLateralForce = 0;
          w.driveTorque = 0; w.availableBrakeTorque = 0; w.brakeLockActive = false; w.brakeLockRequiredTorque = 0; w.brakeLockForce = 0;
          continue;
        }
        const hitPoint = new RAPIER.Ray(anchor, down).pointAt(hit.timeOfImpact);
        w.point = vecCopy(hitPoint);
        w.compression = clamp(config.wheelRadiusM + config.suspension.restLengthM - hit.timeOfImpact, 0, config.suspension.travelM);
        const pointVelocity = vecCopy(body.velocityAtPoint(hitPoint));
        const surfaceNormal = norm(vecCopy(hit.normal));
        w.surfaceNormal = { ...surfaceNormal };
        const suspensionSpeed = -dot(pointVelocity, surfaceNormal);
        const load = clamp((w.compression * config.suspension.springNPerM * tune.springScale + suspensionSpeed * config.suspension.damperNsPerM), 0, config.suspension.maxForceN);
        w.load = load;
        const gripLoad = load + (config.aero ? aeroDownforceN(config, forwardSpeed) * (w.front ? config.aero.frontShare : 1 - config.aero.frontShare) * 0.5 : 0);
        const suspensionImpulse = mul(surfaceNormal, load * DT);
        body.applyImpulseAtPoint(suspensionImpulse, hitPoint, true);
        totalSuspensionImpulse = add(totalSuspensionImpulse, suspensionImpulse);

        w.point = add(hitPoint, mul(surfaceNormal, config.wheelRadiusM));
        w.contactPoint = hitPoint;
        const steerQ = yawQuat(-w.steer);
        const wheelRotation = qmul(rotation, steerQ);
        const wheelForward = norm(rotate(wheelRotation, V(0, 0, -1)));
        const wheelRight = norm(rotate(wheelRotation, V(1, 0, 0)));
        const relative = vecCopy(body.velocityAtPoint(hitPoint));
        const longV = dot(relative, wheelForward), lateralV = dot(relative, wheelRight);
        w.longitudinalVelocity = longV; w.lateralVelocity = lateralV;
        const regularizer = config.tires.lowSpeedRegularizationMS;
        const slipAngle = Math.atan2(lateralV, Math.max(regularizer, Math.abs(longV))) * (longV < -0.1 ? -1 : 1);
        const wheelSurface = w.omega * config.wheelRadiusM;
        const slipRatio = (wheelSurface - longV) / Math.max(regularizer, Math.abs(longV), Math.abs(wheelSurface));
        w.slipAngle = slipAngle; w.slipRatio = slipRatio;
        const record = records.get(hit.collider.handle);
        const surfaceGrip = record?.category === 'ground' ? clamp(hit.collider.friction(), 0.15, 1.5) : 1;
        const handbrakeGripScale = handbrake > 0 && !w.front ? 1 - handbrake * (1 - tune.handbrakeRearMuScale) : 1;
        const muBase = (w.front ? config.tires.frontMu * tune.frontMuScale : config.tires.rearMu * tune.rearMuScale) * surfaceGrip * handbrakeGripScale;
        w.handbrakeGripScale = handbrakeGripScale;
        const normalizedSlip = Math.abs(slipAngle) / Math.max(0.02, config.tires.peakSlipAngleRad);
        const lateralCurve = normalizedSlip <= 1
          ? normalizedSlip * (2 - normalizedSlip)
          : config.tires.postPeakGripFactor + (1 - config.tires.postPeakGripFactor) * Math.exp(-2 * (normalizedSlip - 1));
        const lateralForceRaw = -Math.sign(lateralV || slipAngle) * muBase * gripLoad * lateralCurve;
        // Optional AWD split (config.drivetrain); rear-drive cars keep frontDriveShare 0 and behave exactly as before.
        const frontDriveShare = config.drivetrain?.frontDriveShare ?? 0;
        const driveTorque = w.front ? driveTorquePerWheel * frontDriveShare
          : (i === 2 ? driveTorquePerWheel - signedTransfer : driveTorquePerWheel + signedTransfer) * (1 - frontDriveShare);
        const totalBrakeTorque = brake * (driveDir < 0 ? 1000 : 1450) * 2;
        const brakeTorque = (w.front ? totalBrakeTorque * (tune.frontBrakeBias ?? 0.62) : totalBrakeTorque * (1 - (tune.frontBrakeBias ?? 0.62))) + handbrake * (!w.front ? 1550 : 0)
          // Assist slowing for understeer is rear-biased so it does not take lateral grip from the steering wheels.
          + (assist && assistBrake > 0 ? assistBrake * 2900 * (w.front ? 0.45 : 0.55) : 0);
        const wheelInertia = 1.25;
        const omegaBeforeTorque = w.omega;
        const drivenOmega = w.omega + driveTorque / wheelInertia * DT;
        const brakingDelta = brakeTorque / wheelInertia * DT;
        w.driveTorque = driveTorque;
        w.availableBrakeTorque = brakeTorque;
        w.brakeLockActive = false;
        w.brakeLockRequiredTorque = 0;
        w.brakeLockForce = 0;
        // Integrate the linear tire-force response over this fixed step while
        // wheel spin relaxes against the contact. Explicit Euler overshoots when
        // K * r^2 * dt / I approaches 2 (1.99-2.39 on these rear axles). The exact
        // exponential step average removes that sign-alternation without using
        // a backward-Euler endpoint force that attenuates braking and drive.
        const longitudinalStiffness = w.front ? 1250 : 1550;
        const wheelSpinFactor = longitudinalStiffness * config.wheelRadiusM * config.wheelRadiusM * DT / wheelInertia;
        const relaxationAverage = wheelSpinFactor > 1e-6 ? -Math.expm1(-wheelSpinFactor) / wheelSpinFactor : 1;
        const approachSign = Math.sign(omegaBeforeTorque || driveTorque || longV);
        const netWheelTorque = driveTorque - approachSign * brakeTorque;
        const initialSlipSpeed = omegaBeforeTorque * config.wheelRadiusM - longV;
        let longitudinalForce = longitudinalStiffness * initialSlipSpeed * relaxationAverage
          + (netWheelTorque / config.wheelRadiusM) * (1 - relaxationAverage);
        const cap = muBase * gripLoad;
        // Combined-slip allocation (physics v6). The TOTAL tire force keeps the
        // friction-ellipse magnitude min(|(Fx, Fy_raw)|, cap), but its DIRECTION follows
        // the contact-patch slip velocity (wheel surface speed minus ground speed,
        // lateral speed) instead of the saturated lateral curve. The saturated lateral
        // curve is capped at mu*Fz while the longitudinal demand is unbounded, so the
        // old proportional scaling starved a spinning rear axle of ALL lateral grip
        // (a burnout could never hold or catch a slide). With slip-velocity direction a
        // spinning tyre still pushes sideways in proportion to how fast it slides
        // sideways, so throttle modulates the slide angle and lifting regains grip.
        const lateralSign = lateralForceRaw !== 0 ? Math.sign(lateralForceRaw) : -Math.sign(lateralV);
        const lateralDirectionDemand = lateralSign * Math.max(Math.abs(lateralForceRaw), longitudinalStiffness * Math.abs(lateralV));
        const fitCombinedEllipse = (longitudinal: number): Readonly<{ longitudinal: number; lateral: number }> => {
          const magnitude = Math.min(Math.hypot(longitudinal, lateralForceRaw), cap);
          const direction = Math.hypot(longitudinal, lateralDirectionDemand);
          if (magnitude <= 0 || direction < 1e-9) return { longitudinal: 0, lateral: 0 };
          return { longitudinal: magnitude * longitudinal / direction, lateral: magnitude * lateralDirectionDemand / direction };
        };
        const freeForce = fitCombinedEllipse(longitudinalForce);
        const lockedForceDemand = -longV * longitudinalStiffness;
        const lockedRawForce = clamp(lockedForceDemand, -cap, cap);
        const lockedForce = fitCombinedEllipse(lockedForceDemand);
        const requiredBrakeTorque = wheelInertia * omegaBeforeTorque / DT + driveTorque - config.wheelRadiusM * lockedForce.longitudinal;
        const brakingCanHoldLock = brakeTorque > 0 && Math.abs(drivenOmega) <= brakingDelta + 1e-9
          && approachSign !== 0 && Math.sign(requiredBrakeTorque) === approachSign
          && Math.abs(requiredBrakeTorque) <= brakeTorque + 1e-6;
        w.brakeLockActive = brakingCanHoldLock;
        w.brakeLockRequiredTorque = requiredBrakeTorque;
        w.brakeLockForce = lockedForce.longitudinal;
        if (brakingCanHoldLock) {
          // Static brake support balances the contact reaction while the wheel
          // remains at zero spin. Its required signed torque is bounded above.
          w.omega = 0;
          w.longitudinalForceDemand = lockedForceDemand;
          longitudinalForce = lockedForce.longitudinal;
        } else {
          w.longitudinalForceDemand = longitudinalForce;
          longitudinalForce = freeForce.longitudinal;
        }
        w.rawLongitudinalForce = brakingCanHoldLock ? lockedRawForce : clamp(longitudinalForce, -cap, cap);
        w.rawLateralForce = lateralForceRaw;
        const lateralForce = brakingCanHoldLock ? lockedForce.lateral : freeForce.lateral;
        w.frictionCapacity = cap;
        w.appliedLongitudinalForce = longitudinalForce;
        w.appliedLateralForce = lateralForce;
        const force = add(mul(wheelForward, longitudinalForce), mul(wheelRight, lateralForce));
        body.applyImpulseAtPoint(mul(force, DT), hitPoint, true);
        if (!brakingCanHoldLock) {
          const integratedOmega = omegaBeforeTorque + (netWheelTorque - longitudinalForce * config.wheelRadiusM) * DT / wheelInertia;
          const signWouldReverse = brakeTorque > 0 && approachSign !== 0 && integratedOmega * approachSign < 0;
          w.omega = clamp(signWouldReverse ? 0 : integratedOmega, -wheelOmegaLimit(config), wheelOmegaLimit(config));
        }
      }
      if (assist && wheels.filter((w) => w.contact).length >= 3 && slideForward > 3) {
        // Bounded chassis yaw torque, scaled by this car's yaw inertia. Outside a deliberate drift it pulls the nose
        // back toward the velocity vector past a small slip and damps slip growth (spin-out guard). In a drift it
        // holds the angle the driver chose: steering into the slide with throttle widens it, countersteer narrows it.
        const izz = inertiaFor(config).y;
        const slipRate = (bodySlip - prevBodySlip) / DT;
        const sign = Math.sign(bodySlip), absSlip = Math.abs(bodySlip);
        let restoreErr: number, restoreGain: number, dampGain: number;
        if (driftMode) {
          const intoSlide = -steering * sign; // > 0 when steering into the turn (adds angle)
          // The driver chooses the angle: steering into the slide on throttle widens it, countersteer or lifting
          // narrows it (and lets the car straighten out), so the hold never traps a player who wants out.
          if (driftIntentS <= 0) driftTarget += (throttleInput < 0.4 ? -1 : intoSlide > 0.3 && throttleInput > 0.5 ? 0.35 : intoSlide < -0.3 ? -0.6 : 0) * DT;
          else driftTarget = Math.max(driftTarget, absSlip);
          driftTarget = clamp(driftTarget, 0.2, assist.driftMaxRad);
          const err = absSlip - driftTarget;
          // High-grip cars regrip much harder, so the hold below the target scales with their grip (1 for normal cars).
          restoreErr = err > 0 ? err : throttleInput > 0.5 && intoSlide > -0.3 ? err * assist.driftHoldLow * gripScale ** 2 : 0;
          restoreGain = assist.driftHoldRestore; dampGain = err > 0 ? assist.driftHoldDamping : 0;
        } else {
          // While the driver is initiating (handbrake or flick) the guard steps back so the slide can build.
          restoreErr = Math.max(0, absSlip - assist.stabilitySlipRad);
          restoreGain = initiating ? 0 : assist.stabilityRestore;
          const spinning = absSlip > assist.spinGateRad && Math.abs(slipRate) > assist.spinRateRadS && slipRate * sign > 0;
          dampGain = !initiating && (absSlip > assist.stabilitySlipRad * 0.8 || spinning) ? assist.stabilityDamping : 0;
          // Exit help: countersteering with the throttle lifted means the driver wants out, so help straighten.
          if (assist.exitRestore > 0 && steering * bodySlip > 0 && throttleInput < 0.35 && absSlip > 0.3
            && assist.exitRestore * (absSlip - 0.3) > restoreGain * restoreErr) { restoreErr = absSlip - 0.3; restoreGain = assist.exitRestore; }
        }
        const growing = slipRate * sign > 0 ? slipRate : 0;
        const speedGate = clamp((slideForward - 3) / 5, 0, 1);
        const torque = clamp(-izz * (restoreGain * restoreErr * sign + dampGain * growing) * speedGate, -izz * 12, izz * 12);
        assistYawTorque = torque;
        body.applyTorqueImpulse(mul(rotate(rotation, V(0, 1, 0)), torque * DT), true);
      }
      if (assistLevel !== 'off') prevBodySlip = bodySlip;
      assistStatus = { level: assistLevel, driftMode, driftTargetRad: driftTarget, throttleScale: assistThrottle, brakeAdded: assistBrake, yawTorqueNm: assistYawTorque, steerLimitRad: steerLimit };
      // Rolling resistance and aerodynamic drag act on chassis velocity; force is capped to avoid reversing it in one tick.
      const planarVelocity = V(velocity.x, 0, velocity.z);
      const planarSpeed = len(planarVelocity);
      if (planarSpeed > 1e-4) {
        const dragN = 0.014 * config.massKg * 9.81 + 0.5 * 1.225 * (config.aero?.dragAreaM2 ?? 0.72) * planarSpeed * planarSpeed;
        const dragDeltaV = Math.min(planarSpeed, dragN * DT / config.massKg);
        body.applyImpulse(mul(planarVelocity, -config.massKg * dragDeltaV / planarSpeed), true);
      }
      if (gear > 0 && autoShiftCooldown === 0) {
        const sensedRpm = Math.max(config.engine.idleRpm, ((Math.abs(wheels[2].omega) + Math.abs(wheels[3].omega)) * 0.5) * ratio * 60 / (2 * Math.PI));
        // Ground-speed rpm keeps a wheelspinning launch from hunting through the gearbox: upshift only when the
        // wheels are near redline AND the chassis speed supports the next gear.
        const groundRpm = Math.max(0, -dot(velocity, rotate(rotation, V(0, 0, 1)))) / config.wheelRadiusM * ratio * 60 / (2 * Math.PI);
        if (sensedRpm > config.engine.redlineRpm * 0.91 && groundRpm > config.engine.redlineRpm * 0.42 && gear < config.engine.gearRatios.length) { gear++; autoShiftCooldown = 0.32; }
        else if (sensedRpm < 1750 && gear > 1 && speed < 15) { gear--; autoShiftCooldown = 0.32; }
      }
      for (const w of wheels) w.rollAngle += w.omega * DT;
      // Read after force impulses are applied but before Rapier's contact solver.
      // This lets us distinguish an obstacle collision from traction, suspension,
      // and gravity when a backend collider has no accumulated manifold impulse.
      const preContactVelocity = vecCopy(body.linvel());
      const preContactAngular = vecCopy(body.angvel());
      world.timestep = DT;
      world.step();
      const postContactVelocity = vecCopy(body.linvel());
      let obstacleContact = false;
      let wallNormal = V();
      let impactImpulse = 0;
      const impactIds: string[] = [];
      const estimatedPairImpulses: number[] = [];
      world.contactPairsWith(bodyCollider, (other) => {
        const rec = records.get(other.handle);
        if (rec && rec.category !== 'ground') {
          let manifoldImpulse = 0;
          let normalVelocityLoss = 0;
          let hasSolverContact = false;
          world.contactPair(bodyCollider, other, (manifold) => {
            hasSolverContact ||= manifold.numContacts() > 0 || manifold.numSolverContacts() > 0;
            for (let i = 0; i < manifold.numContacts(); i++) manifoldImpulse += Math.abs(manifold.contactImpulse(i));
            const normal = norm(vecCopy(manifold.normal()));
            if (manifold.numContacts() > 0) {
              // Accumulate the wall direction, oriented to face the car (against its pre-contact motion).
              const flat = V(normal.x, 0, normal.z);
              wallNormal = add(wallNormal, dot(flat, preContactVelocity) > 0 ? mul(flat, -1) : flat);
            }
            const before = Math.abs(dot(preContactVelocity, normal));
            const after = Math.abs(dot(postContactVelocity, normal));
            normalVelocityLoss = Math.max(normalVelocityLoss, before - after);
          });
          if (hasSolverContact) { impactIds.push(rec.id); obstacleContact = true; }
          // Some Rapier triangle-mesh manifolds report contact but no per-point
          // impulse. Estimate the solver impulse from normal velocity loss only
          // while an obstacle contact exists; ground contacts are excluded above.
          if (manifoldImpulse > 0) impactImpulse += manifoldImpulse;
          else if (hasSolverContact) estimatedPairImpulses.push(Math.max(0, normalVelocityLoss) * config.massKg);
        }
      });
      // Several coplanar colliders can share one global body velocity change.
      // Count that fallback only once; direct solver impulses remain additive.
      impactImpulse = Math.max(impactImpulse, ...estimatedPairImpulses);
      if (obstacleContact) {
        // Keep only part of the spin a wall contact adds, so a scrape deflects the car instead of spinning it.
        const after = vecCopy(body.angvel());
        body.setAngvel(add(preContactAngular, mul(add(after, mul(preContactAngular, -1)), WALL_SPIN_KEEP)), true);
        // Walls act as frictionless, non-bouncy planes for the car's planar speed: the solver may remove the speed
        // going INTO the wall (a head-on hit still stops you), but tangential speed it bled off on a glancing hit is
        // handed back, less a small scrape loss. This only ever restores speed, never adds any or points into the wall.
        if (len(wallNormal) > 1e-6) {
          const n = norm(wallNormal);
          const preFlat = V(preContactVelocity.x, 0, preContactVelocity.z);
          const into = Math.min(0, dot(preFlat, n));
          const kept = mul(add(preFlat, mul(n, -into)), 1 - WALL_SCRAPE_LOSS);
          const now = vecCopy(body.linvel());
          if (len(kept) > Math.hypot(now.x, now.z)) body.setLinvel(V(kept.x, now.y, kept.z), true);
        }
      }
      const speedDelta = impactImpulse / config.massKg;
      collision = { tick, impact: speedDelta > 0.05, impulseNs: impactImpulse, speedDeltaMS: speedDelta, colliderIds: [...new Set(impactIds)] };
      current = makeSnapshot();
    },
    snapshot: () => makeSnapshot(),
    snapshots: () => ({ previous, current, interpolationAlpha: 0 }),
    resetToSafePoint: () => reset(),
    recoverTo: (position, rotation) => reset({ ...position }, { ...rotation }),
    dispose: () => world.free(),
    wheelDynamicsTelemetry: () => ({
      simulationTick: tick,
      wheels: wheels.map((w): WheelDynamicsTelemetry => ({
        contact: w.contact, surfaceId: w.surfaceId, contactPoint: w.contact ? { ...w.contactPoint } : null,
        surfaceNormal: w.surfaceNormal ? { ...w.surfaceNormal } : null, normalLoadN: w.load,
        longitudinalVelocityMS: w.longitudinalVelocity, lateralVelocityMS: w.lateralVelocity,
        angularVelocityRadS: w.omega, slipRatio: w.slipRatio, slipAngleRad: w.slipAngle,
        handbrakeGripScale: w.handbrakeGripScale, frictionCapacityN: w.frictionCapacity,
        longitudinalForceDemandN: w.longitudinalForceDemand,
        rawLongitudinalForceN: w.rawLongitudinalForce, rawLateralForceN: w.rawLateralForce,
        appliedLongitudinalForceN: w.appliedLongitudinalForce, appliedLateralForceN: w.appliedLateralForce,
        driveTorqueNm: w.driveTorque, availableBrakeTorqueNm: w.availableBrakeTorque, brakeLockActive: w.brakeLockActive,
        brakeLockRequiredTorqueNm: w.brakeLockRequiredTorque, brakeLockForceN: w.brakeLockForce,
      })) as unknown as VehicleDynamicsTelemetry['wheels'],
    }),
    setCar(id) {
      config = VEHICLE_CONFIGS[id];
      if (tune.id === 'Grip' || tune.id === 'Balanced' || tune.id === 'Drift') tune = validateVehicleTune(VEHICLE_TUNES[id][tune.id]);
      body.setAdditionalMassProperties(config.massKg * 0.96, config.centerOfMassM, inertiaFor(config), { x: 0, y: 0, z: 0, w: 1 }, true);
      bodyCollider.setShape(new RAPIER.Cuboid(0.88, 0.31, config.wheelbaseM * 0.37));
      const x = config.trackM * 0.5;
      wheels[0].local = V(-x, wheelY, -config.wheelbaseM * 0.5);
      wheels[1].local = V(x, wheelY, -config.wheelbaseM * 0.5);
      wheels[2].local = V(-x, wheelY, config.wheelbaseM * 0.5);
      wheels[3].local = V(x, wheelY, config.wheelbaseM * 0.5);
      reset(defaultSpawn.position, defaultSpawn.rotation);
    },
    setTune(value) {
      if (typeof value === 'string') {
        if (!isTunePresetId(value)) throw new RangeError(`Unknown tune preset: ${value}`);
        tune = validateVehicleTune(VEHICLE_TUNES[config.carId][value]);
      } else tune = validateVehicleTune(value);
    },
    setSpawn(position, rotation = yawQuat(0)) {
      spawnPosition = { ...position }; spawnRotation = { ...rotation };
      defaultSpawn.position = { ...position }; defaultSpawn.rotation = { ...rotation };
      reset(spawnPosition, spawnRotation);
    },
    addColliderBox: addBox,
    addStaticTriangleMesh(vertices, indices, surfaceId = `mesh-${generatedId++}`, friction = 0.9, role = 'surface') {
      if (vertices.length < 3 || indices.length < 3 || indices.length % 3 !== 0) throw new Error('Triangle mesh requires vertices and complete triangle indices');
      if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= vertices.length)) throw new Error('Triangle mesh index is out of range');
      const flat = new Float32Array(vertices.flatMap((v) => [v.x, v.y, v.z]));
      const idx = new Uint32Array(indices);
      const desc = RAPIER.ColliderDesc.trimesh(flat, idx).setFriction(friction);
      if (role === 'obstacle') wallMaterial(desc);
      const collider = world.createCollider(desc);
      records.set(collider.handle, { collider, id: surfaceId, surfaceId, category: role === 'obstacle' ? 'prop' : 'ground' });
      return { handle: collider.handle };
    },
    removeCollider(handle) {
      const rec = records.get(handle.handle);
      if (rec) { world.removeCollider(rec.collider, true); records.delete(handle.handle); }
    },
    getConfig: () => config,
    getTuning: () => Object.freeze({ ...tune }),
    getTuneIdentity: () => createVehicleTuneIdentity(config, tune),
    collisionTelemetry: () => collision,
    setAssist(level) {
      if (!isAssistLevel(level) || level === assistLevel) return;
      assistLevel = level; driftMode = false; driftTarget = 0; driftIntentS = 0; tractionScale = 1; steerHistory.length = 0;
      prevBodySlip = 0;
    },
    getAssist: () => assistLevel,
    assistTelemetry: () => assistStatus,
  };
  return api;
}
