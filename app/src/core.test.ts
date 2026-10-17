import { describe, expect, it } from "vitest";
import { detectOnsets, equalSlices } from "./audio/chop";
import { DAW_NOTES, DRUM_NOTES, displayTextSysex, noteForPad, padFromNote, padLedMessage, relativeDelta } from "./midi/protocol";
import { padForStep, stepForPad } from "./modes/stepMap";
import { quantizeTick, STEP_TICKS, swingOffsetTicks } from "./seq/timing";
import { rootFromName } from "./ui/rootFromName";

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

describe("step mode", () => {
  it("reads top row as steps 1-8", () => {
    expect(stepForPad(8)).toBe(0);
    expect(stepForPad(0)).toBe(8);
    for (let s = 0; s < 16; s++) expect(stepForPad(padForStep(s))).toBe(s);
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
