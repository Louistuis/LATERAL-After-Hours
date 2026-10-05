import type { EventMode, RouteId } from '../../contracts/runtime-contracts.js';

export type CalibrationStatus = 'UNCALIBRATED';

export interface RouteEventRecord {
  readonly routeId: RouteId;
  readonly name: string;
  readonly region: 'Harbor Works' | 'Ridge Pass' | 'Coastline';
  readonly version: string;
  readonly designLengthRangeM: readonly [number, number];
  readonly checkpointIds: readonly string[];
  readonly calibrationStatus: CalibrationStatus;
}

export interface EventRecord {
  readonly eventId: string;
  readonly routeId: RouteId;
  readonly mode: EventMode;
  readonly rulesVersion: string;
  readonly checkpointIds: readonly string[];
  readonly medalTargets: null;
  readonly rewardCredits: null;
  readonly calibrationStatus: CalibrationStatus;
}

/** Route/event roster only. Geometry, medal targets, and reward amounts remain uncalibrated. */
export const ROUTES: readonly RouteEventRecord[] = Object.freeze([
  { routeId: 'HW-01', name: 'Foundry Eight', region: 'Harbor Works', version: '1.0.3', designLengthRangeM: [700, 900], checkpointIds: Array.from({ length: 8 }, (_, index) => `HW01-CP-${String(index + 1).padStart(2, '0')}`), calibrationStatus: 'UNCALIBRATED' },
  { routeId: 'HW-02', name: 'Quayside Run', region: 'Harbor Works', version: 'hw02-v1', designLengthRangeM: [900, 1200], checkpointIds: ['start', 'outside-line', 'tight-exit', 'finish'], calibrationStatus: 'UNCALIBRATED' },
  { routeId: 'RP-01', name: 'Seven Bends', region: 'Ridge Pass', version: 'rp01-v1', designLengthRangeM: [1300, 1600], checkpointIds: Array.from({ length: 8 }, (_, index) => `RP01-CP-${String(index + 1).padStart(2, '0')}`), calibrationStatus: 'UNCALIBRATED' },
  { routeId: 'RP-02', name: 'Summit Circuit', region: 'Ridge Pass', version: 'rp02-v1', designLengthRangeM: [800, 1100], checkpointIds: ['start', 'off-camber-entry', 'downhill-exit', 'finish'], calibrationStatus: 'UNCALIBRATED' },
  { routeId: 'CL-01', name: 'Neon Interchange', region: 'Coastline', version: 'cl01-v1', designLengthRangeM: [1000, 1250], checkpointIds: Array.from({ length: 8 }, (_, index) => `CL01-CP-${String(index + 1).padStart(2, '0')}`), calibrationStatus: 'UNCALIBRATED' },
  { routeId: 'CL-02', name: 'Breakwater Sprint', region: 'Coastline', version: 'cl02-v1', designLengthRangeM: [1000, 1400], checkpointIds: ['start', 'bridge-transition', 'final-clip', 'finish'], calibrationStatus: 'UNCALIBRATED' },
]);

export const EVENTS: readonly EventRecord[] = Object.freeze(ROUTES.flatMap((route) =>
  (['drift-attack', 'time-trial', 'rival-ghost'] as const).map((mode) => ({
    eventId: `${route.routeId}:${mode}`,
    routeId: route.routeId,
    mode,
    rulesVersion: 'drift-score-v3-provisional',
    checkpointIds: route.checkpointIds,
    medalTargets: null,
    rewardCredits: null,
    calibrationStatus: 'UNCALIBRATED' as const,
  })),
));

export interface EventCatalogValidation { readonly valid: boolean; readonly errors: readonly string[]; }

export function validateEventCatalog(routes: readonly RouteEventRecord[] = ROUTES, events: readonly EventRecord[] = EVENTS): EventCatalogValidation {
  const errors: string[] = [];
  const routeIds = new Set<RouteId>();
  for (const route of routes) {
    if (routeIds.has(route.routeId)) errors.push(`duplicate route ${route.routeId}`);
    routeIds.add(route.routeId);
    // Checkpoint IDs are route-owned gate IDs. Finish direction/semantics come from world geometry.
    if (route.checkpointIds.length < 2) errors.push(`invalid checkpoints for ${route.routeId}`);
    if (new Set(route.checkpointIds).size !== route.checkpointIds.length) errors.push(`duplicate checkpoint id for ${route.routeId}`);
    if (route.designLengthRangeM[0] <= 0 || route.designLengthRangeM[1] < route.designLengthRangeM[0]) errors.push(`invalid design length for ${route.routeId}`);
  }
  if (routes.length !== 6) errors.push(`expected 6 routes, received ${routes.length}`);
  const eventIds = new Set<string>();
  const modeCounts = new Map<RouteId, Set<EventMode>>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) errors.push(`duplicate event ${event.eventId}`);
    eventIds.add(event.eventId);
    if (!(['drift-attack', 'time-trial', 'rival-ghost'] as const).includes(event.mode)) errors.push(`unknown mode in ${event.eventId}`);
    const modes = modeCounts.get(event.routeId) ?? new Set<EventMode>();
    if (modes.has(event.mode)) errors.push(`duplicate ${event.mode} for ${event.routeId}`);
    modes.add(event.mode);
    modeCounts.set(event.routeId, modes);
    const route = routes.find((candidate) => candidate.routeId === event.routeId);
    if (!route) { errors.push(`unknown route ${event.routeId} in ${event.eventId}`); continue; }
    if (event.checkpointIds.join('|') !== route.checkpointIds.join('|')) errors.push(`checkpoint order mismatch in ${event.eventId}`);
    if (event.calibrationStatus !== 'UNCALIBRATED' || event.medalTargets !== null || event.rewardCredits !== null) errors.push(`unmeasured event has calibrated values: ${event.eventId}`);
  }
  if (events.length !== 18) errors.push(`expected 18 events, received ${events.length}`);
  for (const route of routes) {
    const modes = modeCounts.get(route.routeId);
    if (!modes || modes.size !== 3 || !['drift-attack', 'time-trial', 'rival-ghost'].every((mode) => modes.has(mode as EventMode))) {
      errors.push(`expected one event per mode for ${route.routeId}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
