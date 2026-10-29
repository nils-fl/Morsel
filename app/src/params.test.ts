import { describe, expect, it, vi } from "vitest";
import { DUCK_PAGE, FX_PAGE_INDEX, PAGES, SIDECHAIN_PAGE, fixPage, pagesFor, turnEncoder } from "./params";
import { defaultProject, get, moveFx, set, setFxOn, updateKeys } from "./state/store";

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

describe("turning an encoder", () => {
  it("takes a few detents a step on a param with few settings, the first one straight away", () => {
    set({ selectedTrack: "drums" });
    const page = DUCK_PAGE;
    const on = () => PAGES[page].params[0].value();
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    turnEncoder(page, 0, -1, false);
    expect(on()).toBe(0);
    now += 1000;
    turnEncoder(page, 0, 1, false); // a new turn: on with the first detent
    expect(on()).toBe(1);
    for (let k = 0; k < 3; k++) {
      now += 20;
      turnEncoder(page, 0, -1, false); // the other way: the first detent steps again
      expect(on()).toBe(0);
      now += 20;
      turnEncoder(page, 0, 1, false);
    }
    expect(on()).toBe(1);
    for (let k = 0; k < 4; k++) {
      now += 20;
      turnEncoder(page, 0, -1, false); // a quick turn: one step for the first detent, the next three do nothing
    }
    expect(on()).toBe(0);
    now += 20;
    turnEncoder(page, 0, 1, false, true); // a whole step (arrow key)
    expect(on()).toBe(1);
    clock.mockRestore();
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

  it("doubles the loop on encoder 6, once per turn, and halves it the other way", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { drums: { events: [{ id: "a", tick: 96, note: 0, vel: 100, len: 10 }] } } };
    set({ project: p, currentPattern: 0, selectedTrack: "drums", stepPage: 0, undo: [] });
    const double = PAGES.find((pg) => pg.tag === "STEP")!.params[5];
    expect(double.name).toBe("Double");
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    double.nudge(1, false);
    now += 50;
    double.nudge(1, false); // the same turn: no second double
    let drums = get().project.patterns[0].clips.drums;
    expect(drums.bars).toBe(2);
    expect(drums.events.map((e) => e.tick)).toEqual([96, 480]);
    now += 1000;
    double.nudge(1, false);
    expect(get().project.patterns[0].clips.drums.events.map((e) => e.tick)).toEqual([96, 480, 864, 1248]);
    now += 1000;
    double.nudge(-1, false);
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

  it("quantizes the selected track's notes onto its grid on encoder 4, once per turn, right only", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { drums: { events: [{ id: "a", tick: 26, note: 0, vel: 100, len: 10 }, { id: "b", tick: 48, note: 1, vel: 100, len: 10, nudge: -5 }] } } };
    set({ project: p, currentPattern: 0, selectedTrack: "drums", undo: [] });
    const quant = PAGES.find((pg) => pg.tag === "STEP")!.params[3];
    expect([quant.name, quant.format()]).toEqual(["Quant", "> 1/16"]);
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    quant.nudge(-1, false);
    expect(get().project.patterns[0].clips.drums.events.map((e) => e.tick)).toEqual([26, 48]);
    now += 1000;
    quant.nudge(1, false);
    const events = get().project.patterns[0].clips.drums.events;
    expect(events.map((e) => [e.id, e.tick, e.nudge])).toEqual([["a", 24, undefined], ["b", 48, undefined]]);
    expect(get().undo).toHaveLength(1);
    clock.mockRestore();
  });

  it("sets the velocity of new steps, and what they write: the pad, or on a keys track the note", () => {
    set({ project: defaultProject(), selectedTrack: "drums", selectedPad: 0, stepVel: 100, stepNote: null });
    const params = PAGES.find((pg) => pg.tag === "STEP")!.params;
    const vel = params[6], sound = params[7];
    vel.nudge(-3, false);
    expect(vel.format()).toBe("94");
    vel.nudge(100, false);
    expect(get().stepVel).toBe(127);
    expect(sound.name).toBe("Pad");
    sound.nudge(1, false);
    expect(get().selectedPad).toBe(1);
    expect(sound.format()).toMatch(/^P2 /);
    set({ selectedTrack: "keys" });
    expect(sound.name).toBe("Note");
    sound.nudge(1, false);
    expect(get().stepNote).toBe(49); // from the synth's home note, C3 (48)
  });
});

describe("screen text", () => {
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
  it("summaries read as planned", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: {} };
    p.swing = 54;
    set({ project: p, currentPattern: 0, quantize: 24, stepVel: 100, undo: [] });
    expect(PAGES.find((pg) => pg.tag === "STEP")!.summary()).toBe("2bars Sw54 V100");
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

describe("Pad 2 page", () => {
  it("sets the selected pad's choke group, Off to 4", () => {
    set({ project: defaultProject(), selectedTrack: "drums", drumTrack: "drums", selectedPad: 2 });
    const choke = PAGES.find((p) => p.tag === "PAD2")!.params.find((p) => p.name === "Choke")!;
    expect(choke.format()).toBe("Off");
    for (let i = 0; i < 6; i++) choke.nudge(1, false);
    expect(choke.format()).toBe("Group 4");
    choke.nudge(-1, false);
    expect(get().project.tracks[0].pads[2].choke).toBe(3);
  });
});

describe("FX rack pages", () => {
  const tagsNow = () => pagesFor("drum", false).map((i) => PAGES[i].tag);

  it("switches the effects on the FX page's encoders, in chain order, and adds a page after FX for each one on", () => {
    set({ project: defaultProject(), selectedTrack: "drums", hwMode: "play" });
    const rack = PAGES[FX_PAGE_INDEX];
    expect(rack.params.map((p) => p.name)).toEqual(["Filter", "EQ", "Drive", "Comp", "Chorus", "Delay", "Reverb", "Crush"]);
    expect(tagsNow()).toEqual(["KIT", "PAD", "PAD2", "FX", "MIX", "GLB", "SIDE", "DUCK"]);
    rack.params[6].nudge(1, false); // Reverb on
    rack.params[5].nudge(1, false); // Delay on
    expect(rack.summary()).toBe("Dly>Rev");
    expect(tagsNow()).toEqual(["KIT", "PAD", "PAD2", "FX", "DLY", "VERB", "MIX", "GLB", "SIDE", "DUCK"]);
    // Reverb before Delay: the encoders and the pages follow.
    moveFx(6, 5);
    expect(rack.params[5].name).toBe("Reverb");
    expect(tagsNow()).toEqual(["KIT", "PAD", "PAD2", "FX", "VERB", "DLY", "MIX", "GLB", "SIDE", "DUCK"]);
  });

  it("edits an effect on its page, and leaves for the FX page when it's switched off", () => {
    set({ project: defaultProject(), selectedTrack: "drums", hwMode: "play" });
    setFxOn("delay", true);
    const page = PAGES.findIndex((p) => p.fx === "delay");
    const [time, feedback, , , ping] = PAGES[page].params;
    expect(time.format()).toBe("1/8 dot");
    time.nudge(1, false);
    expect(time.format()).toBe("1/4");
    feedback.nudge(5, false);
    expect(feedback.format()).toBe("40%");
    ping.nudge(-1, false);
    expect(get().project.tracks[0].fx.delay.pingpong).toBe(false);
    set({ encPage: page });
    setFxOn("delay", false);
    fixPage();
    expect(get().encPage).toBe(FX_PAGE_INDEX);
  });
});

