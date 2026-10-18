import { describe, expect, it, vi } from "vitest";
import { PAGES, pagesFor } from "./params";

// The actions pull in the sequencer's worker clock; the pages only need the preset list.
vi.mock("./actions", () => ({ allPresets: () => [], applyPreset: () => {} }));

const tags = (kind: "drum" | "keys") => pagesFor(kind).map((i) => PAGES[i].tag);

describe("encoder pages per track kind", () => {
  it("shows the Pad pages only on drum tracks and the Keys page only on keys tracks", () => {
    expect(tags("drum")).toEqual(["PAD", "PAD2", "FX", "MIX", "GLB", "DUCK"]);
    expect(tags("keys")).toEqual(["KEYS", "FX", "MIX", "GLB", "DUCK"]);
  });

  it("keeps the keys synth off the Global page", () => {
    expect(PAGES.find((p) => p.tag === "GLB")!.params.map((p) => p.name)).toEqual(["Tempo", "Swing", "Quantize", "Repeat"]);
  });
});
