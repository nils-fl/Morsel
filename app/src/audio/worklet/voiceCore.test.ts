import { describe, expect, it } from "vitest";
import { defaultKeys, defaultPad } from "../../state/store";
import { DECAY_MAX } from "../dsp";
import { Param, SampleVoice, SynthVoice, biquadCoefficients, hermite, tablesFor, type SampleData } from "./voiceCore";

const SR = 48000;

/** Render a voice for `seconds` (mono or stereo out), in blocks like the audio thread. `ended`: the block it ended in. */
function render(v: SampleVoice | SynthVoice, seconds: number, channels = 2) {
  const n = Math.round(seconds * SR);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  let ended = -1;
  for (let f = 0; f < n; f += 128) {
    const block = out.map((c) => c.subarray(f, Math.min(n, f + 128)));
    if (!v.render(block, f, block[0].length)) {
      ended = f;
      break;
    }
  }
  return { out, ended };
}

const lastSound = (c: Float32Array) => {
  for (let i = c.length - 1; i >= 0; i--) if (Math.abs(c[i]) > 1e-6) return i;
  return -1;
};

describe("Param (AudioParam timeline)", () => {
  it("sets, ramps and approaches a target", () => {
    const p = new Param(1);
    expect(p.at(0)).toBe(1);
    p.set(0, 1);
    p.linear(1, 2);
    p.target(0.5, 2, 0.1);
    expect(p.at(0.5)).toBe(1);
    expect(p.at(1)).toBe(0);
    expect(p.at(1.5)).toBeCloseTo(0.5);
    expect(p.at(2)).toBeCloseTo(1);
    expect(p.at(2.1)).toBeCloseTo(0.5 + 0.5 * Math.exp(-1));
    expect(p.at(5)).toBeCloseTo(0.5);
  });

  it("holds mid-ramp without changing what comes before", () => {
    const p = new Param(0);
    p.set(0, 0);
    p.linear(1, 1);
    p.hold(0.5);
    expect(p.at(0.25)).toBeCloseTo(0.25);
    expect(p.at(0.5)).toBeCloseTo(0.5);
    expect(p.at(3)).toBeCloseTo(0.5);
    p.linear(0, 0.6);
    expect(p.at(0.55)).toBeCloseTo(0.25);
    expect(p.at(1)).toBe(0);
  });

  it("holds a target curve at its value, then a new target starts from there", () => {
    const p = new Param(0);
    p.set(1, 0);
    p.target(0, 0, 0.1);
    p.hold(0.1);
    const v = Math.exp(-1);
    expect(p.at(0.2)).toBeCloseTo(v);
    p.target(1, 0.1, 0.1);
    expect(p.at(0.2)).toBeCloseTo(1 - (1 - v) * Math.exp(-1));
  });
});

describe("biquad", () => {
  it("uses the spec's lowpass formula with Q in dB", () => {
    const [b0, b1, b2, a1, a2] = biquadCoefficients("lowpass", 1000, 0, SR);
    const w = (2 * Math.PI * 1000) / SR;
    const alpha = Math.sin(w) / 2;
    const a0 = 1 + alpha;
    expect(b0).toBeCloseTo((1 - Math.cos(w)) / 2 / a0, 12);
    expect(b1).toBeCloseTo((1 - Math.cos(w)) / a0, 12);
    expect(b2).toBeCloseTo(b0, 12);
    expect(a1).toBeCloseTo((-2 * Math.cos(w)) / a0, 12);
    expect(a2).toBeCloseTo((1 - alpha) / a0, 12);
  });

  it("passes or blocks everything at the ends, like Chrome", () => {
    expect(biquadCoefficients("lowpass", SR, 0, SR)).toEqual([1, 0, 0, 0, 0]);
    expect(biquadCoefficients("highpass", 0, 0, SR)).toEqual([1, 0, 0, 0, 0]);
    expect(biquadCoefficients("lowpass", 0, 0, SR)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("oscillator tables", () => {
  it("normalizes the full-band table to peak 1 and drops partials up the ranges", () => {
    const { tables, size } = tablesFor("sawtooth", SR);
    expect(size).toBe(4096);
    expect(Math.max(...tables[0].map(Math.abs))).toBeCloseTo(1, 5);
    expect(tables.at(-1)!.every((v) => v === 0)).toBe(true);
  });

  it("makes the sine a sine", () => {
    const { tables, size } = tablesFor("sine", SR);
    expect(tables[0][size / 4]).toBeCloseTo(1, 5);
    expect(tables[0][0]).toBeCloseTo(0, 5);
  });
});

const ones = (frames: number, channels = 1): SampleData => ({ sampleRate: SR, channels: Array.from({ length: channels }, () => new Float32Array(frames).fill(1)) });

const sampleVoice = (pad: Partial<ReturnType<typeof defaultPad>>, data: SampleData, when = 0, vel = 127) =>
  new SampleVoice({ kind: "sample", sample: "s", pad: { ...defaultPad(0), decay: 2, ...pad }, vel, pitchOffset: 0, gate: false }, data, when, SR);

describe("sample voice", () => {
  it("plays the region at the pad's volume, through the mono pan law", () => {
    const { out, ended } = render(sampleVoice({ start: 0.25, end: 0.75, attack: 0, volume: 1 }, ones(4800)), 0.2);
    const center = Math.SQRT1_2;
    expect(out[0][1000]).toBeCloseTo(center, 4);
    expect(out[1][1000]).toBeCloseTo(center, 4);
    // 2400 frames of region (50 ms), then silent and ended by the source's stop.
    expect(lastSound(out[0])).toBe(2399);
    expect(ended).toBeGreaterThan(2399 - 128);
  });

  it("keeps stereo samples' sides at the centre", () => {
    const data: SampleData = { sampleRate: SR, channels: [new Float32Array(4800).fill(1), new Float32Array(4800).fill(-1)] };
    const { out } = render(sampleVoice({ attack: 0, volume: 1 }, data), 0.05);
    expect(out[0][1000]).toBeCloseTo(1, 4);
    expect(out[1][1000]).toBeCloseTo(-1, 4);
  });

  it("reads reversed samples backwards", () => {
    const ramp = new Float32Array(4800).map((_, i) => i / 4800);
    const { out } = render(sampleVoice({ attack: 0, volume: 1, reverse: true }, { sampleRate: SR, channels: [ramp] }), 0.05);
    expect(out[0][100] / Math.SQRT1_2).toBeCloseTo(ramp[4799 - 100], 3);
  });

  it("interpolates with a Hermite curve: exact on frames, closer than a line between them", () => {
    expect(hermite(0.1, 0.4, -0.3, 0.9, 0)).toBe(0.4);
    expect(hermite(0.1, 0.4, -0.3, 0.9, 1)).toBeCloseTo(-0.3, 12);
    // A 5 kHz sine read halfway between frames.
    const w = (2 * Math.PI * 5000) / SR;
    let herr = 0, lerr = 0;
    for (let i = 1; i < 100; i++) {
      const s = (k: number) => Math.sin(w * k);
      const truth = s(i + 0.5);
      herr = Math.max(herr, Math.abs(hermite(s(i - 1), s(i), s(i + 1), s(i + 2), 0.5) - truth));
      lerr = Math.max(lerr, Math.abs((s(i) + s(i + 1)) / 2 - truth));
    }
    expect(herr).toBeLessThan(lerr / 3);
  });

  it("fades the last 2 ms of a region that has no fade of its own", () => {
    const { out } = render(sampleVoice({ start: 0, end: 0.5, attack: 0, volume: 1, decay: DECAY_MAX }, ones(4800)), 0.1);
    const end = 2400;
    expect(out[0][end - 200]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(out[0][end - 48]).toBeLessThan(Math.SQRT1_2 / 2 + 0.01);
    expect(Math.abs(out[0][end - 1])).toBeLessThan(0.01);
  });

  it("starts at the scheduled frame and a choke fades it out within 5 ms", () => {
    const v = sampleVoice({ attack: 0, volume: 1 }, ones(48000), 0.01);
    v.stop(0.1, true);
    const { out, ended } = render(v, 0.2);
    expect(out[0][479]).toBe(0);
    expect(out[0][600]).toBeGreaterThan(0.5);
    expect(lastSound(out[0])).toBeLessThan(0.1 * SR + 0.005 * SR + 2);
    expect(ended).toBeGreaterThan(0);
  });
});

describe("synth voice", () => {
  it("sounds from its start and ends 50 ms after the release, like its node graph", () => {
    const synth = { ...defaultKeys().synth, attack: 0.002, release: 0.05 };
    const v = new SynthVoice({ kind: "synth", synth, note: 60, vel: 100 }, 0, SR);
    v.stop(0.1, false);
    const { out, ended } = render(v, 0.5, 1);
    const peak = Math.max(...out[0].subarray(0, 4800).map(Math.abs));
    expect(peak).toBeGreaterThan(0.05);
    expect(ended).toBeGreaterThan(0.2 * SR - 128);
    expect(ended).toBeLessThanOrEqual(0.2 * SR);
  });
});
