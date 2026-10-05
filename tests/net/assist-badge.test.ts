import { describe, expect, it } from "vitest";
import { plausibleEntry } from "../../src/net/leaderboard";
import { parseMember } from "../../src/net/lobby";
import { VEHICLE_PHYSICS_VERSION } from "../../src/vehicle/tune-identity";

describe("assist level on net results", () => {
  const row = (assist: unknown) => ({ id: "r", username: "dana", route: "HW-01", mode: "time-trial", value: 61_250, car: "CAR-01", pv: VEHICLE_PHYSICS_VERSION, assist });
  it("whitelists the leaderboard assist field and drops anything else", () => {
    expect(plausibleEntry(row("high"), "HW-01", "time-trial")?.assist).toBe("high");
    expect(plausibleEntry(row("off"), "HW-01", "time-trial")?.assist).toBe("off");
    for (const bad of ["turbo", 2, null, undefined, { toString: () => "high" }]) {
      const entry = plausibleEntry(row(bad), "HW-01", "time-trial");
      expect(entry).not.toBeNull();
      expect(entry && "assist" in entry).toBe(false);
    }
  });
  it("reads the optional assist code from a race finish and ignores junk", () => {
    expect(parseMember("a", { rp: [3, 99, 0, 61_000, 0, 1] }).rp?.[5]).toBe(1);
    expect(parseMember("a", { rp: [3, 99, 0, 61_000, 0, 7] }).rp).toHaveLength(5);
    expect(parseMember("a", { rp: [3, 99, 0, 61_000, 0] }).rp).toHaveLength(5);
  });
});
