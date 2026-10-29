import { describe, expect, it } from "vitest";
import { zoneFor } from "./voices";

describe("zoneFor", () => {
  const live = [{ id: "a", root: 42, lo: 36, hi: 47 }, { id: "b", root: 54, lo: 48, hi: 59 }];
  it("plays the zone whose keys hold the note (an Ableton Live instrument)", () => {
    expect(zoneFor(live, 47).id).toBe("a");
    expect(zoneFor(live, 48).id).toBe("b");
  });
  it("falls back to the nearest root outside the ranges, and without ranges", () => {
    expect(zoneFor(live, 70).id).toBe("b");
    expect(zoneFor([{ id: "x", root: 48 }, { id: "y", root: 60 }], 55).id).toBe("y");
  });
});
