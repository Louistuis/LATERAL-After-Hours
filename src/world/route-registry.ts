import type { RouteId } from '../../contracts/runtime-contracts';
import type { DistrictId } from '../../contracts/world-contracts';

/**
 * Routes that are actually built into the world and can be selected, raced online and ranked.
 * The wider catalogue (content/events/catalog.ts) also lists planned routes; anything that must
 * only accept drivable routes (lobbies, leaderboards, menus) should whitelist through this list.
 */
export const PLAYABLE_ROUTE_IDS = ['HW-01', 'RP-01', 'CL-01'] as const satisfies readonly RouteId[];
export type PlayableRouteId = typeof PLAYABLE_ROUTE_IDS[number];

export function isPlayableRoute(id: unknown): id is PlayableRouteId {
  return typeof id === 'string' && (PLAYABLE_ROUTE_IDS as readonly string[]).includes(id);
}

export interface RouteLocation {
  readonly district: DistrictId;
  /** Short place name for menus. */
  readonly place: string;
  /** One-line mood for the route card. */
  readonly blurb: string;
}

export const ROUTE_LOCATIONS: Readonly<Record<PlayableRouteId, RouteLocation>> = {
  'HW-01': { district: 'harbor', place: 'Harbor Works', blurb: 'Figure eight through the container yard, under the cranes.' },
  'RP-01': { district: 'ridge', place: 'Ridge Pass', blurb: 'Six hairpins and the summit esses, a sheer drop to the city lights.' },
  'CL-01': { district: 'coast', place: 'Neon Bay', blurb: 'Four-lane elevated sweepers through the towers, then a light-strip tunnel under the plaza.' },
};
