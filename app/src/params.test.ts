import { describe, expect, it, vi } from "vitest";
import { PAGES, pagesFor } from "./params";
import { defaultProject, get, set, updateKeys, updateProject } from "./state/store";

// The actions pull in the sequencer's worker clock; the pages only need the preset list.
vi.mock("./actions", () => ({ allPresets: () => [], applyPreset: () => {}, currentKit: () => "", kitNames: () => [], stepKit: () => "" }));

const tags = (kind: "drum" | "keys") => pagesFor(kind).map((i) => PAGES[i].tag);

describe("encoder pages per track kind", () => {
  it("shows the Pad pages only on drum tracks and the Keys page only on keys tracks", () => {
    expect(tags("drum")).toEqual(["KIT", "PAD", "PAD2", "FX", "MIX", "GLB", "DUCK"]);
    expect(tags("keys")).toEqual(["KEYS", "LFO", "FX", "MIX", "GLB"]);
  });

  it("keeps the keys synth off the Global page", () => {
    expect(PAGES.find((p) => p.tag === "GLB")!.params.map((p) => p.name)).toEqual(["Tempo", "Swing", "Quantize", "Repeat"]);
  });
});

describe("Keys page", () => {
  const names = () => PAGES.find((p) => p.tag === "KEYS")!.params.map((p) => p.name);
  it("follows the keys track's sound source", () => {
    updateKeys({ type: "synth" });
    expect(names()).toEqual(["Preset", "Waves", "Detune", "Cutoff", "Reso", "Env", "Attack", "Release"]);
    updateKeys({ type: "sample" });
    expect(names()).toEqual(["Sample", "Root", "Attack", "Release", "Cutoff", "Reso"]);
    updateKeys({ type: "chromatic" });
    expect(names()).toEqual(["Source pad"]);
    updateKeys({ type: "multi" });
    expect(names()).toEqual([]);
  });

  it("steps the sample root note by semitones", () => {
    updateKeys({ type: "sample" });
    const root = PAGES.find((p) => p.tag === "KEYS")!.params[1];
    const before = root.value();
    root.nudge(1, false);
    expect(root.value()).toBe(before + 1);
    expect(root.format()).toMatch(/^[A-G]#?-?\d$/);
  });
});

describe("Step page", () => {
  it("comes first in Step mode only", () => {
    expect(tags("drum")).not.toContain("STEP");
    expect(pagesFor("keys", true).map((i) => PAGES[i].tag)).toEqual(["STEP", "KEYS", "LFO", "FX", "MIX", "GLB"]);
  });

  it("sets the selected track's length, dropping its notes past the end, and keeps the bar view inside it", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { drums: { events: [{ id: "a", tick: 0, note: 0, vel: 100, len: 10 }, { id: "b", tick: 400, note: 1, vel: 100, len: 10 }] } } };
    set({ project: p, currentPattern: 0, selectedTrack: "drums", stepPage: 1, undo: [] });
    const bars = PAGES.find((pg) => pg.tag === "STEP")!.params[0];
    bars.nudge(-1, false);
    const pat = get().project.patterns[0];
    expect(pat.clips.drums).toMatchObject({ bars: 1 });
    expect(pat.clips.drums.events.map((e) => e.id)).toEqual(["a"]);
    // The keys track keeps its 2 bars, and the pattern runs as long as it.
    expect(pat.clips.keys.bars).toBe(2);
    expect(pat.bars).toBe(2);
    expect(get().stepPage).toBe(0);
    bars.nudge(1, false);
    bars.nudge(1, false);
    expect(get().project.patterns[0].bars).toBe(3);
    expect(get().undo).toHaveLength(1); // quick turns share one undo step
  });
});

describe("screen text", () => {
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
  it("summaries read as planned", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: {} };
    p.swing = 54;
    set({ project: p, currentPattern: 0, quantize: 24, undo: [] });
    expect(PAGES.find((pg) => pg.tag === "STEP")!.summary()).toBe("2bars Sw54 Q1/16");
    expect(PAGES.find((pg) => pg.tag === "DUCK")!.summary()).toBe("Off");
    updateProject((pr) => ({ ...pr, duck: { ...pr.duck, on: true, depth: 0.85 } }), false);
    expect(PAGES.find((pg) => pg.tag === "DUCK")!.summary()).toBe("On T1P1>All 85%");
    updateKeys({ type: "synth" });
    expect(PAGES.find((pg) => pg.tag === "KEYS")!.summary()).toMatch(/^Synth: /);
    expect(PAGES.find((pg) => pg.tag === "KIT")!.params[0].format()).toBe("None");
  });

  it("uses only characters the screen font has, on every page", () => {
    updateKeys({ type: "synth", lfo: { vibRate: 5, vibDepth: 0.2, filterRate: 2, filterDepth: 0.5 } });
    for (const page of PAGES) {
      expect(ascii(page.name) && ascii(page.tag) && ascii(page.summary())).toBe(true);
      for (const prm of page.params) expect(ascii(prm.name) && ascii(prm.format()), `${page.tag} ${prm.name}: ${prm.format()}`).toBe(true);
    }
  });
});
