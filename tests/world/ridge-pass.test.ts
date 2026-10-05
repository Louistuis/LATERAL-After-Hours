import { describe, expect, it } from 'vitest';
import { buildRidgePass, RIDGE_BARRIER_LAT_M, RIDGE_ROAD_SURFACE } from '../../src/world/ridge-pass.js';
import { ROUTES } from '../../content/events/catalog.js';
import { isPlayableRoute, PLAYABLE_ROUTE_IDS } from '../../src/world/route-registry.js';

describe('RP-01 Ridge Pass authored geometry', () => {
  const ridge = buildRidgePass();
  const { frames, route, lengthM } = { ...ridge.ribbon, route: ridge.ribbon.route };

  it('is a closed, catalogued, playable route with ordered gates and a finish behind the spawn', () => {
    expect(route.id).toBe('RP-01');
    expect(route.closed).toBe(true);
    const catalog = ROUTES.find(entry => entry.routeId === 'RP-01')!;
    expect(route.checkpoints.map(gate => gate.id)).toEqual(catalog.checkpointIds);
    expect(lengthM).toBeGreaterThanOrEqual(catalog.designLengthRangeM[0]);
    expect(lengthM).toBeLessThanOrEqual(catalog.designLengthRangeM[1]);
    expect(route.checkpoints.at(-1)!.finish).toBe(true);
    const spawn = route.spawn.position, finish = route.checkpoints.at(-1)!.center;
    const behind = Math.hypot(spawn.x - finish.x, spawn.z - finish.z);
    expect(behind).toBeGreaterThan(9);   // deeper than the 7.2 m online grid
    expect(behind).toBeLessThan(16);
    expect(isPlayableRoute('RP-01')).toBe(true);
    expect(PLAYABLE_ROUTE_IDS).toContain('HW-01');
  });

  it('keeps hairpins drivable: radius, grade, banking and leg separation', () => {
    const minRadius = Math.min(...frames.map(frame => 1 / Math.max(1e-6, Math.abs(frame.curvature))));
    expect(minRadius).toBeGreaterThan(15);
    expect(Math.max(...frames.map(frame => Math.abs(frame.t.y)))).toBeLessThan(0.105);
    expect(Math.max(...frames.map(frame => Math.abs(frame.bank)))).toBeLessThanOrEqual(0.07 + 1e-9);
    // Adjacent frames: no kinks or steps a wheel could catch.
    for (let i = 0; i < frames.length; i++) {
      const a = frames[i]!, b = frames[(i + 1) % frames.length]!;
      expect(a.p.distanceTo(b.p)).toBeLessThan(2.6);
      expect(Math.abs(a.bank - b.bank)).toBeLessThan(0.01);
      expect(a.n.dot(b.n)).toBeGreaterThan(0.999);
    }
    let clearance = Infinity;
    for (let i = 0; i < frames.length; i += 2) for (let j = i + 1; j < frames.length; j += 2) {
      const along = Math.abs(frames[i]!.s - frames[j]!.s);
      if (Math.min(along, lengthM - along) < 70) continue;
      clearance = Math.min(clearance, Math.hypot(frames[i]!.p.x - frames[j]!.p.x, frames[i]!.p.z - frames[j]!.p.z));
    }
    expect(clearance).toBeGreaterThan(2 * RIDGE_BARRIER_LAT_M + 15);
  });

  it('never lets the carved ground cover the road, shoulders or barriers', () => {
    let worst = -Infinity;
    for (const frame of frames) for (let lat = -RIDGE_BARRIER_LAT_M; lat <= RIDGE_BARRIER_LAT_M + 1e-6; lat += RIDGE_BARRIER_LAT_M / 4) {
      const x = frame.p.x + frame.r.x * lat, z = frame.p.z + frame.r.z * lat, y = frame.p.y + frame.r.y * lat;
      worst = Math.max(worst, ridge.terrain.heightAt(x, z) - y);
    }
    expect(worst).toBeLessThan(-0.5);
  });

  it('ships one seamless drivable strip, two continuous barriers and off-road ground', () => {
    const [road, left, right, ground] = ridge.collisionMeshes;
    expect(road).toMatchObject({ surfaceId: RIDGE_ROAD_SURFACE, drivableRoad: true });
    expect(road!.indices.length / 3).toBe(frames.length * 2);
    for (const barrier of [left, right]) expect(barrier).toMatchObject({ role: 'obstacle', drivableRoad: false });
    expect(left!.indices.length / 3).toBe(frames.length * 8);
    expect(ground).toMatchObject({ drivableRoad: false });
    expect(ground!.indices.length).toBeGreaterThan(3000);
    // Ground under the deck sits clear of the barrier bottoms: no collider overlaps the road strip.
    const roadY = Math.min(...road!.vertices.map(vertex => vertex.y));
    expect(roadY).toBeGreaterThan(5);
  });
});
