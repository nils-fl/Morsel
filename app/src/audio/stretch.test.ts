import { describe, expect, it } from "vitest";
import { stretch } from "./stretch";

const SR = 44100;
const sine = (hz: number, n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR));
const crossings = (x: Float32Array, from = 0, to = x.length) => {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
  return n;
};

describe("stretch", () => {
  it("gives exactly the length asked for", () => {
    const [out] = stretch([sine(220, SR)], SR, Math.round(SR * 1.15));
    expect(out.length).toBe(Math.round(SR * 1.15));
  });

  it("keeps the pitch, slower or faster", () => {
    for (const ratio of [78 / 90, 90 / 78, 0.5]) {
      const [out] = stretch([sine(440, SR)], SR, Math.round(SR * ratio));
      // Away from the ends: 880 crossings a second.
      const a = Math.round(0.1 * out.length), b = Math.round(0.9 * out.length);
      const perSecond = (crossings(out, a, b) / (b - a)) * SR;
      expect(perSecond).toBeGreaterThan(880 * 0.98);
      expect(perSecond).toBeLessThan(880 * 1.02);
    }
  });

  it("keeps the level of a steady tone", () => {
    const [out] = stretch([sine(300, SR)], SR, Math.round(SR * 1.2));
    const peak = out.subarray(SR * 0.1, SR * 1.1).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.95);
    expect(peak).toBeLessThan(1.05);
  });

  it("lands every anchored hit on its scaled position, unfaded", () => {
    const n = SR, hits = [0, 0.25, 0.5, 0.75].map((f) => Math.round(f * n));
    const x = new Float32Array(n);
    // Clicks decaying into a low hum, like drum hits.
    for (const h of hits) for (let i = 0; i < 2000 && h + i < n; i++) x[h + i] += Math.exp(-i / 300) * (i === 0 ? 1 : 0.3 * Math.sin(i / 20));
    for (const outLen of [Math.round((n * 78) / 90), Math.round((n * 90) / 78)]) {
      const [out] = stretch([x], SR, outLen, hits.slice(1));
      for (const h of hits) {
        const at = Math.round((h * outLen) / n);
        expect(out[at]).toBeCloseTo(1, 5);
      }
    }
  });

  it("stretches every channel the same way", () => {
    const l = sine(330, SR), r = sine(330, SR);
    const [a, b] = stretch([l, r], SR, Math.round(SR * 0.8), [SR / 2]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
