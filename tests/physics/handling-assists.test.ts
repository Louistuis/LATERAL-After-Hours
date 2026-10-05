import { afterEach, describe, expect, it } from 'vitest';
import type { CarId, InputFrame, Vec3 } from '../../contracts/runtime-contracts.js';
import { buildHarborApronCollision, buildHarborCurbCollisions, buildHarborGuardrailCollisions, buildHarborRoute } from '../../src/world/route-data.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { createVehicleSimulation, type AssistLevel, type TunePresetId, type VehicleSimulationHandle } from '../../src/physics/index.js';
import { createRawReferenceSimulation } from './fixtures/raw-v6-reference.js';

const open: { dispose(): void }[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const frame = (tick: number, patch: Partial<InputFrame> = {}): InputFrame =>
  ({ simulationTick: tick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false, ...patch });

/** The game's HW-01 collision set: road, apron, curbs (with run-off shoulder) and guardrails. */
function addHarbor(sim: VehicleSimulationHandle): void {
  const { collision } = buildHarborRoute();
  sim.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId, 0.9);
  const apron = buildHarborApronCollision();
  sim.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId, 0.9);
  for (const curb of buildHarborCurbCollisions()) sim.addStaticTriangleMesh(curb.vertices, curb.indices, curb.surfaceId, 0.9);
  for (const rail of buildHarborGuardrailCollisions()) sim.addStaticTriangleMesh(rail.vertices, rail.indices, rail.surfaceId, 0.9, 'obstacle');
}

/**
 * Newcomer trace: throttle pinned, keyboard steering (full lock or nothing, held at least 0.1 s once pressed),
 * aiming at a short look-ahead point on the centreline. No braking, no handbrake.
 */
async function newcomerLap(assist: AssistLevel, carId: CarId, tune: TunePresetId) {
  const { route } = buildHarborRoute();
  const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId, tune, assist });
  open.push(sim); addHarbor(sim);
  const tracker = new RouteProgressTracker(route.centerline, route.widthM);
  const d = [0];
  for (let i = 1; i < route.centerline.length; i++) { const a = route.centerline[i - 1]!, b = route.centerline[i]!; d.push(d.at(-1)! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)); }
  const pointAt = (dist: number): Vec3 => {
    const x = Math.min(d.at(-1)!, dist); let i = 1;
    while (i < d.length - 1 && d[i]! < x) i++;
    const a = route.centerline[i - 1]!, b = route.centerline[i]!, t = (x - d[i - 1]!) / (d[i]! - d[i - 1]!);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  let progress = tracker.update(sim.snapshot().position);
  let spins = 0, spinning = false, held = 0, steer = 0, ticks = 0;
  for (let tick = 1; tick <= 4800; tick++) {
    ticks = tick;
    const s = sim.snapshot();
    const speed = Math.hypot(s.linearVelocityMS.x, s.linearVelocityMS.z);
    const target = pointAt(progress.progressM + Math.max(6, speed * 0.5));
    const q = s.rotation;
    const heading = Math.atan2(-2 * (q.x * q.z + q.w * q.y), (1 - 2 * (q.x * q.x + q.y * q.y)));
    const err = wrap(Math.atan2(target.x - s.position.x, -(target.z - s.position.z)) - heading);
    if (held > 0) held--;
    else { steer = Math.abs(err) > 0.07 ? Math.sign(err) : 0; if (steer !== 0) held = 6; }
    sim.step(frame(tick, { throttle: 1, steering: steer }));
    const n = sim.snapshot();
    progress = tracker.update(n.position);
    const v = Math.hypot(n.linearVelocityMS.x, n.linearVelocityMS.z), slip = Math.abs(n.driftAngleRad);
    const spunNow = v > 3 && slip > 1.3; // more than ~75 degrees off the direction of travel
    if (spunNow && !spinning) spins++;
    spinning = spunNow ? true : slip < 0.5 ? false : spinning;
    if (progress.progressM / route.lengthM > 0.985) return { done: true, spins, seconds: ticks / 60 };
  }
  return { done: false, spins, seconds: ticks / 60 };
}

/** CAR-01 coasting into the HW-01 right guardrail at a given angle (degrees) and speed. */
async function wallStrike(angleDeg: number, speedMS: number) {
  const { route } = buildHarborRoute();
  let distance = 0, center: Vec3 = route.centerline[0]!, forward = { x: 0, z: -1 };
  for (let i = 1; i < route.centerline.length; i++) {
    const a = route.centerline[i - 1]!, b = route.centerline[i]!, seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (distance + seg >= 60) {
      const f = (60 - distance) / seg, h = Math.hypot(b.x - a.x, b.z - a.z);
      center = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      forward = { x: (b.x - a.x) / h, z: (b.z - a.z) / h };
      break;
    }
    distance += seg;
  }
  const right = { x: -forward.z, z: forward.x }, angle = angleDeg * Math.PI / 180;
  const dir = { x: forward.x * Math.cos(angle) + right.x * Math.sin(angle), z: forward.z * Math.cos(angle) + right.z * Math.sin(angle) };
  const yaw = Math.atan2(-dir.x, -dir.z);
  const sim = await createVehicleSimulation({ ground: false, carId: 'CAR-01', tune: 'Balanced', spawn: {
    position: { x: center.x + right.x * 5.4, y: center.y + 0.93, z: center.z + right.z * 5.4 },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    linearVelocityMS: { x: dir.x * speedMS, y: 0, z: dir.z * speedMS } } });
  open.push(sim); addHarbor(sim);
  const speed = () => { const v = sim.snapshot().linearVelocityMS; return Math.hypot(v.x, v.z); };
  let first = -1, before = 0, maxYaw = 0;
  for (let tick = 1; tick <= 240; tick++) {
    const s0 = speed();
    sim.step(frame(tick));
    if (first < 0 && sim.collisionTelemetry().colliderIds.includes('barrier:harbor:hw01:right')) { first = tick; before = s0; }
    if (first > 0) maxYaw = Math.max(maxYaw, Math.abs(sim.snapshot().angularVelocityRadS.y));
    if (first > 0 && tick === first + 30) return { hit: true, before, keptRatio: speed() / before, maxYaw };
  }
  return { hit: first > 0, before, keptRatio: 0, maxYaw };
}

describe('driving assists', () => {
  it('Beginner (high) carries a full-throttle keyboard newcomer round HW-01 with no spin-out, while Off spins', async () => {
    const high = await newcomerLap('high', 'CAR-02', 'Balanced');
    const off = await newcomerLap('off', 'CAR-02', 'Balanced');
    expect(high).toMatchObject({ done: true, spins: 0 });
    expect(high.seconds).toBeLessThan(75);
    expect(off.spins).toBeGreaterThan(0);
    expect(off.done).toBe(false);
  }, 60_000);

  it.each(['Balanced', 'Grip', 'Drift'] as const)('Beginner (high) newcomer completes HW-01 in CAR-01 on %s without spinning', async tune => {
    expect(await newcomerLap('high', 'CAR-01', tune)).toMatchObject({ done: true, spins: 0 });
  }, 60_000);

  it.each(['Balanced', 'Grip', 'Drift'] as const)('Beginner (high) keeps the McLaren planted for a full-throttle newcomer on %s', async tune => {
    expect(await newcomerLap('high', 'CAR-04', tune)).toMatchObject({ done: true, spins: 0 });
  }, 60_000);

  // CAR-02 on Grip plows into the barrier at ~50 degrees twice (Drift has no understeer slowing by design) and the
  // impact itself counts as a spin-out here, so it gets one extra; it still completes the lap.
  it.each([['CAR-01', 'Balanced', 1], ['CAR-01', 'Grip', 1], ['CAR-01', 'Drift', 1], ['CAR-02', 'Balanced', 1], ['CAR-02', 'Grip', 2], ['CAR-02', 'Drift', 1]] as const)(
    'Drift (the default) newcomer completes HW-01 in %s on %s with at most %i spin-out', async (car, tune, maxSpins) => {
      const lap = await newcomerLap('medium', car, tune);
      expect(lap.done).toBe(true);
      expect(lap.spins).toBeLessThanOrEqual(maxSpins);
    }, 60_000);

  it('Off reproduces the pre-assist raw simulation bit for bit on obstacle-free traces', async () => {
    const traces: ReadonlyArray<{ car: CarId; tune: TunePresetId; input: (tick: number) => Partial<InputFrame> }> = [
      { car: 'CAR-01', tune: 'Balanced', input: t => ({ throttle: 1, steering: t > 120 ? Math.sin(t / 25) : 0 }) },
      { car: 'CAR-01', tune: 'Drift', input: t => ({ throttle: t < 300 ? 1 : 0.7, steering: t > 150 ? -1 : 0, handbrake: t > 150 && t < 180 ? 1 : 0 }) },
      { car: 'CAR-02', tune: 'Grip', input: t => ({ throttle: t < 200 ? 1 : 0, brake: t >= 200 && t < 260 ? 1 : 0, steering: t > 100 ? 0.6 : 0 }) },
      { car: 'CAR-02', tune: 'Balanced', input: t => ({ throttle: 0.9, steering: t % 90 < 45 ? 1 : -1 }) },
    ];
    for (const trace of traces) {
      const live = await createVehicleSimulation({ carId: trace.car, tune: trace.tune, assist: 'off' });
      const implicit = await createVehicleSimulation({ carId: trace.car, tune: trace.tune });
      const raw = await createRawReferenceSimulation({ carId: trace.car, tune: trace.tune });
      open.push(live, implicit, raw);
      for (let tick = 1; tick <= 480; tick++) {
        const input = frame(tick, trace.input(tick));
        live.step(input); implicit.step(input); raw.step(input);
      }
      expect(live.snapshot()).toEqual(raw.snapshot());
      expect(implicit.snapshot()).toEqual(raw.snapshot());
      expect(live.wheelDynamicsTelemetry()).toEqual(raw.wheelDynamicsTelemetry());
    }
  }, 60_000);

  it('a 15 degree wall glance deflects and keeps most of the speed; a head-on hit still stops the car', async () => {
    const glance = await wallStrike(15, 22);
    expect(glance.hit).toBe(true);
    expect(glance.keptRatio).toBeGreaterThan(0.7);
    expect(glance.maxYaw).toBeLessThan(2.5);
    const headOn = await wallStrike(80, 22);
    expect(headOn.hit).toBe(true);
    expect(headOn.keptRatio).toBeLessThan(0.3);
  }, 30_000);

  it('Beginner (high) still drifts on the handbrake and holds the angle without spinning', async () => {
    const sim = await createVehicleSimulation({ carId: 'CAR-01', tune: 'Drift', assist: 'high' });
    open.push(sim);
    let tick = 0;
    while (tick < 900 && Math.hypot(sim.snapshot().linearVelocityMS.x, sim.snapshot().linearVelocityMS.z) < 18) sim.step(frame(++tick, { throttle: 1 }));
    for (let i = 0; i < 30; i++) sim.step(frame(++tick, { throttle: 0.6, steering: -1, handbrake: i < 24 ? 1 : 0 }));
    let peak = 0, held = 0, spun = false;
    for (let i = 0; i < 180; i++) {
      sim.step(frame(++tick, { throttle: 0.8, steering: -0.6 }));
      const s = sim.snapshot(), slip = Math.abs(s.driftAngleRad);
      peak = Math.max(peak, slip); if (slip > 0.3) held++;
      if (slip > 1.3) spun = true;
    }
    expect(peak).toBeGreaterThan(20 * Math.PI / 180);
    expect(held / 60).toBeGreaterThan(1);
    expect(spun).toBe(false);
  }, 30_000);

  it('switches assist level live without moving the car', async () => {
    const sim = await createVehicleSimulation({ carId: 'CAR-01' });
    open.push(sim);
    expect(sim.getAssist()).toBe('off');
    for (let tick = 1; tick <= 60; tick++) sim.step(frame(tick, { throttle: 1 }));
    const before = sim.snapshot();
    sim.setAssist('high');
    expect(sim.getAssist()).toBe('high');
    expect(sim.snapshot()).toEqual(before);
    sim.step(frame(61, { throttle: 1 }));
    expect(sim.assistTelemetry().level).toBe('high');
  });
});
