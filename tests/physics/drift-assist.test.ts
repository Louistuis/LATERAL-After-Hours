import { afterEach, describe, expect, it } from 'vitest';
import type { CarId, InputFrame } from '../../contracts/runtime-contracts.js';
import {
  ASSIST_LABELS, ASSIST_SETTINGS_VERSION, DEFAULT_PLAYER_ASSIST, createVehicleSimulation, migrateAssistLevel,
  type AssistLevel, type TunePresetId, type VehicleSimulationHandle,
} from '../../src/physics/index.js';

// The Drift level ('medium') is the default: it must feel like the raw car (Off) and only catch real spins.
const open: { dispose(): void }[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });
const GROUND = { halfExtentsM: { x: 2000, y: 0.25, z: 2000 } };
const speedOf = (s: ReturnType<VehicleSimulationHandle['snapshot']>) => Math.hypot(s.linearVelocityMS.x, s.linearVelocityMS.z);

async function sim(carId: CarId, tune: TunePresetId, assist: AssistLevel, speedMS: number) {
  const s = await createVehicleSimulation({ carId, tune, assist, ground: GROUND, spawn: { position: { x: 0, y: 0.78, z: 1500 }, linearVelocityMS: { x: 0, y: 0, z: -speedMS } } } as never);
  open.push(s);
  let tick = 0;
  const step = (p: Partial<InputFrame>) => s.step({ simulationTick: ++tick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false, ...p });
  return { s, step };
}

/** Step steer at constant throttle: time to 90% of the settled yaw rate, and that yaw rate. */
async function response(carId: CarId, assist: AssistLevel, kmh: number, steer: number) {
  const { s, step } = await sim(carId, 'Balanced', assist, kmh / 3.6);
  for (let i = 0; i < 40; i++) step({ throttle: 0.35 });
  const yaws: number[] = [];
  for (let i = 0; i < 90; i++) { step({ throttle: 0.35, steering: steer }); yaws.push(Math.abs(s.snapshot().angularVelocityRadS.y)); }
  const yaw = yaws.slice(60).reduce((a, b) => a + b, 0) / 30;
  return { t90: (yaws.findIndex((y) => y >= 0.9 * yaw) + 1) / 60, yaw };
}

/**
 * Scripted skilled driver: a flick into a power slide, then countersteer and throttle modulated on the drift angle
 * (handbrake tap only when far under the target), with switchbacks between holds. Countersteer is the opposite
 * sign to driftAngleRad in this simulation.
 */
async function drift(carId: CarId, tune: TunePresetId, assist: AssistLevel, targetDeg: number, holds: number, holdS: number) {
  const T = targetDeg * Math.PI / 180;
  const { s, step } = await sim(carId, tune, assist, 19);
  let prev = 0, spins = 0, spinning = false, over40 = 0;
  const angles: number[] = [], switches: number[] = [];
  const watch = () => {
    const n = s.snapshot(), ab = Math.abs(n.driftAngleRad), spun = ab > 1.75 && speedOf(n) > 3;
    if (spun && !spinning) spins++;
    spinning = spun ? true : ab < 0.6 ? false : spinning;
    return n.driftAngleRad;
  };
  for (let i = 0; i < 20; i++) step({ throttle: 0.4 });
  for (let i = 0; i < 8; i++) { step({ throttle: 0.3, steering: 0.7 }); watch(); }
  for (let i = 0; i < 72; i++) { step({ throttle: 1, steering: -1 }); if (Math.abs(watch()) > 0.44) break; }
  let dir = Math.sign(s.snapshot().driftAngleRad) || -1;
  for (let h = 0; h < holds; h++) {
    for (let i = 0; i < holdS * 60; i++) {
      const b = s.snapshot().driftAngleRad, rate = (b - prev) * 60; prev = b;
      const ab = b * dir, e = ab - T + 0.12 * rate * dir;
      step({ throttle: Math.max(0, Math.min(1, 0.72 - 2.2 * e)), steering: -dir * Math.max(-1, Math.min(1, 0.95 * Math.max(ab, 0) + 1.6 * e)), handbrake: e < -0.25 && rate * dir < 0.3 ? 1 : 0 });
      const now = watch() * dir; angles.push(now * 180 / Math.PI); if (now > 40 * Math.PI / 180) over40++;
    }
    if (h === holds - 1) break;
    let t = 0; dir = -dir;
    for (; t < 120; t++) { prev = s.snapshot().driftAngleRad; step(t < 12 ? { throttle: 0.25, steering: -dir } : { throttle: 1, steering: dir }); if (watch() * dir > 0.52) break; }
    switches.push((t + 1) / 60);
  }
  return { meanDeg: angles.reduce((a, b) => a + b, 0) / angles.length, over40S: over40 / 60, switches, spins };
}

describe('Drift assist level (the default)', () => {
  it('is the default for new players and is shown as Drift, with High shown as Beginner', () => {
    expect(DEFAULT_PLAYER_ASSIST).toBe('medium');
    expect(ASSIST_LABELS).toEqual({ medium: 'Drift', high: 'Beginner', off: 'Off' });
  });

  it('migrates old saves once: the old default High moves to Drift, explicit choices stay', () => {
    expect(migrateAssistLevel(undefined, undefined)).toBe('medium');
    expect(migrateAssistLevel('high', undefined)).toBe('medium');
    expect(migrateAssistLevel('medium', undefined)).toBe('medium');
    expect(migrateAssistLevel('off', undefined)).toBe('off');
    expect(migrateAssistLevel('high', ASSIST_SETTINGS_VERSION)).toBe('high');
    expect(migrateAssistLevel('off', ASSIST_SETTINGS_VERSION)).toBe('off');
    expect(migrateAssistLevel('turbo', ASSIST_SETTINGS_VERSION)).toBe('medium');
  });

  it.each([['CAR-01', 60], ['CAR-01', 120], ['CAR-02', 60], ['CAR-02', 120]] as const)('%s steers like Off at %i km/h (no extra lag, no numb limiter)', async (car, kmh) => {
    for (const steer of [0.08, 0.2]) {
      const off = await response(car, 'off', kmh, steer);
      const drift = await response(car, 'medium', kmh, steer);
      expect(Math.abs(drift.t90 - off.t90)).toBeLessThanOrEqual(off.t90 * 0.1 + 1e-9);
      expect(Math.abs(drift.yaw - off.yaw)).toBeLessThanOrEqual(off.yaw * 0.1);
    }
  }, 60_000);

  it('a skilled driver chains 40 degree drifts with switchbacks as quick as the raw car, without spinning', async () => {
    const off = await drift('CAR-01', 'Drift', 'off', 45, 4, 2.5);
    const assisted = await drift('CAR-01', 'Drift', 'medium', 45, 4, 2.5);
    expect(assisted.spins).toBe(0);
    expect(assisted.meanDeg).toBeGreaterThan(38);
    expect(assisted.over40S).toBeGreaterThan(3);
    expect(assisted.switches.every((t) => t < 2)).toBe(true);
    expect(Math.max(...assisted.switches)).toBeLessThanOrEqual(Math.max(...off.switches) + 0.3);
  }, 60_000);

  it('holds whatever angle the driver asks for up to about 50 degrees, small or large', async () => {
    const small = await drift('CAR-01', 'Drift', 'medium', 20, 1, 3);
    const large = await drift('CAR-01', 'Drift', 'medium', 50, 1, 3);
    expect(Math.abs(small.meanDeg - 20)).toBeLessThan(5);
    expect(large.meanDeg).toBeGreaterThan(45);
  }, 60_000);
});
