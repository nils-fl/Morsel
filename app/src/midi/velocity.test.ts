import { describe, expect, it } from "vitest";
import { velocityThrough } from "./velocity";

describe("velocity curves", () => {
  it("Full leaves the velocity as played", () => {
    for (const v of [1, 40, 64, 100, 127]) expect(velocityThrough("full", v)).toBe(v);
  });
  it("Medium and Light lift soft hits and keep the hardest at 127", () => {
    expect(velocityThrough("medium", 1)).toBe(50);
    expect(velocityThrough("light", 1)).toBe(80);
    for (const c of ["medium", "light"] as const) {
      expect(velocityThrough(c, 127)).toBe(127);
      expect(velocityThrough(c, 40)).toBeGreaterThan(40);
    }
    expect(velocityThrough("light", 40)).toBeGreaterThan(velocityThrough("medium", 40));
  });
  it("keeps the order of the hits", () => {
    for (const c of ["medium", "light"] as const) {
      const out = Array.from({ length: 127 }, (_, i) => velocityThrough(c, i + 1));
      expect(out.every((v, i) => i === 0 || v >= out[i - 1])).toBe(true);
    }
  });
  it("Fixed plays every hit at 127, and a release stays a release", () => {
    expect(velocityThrough("fixed", 12)).toBe(127);
    for (const c of ["full", "medium", "light", "fixed"] as const) expect(velocityThrough(c, 0)).toBe(0);
  });
});
