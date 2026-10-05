import { describe, expect, it } from 'vitest';
import { buildCoastInterchange, COAST_BARRIER_LAT_M, COAST_ROAD_SURFACE } from '../../src/world/coast-interchange.js';
import { ROUTES } from '../../content/events/catalog.js';
import { isPlayableRoute } from '../../src/world/route-registry.js';

describe('CL-01 Neon Interchange authored geometry', () => {
  const coast = buildCoastInterchange();
  const { frames, lengthM, route } = coast.ribbon;

  it('is a closed, catalogued, playable route with ordered gates and a finish behind the spawn', () => {
    const catalog = ROUTES.find(entry => entry.routeId === 'CL-01')!;
    expect(route).toMatchObject({ id: 'CL-01', district: 'coast', closed: true });
    expect(route.checkpoints.map(gate => gate.id)).toEqual(catalog.checkpointIds);
    expect(lengthM).toBeGreaterThanOrEqual(catalog.designLengthRangeM[0]);
    expect(lengthM).toBeLessThanOrEqual(catalog.designLengthRangeM[1]);
    const spawn = route.spawn.position, finish = route.checkpoints.at(-1)!.center;
    expect(Math.hypot(spawn.x - finish.x, spawn.z - finish.z)).toBeGreaterThan(9);
    expect(isPlayableRoute('CL-01')).toBe(true);
  });

  it('has fast sweepers, sane ramps and banking, an elevated deck and a tunnel', () => {
    expect(Math.min(...frames.map(frame => 1 / Math.max(1e-6, Math.abs(frame.curvature))))).toBeGreaterThan(30);
    expect(Math.max(...frames.map(frame => Math.abs(frame.t.y)))).toBeLessThan(0.11);
    expect(Math.max(...frames.map(frame => Math.abs(frame.bank)))).toBeLessThanOrEqual(0.09 + 1e-9);
    for (let i = 0; i < frames.length; i++) {
      const a = frames[i]!, b = frames[(i + 1) % frames.length]!;
      expect(Math.abs(a.bank - b.bank)).toBeLessThan(0.012);
      expect(a.n.dot(b.n)).toBeGreaterThan(0.999);
    }
    expect(frames.filter((_, i) => coast.elevated(i)).length).toBeGreaterThan(frames.length / 3);
    const tunnel = frames.filter((_, i) => coast.tunnel(i));
    expect(tunnel.length * 2).toBeGreaterThan(80);
    expect(Math.max(...tunnel.map(frame => frame.p.y))).toBeLessThan(-1);
  });

  it('never lets the ground cover the road and ships the same collider set as the ridge', () => {
    let worst = -Infinity;
    for (const frame of frames) for (let lat = -COAST_BARRIER_LAT_M; lat <= COAST_BARRIER_LAT_M + 1e-6; lat += COAST_BARRIER_LAT_M / 4) {
      worst = Math.max(worst, coast.terrain.heightAt(frame.p.x + frame.r.x * lat, frame.p.z + frame.r.z * lat) - (frame.p.y + frame.r.y * lat));
    }
    expect(worst).toBeLessThan(-0.2);
    const [road, left, right] = coast.collisionMeshes;
    expect(road).toMatchObject({ surfaceId: COAST_ROAD_SURFACE, drivableRoad: true });
    for (const barrier of [left, right]) expect(barrier).toMatchObject({ role: 'obstacle', drivableRoad: false });
  });
});
