import { describe, expect, it } from "vitest";
import { beatsLabel, guessBeats, remapSliceOpts, sourceBpm, trimRegion } from "./chop";

describe("remapSliceOpts", () => {
  const m = [0, 0.5, 1];
  it("keeps the settings when a marker only moved", () => {
    expect(remapSliceOpts(m, ["a", "b"], [0, 0.4, 1], "x")).toEqual(["a", "b"]);
  });
  it("gives both halves of a split slice its settings", () => {
    expect(remapSliceOpts(m, ["a", "b"], [0, 0.3, 0.5, 1], "x")).toEqual(["a", "a", "b"]);
    expect(remapSliceOpts(m, ["a", "b"], [0, 0.5, 0.7, 1], "x")).toEqual(["a", "b", "b"]);
  });
  it("keeps the left slice's settings when a marker goes", () => {
    expect(remapSliceOpts([0, 0.3, 0.5, 1], ["a", "b", "c"], [0, 0.5, 1], "x")).toEqual(["a", "c"]);
  });
  it("uses the fallback outside the old region", () => {
    expect(remapSliceOpts([0.2, 0.5, 0.8], ["a", "b"], [0, 0.1, 0.5, 0.8], "x")).toEqual(["x", "x", "b"]);
  });
});

describe("trimRegion", () => {
  const m = [0, 0.2, 0.4, 0.6, 1];
  it("drops the inner markers the start passes", () => {
    expect(trimRegion(m, "start", 0.3, 0.01)).toEqual([0.3, 0.4, 0.6, 1]);
  });
  it("drops the inner markers the end passes", () => {
    expect(trimRegion(m, "end", 0.5, 0.01)).toEqual([0, 0.2, 0.4, 0.5]);
  });
  it("keeps the region at least minGap wide", () => {
    expect(trimRegion([0.2, 0.5], "start", 0.9, 0.01)).toEqual([0.49, 0.5]);
    expect(trimRegion([0.2, 0.5], "end", 0, 0.01)[1]).toBeCloseTo(0.21);
  });
});

describe("tempo", () => {
  it("works out the tempo of a region", () => {
    expect(sourceBpm(16, 12.3)).toBeCloseTo(78.05, 2);
  });
  it("guesses the bar count closest to the project tempo", () => {
    expect(guessBeats(12.3, 90)).toBe(16); // 4 bars at 78, not 8 at 156
    expect(guessBeats(12.3, 140)).toBe(32);
    expect(guessBeats(2.5, 96)).toBe(4);
  });
  it("labels whole bars as bars", () => {
    expect([beatsLabel(4), beatsLabel(16), beatsLabel(6), beatsLabel(1)]).toEqual(["1 bar", "4 bars", "6 beats", "1 beat"]);
  });
});
