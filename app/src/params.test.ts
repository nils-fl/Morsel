import { describe, expect, it, vi } from "vitest";
import { DUCK_PAGE, PAGES, SIDECHAIN_PAGE, fixPage, pagesFor } from "./params";
import { defaultProject, get, set, updateKeys } from "./state/store";

// The actions pull in the sequencer's worker clock; the pages only need the preset list.
vi.mock("./actions", () => ({ allPresets: () => [], applyPreset: () => {}, currentKit: () => "", kitNames: () => [], stepKit: () => "" }));

const tags = (kind: "drum" | "keys") => pagesFor(kind).map((i) => PAGES[i].tag);

describe("encoder pages per track kind", () => {
  it("shows the Pad pages only on drum tracks and the Keys page only on keys tracks", () => {
    expect(tags("drum")).toEqual(["KIT", "PAD", "PAD2", "FX", "MIX", "GLB", "SIDE", "DUCK"]);
    expect(tags("keys")).toEqual(["KEYS", "LFO", "FX", "MIX", "GLB", "DUCK"]);
  });

  it("keeps the keys synth off the Global page", () => {
    expect(PAGES.find((p) => p.tag === "GLB")!.params.map((p) => p.name)).toEqual(["Tempo", "Swing", "Quantize", "Repeat"]);
  });

  it("stays on Duck across track kinds, goes from Sidechain to Duck, and from other missing pages to the first", () => {
    set({ selectedTrack: "drums", encPage: SIDECHAIN_PAGE });
    set({ selectedTrack: "keys" });
    fixPage();
    expect(get().encPage).toBe(DUCK_PAGE);
    set({ selectedTrack: "drums" });
    fixPage();
    expect(get().encPage).toBe(DUCK_PAGE);
    set({ encPage: PAGES.findIndex((p) => p.tag === "PAD"), selectedTrack: "keys" });
    fixPage();
    expect(PAGES[get().encPage].tag).toBe("KEYS");
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
    expect(pagesFor("keys", true).map((i) => PAGES[i].tag)).toEqual(["STEP", "KEYS", "LFO", "FX", "MIX", "GLB", "DUCK"]);
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

  it("doubles the loop with Shift, once per turn, and halves it the other way", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { drums: { events: [{ id: "a", tick: 96, note: 0, vel: 100, len: 10 }] } } };
    set({ project: p, currentPattern: 0, selectedTrack: "drums", stepPage: 0, undo: [] });
    const bars = PAGES.find((pg) => pg.tag === "STEP")!.params[0];
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    bars.nudge(1, true);
    now += 50;
    bars.nudge(1, true); // the same turn: no second double
    let drums = get().project.patterns[0].clips.drums;
    expect(drums.bars).toBe(2);
    expect(drums.events.map((e) => e.tick)).toEqual([96, 480]);
    now += 1000;
    bars.nudge(1, true);
    expect(get().project.patterns[0].clips.drums.events.map((e) => e.tick)).toEqual([96, 480, 864, 1248]);
    now += 1000;
    bars.nudge(-1, true);
    drums = get().project.patterns[0].clips.drums;
    expect(drums.bars).toBe(2);
    expect(drums.events.map((e) => e.tick)).toEqual([96, 480]);
    expect(get().undo).toHaveLength(3);
    clock.mockRestore();
  });

  it("sets the clip's step grid on encoder 5 and pages through it by half bars on 1/32", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { drums: { events: [] } } };
    set({ project: p, currentPattern: 0, selectedTrack: "drums", stepPage: 0, undo: [] });
    const [, page, , , grid] = PAGES.find((pg) => pg.tag === "STEP")!.params;
    expect(grid.format()).toBe("1/16");
    grid.nudge(1, false);
    expect(grid.format()).toBe("1/32");
    expect(get().project.patterns[0].clips.drums.step).toBe(12);
    page.nudge(1, false);
    expect(page.format()).toBe("1.3/2");
    page.nudge(1, false);
    page.nudge(1, false);
    page.nudge(1, false);
    expect(page.format()).toBe("2.3/2");
    // Back to 1/16: a bar a page, so the page on the pads moves back inside the loop.
    grid.nudge(-1, false);
    expect(get().stepPage).toBe(1);
    expect(page.format()).toBe("2/2");
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
    set({ selectedTrack: "drums", selectedPad: 2 });
    const side = PAGES.find((pg) => pg.tag === "SIDE")!;
    expect(side.summary()).toBe("P3 Off (0 in)");
    side.params[0].nudge(1, false);
    expect(side.summary()).toBe("P3 In1 (1 in)");
    set({ selectedTrack: "keys" });
    const duck = PAGES.find((pg) => pg.tag === "DUCK")!;
    expect(duck.summary()).toBe("Off");
    duck.params[0].nudge(1, false);
    expect(duck.summary()).toBe("On In1 85%");
    expect(duck.params.map((x) => x.name)).toEqual(["Duck", "Input", "Depth", "Attack", "Hold", "Release"]);
    // A drum track ducks pad by pad; its own input pad never dips. Encoder 7 switches the selected pad.
    set({ selectedTrack: "drums", selectedPad: 2 });
    duck.params[0].nudge(1, false);
    expect(duck.summary()).toBe("On In1 85% 15p");
    expect(duck.params[6].format()).toBe("P3 input");
    set({ selectedPad: 5 });
    expect(duck.params[6].format()).toBe("P6 ducks");
    duck.params[6].nudge(-1, false);
    expect(duck.params[6].format()).toBe("P6 off");
    expect(duck.summary()).toBe("On In1 85% 14p");
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
