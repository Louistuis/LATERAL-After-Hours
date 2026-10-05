import { describe, expect, it } from 'vitest';
import type { CarId } from '../../contracts/runtime-contracts';
import {
  blowOffStrength, combustionParams, crackleStrength, electricParams, ENGINE_VOICES, isThrottleLift, rpmNorm, selectEngineVoice, turboParams, turboStep,
  type CombustionVoice, type ElectricVoice,
} from '../../src/audio/engine-voices';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';

const CARS = Object.keys(VEHICLE_CONFIGS) as CarId[];
const combustion = (car: CarId): CombustionVoice => ENGINE_VOICES[car] as CombustionVoice;
const state = (car: CarId, rpm: number, throttle: number, speedMS = 20) => ({ rpm, throttle, speedMS, idleRpm: VEHICLE_CONFIGS[car].engine.idleRpm, redlineRpm: VEHICLE_CONFIGS[car].engine.redlineRpm });
/** Exhaust firing frequency of a four-stroke at the voice rpm. */
const firingHz = (voice: CombustionVoice, voiceRpm: number): number => voiceRpm / 60 * voice.cylinders / 2;

describe('per-car voice selection', () => {
  it('gives every roster car its own voice and falls back to the starter for unknown ids', () => {
    expect(new Set(CARS.map(car => selectEngineVoice(car).id)).size).toBe(CARS.length);
    expect(selectEngineVoice('CAR-03').id).toBe(selectEngineVoice('CAR-01').id);
    expect(selectEngineVoice('nonsense').id).toBe('v8-crossplane');
  });

  it('makes the Cybertruck electric and only the Delta and Agera turbocharged', () => {
    expect(selectEngineVoice('CAR-02').kind).toBe('electric');
    for (const car of ['CAR-01', 'CAR-04', 'CAR-05', 'CAR-06'] as const) expect(selectEngineVoice(car).kind).toBe('combustion');
    expect(combustion('CAR-05').turbo).not.toBeNull();
    expect(combustion('CAR-06').turbo).not.toBeNull();
    expect(combustion('CAR-01').turbo).toBeNull();
    expect(combustion('CAR-04').turbo).toBeNull();
    // The rally four gets the sharp blow-off and whistle; the Agera is mostly whoosh.
    expect(combustion('CAR-05').turbo!.whistle).toBeGreaterThan(combustion('CAR-06').turbo!.whistle);
    expect(combustion('CAR-06').turbo!.whoosh).toBeGreaterThan(combustion('CAR-05').turbo!.whoosh);
  });

  it('fires the Challenger V8 unevenly per bank (burble) and the V10 evenly', () => {
    const bankAngles = (voice: CombustionVoice, bank: 0 | 1) => voice.firing.filter(event => event.bank === bank).map(event => event.angle);
    const gaps = (angles: number[]) => angles.map((angle, i) => ((angles[(i + 1) % angles.length]! - angle) + 720) % 720);
    expect(new Set(gaps(bankAngles(combustion('CAR-01'), 0))).size).toBeGreaterThan(1);
    expect(new Set(gaps(bankAngles(combustion('CAR-04'), 0)))).toEqual(new Set([144]));
    expect(combustion('CAR-01').cylinders).toBe(8);
    expect(combustion('CAR-04').cylinders).toBe(10);
    expect(combustion('CAR-05').cylinders).toBe(4);
    expect(combustion('CAR-06').cylinders).toBe(8);
  });

  it('pitches the F1 far above the others and the Challenger lowest', () => {
    const redline = (car: CarId) => { const voice = combustion(car); return firingHz(voice, combustionParams(voice, state(car, VEHICLE_CONFIGS[car].engine.redlineRpm, 1)).voiceRpm); };
    expect(redline('CAR-04')).toBeGreaterThan(1100);
    expect(redline('CAR-04')).toBeGreaterThan(2 * redline('CAR-06'));
    expect(redline('CAR-01')).toBeLessThan(redline('CAR-06'));
    expect(redline('CAR-05')).toBeLessThan(redline('CAR-01'));
    const idle = (car: CarId) => { const voice = combustion(car); return firingHz(voice, combustionParams(voice, state(car, VEHICLE_CONFIGS[car].engine.idleRpm, 0)).voiceRpm); };
    expect(idle('CAR-01')).toBeLessThan(60);
  });
});

describe('combustion parameter mapping', () => {
  it('follows rpm with both layers and an equal-power crossfade', () => {
    const voice = combustion('CAR-01');
    let previous = 0;
    for (const rpm of [850, 2000, 3500, 5000, 7600]) {
      const p = combustionParams(voice, state('CAR-01', rpm, 0.5));
      expect(p.rates[0]).toBeGreaterThan(previous);
      previous = p.rates[0];
      expect(p.rates[0] / p.rates[1]).toBeCloseTo(voice.layerRpm[1] / voice.layerRpm[0]);
      expect(p.layerGains[0] ** 2 + p.layerGains[1] ** 2).toBeCloseTo(1);
      expect(p.loadGains[0] ** 2 + p.loadGains[1] ** 2).toBeCloseTo(1);
    }
    expect(combustionParams(voice, state('CAR-01', 850, 0)).layerGains[0]).toBeGreaterThan(0.9);
    expect(combustionParams(voice, state('CAR-01', 7600, 0)).layerGains[1]).toBeGreaterThan(0.9);
  });

  it('opens up tone, saturation and level on throttle and stays muffled on the overrun', () => {
    for (const car of ['CAR-01', 'CAR-04', 'CAR-05', 'CAR-06'] as const) {
      const voice = combustion(car);
      const coast = combustionParams(voice, state(car, 5000, 0));
      const load = combustionParams(voice, state(car, 5000, 1));
      expect(load.exhaustGain).toBeGreaterThan(coast.exhaustGain * 1.4);
      expect(load.cutoffHz).toBeGreaterThan(coast.cutoffHz);
      expect(load.drive).toBeGreaterThan(coast.drive);
      expect(load.intakeGain).toBeGreaterThan(0);
      expect(coast.intakeGain).toBe(0);
      expect(load.loadGains[0]).toBe(1);
      expect(coast.loadGains[1]).toBe(1);
    }
  });

  it('bounces off the limiter only at the redline on throttle and survives bad input', () => {
    const voice = combustion('CAR-05');
    expect(combustionParams(voice, state('CAR-05', 7590, 1)).limiter).toBe(true);
    expect(combustionParams(voice, state('CAR-05', 7590, 0)).limiter).toBe(false);
    expect(combustionParams(voice, state('CAR-05', 6000, 1)).limiter).toBe(false);
    const bad = combustionParams(voice, { rpm: Number.NaN, throttle: Number.NaN, speedMS: Infinity, idleRpm: 850, redlineRpm: 7600 });
    for (const value of [bad.voiceRpm, ...bad.rates, ...bad.layerGains, ...bad.loadGains, bad.exhaustGain, bad.cutoffHz, bad.drive]) expect(Number.isFinite(value)).toBe(true);
    expect(rpmNorm({ rpm: 10_000, idleRpm: 850, redlineRpm: 7600 })).toBe(1);
  });
});

describe('electric motor mapping', () => {
  const voice = ENGINE_VOICES['CAR-02'] as ElectricVoice;
  it('whines with road speed, capped, and is near silent at a standstill', () => {
    const slow = electricParams(voice, { throttle: 1, speedMS: 5 });
    const fast = electricParams(voice, { throttle: 1, speedMS: 40 });
    expect(fast.whineHz).toBeGreaterThan(slow.whineHz * 3);
    expect(electricParams(voice, { throttle: 1, speedMS: 500 }).whineHz).toBe(voice.whineMaxHz);
    expect(electricParams(voice, { throttle: 0, speedMS: 0 }).whineGain).toBe(0);
  });
  it('keeps a quieter regen whine on a lift and steps the inverter tone only at low speed', () => {
    const lift = electricParams(voice, { throttle: 0, speedMS: 25 });
    const drive = electricParams(voice, { throttle: 1, speedMS: 25 });
    expect(lift.whineGain).toBeGreaterThan(0);
    expect(lift.whineGain).toBeLessThan(drive.whineGain);
    expect(electricParams(voice, { throttle: 1, speedMS: 1 }).inverterHz).toBeLessThan(electricParams(voice, { throttle: 1, speedMS: 8 }).inverterHz);
    expect(electricParams(voice, { throttle: 1, speedMS: 20 }).inverterGain).toBe(0);
  });
});

describe('turbo, blow-off and crackle', () => {
  const lancia = combustion('CAR-05');
  it('spools slowly with throttle and revs and collapses fast on a lift', () => {
    let boost = 0;
    for (let i = 0; i < 6; i++) boost = turboStep(boost, 1, 0.8, 1 / 60, lancia.turbo!.spoolSeconds);
    expect(boost).toBeGreaterThan(0); expect(boost).toBeLessThan(0.3);
    for (let i = 0; i < 120; i++) boost = turboStep(boost, 1, 0.8, 1 / 60, lancia.turbo!.spoolSeconds);
    expect(boost).toBeGreaterThan(0.9);
    const lifted = turboStep(boost, 0, 0.8, 0.1, lancia.turbo!.spoolSeconds);
    expect(lifted).toBeLessThan(boost * 0.6);
    expect(turboStep(0, 1, 0.1, 1, lancia.turbo!.spoolSeconds)).toBe(0); // no boost at idle revs
    const full = turboParams(lancia.turbo!, 1, 1), half = turboParams(lancia.turbo!, 0.5, 1);
    expect(full.whistleHz).toBeGreaterThan(half.whistleHz);
    expect(full.whistleGain).toBeGreaterThan(half.whistleGain);
  });
  it('blows off only with boost on a turbo car and crackles only on a high-rpm lift', () => {
    expect(isThrottleLift(0.9, 0.05)).toBe(true);
    expect(isThrottleLift(0.3, 0)).toBe(false);
    expect(isThrottleLift(null, 0)).toBe(false);
    expect(blowOffStrength(lancia, 0.9)).toBeGreaterThan(0);
    expect(blowOffStrength(lancia, 0.2)).toBe(0);
    expect(blowOffStrength(combustion('CAR-01'), 1)).toBe(0);
    expect(crackleStrength(lancia, 0.9)).toBeGreaterThan(crackleStrength(lancia, 0.6));
    expect(crackleStrength(lancia, 0.2)).toBe(0);
    expect(crackleStrength(ENGINE_VOICES['CAR-02'], 1)).toBe(0);
  });
});
