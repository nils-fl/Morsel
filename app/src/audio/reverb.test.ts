import { describe, expect, it } from "vitest";
import { MAX_PREDELAY, reverbImpulseData } from "./reverb";

const SR = 48000;
const room = { size: 0.5, decay: 0.5, predelay: 0.25, tone: 0.5, level: 0.8 };
const energy = (chans: Float32Array[]) => chans.reduce((e, d) => e + d.reduce((s, v) => s + v * v, 0), 0);

describe("reverb impulse", () => {
  it("is the same every time for the same knobs", () => {
    expect(reverbImpulseData(SR, room)).toEqual(reverbImpulseData(SR, room));
  });

  it("has a wide (decorrelated) stereo tail", () => {
    const [l, r] = reverbImpulseData(SR, room);
    let lr = 0;
    for (let i = 0; i < l.length; i++) lr += l[i] * r[i];
    expect(Math.abs(lr) / Math.sqrt(energy([l]) * energy([r]))).toBeLessThan(0.2);
  });

  it("keeps the level when the size changes", () => {
    const small = energy(reverbImpulseData(SR, { ...room, size: 0 }));
    const big = energy(reverbImpulseData(SR, { ...room, size: 1 }));
    expect(big / small).toBeCloseTo(1, 3);
  });

  it("starts after the pre-delay", () => {
    const [l] = reverbImpulseData(SR, { ...room, predelay: 1 });
    const silent = Math.round(MAX_PREDELAY * SR);
    expect(l.subarray(0, silent).every((v) => v === 0)).toBe(true);
    expect(l.subarray(silent).some((v) => v !== 0)).toBe(true);
  });

  it("gets darker as it fades", () => {
    // High-frequency content: the energy of the sample-to-sample differences, relative to the signal's.
    const brightness = (d: Float32Array) => {
      let diff = 0, all = 0;
      for (let i = 1; i < d.length; i++) {
        diff += (d[i] - d[i - 1]) ** 2;
        all += d[i] ** 2;
      }
      return diff / all;
    };
    const [l] = reverbImpulseData(SR, room);
    const early = l.subarray(Math.round(0.1 * SR), Math.round(0.3 * SR));
    const late = l.subarray(Math.round(1.5 * SR), Math.round(1.7 * SR));
    expect(brightness(late)).toBeLessThan(brightness(early) * 0.6);
  });
});
