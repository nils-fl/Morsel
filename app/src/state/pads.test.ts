import { describe, expect, it } from "vitest";
import { DECAY_MAX } from "../audio/dsp";
import { padsFromSamples, slicePads } from "./pads";
import { defaultPad } from "./store";
import { PAD_COUNT } from "./types";

const empty = () => Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i));
const lib = (...names: string[]) => names.map((name, i) => ({ id: `s${i}`, name }));

describe("slicePads", () => {
  it("puts N slices on pads from the first pad and leaves the others", () => {
    const pads = slicePads(empty(), "x", [0, 0.25, 0.5, 1], 2, "Slice");
    expect(pads.slice(2, 5).map((p) => [p.sampleId, p.start, p.end, p.name])).toEqual([
      ["x", 0, 0.25, "Slice 1"], ["x", 0.25, 0.5, "Slice 2"], ["x", 0.5, 1, "Slice 3"],
    ]);
    expect(pads[2]).toMatchObject({ decay: DECAY_MAX, mode: "oneshot", color: defaultPad(2).color });
    expect(pads[1]).toEqual(defaultPad(1));
    expect(pads[5]).toEqual(defaultPad(5));
  });

  it("drops slices past pad 16", () => {
    const markers = Array.from({ length: 21 }, (_, i) => i / 20);
    expect(slicePads(empty(), "x", markers, 10, "S").filter((p) => p.sampleId)).toHaveLength(6);
  });
});

describe("padsFromSamples", () => {
  it("fills pads in the given order and empties the rest", () => {
    const pads = padsFromSamples(lib("Kick", "Snare"));
    expect(pads.map((p) => p.sampleId).slice(0, 3)).toEqual(["s0", "s1", null]);
    expect(pads[0].name).toBe("Kick");
    expect(pads).toHaveLength(PAD_COUNT);
  });

  it("takes at most 16 and cuts names to 12 characters", () => {
    const pads = padsFromSamples(lib(...Array.from({ length: 20 }, (_, i) => `A very long sample ${i}`)));
    expect(pads.every((p) => p.sampleId)).toBe(true);
    expect(pads[0].name).toBe("A very long ");
  });

  it("chokes the open hat with the closed hat", () => {
    const pads = padsFromSamples(lib("Kick", "Hat Closed", "Hat Open", "Snare"));
    expect(pads.map((p) => p.choke).slice(0, 4)).toEqual([0, 1, 1, 0]);
    expect(padsFromSamples(lib("CH", "OH")).map((p) => p.choke).slice(0, 2)).toEqual([1, 1]);
    expect(padsFromSamples(lib("Kick", "Open Hat")).every((p) => p.choke === 0)).toBe(true);
  });
});
