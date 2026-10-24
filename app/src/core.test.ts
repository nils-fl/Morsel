import { describe, expect, it } from "vitest";
import { addMarker, clampView, detectOnsets, equalSlices, moveMarker, removeMarker, slicesFromMarkers, zeroCrossing } from "./audio/chop";
import { DAW_NOTES, DRUM_NOTES, displayTextSysex, noteForPad, padFromNote, padLedMessage, relativeDelta } from "./midi/protocol";
import { padForStep, stepForPad } from "./modes/stepMap";
import { BAR_TICKS, GRID_OPTIONS, humanizeEvents, MAX_NUDGE, PPQN, pageSteps, quantizeEvents, quantizeTick, rowSteps, STEP_TICKS, swingOffsetTicks } from "./seq/timing";
import { rootFromName } from "./ui/notes";

describe("protocol", () => {
  it("maps drum pads MPC-style (pad 1 = bottom-left = note 36)", () => {
    expect(noteForPad("drum", 0)).toBe(36);
    expect(noteForPad("drum", 8)).toBe(40);
    expect(padFromNote("drum", 51)).toBe(15);
    expect(new Set(DRUM_NOTES).size).toBe(16);
  });
  it("maps DAW pads (bottom row 112.., top row 96..)", () => {
    expect(noteForPad("daw", 0)).toBe(112);
    expect(noteForPad("daw", 15)).toBe(103);
    expect(new Set(DAW_NOTES).size).toBe(16);
  });
  it("builds LED messages on the right channel", () => {
    expect(padLedMessage("drum", 0, 5)).toEqual([0x99, 36, 5]);
    expect(padLedMessage("daw", 0, 5, "pulse")).toEqual([0x92, 112, 5]);
  });
  it("builds display text and replaces non-ASCII", () => {
    expect(displayTextSysex(0x21, 1, "Aé")).toEqual([0xf0, 0, 0x20, 0x29, 2, 0x13, 6, 0x21, 1, 0x41, 0x3f, 0xf7]);
  });
  it("decodes relative encoders", () => {
    expect(relativeDelta(65)).toBe(1);
    expect(relativeDelta(62)).toBe(-2);
  });
});

describe("timing", () => {
  it("swing only delays odd 16ths", () => {
    expect(swingOffsetTicks(0, 66)).toBe(0);
    expect(swingOffsetTicks(STEP_TICKS, 50)).toBe(0);
    expect(swingOffsetTicks(STEP_TICKS, 75)).toBe(STEP_TICKS / 2);
    expect(swingOffsetTicks(STEP_TICKS * 2, 75)).toBe(0);
    expect(swingOffsetTicks(STEP_TICKS + 1, 75)).toBe(0);
  });
  it("quantizes to the nearest grid line and wraps", () => {
    expect(quantizeTick(30, 24, 384)).toBe(24);
    expect(quantizeTick(37, 24, 384)).toBe(48);
    expect(quantizeTick(380, 24, 384)).toBe(0);
    expect(quantizeTick(13.4, 0, 384)).toBe(13);
  });
});

describe("clip quantize and humanize", () => {
  const ev = (tick: number, note = 0, vel = 100, nudge?: number) => ({ tick, note, vel, ...(nudge !== undefined && { nudge }) });

  it("moves notes onto the grid, or part of the way", () => {
    expect(quantizeEvents([ev(30), ev(44, 1)], STEP_TICKS, 1, BAR_TICKS).map((e) => e.tick)).toEqual([24, 48]);
    expect(quantizeEvents([ev(32)], STEP_TICKS, 0.5, BAR_TICKS)[0].tick).toBe(28);
    // The nudge is where the note sounds: folded in, then gone.
    expect(quantizeEvents([ev(24, 0, 100, 10)], STEP_TICKS, 1, BAR_TICKS)).toEqual([ev(24)]);
  });

  it("keeps notes inside the clip and merges hits that land together", () => {
    expect(quantizeEvents([ev(BAR_TICKS - 3)], STEP_TICKS, 1, BAR_TICKS)[0].tick).toBe(0);
    const merged = quantizeEvents([ev(22, 0, 60), ev(26, 0, 110), ev(25, 1, 50)], STEP_TICKS, 1, BAR_TICKS);
    expect(merged).toEqual([ev(24, 0, 110), ev(24, 1, 50)]);
  });

  it("humanizes within bounds", () => {
    let i = 0;
    const rand = () => [0, 1][i++ % 2];
    const out = humanizeEvents([ev(0, 0, 125), ev(0, 0, 5, MAX_NUDGE)], 1, rand);
    expect(out[0]).toMatchObject({ vel: 115, nudge: 2 });
    expect(out[1]).toMatchObject({ vel: 1, nudge: MAX_NUDGE });
    expect(humanizeEvents([ev(0)], 0)).toEqual([ev(0)]);
  });
});

describe("step mode", () => {
  it("reads top row as steps 1-8", () => {
    expect(stepForPad(8)).toBe(0);
    expect(stepForPad(0)).toBe(8);
    for (let s = 0; s < 16; s++) expect(stepForPad(padForStep(s))).toBe(s);
  });

  it("lays triplet pages out as two rows of 6, the last two pads of each row unused", () => {
    expect(stepForPad(8, 6)).toBe(0);
    expect(stepForPad(13, 6)).toBe(5);
    expect(stepForPad(0, 6)).toBe(6);
    expect([6, 7, 14, 15].map((pad) => stepForPad(pad, 6))).toEqual([-1, -1, -1, -1]);
    for (let s = 0; s < 12; s++) expect(stepForPad(padForStep(s, 6), 6)).toBe(s);
  });

  it("pages always start on a beat", () => {
    for (const { ticks } of GRID_OPTIONS) {
      expect((pageSteps(ticks) * ticks) % PPQN).toBe(0);
      expect((rowSteps(ticks) * ticks) % PPQN).toBe(0);
    }
    expect(GRID_OPTIONS.map((g) => pageSteps(g.ticks))).toEqual([16, 16, 12, 12]);
  });
});

describe("chop", () => {
  it("makes equal slices", () => {
    expect(equalSlices(4)).toEqual([[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]]);
  });
  it("finds onsets of clicks", () => {
    const sr = 44100;
    const data = new Float32Array(sr * 2);
    for (const at of [0.1, 0.6, 1.1, 1.6]) for (let i = 0; i < 2000; i++) data[Math.floor(at * sr) + i] = Math.sin(i / 3) * (1 - i / 2000);
    const on = detectOnsets(data, sr, 8);
    expect(on[0]).toBe(0);
    const secs = on.slice(1).map((o) => o * 2);
    for (const at of [0.6, 1.1, 1.6]) expect(secs.some((s) => Math.abs(s - at) < 0.03)).toBe(true);
  });
  it("finds onsets only inside a range, as fractions of the whole buffer", () => {
    const sr = 44100;
    const data = new Float32Array(sr * 2);
    for (const at of [0.1, 0.6, 1.1, 1.6]) for (let i = 0; i < 2000; i++) data[Math.floor(at * sr) + i] = Math.sin(i / 3) * (1 - i / 2000);
    const on = detectOnsets(data, sr, 8, 0.5, [0.5, 1]);
    expect(on[0]).toBe(0.5);
    const secs = on.slice(1).map((o) => o * 2);
    expect(secs.every((s) => s >= 1 && s <= 2)).toBe(true);
    for (const at of [1.1, 1.6]) expect(secs.some((s) => Math.abs(s - at) < 0.03)).toBe(true);
  });
  it("snaps to the nearest zero crossing", () => {
    const data = new Float32Array(1000).map((_, i) => Math.sin((i / 100) * Math.PI)); // crosses every 100 samples
    expect(Math.abs(zeroCrossing(data, 0.43) * 1000 - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(zeroCrossing(data, 0.48) * 1000 - 500)).toBeLessThanOrEqual(1);
    expect(zeroCrossing(new Float32Array(1000).fill(0.5), 0.43)).toBe(0.43); // none in reach
  });
  it("keeps markers sorted and apart", () => {
    let m = [0.1, 0.9];
    m = addMarker(m, 0.5, 0.05);
    m = addMarker(m, 0.3, 0.05);
    expect(m).toEqual([0.1, 0.3, 0.5, 0.9]);
    expect(addMarker(m, 0.52, 0.05)).toBe(m); // too close
    expect(addMarker(m, 0.95, 0.05)).toBe(m); // outside the region
    expect(moveMarker(m, 1, 0.8, 0.05)).toEqual([0.1, 0.45, 0.5, 0.9]); // clamped below its neighbour
    expect(moveMarker(m, 0, 0, 0.05)[0]).toBe(0); // region bounds move too
    expect(removeMarker(m, 0)).toBe(m);
    expect(removeMarker(m, 2)).toEqual([0.1, 0.3, 0.9]);
    expect(slicesFromMarkers(m)).toEqual([[0.1, 0.3], [0.3, 0.5], [0.5, 0.9]]);
  });
  it("keeps the view inside the sample and no narrower than the minimum", () => {
    expect(clampView(0.9, 0.2, 0.01)).toEqual([0.8, 1]);
    expect(clampView(-0.1, 0.2, 0.01)).toEqual([0, 0.2]);
    expect(clampView(0.5, 0.001, 0.01)[1] - 0.5).toBeCloseTo(0.01);
    expect(clampView(0.3, 3, 0.01)).toEqual([0, 1]);
  });
});

describe("multisample names", () => {
  it("parses note names and numbers (C4 = 60)", () => {
    expect(rootFromName("Piano_C4.wav")).toBe(60);
    expect(rootFromName("Rhodes A#2.wav")).toBe(46);
    expect(rootFromName("Pad-Db3.aif")).toBe(49);
    expect(rootFromName("Strings 060.wav")).toBe(60);
    expect(rootFromName("noise.wav")).toBe(null);
  });
});
