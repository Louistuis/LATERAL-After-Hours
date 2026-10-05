import { describe, expect, it } from 'vitest';
import { createRunController } from '../../src/events/run-controller.js';
import type { EventRunConfig } from '../../src/events/run-controller.js';
import { EVENTS, ROUTES, validateEventCatalog } from '../../content/events/catalog.js';
import type { EventRecord } from '../../content/events/catalog.js';

const config = (mode: EventRunConfig['mode'] = 'drift-attack'): EventRunConfig => ({
  eventId: 'e1', routeId: 'HW-01', mode, rulesVersion: 'r1', carId: 'CAR-01', routeVersion: 'v1', physicsVersion: 'physics-1', tuneHash: 't1',
  checkpoints: [
    { id: 'cp1', center: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, halfWidthM: 5 },
    { id: 'finish', center: { x: 0, y: 0, z: 10 }, forward: { x: 0, y: 0, z: 1 }, halfWidthM: 5, finish: true },
  ], medalTargets: mode === 'time-trial' || mode === 'rival-ghost' ? { gold: 1, silver: 5, bronze: 10 } : { gold: 1000, silver: 500, bronze: 100 },
});

describe('event run lifecycle', () => {
  it('ships six route and eighteen explicitly uncalibrated event records', () => {
    expect(ROUTES).toHaveLength(6);
    expect(EVENTS).toHaveLength(18);
    expect(validateEventCatalog()).toEqual({ valid: true, errors: [] });
    expect(EVENTS.every((event) => event.medalTargets === null && event.rewardCredits === null)).toBe(true);
    expect(validateEventCatalog(ROUTES, EVENTS.filter((event) => event.eventId !== 'HW-01:rival-ghost'))
      .errors.some((error) => error.includes('one event per mode'))).toBe(true);
    expect(validateEventCatalog(ROUTES, EVENTS.map((event, index) => index === 17 ? { ...event, routeId: 'ZZ-99' as EventRecord['routeId'] } : event))
      .errors.some((error) => error.includes('unknown route'))).toBe(true);
  });

  it('gates time to ACTIVE and requires ordered, forward gate crossings', () => {
    const run = createRunController(config(), () => 'run1');
    run.prepare(); run.startCountdown();
    for (let i = 0; i < 181; i++) run.tick(1 / 60);
    expect(run.status().state).toBe('ACTIVE');
    run.updateCheckpoints({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 });
    expect(run.status().checkpointIndex).toBe(0);
    expect(run.updateCheckpoints({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }).acceptedIds).toEqual(['cp1']);
    expect(run.updateCheckpoints({ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: 11 }).completed).toBe(true);
    expect(run.finish(1200)?.medal).toBe('gold');
    expect(run.finish(1200)).toMatchObject({ routeVersion: 'v1', physicsVersion: 'physics-1', tuneHash: 't1' });
    run.showResults();
    expect(run.status().state).toBe('RESULTS');
  });

  it('rejects teleport and vertical gate bypasses, and reset creates a new run', () => {
    let id = 0;
    const run = createRunController(config(), () => `run${++id}`);
    run.startCountdown(); run.activate();
    expect(run.updateCheckpoints({ x: 0, y: 0, z: -40 }, { x: 0, y: 0, z: 1 }).invalidCrossing).toBe(true);
    expect(run.updateCheckpoints({ x: 0, y: 10, z: -1 }, { x: 0, y: 10, z: 1 }).acceptedIds).toEqual([]);
    run.abort('reset');
    expect(run.reset().runId).toBe('run2');
    expect(run.status()).toMatchObject({ state: 'PREPARE', elapsedActiveSeconds: 0, checkpointIndex: 0 });
  });

  it('uses opposite medal comparator for Time Trial', () => {
    const run = createRunController(config('time-trial'), () => 'timed');
    run.startCountdown(); run.activate();
    for (let i = 0; i < 361; i++) run.tick(1 / 60);
    run.updateCheckpoints({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });
    run.updateCheckpoints({ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: 11 });
    expect(run.finish(0)?.medal).toBe('bronze');
  });

  it('compares Rival Ghost tiers by elapsed time', () => {
    const run = createRunController(config('rival-ghost'), () => 'rival');
    run.startCountdown(); run.activate();
    for (let i = 0; i < 361; i++) run.tick(1 / 60);
    run.updateCheckpoints({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });
    run.updateCheckpoints({ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: 11 });
    expect(run.finish(0)?.medal).toBe('bronze');
  });

  it('keeps shortcut and wrong-way invalidation sticky through finish and clears on retry', () => {
    let id = 0;
    const run = createRunController(config(), () => `invalid-${++id}`);
    run.startCountdown(); run.activate();
    run.markInvalid('shortcut');
    expect(run.status().state).toBe('ACTIVE');
    expect(run.status().invalidReason).toBe('shortcut');
    run.updateCheckpoints({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });
    run.updateCheckpoints({ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: 11 });
    const result = run.finish(1200)!;
    expect(result).toMatchObject({ valid: false, medal: 'none' });
    expect(run.finish(1200)).toBe(result);
    expect(run.markInvalid('wrong-way').invalidReason).toBe('shortcut');
    expect(run.reset()).toMatchObject({ state: 'PREPARE', invalidReason: null, runId: 'invalid-2' });
    run.startCountdown(); run.activate();
    run.updateCheckpoints({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });
    run.updateCheckpoints({ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: 11 });
    expect(run.status().state).toBe('FINISHING');
    run.markInvalid('wrong-way');
    expect(run.finish(1200)).toMatchObject({ valid: false, medal: 'none' });
  });
});
