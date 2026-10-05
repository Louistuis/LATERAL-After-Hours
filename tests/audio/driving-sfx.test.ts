import { describe, expect, it } from 'vitest';
import type { VehicleSnapshot, WheelSnapshot } from '../../contracts/runtime-contracts';
import {
  calculateImpactSeverity, gearChange, impactVoice, isHandbrakePull, medalCue, RaceCueTracker, scrapeLevel, surfaceParams, tyreParams,
} from '../../src/audio/driving-sfx';

function wheels(options: { slipAngleRad?: number; slipRatio?: number; grounded?: number; surfaces?: (string | null)[]; rearOnly?: boolean } = {}): VehicleSnapshot['wheels'] {
  const wheel = (index: number): WheelSnapshot => ({
    contact: index < (options.grounded ?? 4), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0.1, normalLoadN: 3000, angularVelocityRadS: 0,
    slipRatio: options.slipRatio ?? 0, slipAngleRad: options.rearOnly && index < 2 ? 0.02 : options.slipAngleRad ?? 0, surfaceId: options.surfaces?.[index] ?? 'road:harbor',
  });
  return [wheel(0), wheel(1), wheel(2), wheel(3)];
}

describe('tyre squeal mapping', () => {
  it('is silent while slow, gripping or airborne', () => {
    expect(tyreParams(wheels({ slipAngleRad: 0.6 }), 2).squealGain).toBe(0);
    expect(tyreParams(wheels({ slipAngleRad: 0.05 }), 20).squealGain).toBe(0);
    expect(tyreParams(wheels({ slipAngleRad: 0.6, grounded: 1 }), 20).squealGain).toBe(0);
    expect(tyreParams(wheels({ slipAngleRad: Number.NaN }), Number.NaN).squealGain).toBe(0);
  });
  it('grows with slip angle and speed, and follows a rear-wheel drift at full strength', () => {
    const light = tyreParams(wheels({ slipAngleRad: 0.2 }), 20);
    const heavy = tyreParams(wheels({ slipAngleRad: 0.45 }), 20);
    expect(heavy.squealGain).toBeGreaterThan(light.squealGain);
    expect(tyreParams(wheels({ slipAngleRad: 0.45 }), 6).squealGain).toBeLessThan(heavy.squealGain);
    expect(tyreParams(wheels({ slipAngleRad: 0.45, rearOnly: true }), 20).squealGain).toBeCloseTo(heavy.squealGain);
    expect(heavy.scrubGain).toBeGreaterThan(light.scrubGain);
    expect(tyreParams(wheels({ slipAngleRad: 2 }), 60).squealGain).toBeLessThanOrEqual(0.5);
  });
  it('also squeals on wheelspin and drops pitch in a deep slide', () => {
    expect(tyreParams(wheels({ slipRatio: 0.7 }), 15).squealGain).toBeGreaterThan(0);
    const moderate = tyreParams(wheels({ slipAngleRad: 0.5 }), 20);
    const deep = tyreParams(wheels({ slipAngleRad: 1.1 }), 20);
    expect(deep.squealHz).toBeLessThan(moderate.squealHz);
    expect(deep.squealHz).toBeGreaterThanOrEqual(560);
  });
});

describe('surface and barrier mapping', () => {
  it('rumbles on gravel and grass, buzzes on curbs at a speed-following rate, and stays quiet on the road', () => {
    expect(surfaceParams(wheels(), 20)).toMatchObject({ gravelGain: 0, curbGain: 0 });
    const offRoad = surfaceParams(wheels({ surfaces: ['ground:ridge:rp01', 'ground:ridge:rp01', 'road', 'road'] }), 20);
    expect(offRoad.gravelGain).toBeGreaterThan(0);
    expect(surfaceParams(wheels({ surfaces: Array(4).fill('ground:ridge:rp01') }), 20).gravelGain).toBeGreaterThan(offRoad.gravelGain);
    const curb = surfaceParams(wheels({ surfaces: ['curb:harbor:hw01:left', 'curb:harbor:hw01:left', 'road', 'road'] }), 12);
    expect(curb.curbGain).toBeGreaterThan(0);
    expect(surfaceParams(wheels({ surfaces: Array(4).fill('curb:x') }), 30).curbHz).toBeGreaterThan(curb.curbHz);
    expect(surfaceParams(wheels({ surfaces: Array(4).fill('ground:x') }), 0).gravelGain).toBe(0);
  });
  it('scrapes only on repeated contact at speed', () => {
    expect(scrapeLevel([100], 100, 20)).toBe(0);
    expect(scrapeLevel([95, 100], 100, 20)).toBeGreaterThan(0);
    expect(scrapeLevel([60, 70], 100, 20)).toBe(0);
    expect(scrapeLevel([95, 96, 97, 98, 99, 100], 100, 20)).toBeGreaterThan(scrapeLevel([95, 100], 100, 20));
    expect(scrapeLevel([95, 96, 97, 98, 99, 100], 100, 1)).toBe(0);
  });
});

describe('impacts, shifts and handbrake', () => {
  it('maps tiny, medium and strong actual impacts to quiet, distinct and capped severity', () => {
    expect(calculateImpactSeverity({ speedDeltaMS: 0.015, impulseNs: 17.45 })).toBe(0);
    expect(calculateImpactSeverity({ speedDeltaMS: 0.87, impulseNs: 1009 })).toBeGreaterThan(0.1);
    expect(calculateImpactSeverity({ speedDeltaMS: 4.36, impulseNs: 5065 })).toBe(1);
    expect(calculateImpactSeverity({ speedDeltaMS: NaN, impulseNs: 10 })).toBe(0);
    expect(calculateImpactSeverity({ speedDeltaMS: 0, impulseNs: 5000 })).toBe(0);
  });
  it('scales the impact sound with impact speed', () => {
    expect(impactVoice(0)).toBeNull();
    expect(impactVoice(Number.NaN)).toBeNull();
    expect(impactVoice(0.1)!.level).toBe(0);
    expect(impactVoice(0.5)!.level).toBe(1);
    expect(impactVoice(1)!.level).toBe(2);
    expect(impactVoice(1)!.gain).toBeGreaterThan(impactVoice(0.1)!.gain);
    expect(impactVoice(5)!.gain).toBeLessThanOrEqual(1);
  });
  it('detects gear changes and fresh handbrake pulls', () => {
    expect(gearChange(null, 2)).toBeNull();
    expect(gearChange(2, 2)).toBeNull();
    expect(gearChange(2, 3)).toBe('up');
    expect(gearChange(3, 2)).toBe('down');
    expect(gearChange(1, -1)).toBe('reverse');
    expect(isHandbrakePull(0, 1, 15)).toBe(true);
    expect(isHandbrakePull(1, 1, 15)).toBe(false);
    expect(isHandbrakePull(0, 1, 2)).toBe(false);
    expect(isHandbrakePull(null, 1, 15)).toBe(false);
  });
});

describe('race cue tracker', () => {
  const run = (state: string, checkpointIndex = 0, runId = 'r1') => ({ runId, state, checkpointIndex });
  it('beeps on 3, 2 and 1, then GO, then each checkpoint', () => {
    const tracker = new RaceCueTracker();
    const cues: string[] = [];
    for (let tick = 0; tick <= 179; tick++) cues.push(...tracker.update({ run: run('COUNTDOWN'), result: null, tick }).map(cue => cue.cue));
    cues.push(...tracker.update({ run: run('ACTIVE'), result: null, tick: 180 }).map(cue => cue.cue));
    cues.push(...tracker.update({ run: run('ACTIVE'), result: null, tick: 181 }).map(cue => cue.cue));
    cues.push(...tracker.update({ run: run('ACTIVE', 1), result: null, tick: 300 }).map(cue => cue.cue));
    cues.push(...tracker.update({ run: run('ACTIVE', 1), result: null, tick: 301 }).map(cue => cue.cue));
    expect(cues).toEqual(['count', 'count', 'count', 'go', 'checkpoint']);
  });
  it('announces the finish once with a delayed medal, none for an invalid run, and resets on retry', () => {
    const tracker = new RaceCueTracker();
    tracker.update({ run: run('ACTIVE', 3), result: null, tick: 10 });
    const finish = tracker.update({ run: run('RESULTS', 4), result: { runId: 'r1', medal: 'silver', valid: true }, tick: 11 });
    expect(finish).toEqual([{ cue: 'finish', delay: 0 }, { cue: 'medal-silver', delay: 0.9 }]);
    expect(tracker.update({ run: run('RESULTS', 4), result: { runId: 'r1', medal: 'silver', valid: true }, tick: 12 })).toEqual([]);
    tracker.update({ run: run('COUNTDOWN', 0, 'r2'), result: { runId: 'r1', medal: 'silver', valid: true }, tick: 20 });
    tracker.update({ run: run('ACTIVE', 0, 'r2'), result: null, tick: 200 });
    const invalid = tracker.update({ run: run('RESULTS', 4, 'r2'), result: { runId: 'r2', medal: 'gold', valid: false }, tick: 900 });
    expect(invalid.map(cue => cue.cue)).toEqual(['finish']);
    expect(medalCue('none')).toBeNull();
    expect(new RaceCueTracker().update({ run: null, result: null, tick: 0 })).toEqual([]);
  });
});
