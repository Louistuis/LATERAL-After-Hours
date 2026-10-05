import { describe, expect, it } from 'vitest';
import { summarizeFrames, validateFrameSamples, validateRouteTelemetry } from '../../tools/benchmark/game-runtime-contract.mjs';

describe('actual-game benchmark evidence validation', () => {
  it('summarizes delivered frame intervals with nearest-rank percentiles', () => {
    const result = summarizeFrames([
      { frameIntervalMs: null },
      { frameIntervalMs: 10 },
      { frameIntervalMs: 20 },
      { frameIntervalMs: 30 },
      { frameIntervalMs: 40 },
    ]);
    expect(result.frames).toBe(5);
    expect(result.frameIntervalP50Ms).toBe(20);
    expect(result.frameIntervalP95Ms).toBe(40);
    expect(result.averageFps).toBe(40);
    expect(result.maxFrameIntervalMs).toBe(40);
  });

  it('rejects paused, quality-mismatched, counter-missing or non-advancing samples', () => {
    const samples = [
      { frameIntervalMs: null, simulationTick: 1, paused: false, quality: 'balanced', drawCallsAllPasses: 5, trianglesAllPasses: 20 },
      { frameIntervalMs: 16.7, simulationTick: 2, paused: false, quality: 'balanced', drawCallsAllPasses: 5, trianglesAllPasses: 20 },
    ];
    expect(validateFrameSamples(samples, 'balanced').valid).toBe(true);
    expect(validateFrameSamples(samples.map((sample) => ({ ...sample, paused: true })), 'balanced').pausedFrames).toBe(2);
    expect(validateFrameSamples(samples.map((sample) => ({ ...sample, drawCallsAllPasses: null })), 'balanced').missingCounters).toEqual(['drawCallsAllPasses']);
    expect(validateFrameSamples(samples, 'high').valid).toBe(false);
    expect(validateFrameSamples(samples.map((sample) => ({ ...sample, simulationTick: 1 })), 'balanced').valid).toBe(false);
  });

  it('requires a substantial legal segment with road-wheel contact throughout', () => {
    const telemetry = Array.from({ length: 10 }, (_, index) => ({
      routeLegal: index < 9,
      roadWheelContactCount: index < 9 ? 4 : 0,
      routeProgressM: index === 9 ? 330 : 30 * index,
    }));
    expect(validateRouteTelemetry(telemetry, 500)).toMatchObject({ valid: true, legalRatio: 0.9, roadContactRatio: 0.9, measuredProgressM: 330, requiredProgressM: 300 });
    expect(validateRouteTelemetry(telemetry.map((entry) => ({ ...entry, roadWheelContactCount: 0 })), 500).valid).toBe(false);
  });
});
