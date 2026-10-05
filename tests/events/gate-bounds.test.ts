import { describe, expect, it } from 'vitest';
import { createRunController } from '../../src/events/run-controller.js';

const run = () => {
  const controller = createRunController({ eventId: 'RP-01:time-trial', routeId: 'RP-01', mode: 'time-trial', rulesVersion: 'r', carId: 'CAR-01',
    routeVersion: 'v', physicsVersion: 'p', tuneHash: 't', countdownSeconds: 0,
    checkpoints: [{ id: 'g1', center: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 }, halfWidthM: 6, finish: true }] }, () => 'id');
  controller.startCountdown(); controller.activate();
  return controller;
};

describe('bounded gate planes', () => {
  it('ignores crossings of the gate plane on a parallel leg of the road 34 m away', () => {
    const controller = run();
    expect(controller.updateCheckpoints({ x: 1, y: 0, z: 34 }, { x: -1, y: 0, z: 34 }).invalidCrossing).toBe(false);
    expect(controller.updateCheckpoints({ x: -1, y: 0, z: -34 }, { x: 1, y: 0, z: -34 }).invalidCrossing).toBe(false);
    // A road stacked 10 m below the gate is another road too.
    expect(controller.updateCheckpoints({ x: 1, y: -10, z: 0 }, { x: -1, y: -10, z: 0 }).invalidCrossing).toBe(false);
  });
  it('accepts a crossing out on the shoulder instead of silently missing the gate', () => {
    const controller = run();
    expect(controller.updateCheckpoints({ x: -1, y: 0, z: 8.8 }, { x: 1, y: 0, z: 8.8 })).toMatchObject({ acceptedIds: ['g1'], invalidCrossing: false });
  });
  it('still flags backward and just-wide crossings next to the gate, and accepts a clean one', () => {
    const controller = run();
    expect(controller.updateCheckpoints({ x: 1, y: 0, z: 2 }, { x: -1, y: 0, z: 2 }).invalidCrossing).toBe(true);
    // Up to 3.5 m past the half width (curb, run-off shoulder, guardrail) is still the gate; beyond that is wide.
    expect(controller.updateCheckpoints({ x: -1, y: 0, z: 11 }, { x: 1, y: 0, z: 11 }).invalidCrossing).toBe(true);
    expect(controller.updateCheckpoints({ x: -1, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }).acceptedIds).toEqual(['g1']);
  });
});
