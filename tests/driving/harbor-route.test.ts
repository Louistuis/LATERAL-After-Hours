import { describe, expect, it } from 'vitest';
import { buildHarborRoute } from '../../src/world/route-data.js';
import { RouteProgressTracker } from '../../src/core/route-progress.js';
import { createRunController } from '../../src/events/run-controller.js';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics/index.js';
import type { Vec3 } from '../../contracts/runtime-contracts.js';

/** Validate authored route data through the same tracker and ordered gates used by events. */
describe('HW-01 event route integration', () => {
  it('accepts one forward centerline lap without a false shortcut or wrong-way violation', () => {
    const { route } = buildHarborRoute();
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    const run = createRunController({
      eventId: 'HW-01:time-trial', routeId: route.id, mode: 'time-trial',
      rulesVersion: 'fixture-rules-v1', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION,
      carId: 'CAR-01', tuneHash: 'fixture-tune',
      checkpoints: route.checkpoints, countdownSeconds: 0,
    }, () => 'harbor-forward-lap');
    run.startCountdown();
    run.activate();

    let previous: Vec3 = route.spawn.position;
    expect(tracker.update(previous)).toMatchObject({ legal: true, violation: null });
    const accepted: string[] = [];
    for (let segment = 0; segment < route.centerline.length - 1; segment++) {
      const from = route.centerline[segment]!;
      const to = route.centerline[segment + 1]!;
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const current: Vec3 = {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t + 0.7,
          z: from.z + (to.z - from.z) * t,
        };
        const projection = tracker.update(current);
        expect(projection.violation).toBeNull();
        expect(projection.legal).toBe(true);
        accepted.push(...run.updateCheckpoints(previous, current).acceptedIds);
        previous = current;
      }
    }
    expect(accepted).toEqual(route.checkpoints.map(gate => gate.id));
    expect(tracker.update(previous).progressM).toBeCloseTo(tracker.lengthM, 1);
    expect(run.finish(0)).toMatchObject({ valid: true, routeId: 'HW-01', mode: 'time-trial' });
  });
});
