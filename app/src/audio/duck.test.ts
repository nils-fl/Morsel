import { describe, expect, it } from "vitest";
import { duckGainAt, duckRamp } from "./duck";

const env = (depth: number, attack: number, hold: number, release: number) => ({ depth, attack, hold, release });

describe("ducker", () => {
  it("holds at the hit, dips toward 1 - depth, recovers after attack + hold", () => {
    const pts = duckRamp(10, env(0.8, 0.006, 0.05, 0.3));
    expect(pts.map((p) => p.kind)).toEqual(["hold", "target", "target"]);
    // Nothing is scheduled before the hit, so the level before it is untouched.
    expect(Math.min(...pts.map((p) => p.t))).toBe(10);
    expect(pts[1].t).toBe(10);
    expect(pts[1].v).toBeCloseTo(0.2);
    expect(pts[1].tau).toBeCloseTo(0.002);
    expect(pts[2].t).toBeCloseTo(10.056);
    expect(pts[2]).toMatchObject({ v: 1, kind: "target" });
    expect(pts[2].tau).toBeCloseTo(0.1);
  });
  it("clamps depth and keeps attack/hold/release usable", () => {
    expect(duckRamp(0, env(5, 0, 0, 0))[1].v).toBe(0);
    expect(duckRamp(0, env(-1, 0, 0, 0))[1].v).toBe(1);
    expect(duckRamp(0, env(0.5, 0, -1, 0))[2].t).toBeGreaterThan(0);
    expect(duckRamp(0, env(0.5, 0, 0, 0))[1].tau).toBeGreaterThan(0);
    expect(duckRamp(0, env(0.5, 0, 0, 0))[2].tau).toBeGreaterThan(0);
  });
  it("stays down through the hold, then comes back over the release", () => {
    const c = env(0.85, 0.005, 0.06, 0.3);
    expect(duckGainAt(-0.1, c)).toBe(1);
    expect(duckGainAt(0.02, c)).toBeLessThan(0.2);
    expect(duckGainAt(0.06, c)).toBeLessThan(0.2); // still held
    expect(duckGainAt(0.065 + 0.1, c)).toBeLessThan(0.75); // a third of the way through the release: clearly audible
    expect(duckGainAt(0.065 + 0.3, c)).toBeGreaterThan(0.9);
  });
});
