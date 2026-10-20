import { describe, expect, it, vi } from "vitest";

// A one-second silent buffer stands in for the chopped sample.
vi.mock("../audio/engine", () => ({
  engine: { buffer: () => ({ length: 44100, duration: 1, getChannelData: () => new Float32Array(44100) }) },
}));

import { chopMarkerArrows, chopStepMarker } from "./chop";
import { get, set } from "../state/store";

const session = (sel: number | null) =>
  set({ chop: { sampleId: "s", markers: [0, 0.25, 0.5, 1], view: [0, 1], sel, firstPad: 0, count: 8, sens: 0.5 } });

describe("chop marker stepping (encoder 3, Pad up / down)", () => {
  it("starts at the first or last marker when none is selected", () => {
    session(null);
    chopStepMarker(1);
    expect(get().chop!.sel).toBe(0);
    session(null);
    chopStepMarker(-1);
    expect(get().chop!.sel).toBe(3);
  });
  it("stops at both ends", () => {
    session(0);
    chopStepMarker(-1);
    expect(get().chop!.sel).toBe(0);
    session(3);
    chopStepMarker(1);
    expect(get().chop!.sel).toBe(3);
  });
  it("lights only the arrows that lead somewhere", () => {
    session(0);
    expect(chopMarkerArrows()).toEqual({ up: false, down: true });
    session(3);
    expect(chopMarkerArrows()).toEqual({ up: true, down: false });
    session(null);
    expect(chopMarkerArrows()).toEqual({ up: true, down: true });
  });
});
