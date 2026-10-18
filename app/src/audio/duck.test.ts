import { describe, expect, it } from "vitest";
import { duckGainAt, duckRamp } from "./duck";

describe("ducker", () => {
  it("holds at the hit, dips toward 1 - depth from the hit, recovers after the attack", () => {
    const pts = duckRamp(10, 0.8, 0.006, 0.3);
    expect(pts.map((p) => p.kind)).toEqual(["hold", "target", "target"]);
    // Nothing is scheduled before the hit, so the level before it is untouched.
    expect(Math.min(...pts.map((p) => p.t))).toBe(10);
    expect(pts[1].t).toBe(10);
    expect(pts[1].v).toBeCloseTo(0.2);
    expect(pts[1].tau).toBeCloseTo(0.002);
    expect(pts[2]).toMatchObject({ t: 10.006, v: 1, kind: "target" });
    expect(pts[2].tau).toBeCloseTo(0.1);
  });
  it("clamps depth and keeps attack/release usable", () => {
    expect(duckRamp(0, 5, 0, 0)[1].v).toBe(0);
    expect(duckRamp(0, -1, 0, 0)[1].v).toBe(1);
    expect(duckRamp(0, 0.5, 0, 0)[1].tau).toBeGreaterThan(0);
    expect(duckRamp(0, 0.5, 0, 0)[2].t).toBeGreaterThan(0);
    expect(duckRamp(0, 0.5, 0, 0)[2].tau).toBeGreaterThan(0);
  });
  it("draws the same curve it schedules: floor after attack, mostly back after the release", () => {
    const c = { depth: 0.8, attack: 0.01, release: 0.3 };
    expect(duckGainAt(-0.1, c)).toBe(1);
    expect(duckGainAt(0.01, c)).toBeLessThan(0.25);
    expect(duckGainAt(0.31, c)).toBeGreaterThan(0.95);
  });
});
