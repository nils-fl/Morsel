import { describe, expect, it } from "vitest";
import { defaultKeys, defaultPad } from "../../state/store";
import { DECAY_MAX, RELEASE_TAIL, driveCurve } from "../dsp";
import { Expression, Oversampler2x, Param, SampleVoice, SynthVoice, biquadCoefficients, hermite, tablesFor, type SampleData } from "./voiceCore";

const SR = 48000;

/**
 * Render a voice for `seconds` (mono or stereo out), in blocks like the audio thread, bent by `expr` as the processor
 * does. `ended`: the block it ended in.
 */
function render(v: SampleVoice | SynthVoice, seconds: number, channels = 2, expr?: Expression) {
  const n = Math.round(seconds * SR);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  let ended = -1;
  for (let f = 0; f < n; f += 128) {
    const block = out.map((c) => c.subarray(f, Math.min(n, f + 128)));
    expr?.fill(f, block[0].length, SR);
    if (!v.render(block, f, block[0].length, expr)) {
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
  it("sounds from its start and ends once its release has faded 90 dB, like its node graph", () => {
    const synth = { ...defaultKeys().synth, attack: 0.002, release: 0.05 };
    const v = new SynthVoice({ kind: "synth", synth, note: 60, vel: 100 }, 0, SR);
    v.stop(0.1, false);
    const { out, ended } = render(v, 0.5, 1);
    const peak = Math.max(...out[0].subarray(0, 4800).map(Math.abs));
    expect(peak).toBeGreaterThan(0.05);
    const end = 0.1 + 0.05 * RELEASE_TAIL + 0.01; // stop + release x RELEASE_TAIL, not release + 50 ms
    expect(ended).toBeGreaterThan(end * SR - 128);
    expect(ended).toBeLessThanOrEqual(end * SR + 128);
    // Just before it ends it's (nearly) silent: no tick when it stops.
    const last = Math.max(...out[0].subarray(ended - 256, ended - 128).map(Math.abs));
    expect(last / peak).toBeLessThan(Math.pow(10, -80 / 20));
  });
});

describe("expression (the Launchkey's strips)", () => {
  // A plain sine: osc 2, sub, noise, drive and the filter out of the way, so zero crossings count the pitch.
  const sine = { ...defaultKeys().synth, wave: "sine" as const, osc2Level: 0, sub: 0, noise: 0, drive: 0, cutoff: 1, envAmount: 0, attack: 0.002, sustain: 1 };
  const crossings = (c: Float32Array, from: number, to: number) => {
    let n = 0;
    for (let i = from + 1; i < to; i++) if ((c[i - 1] < 0) !== (c[i] < 0)) n++;
    return n;
  };

  it("bends a synth note an octave up at +1200 cents, held notes too", () => {
    const straight = render(new SynthVoice({ kind: "synth", synth: sine, note: 57, vel: 100 }, 0, SR), 0.5, 1).out[0];
    const expr = new Expression();
    expr.set(0.1, 1200, 0);
    const bent = render(new SynthVoice({ kind: "synth", synth: sine, note: 57, vel: 100 }, 0, SR), 0.5, 1, expr).out[0];
    // Before the bend the two match; well after it (0.3–0.5 s) the bent one crosses zero twice as often.
    expect(crossings(bent, 0, 4800)).toBe(crossings(straight, 0, 4800));
    expect(crossings(bent, 0.3 * SR, 0.5 * SR) / crossings(straight, 0.3 * SR, 0.5 * SR)).toBeCloseTo(2, 1);
  });

  it("bends a sample voice: an octave up plays the region in half the time", () => {
    const pad = { decay: DECAY_MAX, attack: 0.001 };
    const straight = render(sampleVoice(pad, ones(SR)), 1.5);
    const expr = new Expression();
    expr.set(0, 1200, 0);
    const bent = render(sampleVoice(pad, ones(SR)), 1.5, 2, expr);
    expect(straight.ended).toBeGreaterThan(0.99 * SR);
    expect(Math.abs(bent.ended - 0.5 * SR)).toBeLessThan(0.01 * SR);
  });

  it("leaves voices exactly as they were while the strips are at rest", () => {
    const synth = { ...defaultKeys().synth, attack: 0.002 };
    const plain = render(new SynthVoice({ kind: "synth", synth, note: 60, vel: 100 }, 0, SR), 0.2, 1).out[0];
    const rested = render(new SynthVoice({ kind: "synth", synth, note: 60, vel: 100 }, 0, SR), 0.2, 1, new Expression()).out[0];
    expect(Array.from(rested)).toEqual(Array.from(plain));
  });

  it("eases to a new value in a few milliseconds and settles back to rest", () => {
    const expr = new Expression();
    expr.set(0, 100, 0.5);
    expr.fill(0, 128, SR);
    expect(expr.bend[0]).toBeGreaterThan(0);
    expect(expr.bend[0]).toBeLessThan(5);
    for (let f = 128; f < 0.1 * SR; f += 128) expr.fill(f, 128, SR);
    expect(expr.bend[127]).toBeCloseTo(100, 1);
    expect(expr.mod[127]).toBeCloseTo(0.5, 3);
    expr.set(0.1, 0, 0);
    for (let f = 0.1 * SR; f < 0.5 * SR; f += 128) expr.fill(f, 128, SR);
    expect(expr.idle).toBe(true);
    expect(expr.bend.every((x) => x === 0)).toBe(true);
  });

  it("adds vibrato with the mod wheel, the pitch swinging both ways", () => {
    const expr = new Expression();
    expr.set(0, 0, 1);
    for (let f = 0; f < 0.1 * SR; f += 128) expr.fill(f, 128, SR);
    // Over one 5 Hz cycle the extra cents reach about ±50.
    const cents: number[] = [];
    for (let f = 0.1 * SR; f < 0.3 * SR; f += 128) {
      expr.fill(f, 128, SR);
      cents.push(expr.cents(0, f / SR, 5));
    }
    expect(Math.max(...cents)).toBeGreaterThan(45);
    expect(Math.min(...cents)).toBeLessThan(-45);
  });
});

describe("Oversampler2x", () => {
  const N = 16384; // frequencies on exact DFT bins, measured over the second N frames with a Hann window
  const sine = (bin: number, amp: number) => Float32Array.from({ length: 2 * N }, (_, i) => amp * Math.sin((2 * Math.PI * bin * i) / N));
  const mag = (x: Float32Array, bin: number) => {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      const v = x[N + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      re += v * Math.cos((2 * Math.PI * bin * i) / N);
      im -= v * Math.sin((2 * Math.PI * bin * i) / N);
    }
    return Math.hypot(re, im) / (N / 4);
  };
  const plainShape = (c: Float32Array, v: number) => {
    const p = ((c.length - 1) / 2) * (v + 1);
    const k = Math.min(c.length - 2, Math.max(0, Math.floor(p)));
    return c[k] + (c[k + 1] - c[k]) * (p - k);
  };
  /** The odd harmonics 3..15 of `bin` that fold back below Nyquist, as their combined level. */
  const aliases = (y: Float32Array, bin: number) => {
    const folded = new Set<number>();
    for (let h = 3; h <= 15; h += 2) {
      let f = (h * bin) % N;
      if (f > N / 2) f = N - f;
      if (h * bin > N / 2 && f % bin !== 0) folded.add(f);
    }
    return Math.sqrt([...folded].reduce((a, f) => a + mag(y, f) ** 2, 0));
  };

  it("passes a low tone through at the same level (a straight curve)", () => {
    const o = new Oversampler2x();
    const x = sine(150, 0.5);
    const y = x.map((v) => o.run(Float32Array.from([-1, 1]), v));
    expect(mag(y, 150) / mag(x, 150)).toBeCloseTo(1, 2);
  });

  it("folds less of a driven high tone back down, and keeps its top end", () => {
    const curve = driveCurve(0.3);
    const bin = 3072; // 9 kHz at 48 kHz
    const x = sine(bin, 0.9);
    const o = new Oversampler2x();
    const over = x.map((v) => o.run(curve, v));
    const plain = x.map((v) => plainShape(curve, v));
    let last = 0;
    const averaged = x.map((v) => { // what it replaces: a shaped midpoint, averaged in
      const m = plainShape(curve, (v + last) / 2);
      last = v;
      return (m + plainShape(curve, v)) / 2;
    });
    expect(aliases(over, bin)).toBeLessThan(aliases(plain, bin) / 2.5); // about 10 dB less
    expect(aliases(over, bin)).toBeLessThan(aliases(averaged, bin) / 1.5);
    expect(mag(over, bin)).toBeGreaterThan(mag(averaged, bin)); // averaging dulled the highs
  });
});
