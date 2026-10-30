import { describe, expect, it } from "vitest";
import { FFT, hpss, istft, medianFilter, reflectPad, stft } from "./hpss";

const noise = (n: number, seed = 1) => {
  let s = seed;
  return Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
};
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const energy = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);

describe("FFT", () => {
  it("finds a sine in its bin and inverts back", () => {
    const n = 64, fft = new FFT(n);
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n)), im = new Float64Array(n);
    const orig = re.slice();
    fft.run(re, im);
    expect(re[5]).toBeCloseTo(n / 2, 6);
    expect(Math.abs(re[6])).toBeLessThan(1e-9);
    fft.run(re, im, true);
    re.forEach((v, i) => expect(v / n).toBeCloseTo(orig[i], 9));
  });
});

describe("reflectPad", () => {
  it("mirrors without repeating the edge sample, as torch does", () => {
    expect([...reflectPad(Float32Array.of(1, 2, 3, 4), 2, 1)]).toEqual([3, 2, 1, 2, 3, 4, 3]);
  });
});

describe("stft / istft", () => {
  it("gives the signal back", () => {
    const x = noise(10000);
    expect(maxDiff(istft(stft(x, 512, 128), 512, 128, x.length), x)).toBeLessThan(1e-5);
  });

  it("is normalized like torch (a Hann-windowed frame of ones sums to nfft / 2 / sqrt(nfft))", () => {
    const z = stft(new Float32Array(2048).fill(1), 512, 128);
    expect(z.re[8]).toBeCloseTo(256 / Math.sqrt(512), 4);
  });
});

describe("medianFilter", () => {
  it("takes the median along time (rows) or frequency (columns), shorter at the edges", () => {
    // 2 bins × 4 frames.
    const g = Float32Array.of(1, 9, 2, 3, 5, 5, 0, 5);
    expect([...medianFilter(g, 2, 4, 3, "time")]).toEqual([9, 2, 3, 3, 5, 5, 5, 5]);
    expect([...medianFilter(g, 2, 4, 3, "freq")]).toEqual([5, 9, 2, 5, 5, 9, 2, 5]);
  });
});

describe("hpss", () => {
  const rate = 44100, n = rate * 2;
  const clicks = Float32Array.from({ length: n }, (_, i) => (i % 11025 === 0 ? 1 : 0));
  const chord = Float32Array.from({ length: n }, (_, i) => [220, 277.2, 329.6].reduce((s, f) => s + 0.2 * Math.sin((2 * Math.PI * f * i) / rate), 0));

  it("adds back up to the input", () => {
    const mix = clicks.map((v, i) => v + chord[i]);
    const { drums, harmonic } = hpss([mix]);
    expect(maxDiff(drums[0].map((v, i) => v + harmonic[0][i]), mix)).toBeLessThan(1e-4);
  });

  it("puts clicks in the drums and a held chord in the rest", () => {
    const hits = hpss([clicks]);
    expect(energy(hits.drums[0]) / energy(clicks)).toBeGreaterThan(0.9);
    const tones = hpss([chord]);
    expect(energy(tones.harmonic[0]) / energy(chord)).toBeGreaterThan(0.9);
  });

  it("keeps the stereo picture: a left-only sound stays left", () => {
    const { drums, harmonic } = hpss([clicks.map((v, i) => v + chord[i]), new Float32Array(n)]);
    expect(energy(drums[1]) + energy(harmonic[1])).toBeLessThan(1e-12);
  });

  it("copes with a sample shorter than a window", () => {
    const short = noise(300);
    const { drums, harmonic } = hpss([short]);
    expect(drums[0]).toHaveLength(300);
    expect(maxDiff(drums[0].map((v, i) => v + harmonic[0][i]), short)).toBeLessThan(1e-4);
  });
});
