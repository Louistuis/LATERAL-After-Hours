import { describe, expect, it } from "vitest";
import type { InputFrame, RunResult, Vec3 } from "../../contracts/runtime-contracts.js";
import { CAR_MEDAL_PACE, MEDAL_TABLE, carMedalPace, medalTargetsFor, nextMedalTarget, scaleMedalTargets, validMedalTargets } from "../../src/events/medal-targets.js";
import { createRunController } from "../../src/events/run-controller.js";
import { createDriftScorer } from "../../src/events/scoring.js";
import { PLAYABLE_ROUTE_IDS } from "../../src/world/route-registry.js";
import { buildHarborApronCollision, buildHarborCurbCollisions, buildHarborGuardrailCollisions, buildHarborRoute, buildHarborWaterCollision } from "../../src/world/route-data.js";
import { buildRidgePass } from "../../src/world/ridge-pass.js";
import { buildCoastInterchange } from "../../src/world/coast-interchange.js";
import { RouteProgressTracker } from "../../src/core/route-progress.js";
import { DrivingSession } from "../../src/driving/session.js";
import { createVehicleSimulation, VEHICLE_PHYSICS_VERSION } from "../../src/physics/index.js";

const routeOf = (id: string) => id === "HW-01" ? buildHarborRoute().route : id === "RP-01" ? buildRidgePass().ribbon.route : buildCoastInterchange().ribbon.route;

describe("medal targets", () => {
  it.each(PLAYABLE_ROUTE_IDS)("%s has calibrated, ordered targets for its current geometry version", id => {
    const route = routeOf(id);
    expect(MEDAL_TABLE[id]?.routeVersion, `re-measure ${id} with notes/probes/medal-probe.ts after a geometry change`).toBe(route.version);
    for (const mode of ["time-trial", "drift-attack", "rival-ghost"] as const) expect(validMedalTargets(mode, medalTargetsFor(route, mode))).toBe(true);
    expect(medalTargetsFor(route, "rival-ghost")).toEqual(medalTargetsFor(route, "time-trial"));
  });

  it("prefers targets a route declares itself, and gives none to a re-authored route version", () => {
    const route = routeOf("HW-01");
    const own = { gold: 40, silver: 45, bronze: 50 };
    expect(medalTargetsFor({ ...route, medalTargets: { "time-trial": own } }, "time-trial")).toEqual(own);
    expect(medalTargetsFor({ ...route, medalTargets: { "time-trial": { gold: 50, silver: 45, bronze: 40 } } }, "time-trial")).toEqual(MEDAL_TABLE["HW-01"]!.targets["time-trial"]);
    expect(medalTargetsFor({ ...route, version: "hw01-v2" }, "time-trial")).toBeUndefined();
    expect(medalTargetsFor({ ...route, id: "HW-02", version: "x" }, "drift-attack")).toBeUndefined();
  });

  it("scales time targets by the car pace factor, never drift points", () => {
    for (const id of PLAYABLE_ROUTE_IDS) {
      const route = routeOf(id), base = medalTargetsFor(route, "time-trial")!;
      expect(medalTargetsFor(route, "time-trial", "CAR-01")).toEqual(base);
      const fast = medalTargetsFor(route, "time-trial", "CAR-04")!;
      expect(validMedalTargets("time-trial", fast)).toBe(true);
      // The McLaren needs proportionally faster laps for every medal.
      for (const medal of ["gold", "silver", "bronze"] as const) {
        expect(fast[medal]).toBeLessThan(base[medal]);
        expect(Math.abs(fast[medal] - base[medal] * CAR_MEDAL_PACE["CAR-04"]!)).toBeLessThanOrEqual(0.051);
      }
      expect(medalTargetsFor(route, "rival-ghost", "CAR-04")).toEqual(fast);
      expect(medalTargetsFor(route, "drift-attack", "CAR-04")).toEqual(medalTargetsFor(route, "drift-attack"));
    }
    const own = { gold: 40, silver: 45, bronze: 50 };
    expect(medalTargetsFor({ ...routeOf("HW-01"), medalTargets: { "time-trial": own } }, "time-trial", "CAR-04")).toEqual({ gold: 36, silver: 40.5, bronze: 45 });
  });

  it("falls back to pace 1 for unknown or insane factors", () => {
    expect(carMedalPace(undefined)).toBe(1);
    expect(carMedalPace("CAR-03" as never)).toBe(1);
    expect(carMedalPace("CAR-04")).toBeLessThan(1);
    expect(scaleMedalTargets("time-trial", { gold: 50, silver: 55, bronze: 66 }, Number.NaN)).toEqual({ gold: 50, silver: 55, bronze: 66 });
    expect(scaleMedalTargets("drift-attack", { gold: 1200, silver: 400, bronze: 100 }, 0.5)).toEqual({ gold: 1200, silver: 400, bronze: 100 });
    for (const factor of Object.values(CAR_MEDAL_PACE)) expect(factor).toBeGreaterThanOrEqual(0.5);
  });

  it("reports the medal still in reach for the HUD", () => {
    const time = { gold: 50, silver: 55, bronze: 66 }, score = { gold: 1200, silver: 400, bronze: 100 };
    expect(nextMedalTarget("time-trial", time, 49)).toEqual({ medal: "gold", target: 50 });
    expect(nextMedalTarget("time-trial", time, 60)).toEqual({ medal: "bronze", target: 66 });
    expect(nextMedalTarget("time-trial", time, 70)).toBeNull();
    expect(nextMedalTarget("drift-attack", score, 0)).toEqual({ medal: "bronze", target: 100 });
    expect(nextMedalTarget("drift-attack", score, 500)).toEqual({ medal: "gold", target: 1200 });
    expect(nextMedalTarget("drift-attack", score, 5000)).toBeNull();
  });

  it("a full-throttle newcomer on Assist High earns HW-01 time trial bronze through the real run controller", async () => {
    const { route, collision } = buildHarborRoute();
    const sim = await createVehicleSimulation({ ground: false, spawn: route.spawn, carId: "CAR-01", tune: "Balanced", assist: "high" });
    for (const m of [collision, buildHarborApronCollision(), buildHarborWaterCollision(), ...buildHarborCurbCollisions(), ...buildHarborGuardrailCollisions()]) sim.addStaticTriangleMesh(m.vertices, m.indices, m.surfaceId, 0.9, m.role ?? "surface");
    const run = createRunController({ eventId: "HW-01:time-trial", routeId: route.id, mode: "time-trial", rulesVersion: "drift-score-v3-provisional",
      routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION, carId: "CAR-01", tuneHash: sim.getTuneIdentity(), checkpoints: route.checkpoints,
      countdownSeconds: 0, medalTargets: medalTargetsFor(route, "time-trial") }, () => "medal-newcomer");
    run.startCountdown(); run.activate();
    const tracker = new RouteProgressTracker(route.centerline, route.widthM);
    let progress = tracker.update(sim.snapshot().position), result: RunResult | null = null;
    const session = new DrivingSession({ simulation: sim, run, scorer: createDriftScorer({ rulesVersion: "drift-score-v3-provisional", routeLengthM: route.lengthM }),
      routeEvidence: (_p, cur, cps) => { progress = tracker.update(cur.position);
        return { routeProgressM: progress.progressM, legalCorridor: progress.legal, runViolation: progress.violation ?? undefined, checkpointValid: !cps?.invalidCrossing,
          roadContact: cur.wheels.filter(w => w.contact && w.surfaceId === collision.surfaceId).length >= 3 }; },
      onRunFinished: r => { result = r; } });
    const c = route.centerline, d = [0];
    for (let i = 1; i < c.length; i++) d.push(d.at(-1)! + Math.hypot(c[i]!.x - c[i - 1]!.x, c[i]!.y - c[i - 1]!.y, c[i]!.z - c[i - 1]!.z));
    const pointAt = (x: number): Vec3 => { x = Math.min(d.at(-1)!, x); let i = 1; while (i < d.length - 1 && d[i]! < x) i++; const a = c[i - 1]!, b = c[i]!, t = (x - d[i - 1]!) / (d[i]! - d[i - 1]!); return { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t }; };
    let held = 0, steer = 0;
    const input = (tick: number): InputFrame => {
      const s = sim.snapshot(), v = Math.hypot(s.linearVelocityMS.x, s.linearVelocityMS.z), t = pointAt(progress.progressM + Math.max(6, v * 0.5)), q = s.rotation;
      const err = Math.atan2(Math.sin(Math.atan2(t.x - s.position.x, -(t.z - s.position.z)) - Math.atan2(-2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))), Math.cos(Math.atan2(t.x - s.position.x, -(t.z - s.position.z)) - Math.atan2(-2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))));
      if (held > 0) held--; else { steer = Math.abs(err) > 0.07 ? Math.sign(err) : 0; if (steer) held = 6; }
      return { simulationTick: tick, throttle: 1, brake: 0, steering: steer, handbrake: 0, shift: 0, resetPressed: false };
    };
    try { for (let tick = 1; tick <= 6000 && !result; tick++) session.advance(1 / 60, input); } finally { session.dispose(); }
    expect(result).toMatchObject({ valid: true, medal: "bronze" });
  }, 60_000);
});
