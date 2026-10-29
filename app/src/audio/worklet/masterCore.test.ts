import { describe, expect, it } from "vitest";
import { CEILING, MasterCore, softClip } from "./masterCore";

const SR = 48000;

/** Run stereo `l`/`r` through a limiter in 128-frame blocks, like the audio thread. */
function run(core: MasterCore, l: Float32Array, r = l) {
  const out = [new Float32Array(l.length), new Float32Array(l.length)];
  for (let f = 0; f < l.length; f += 128) {
    const end = Math.min(l.length, f + 128);
    core.process([l.subarray(f, end), r.subarray(f, end)], out.map((c) => c.subarray(f, end)), end - f);
  }
  return out;
}

const sine = (amp: number, hz: number, seconds: number) =>
  Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

describe("master limiter", () => {
  it("soft clip leaves quiet samples alone and never goes past 1", () => {
    expect(softClip(0.3)).toBe(0.3);
    expect(softClip(-0.5)).toBe(-0.5);
    expect(softClip(0.69)).toBe(0.69);
    expect(softClip(0.9)).toBeLessThan(0.9);
    expect(softClip(10)).toBeLessThanOrEqual(1);
    expect(softClip(-10)).toBeGreaterThanOrEqual(-1);
  });

  it("passes a quiet signal through unchanged, only delayed", () => {
    const core = new MasterCore(SR);
    const x = sine(0.4, 220, 0.1);
    const [y] = run(core, x);
    for (let i = core.latency; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i - core.latency], 6);
  });

  it("keeps stacked full-velocity hits under the ceiling", () => {
    // A kick, an 808 and a crash on the same tick: sharp attacks far above 0 dBFS.
    const n = Math.round(0.5 * SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const kick = 0.9 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 8);
      const boom = 0.9 * Math.sin(2 * Math.PI * 45 * t) * Math.exp(-t * 2);
      const crash = 0.9 * (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.exp(-t * 3);
      l[i] = (kick + boom + crash) * 1.6;
      r[i] = (kick + boom - crash) * 1.6;
    }
    const core = new MasterCore(SR);
    const out = run(core, l, r);
    for (const c of out) for (const v of c) expect(Math.abs(v)).toBeLessThanOrEqual(CEILING + 1e-6);
    const m = core.takeMeter();
    expect(m.gain).toBeLessThan(1);
    expect(m.peak).toBeGreaterThan(0.9);
    expect(core.takeMeter()).toEqual({ peak: 0, gain: 1 });
  });

  it("recovers after a loud hit, slowly enough not to move within a bass cycle", () => {
    const core = new MasterCore(SR);
    run(core, sine(3, 100, 0.05));
    const after = sine(0.3, 220, 2);
    const [y] = run(core, after);
    const gainAt = (s: number) => {
      const end = Math.round(s * SR);
      const tail = y.subarray(end - 1000, end);
      const src = after.subarray(end - 1000 - core.latency, end - core.latency);
      return Math.max(...tail.map(Math.abs)) / Math.max(...src.map(Math.abs));
    };
    // About 63% of the way back after the 250 ms release, and back to (almost) 1 two seconds later.
    const start = 1 / 3;
    const at = (gainAt(0.27) - start) / (1 - start);
    expect(at).toBeGreaterThan(0.5);
    expect(at).toBeLessThan(0.8);
    expect(gainAt(2)).toBeGreaterThan(0.99);
  });

  it("leaves a loud signal under the ceiling untouched: no saturation on the way", () => {
    const core = new MasterCore(SR);
    const x = sine(0.89, 110, 0.2); // −1 dBFS: the old soft clip bent everything above −3 dBFS
    const [y] = run(core, x);
    for (let i = core.latency; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i - core.latency], 6);
  });
});
