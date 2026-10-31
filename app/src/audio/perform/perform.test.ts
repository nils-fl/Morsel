import { describe, expect, it } from "vitest";
import { FLEX_NAMES, KNOB_FX, PAD_FX, defaultPerform, normalizePerform, type PerformSettings } from "./catalog";
import { History } from "./dsp";
import { FLEX_PROGRAMS } from "./flexBeat";
import { PerformCore } from "./performCore";

const SR = 48000;
const BPM = 120;
/** Frames per beat at 120 BPM. */
const BEAT = SR / 2;

/** Run `l`/`r` through the engine in 128-frame blocks, like the audio thread; `at(frame)` is called before each block. */
function run(core: PerformCore, l: Float32Array, r = l, at?: (frame: number) => void, frame0 = 0) {
  const out = [new Float32Array(l.length), new Float32Array(l.length)];
  for (let f = 0; f < l.length; f += 128) {
    at?.(f);
    const end = Math.min(l.length, f + 128);
    core.process([l.subarray(f, end), r.subarray(f, end)], out.map((c) => c.subarray(f, end)), end - f, frame0 + f);
  }
  return out;
}

const sine = (amp: number, hz: number, frames: number) => Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
/** A signal whose every frame is different (a slow ramp), so a repeat shows up as a repeated value. */
const ramp = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (i % SR) / SR - 0.5);

function core(settings: (s: PerformSettings) => void = () => {}) {
  const c = new PerformCore(SR);
  const s = defaultPerform();
  settings(s);
  c.message({ t: "settings", settings: s });
  c.message({ t: "grid", bpm: BPM, origin: 0 });
  return c;
}

const fx = (name: string) => PAD_FX.findIndex((d) => d.name === name);
const maxStep = (x: Float32Array, from = 0, to = x.length) => {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
/** Positive-going zero crossings per second in x[from..to). */
const pitch = (x: Float32Array, from: number, to: number) => {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] <= 0 && x[i] > 0) n++;
  return (n * SR) / (to - from);
};

describe("Perform engine", () => {
  it("passes the mix through untouched with nothing engaged", () => {
    const c = core();
    const x = sine(0.5, 330, 4096);
    const [y] = run(c, x);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBe(x[i]);
  });

  it("history reads back what was written, and silence outside it", () => {
    const h = new History(0.1, SR);
    for (let i = 0; i < 1000; i++) h.write(i, -i);
    const o: [number, number] = [0, 0];
    expect(h.read(500, o)).toEqual([500, -500]);
    expect(h.read(500.5, o)).toEqual([500.5, -500.5]);
    expect(h.read(2000, o)).toEqual([0, 0]);
  });

  it("brings a Pad FX in and out without clicks", () => {
    const lp = fx("LP Filter");
    // Without resonance (a resonant filter opening quickly chirps, as it should).
    const c = core((s) => (s.pad[lp][0] = 0));
    const x = sine(0.5, 200, SR);
    const [y] = run(c, x, x, (f) => {
      if (f === 9600) c.message({ t: "pads", active: [{ fx: lp, amount: 1 }] });
      if (f === 28800) c.message({ t: "pads", active: [] });
    });
    // A 200 Hz sine at 0.5 moves at most 0.5 * 2pi * 200 / 48000 = 0.013 a sample.
    expect(maxStep(y)).toBeLessThan(0.03);
    // Fully pressed the low-pass is closed: the sine is much quieter in the middle.
    const mid = Math.max(...y.subarray(20000, 26000).map(Math.abs));
    expect(mid).toBeLessThan(0.25);
    // Let go, it is back to the dry signal.
    for (let i = 40000; i < 48000; i++) expect(Math.abs(y[i] - x[i])).toBeLessThan(1e-3);
  });

  it("Beat Repeat loops the division before the press", () => {
    const br = fx("Beat Repeat");
    // Division 1/8 (index 2): a quarter of a second at 120 BPM. No resonance; a light touch keeps the filter open.
    const c = core((s) => (s.pad[br] = [2, 0, 0]));
    const len = BEAT / 2;
    const x = sine(0.5, 220, SR);
    const press = 24064;
    const [y] = run(c, x, x, (f) => f === press && c.message({ t: "pads", active: [{ fx: br, amount: 0 }] }));
    // Once faded in, every frame is the one a division earlier: the slice [press - len, press) over and over.
    for (let i = press + 1000; i < press + len - 200; i += 37) expect(y[i]).toBeCloseTo(x[i - len], 1);
    for (let i = press + len + 200; i < press + 2 * len - 200; i += 37) expect(y[i]).toBeCloseTo(x[i - 2 * len], 1);
  });

  it("Beat Repeat's pressure closes its low-pass", () => {
    const br = fx("Beat Repeat");
    const c = core((s) => (s.pad[br] = [2, 0, 0]));
    const x = sine(0.5, 2000, SR);
    const [y] = run(c, x, x, (f) => f === 24064 && c.message({ t: "pads", active: [{ fx: br, amount: 1 }] }));
    expect(Math.max(...y.subarray(40000, 46000).map(Math.abs))).toBeLessThan(0.02);
  });

  it("Half Speed plays an octave down at x2", () => {
    const hs = fx("Half Speed");
    const c = core((s) => (s.pad[hs] = [1, 1]));
    const x = sine(0.5, 1000, SR);
    const [y] = run(c, x, x, (f) => f === 0 && c.message({ t: "pads", active: [{ fx: hs, amount: 1 }] }));
    expect(pitch(y, 4800, 40000)).toBeCloseTo(500, -1);
  });

  it("sounds at most four Pad FX at once", () => {
    const c = core();
    const active = [0, 2, 5, 6, 9].map((f) => ({ fx: f, amount: 1 }));
    c.message({ t: "pads", active });
    // The engine takes the first four it is given (the app sends the newest four in press order).
    const chain = (c as unknown as { chain: number[] }).chain;
    expect(chain).toEqual([0, 2, 5, 6]);
  });

  it("a delay throw rings on after the pad is let go", () => {
    const d = fx("Delay");
    const c = core();
    const x = new Float32Array(SR);
    x[2000] = 1;
    const [y] = run(c, x, x, (f) => {
      if (f === 0) c.message({ t: "pads", active: [{ fx: d, amount: 1 }] });
      if (f === 4096) c.message({ t: "pads", active: [] });
    });
    // 1/4 at 120 BPM = 0.5 s: the first echo arrives long after the release.
    const echo = Math.round(0.5 * SR) + 2000;
    expect(Math.max(...y.subarray(echo - 50, echo + 50).map(Math.abs))).toBeGreaterThan(0.3);
  });

  it("every Pad FX is silent-safe: finite output for loud input at full pressure", () => {
    const x = sine(1, 110, SR / 4);
    for (let i = 0; i < PAD_FX.length; i++) {
      const c = core();
      const [y, z] = run(c, x, x, (f) => f === 0 && c.message({ t: "pads", active: [{ fx: i, amount: 1 }] }));
      for (const v of [...y, ...z]) expect(Number.isFinite(v), PAD_FX[i].name).toBe(true);
      // Resonant filters may ring above the input; nothing should run away.
      expect(Math.max(...y.map(Math.abs)), PAD_FX[i].name).toBeLessThan(8);
    }
  });
});

describe("Flex Beat", () => {
  it("has 16 pads, Empty first", () => {
    expect(FLEX_PROGRAMS.length).toBe(16);
    expect(FLEX_NAMES.length).toBe(16);
    expect(FLEX_PROGRAMS[0]).toBeNull();
  });

  it("never asks for the future: every program stays at or behind now", () => {
    for (const [i, p] of FLEX_PROGRAMS.entries()) {
      if (!p) continue;
      for (let x = 0; x < p.beats; x += 1 / 64) {
        const t = typeof p.time === "function" ? p.time(x) : 0;
        expect(t, `${FLEX_NAMES[i]} at ${x}`).toBeGreaterThanOrEqual(0);
        // ...and never further back than the pass has gone plus what came before it (the history).
        expect(t, `${FLEX_NAMES[i]} at ${x}`).toBeLessThanOrEqual(x + 8);
      }
    }
  });

  it("1 beat repeat loops the beat it started on", () => {
    const c = core((s) => (s.flex.quantize = false));
    const x = ramp(SR * 2);
    const [y] = run(c, x, x, (f) => f === 0 && c.message({ t: "flex", program: 1 }));
    for (let i = BEAT + 300; i < 2 * BEAT - 300; i += 41) expect(y[i]).toBeCloseTo(x[i - BEAT], 4);
  });

  it("quantized, waits for the next bar line, then follows the bar", () => {
    const c = core();
    const x = ramp(SR * 3);
    const press = 25088; // in beat 2 of bar 1 (a block start)
    const [y] = run(c, x, x, (f) => f === press && c.message({ t: "flex", program: 1 }));
    // Until the bar line (4 beats = 2 s) the mix passes.
    for (let i = press + 500; i < 4 * BEAT - 500; i += 97) expect(y[i]).toBe(x[i]);
    // In bar 2 beat 2, it repeats bar 2's first beat.
    expect(y[5 * BEAT + 3000]).toBeCloseTo(x[4 * BEAT + 3000], 4);
  });

  it("a one-shot pass ends by itself and says so", () => {
    let ended = false;
    const c = core((s) => {
      s.flex.oneShot = true;
      s.flex.quantize = false;
    });
    c.onFlexEnd = () => (ended = true);
    const x = sine(0.5, 220, SR * 3);
    const [y] = run(c, x, x, (f) => f === 0 && c.message({ t: "flex", program: 13 }));
    expect(ended).toBe(true);
    // After the pass (4 beats = 2 s) the mix is back.
    for (let i = Math.round(2.2 * SR); i < Math.round(2.4 * SR); i++) expect(y[i]).toBeCloseTo(x[i], 3);
  });

  it("a gate closes on its off steps", () => {
    const c = core((s) => (s.flex.quantize = false));
    const x = sine(0.5, 220, SR);
    // 1/8 gate: open the first half of each 8th (an 8th = 12000 frames).
    const [y] = run(c, x, x, (f) => f === 0 && c.message({ t: "flex", program: 12 }));
    expect(Math.max(...y.subarray(7000, 11500).map(Math.abs))).toBeLessThan(0.01);
    expect(Math.max(...y.subarray(13000, 17000).map(Math.abs))).toBeGreaterThan(0.4);
  });
});

describe("Knob FX", () => {
  it("passes through while off, and at 0 % mix", () => {
    const x = sine(0.5, 330, 4096);
    for (const settings of [(s: PerformSettings) => (s.knob.on = false), (s: PerformSettings) => ((s.knob.on = true), (s.knob.mix = 0))]) {
      const [y] = run(core(settings), x);
      for (let i = 0; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i], 6);
    }
  });

  it("every Knob FX gives finite, bounded output", () => {
    const x = sine(1, 110, SR / 4);
    for (let k = 0; k < KNOB_FX.length; k++) {
      const c = core((s) => {
        s.knob.on = true;
        s.knob.kind = k;
      });
      const [y] = run(c, x);
      for (const v of y) expect(Number.isFinite(v), KNOB_FX[k].name).toBe(true);
      expect(Math.max(...y.map(Math.abs)), KNOB_FX[k].name).toBeLessThan(4);
    }
  });

  it("the Pumper ducks on every beat and comes back before the next", () => {
    const pumper = KNOB_FX.findIndex((k) => k.name === "Pumper");
    const c = core((s) => {
      s.knob.on = true;
      s.knob.kind = pumper;
      s.knob.params[pumper] = [3, 0.5, 1]; // every beat, full depth
    });
    const x = sine(0.5, 220, SR);
    const [y] = run(c, x);
    const peak = (from: number, to: number) => Math.max(...y.subarray(from, to).map(Math.abs));
    // Just after beat 2 (frame 24000) it is down; late in the beat it is nearly back.
    expect(peak(BEAT + 500, BEAT + 1500)).toBeLessThan(0.05);
    expect(peak(2 * BEAT - 3000, 2 * BEAT - 1000)).toBeGreaterThan(0.4);
  });

  it("the DJ filter at noon leaves the mix alone", () => {
    const x = sine(0.5, 5000, 4096);
    const [y] = run(core((s) => (s.knob.on = true)), x);
    for (let i = 600; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i], 4);
  });
});

describe("Perform settings", () => {
  it("fills in what a saved project is missing and clamps what is out of range", () => {
    const n = normalizePerform({ pad: [[9, 9]], knob: { kind: 99, on: true }, flex: { mix: 7 } });
    expect(n.pad.length).toBe(PAD_FX.length);
    expect(n.pad[0]).toEqual([2, 1]);
    expect(n.knob.kind).toBe(KNOB_FX.length - 1);
    expect(n.knob.on).toBe(true);
    expect(n.flex.mix).toBe(1);
    expect(normalizePerform(undefined)).toEqual(defaultPerform());
  });
});
