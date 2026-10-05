import { describe, expect, it } from 'vitest';
import { EVENTS, ROUTES, validateEventCatalog } from '../../content/events/catalog.js';

describe('event catalog', () => {
  it('contains one event per mode and uses authored HW-01 gate identity', () => {
    expect(validateEventCatalog()).toEqual({ valid: true, errors: [] });
    expect(ROUTES.find(route => route.routeId === 'HW-01')).toMatchObject({
      version: '1.0.3', checkpointIds: Array.from({ length: 8 }, (_, index) => `HW01-CP-${String(index + 1).padStart(2, '0')}`),
    });
    expect(EVENTS).toHaveLength(18);
    expect(EVENTS.every(event => event.rulesVersion === 'drift-score-v3-provisional')).toBe(true);
    expect(EVENTS.every(event => event.medalTargets === null && event.rewardCredits === null && event.calibrationStatus === 'UNCALIBRATED')).toBe(true);
  });

  it('rejects missing route/mode coverage and unknown route references', () => {
    expect(validateEventCatalog(ROUTES, EVENTS.slice(1)).valid).toBe(false);
    expect(validateEventCatalog(ROUTES, [...EVENTS.slice(0, -1), { ...EVENTS.at(-1)!, routeId: 'HW-99' as typeof ROUTES[number]['routeId'] }]).errors)
      .toContain('unknown route HW-99 in CL-02:rival-ghost');
  });
});
