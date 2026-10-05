import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../contracts/runtime-contracts.js';
import { buildHarborApronCollision, buildHarborGuardrailCollisions, buildHarborRoute } from '../../src/world/route-data.js';
import { createVehicleSimulation } from '../../src/physics/index.js';

function entryAtStation(stationM: number): { center: Vec3; forward: Vec3; right: Vec3 } {
  const { route } = buildHarborRoute();
  let distance = 0;
  for (let index = 1; index < route.centerline.length; index++) {
    const a = route.centerline[index - 1]!, b = route.centerline[index]!;
    const segment = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (distance + segment >= stationM) {
      const fraction = (stationM - distance) / segment;
      const center = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, z: a.z + (b.z - a.z) * fraction };
      const horizontal = Math.hypot(b.x - a.x, b.z - a.z);
      const forward = { x: (b.x - a.x) / horizontal, y: 0, z: (b.z - a.z) / horizontal };
      return { center, forward, right: { x: -forward.z, y: 0, z: forward.x } };
    }
    distance += segment;
  }
  throw new Error('Station is outside the authored centerline');
}

async function strikeRightRail(angleDeg: number): Promise<{ contactFrames: number; firstRoadWheels: number; maxSpeedDeltaMS: number; maximumImpulseNs: number }> {
  const { collision } = buildHarborRoute();
  const { center, forward, right } = entryAtStation(107);
  const angle = angleDeg * Math.PI / 180;
  const direction = { x: forward.x * Math.cos(angle) + right.x * Math.sin(angle), y: 0,
    z: forward.z * Math.cos(angle) + right.z * Math.sin(angle) };
  const yaw = Math.atan2(-direction.x, -direction.z);
  const simulation = await createVehicleSimulation({ ground: false, carId: 'CAR-01', tune: 'Balanced',
    spawn: { position: { x: center.x + right.x * 6.4, y: center.y + 0.93, z: center.z + right.z * 6.4 },
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      linearVelocityMS: { x: direction.x * 9, y: 0, z: direction.z * 9 } } });
  simulation.addStaticTriangleMesh(collision.vertices, collision.indices, collision.surfaceId, 0.9);
  const apron = buildHarborApronCollision();
  simulation.addStaticTriangleMesh(apron.vertices, apron.indices, apron.surfaceId, 0.9);
  for (const barrier of buildHarborGuardrailCollisions()) {
    simulation.addStaticTriangleMesh(barrier.vertices, barrier.indices, barrier.surfaceId, 0.9, 'obstacle');
  }
  let contactFrames = 0, firstRoadWheels = -1, maxSpeedDeltaMS = 0, maximumImpulseNs = 0;
  try {
    for (let tick = 1; tick <= 150; tick++) {
      simulation.step({ simulationTick: tick, throttle: 0, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false });
      const contact = simulation.collisionTelemetry();
      if (contact.colliderIds.includes('barrier:harbor:hw01:right')) {
        contactFrames++;
        if (firstRoadWheels < 0) firstRoadWheels = simulation.snapshot().wheels.filter(wheel => wheel.contact && wheel.surfaceId === collision.surfaceId).length;
        maxSpeedDeltaMS = Math.max(maxSpeedDeltaMS, contact.speedDeltaMS);
        maximumImpulseNs = Math.max(maximumImpulseNs, contact.impulseNs);
      }
    }
    return { contactFrames, firstRoadWheels, maxSpeedDeltaMS, maximumImpulseNs };
  } finally { simulation.dispose(); }
}

describe('HW-01 v1.0.3 physical guardrail collision', () => {
  it('reports a brief glancing and a sustained direct obstacle contact', async () => {
    const glancing = await strikeRightRail(18);
    const direct = await strikeRightRail(25);
    expect(glancing.contactFrames).toBeGreaterThan(0);
    expect(direct.contactFrames).toBeGreaterThan(glancing.contactFrames);
    for (const contact of [glancing, direct]) {
      expect(contact.firstRoadWheels).toBeLessThan(3);
      expect(contact.maxSpeedDeltaMS).toBeGreaterThan(0);
      expect(contact.maximumImpulseNs).toBeGreaterThan(0);
    }
  });
});
