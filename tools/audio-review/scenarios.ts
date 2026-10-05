import type { CarId } from '../../contracts/runtime-contracts';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';
import type { Scenario, Telemetry } from './render';

const CARS: CarId[] = ['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06'];
const FX = { engine: 0, music: 0 } as const;
const smooth = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));

/** Full-throttle launch through four gears, then a lift and coast: the most telling clip per car. */
function pull(car: CarId, liftAt = 6.6): (t: number) => Telemetry {
  const engine = VEHICLE_CONFIGS[car].engine;
  const top = engine.redlineRpm * 0.93;
  const plan: Array<{ gear: number; start: number; end: number; from: number }> = [];
  let time = 0.4, rpm = 2600;
  for (let gear = 1; gear <= 4; gear++) {
    const duration = 0.9 + gear * 0.38;
    plan.push({ gear, start: time, end: time + duration, from: rpm });
    rpm = top * engine.gearRatios[gear]! / engine.gearRatios[gear - 1]!;
    time += duration;
  }
  return t => {
    if (t < 0.4) return { rpm: engine.idleRpm, throttle: 0, speedMS: 0, gear: 1 };
    if (t >= liftAt) {
      const last = plan[plan.length - 1]!;
      const atLift = smooth(last.from, top, (liftAt - last.start) / (last.end - last.start));
      return { rpm: smooth(atLift, 1800, (t - liftAt) / 2.4), throttle: 0, speedMS: smooth(38, 30, (t - liftAt) / 3), gear: last.gear };
    }
    const step = plan.find(entry => t < entry.end) ?? plan[plan.length - 1]!;
    const k = (t - step.start) / (step.end - step.start);
    return { rpm: smooth(step.from, top, k), throttle: 1, speedMS: 4 + t * 5, gear: step.gear };
  };
}

function engineClips(car: CarId): Record<string, Scenario> {
  const engine = VEHICLE_CONFIGS[car].engine;
  const mid = engine.idleRpm + 0.45 * (engine.redlineRpm - engine.idleRpm);
  if (car === 'CAR-02') {
    return {
      [`${car}-idle`]: { car, seconds: 4, at: () => ({ rpm: engine.idleRpm, throttle: 0, speedMS: 0 }) },
      [`${car}-creep`]: { car, seconds: 4, at: t => ({ rpm: engine.idleRpm, throttle: 0.35, speedMS: Math.min(8, t * 2.5) }) },
      [`${car}-mid`]: { car, seconds: 4, at: () => ({ rpm: mid, throttle: 0.55, speedMS: 22, gear: 3 }) },
      [`${car}-redline`]: { car, seconds: 3, at: () => ({ rpm: engine.redlineRpm, throttle: 1, speedMS: 55, gear: 6 }) },
      [`${car}-pull`]: { car, seconds: 9, at: t => t < 6.6 ? { throttle: t < 0.4 ? 0 : 1, speedMS: Math.max(0, (t - 0.4) * 8.2), rpm: mid } : { throttle: 0, speedMS: smooth(51, 40, (t - 6.6) / 2.4), rpm: mid } },
    };
  }
  return {
    [`${car}-idle`]: { car, seconds: 4, at: () => ({ rpm: engine.idleRpm, throttle: 0, speedMS: 0 }) },
    [`${car}-mid`]: { car, seconds: 4, at: () => ({ rpm: mid, throttle: 0.55, speedMS: 22, gear: 3 }) },
    [`${car}-redline`]: { car, seconds: 3, at: t => ({ rpm: smooth(engine.redlineRpm * 0.9, engine.redlineRpm * 0.985, t / 0.5), throttle: 1, speedMS: 30, gear: 3 }) },
    [`${car}-pull`]: { car, seconds: 9, at: pull(car) },
  };
}

function race(): Scenario {
  return {
    car: 'CAR-01', seconds: 9, volumes: FX,
    at: (t, tick) => {
      const countdown = tick <= 180;
      const state = countdown ? 'COUNTDOWN' : t < 6.2 ? 'ACTIVE' : 'RESULTS';
      const checkpointIndex = t < 4.5 ? 0 : t < 6.2 ? 1 : 2;
      return { paused: state === 'RESULTS', race: { run: { runId: 'review', state, checkpointIndex }, result: state === 'RESULTS' ? { runId: 'review', medal: 'gold', valid: true } : null, tick } };
    },
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  ...Object.assign({}, ...CARS.map(engineClips)),
  'fx-drift-squeal': { car: 'CAR-01', seconds: 6.5, volumes: FX, at: t => ({ speedMS: 22, slipAngleRad: t < 1.5 ? smooth(0, 0.35, t / 1.5) : t < 3 ? smooth(0.35, 0.8, (t - 1.5) / 1.5) : t < 4.5 ? smooth(0.8, 0.25, (t - 3) / 1.5) : smooth(0.25, 0, (t - 4.5) / 1) }) },
  'fx-wheelspin': { car: 'CAR-01', seconds: 3, volumes: FX, at: t => ({ speedMS: 5 + t * 3, slipRatio: t > 0.3 && t < 2 ? 0.8 : 0.05 }) },
  'fx-handbrake': { car: 'CAR-01', seconds: 2.5, volumes: FX, at: t => ({ speedMS: 18, handbrake: t > 0.5 && t < 1.3 ? 1 : 0, slipAngleRad: t > 0.6 ? smooth(0.5, 0.15, (t - 0.6) / 1.4) : 0 }) },
  'fx-shifts': { car: 'CAR-01', seconds: 4, volumes: FX, at: t => ({ speedMS: 20, gear: [1, 2, 3, 4, 3, 2][Math.min(5, Math.floor(t / 0.6))] }) },
  'fx-impacts': { car: 'CAR-01', seconds: 4.2, volumes: FX, at: (_t, tick) => ({ speedMS: 15, impact: tick === 18 ? { speedDeltaMS: 0.6, impulseNs: 700 } : tick === 90 ? { speedDeltaMS: 1.8, impulseNs: 2100 } : tick === 156 ? { speedDeltaMS: 4.6, impulseNs: 5600 } : null }) },
  'fx-scrape': { car: 'CAR-01', seconds: 3.2, volumes: FX, at: (t, tick) => ({ speedMS: 18, impact: t > 0.4 && t < 2.3 ? (tick === 24 ? { speedDeltaMS: 1.1, impulseNs: 1300 } : tick % 2 === 0 ? { speedDeltaMS: 0.12, impulseNs: 150 } : null) : null }) },
  'fx-gravel': { car: 'CAR-01', seconds: 3.5, volumes: FX, at: t => ({ speedMS: 16, surfaceId: t > 0.5 && t < 3 ? 'ground:ridge:rp01' : 'road:ridge' }) },
  'fx-curb': { car: 'CAR-01', seconds: 3, volumes: FX, at: t => ({ speedMS: 14, surfaceId: t > 0.4 && t < 2.4 ? 'curb:harbor:hw01:left' : 'road:harbor' }) },
  'cues-race': race(),
  'cues-medals': { car: 'CAR-01', seconds: 6, volumes: FX, at: () => ({ paused: true }), cues: [{ time: 0.2, kind: 'medal-bronze' }, { time: 2, kind: 'medal-silver' }, { time: 4, kind: 'medal-gold' }] },
  'cues-menu-economy': {
    car: 'CAR-01', seconds: 6, volumes: FX, at: () => ({ paused: true }),
    cues: [
      { time: 0.2, kind: 'hover' }, { time: 0.45, kind: 'hover' }, { time: 0.7, kind: 'hover' }, { time: 1, kind: 'select' }, { time: 1.6, kind: 'back' },
      ...Array.from({ length: 10 }, (_, i) => ({ time: 2 + i * 0.05, kind: 'tick' as const })),
      { time: 2.9, kind: 'marks' }, { time: 3.8, kind: 'purchase' }, { time: 5.2, kind: 'deny' },
    ],
  },
  'mix-challenger-drive': {
    car: 'CAR-01', seconds: 10,
    at: (t, tick) => {
      const drive = pull('CAR-01', 7)(t);
      return { ...drive, slipAngleRad: t > 3.2 && t < 5.4 ? Math.sin((t - 3.2) / 2.2 * Math.PI) * 0.65 : 0, impact: tick === 450 ? { speedDeltaMS: 2.2, impulseNs: 2600 } : null };
    },
  },
  'mix-delta-drive': {
    car: 'CAR-05', seconds: 10,
    at: (t, tick) => ({ ...pull('CAR-05', 7)(t), slipAngleRad: t > 3 && t < 5 ? Math.sin((t - 3) / 2 * Math.PI) * 0.6 : 0, handbrake: t > 3 && t < 3.4 ? 1 : 0, surfaceId: t > 8 ? 'ground:ridge:rp01' : 'road', impact: tick === 0 ? null : null }),
  },
};

/** Old oscillator engine at its old defaults, for the loudness comparison. */
export const OLD_SCENARIOS: Record<string, Scenario> = {
  'old-CAR-01-mid': engineClips('CAR-01')['CAR-01-mid']!,
  'old-CAR-01-pull': engineClips('CAR-01')['CAR-01-pull']!,
  'old-CAR-04-pull': engineClips('CAR-04')['CAR-04-pull']!,
};
