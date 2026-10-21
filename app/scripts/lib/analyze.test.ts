import { describe, expect, it } from "vitest";
import { analyzeHit, quartiles } from "./analyze.mjs";

const SR = 44100;

describe("analyzeHit", () => {
  it("measures a decaying sine's pitch, length and brightness", () => {
    // 100 Hz, falling 20 dB per 100 ms: -40 dB at 0.2 s.
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 100 * i) / SR) * 10 ** ((-20 * (i / SR / 0.1)) / 20);
    const m = analyzeHit(x, SR);
    expect(m.pitch).toBeGreaterThan(97);
    expect(m.pitch).toBeLessThan(103);
    expect(m.len40).toBeGreaterThan(0.18);
    expect(m.len40).toBeLessThan(0.22);
    expect(m.centroid).toBeLessThan(200);
    expect(m.bands[1]).toBeGreaterThan(0.9);
  });
});

describe("quartiles", () => {
  it("interpolates", () => {
    expect(quartiles([4, 1, 3, 2, 5])).toEqual({ n: 5, q1: 2, median: 3, q3: 4 });
    expect(quartiles([])).toBeNull();
  });
});
