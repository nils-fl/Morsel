import { describe, expect, it } from "vitest";
import {
  DRUMS_ID, KEYS_ID, addEvent, addTrack, clipOf, editStep, markUndo, canRemoveTrack, copyClip, copyPattern, defaultPad, doubleClip, setClipGrid, setTrackBars, clipStep, stepPages, setTrackDuck, setDuckPad, padDucks, toggleSidechainInput, trackBars, trackLength, updateKeys, defaultProject, fixSelection, get, migrateV1, normalizeProject, removeTrack, resetSession, selectTrack, set, stepTrack, undo, redo, updateProject, undoTrack, trackUndoSteps,
} from "./store";
import { MAX_TRACKS, PATTERN_COUNT, type NoteEvent, type Project } from "./types";
import { DECAY_MAX } from "../audio/dsp";

const ev = (id: string, tick: number, note: number): NoteEvent => ({ id, tick, note, vel: 100, len: 10 });
const reset = (p: Project = defaultProject()) => set({ project: p, undo: [], redo: [], selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID });
const keysOf = (p: Project) => p.tracks.find((t) => t.kind === "keys")!.keys!;

describe("normalizeProject", () => {
  it("plays loaded pads whole: the old 1.5 s default decay becomes the whole sample, edited ones stay", () => {
    expect(defaultPad(0).decay).toBe(DECAY_MAX);
    const p = defaultProject();
    const drums = p.tracks.find((t) => t.kind === "drum")!;
    drums.pads[0] = { ...drums.pads[0], decay: 1.5 };
    drums.pads[1] = { ...drums.pads[1], decay: 0.4 };
    const q = normalizeProject(JSON.parse(JSON.stringify(p)));
    const pads = q.tracks.find((t) => t.kind === "drum")!.pads;
    expect(pads[0].decay).toBe(DECAY_MAX);
    expect(pads[1].decay).toBe(0.4);
  });

  it("keeps the master's glue off unless it was switched on", () => {
    expect(defaultProject().masterGlue).toBe(false);
    expect(normalizeProject({ masterGlue: true }).masterGlue).toBe(true);
    expect(normalizeProject({}).masterGlue).toBe(false);
  });

  it("returns the defaults for junk", () => {
    expect(normalizeProject(undefined)).toEqual(defaultProject());
    expect(normalizeProject("nope")).toEqual(defaultProject());
  });

  it("round-trips a v2 project", () => {
    const p = defaultProject();
    p.patterns[2] = { bars: 2, clips: { [DRUMS_ID]: { events: [ev("a", 0, 3)] }, [KEYS_ID]: { events: [ev("b", 96, 64)] } } };
    p.tracks[0].fx.drive = 0.4;
    p.tracks[1].sendA = 0.5;
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("always keeps a drum and a keys track, at most 8 tracks", () => {
    expect(normalizeProject({ tracks: [] }).tracks.map((t) => t.kind)).toEqual(["drum", "keys"]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, kind: "drum" }));
    const p = normalizeProject({ tracks: many });
    expect(p.tracks).toHaveLength(MAX_TRACKS);
    expect(p.tracks.some((t) => t.kind === "keys")).toBe(true);
  });

  it("gives duplicate track ids fresh ones and drops clips of unknown tracks", () => {
    const p = normalizeProject({
      tracks: [{ id: "x", kind: "drum" }, { id: "x", kind: "keys" }],
      patterns: [{ bars: 1, clips: { x: { events: [ev("a", 0, 1)] }, gone: { events: [ev("b", 0, 1)] } } }],
    });
    expect(new Set(p.tracks.map((t) => t.id)).size).toBe(2);
    expect(Object.keys(p.patterns[0].clips)).toEqual(["x"]);
  });

  it("clamps values and drops broken events and song steps", () => {
    const p = normalizeProject({
      bpm: 9999,
      swing: "x",
      tracks: [{ id: "d", kind: "drum" }, { id: "k", kind: "keys" }],
      patterns: [{ bars: 99, clips: { d: { events: [ev("a", 0, 0), { id: "b", tick: -5, note: 0 }, ev("c", 0, 99), null] } } }],
      song: [{ pattern: 3, repeats: 2 }, { pattern: 99, repeats: 1 }, "x"],
    });
    expect(p.bpm).toBe(240);
    expect(p.swing).toBe(defaultProject().swing);
    expect(p.patterns[0].bars).toBe(16);
    expect(p.patterns[0].clips.d.events.map((e) => e.id)).toEqual(["a"]); // pad 99 doesn't exist on a drum track
    expect(p.song).toEqual([{ pattern: 3, repeats: 2 }]);
  });

  it("gives repeated event ids (from the old Double button) fresh ones", () => {
    const p = normalizeProject({ patterns: [{ bars: 4, events: [ev("x", 0, 0), ev("xd", 100, 0), ev("xd", 200, 0), ev("x", 300, 0)].map(({ note, ...e }) => ({ ...e, track: note })) }] });
    const ids = p.patterns[0].clips[DRUMS_ID].events.map((e) => e.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(0, 2)).toEqual(["x", "xd"]);
  });

  it("keeps sidechain inputs that are pads of drum tracks, once each, and drops keys inputs that are gone", () => {
    const p = normalizeProject({
      tracks: [{ id: "d", kind: "drum" }, { id: "k", kind: "keys", duck: { on: true, input: "d:9", depth: 3 } }, { id: "k2", kind: "keys", duck: { on: true, input: "d:3" } }],
      sidechain: ["d:3", "nope:1", "k:2", "d:16", "d:3", 7, "d:0"],
    });
    expect(p.sidechain).toEqual(["d:3", "d:0"]);
    expect(p.tracks[0].duck).toMatchObject({ on: false, input: null, pads: Array(16).fill(true) });
    expect(p.tracks[1].duck).toMatchObject({ on: true, input: null, depth: 1 });
    expect(p.tracks[2].duck).toMatchObject({ on: true, input: "d:3" });
  });
});

describe("v1 migration", () => {
  const v1 = {
    name: "Old",
    bpm: 120,
    pads: [{ name: "Kick", sampleId: "s1" }],
    keys: { type: "chromatic", sourcePad: 3, synth: { cutoff: 0.9 } },
    patterns: [{ bars: 2, events: [{ id: "a", tick: 0, track: 0, note: 60, vel: 100, len: 24 }, { id: "b", tick: 96, track: 16, note: 64, vel: 90, len: 48 }, { id: "c", tick: 0, track: 5, note: 60, vel: 80, len: 24 }] }],
    mutes: [true, ...Array(15).fill(false), true],
    solos: Array(17).fill(false),
    levels: [...Array(16).fill(1), 0.5],
    duck: { on: true, source: 2, target: 16, depth: 0.5 },
  };

  it("turns pads and Keys into a drum and a keys track", () => {
    const p = normalizeProject(v1);
    expect(p.name).toBe("Old");
    expect(p.tracks.map((t) => [t.id, t.kind])).toEqual([[DRUMS_ID, "drum"], [KEYS_ID, "keys"]]);
    const [drums, keys] = p.tracks;
    expect(drums.pads[0]).toMatchObject({ name: "Kick", sampleId: "s1" });
    expect(drums.pads).toHaveLength(16);
    expect(drums.padMutes[0]).toBe(true);
    expect(drums.mute).toBe(false);
    expect(keys.mute).toBe(true);
    expect(keys.level).toBe(0.5);
    expect(keys.keys).toMatchObject({ type: "chromatic", sourceTrack: DRUMS_ID, sourcePad: 3 });
    expect(keys.keys!.synth.cutoff).toBe(0.9);
    expect(keys.keys!.synth.release).toBe(defaultProject().tracks[1].keys!.synth.release);
  });

  it("splits pattern events into clips; drum notes become pad numbers", () => {
    const pat = normalizeProject(v1).patterns[0];
    expect(pat.bars).toBe(2);
    expect(pat.clips[DRUMS_ID].events.map((e) => [e.id, e.note])).toEqual([["a", 0], ["c", 5]]);
    expect(pat.clips[KEYS_ID].events).toEqual([{ id: "b", tick: 96, note: 64, vel: 90, len: 48 }]);
  });

  it("drops the old ducker", () => {
    const p = normalizeProject(v1);
    expect(p.sidechain).toEqual([]);
    expect(p.tracks.find((t) => t.id === KEYS_ID)!.duck).toEqual(defaultProject().tracks[1].duck);
  });

  it("keeps the Keys preset name, and gives old projects the default", () => {
    expect(keysOf(normalizeProject({ keys: { type: "synth" } })).preset).toBe("Init");
    expect(keysOf(normalizeProject({ keys: { preset: 5 } })).preset).toBe("Init");
    expect(keysOf(normalizeProject({ keys: { preset: "Warm Pad" } })).preset).toBe("Warm Pad");
  });

  it("leaves a v2 project alone", () => {
    const p = defaultProject();
    expect(migrateV1(p as unknown as Record<string, unknown>).tracks).toHaveLength(2);
    expect(normalizeProject(p).patterns).toHaveLength(PATTERN_COUNT);
  });
});

describe("tracks", () => {
  it("adds up to 8 tracks and selects the new one", () => {
    reset();
    const id = addTrack("drum")!;
    expect(get().selectedTrack).toBe(id);
    expect(get().drumTrack).toBe(id);
    expect(get().project.tracks.find((t) => t.id === id)!.name).toBe("Drums 2");
    while (addTrack("keys"));
    expect(get().project.tracks).toHaveLength(MAX_TRACKS);
    expect(addTrack("keys")).toBeNull();
  });

  it("keeps the last drum and keys track", () => {
    reset();
    expect(canRemoveTrack(get().project, DRUMS_ID)).toBe(false);
    removeTrack(KEYS_ID);
    expect(get().project.tracks).toHaveLength(2);
  });

  it("removes a track with its clips and fixes references to it; undo brings it back", () => {
    reset();
    const id = addTrack("drum")!;
    const p = get().project;
    set({
      project: {
        ...p,
        patterns: p.patterns.map((pat, i) => (i === 0 ? { ...pat, clips: { [id]: { events: [ev("a", 0, 1)] }, [DRUMS_ID]: { events: [ev("b", 0, 2)] } } } : pat)),
        sidechain: [`${id}:4`, `${DRUMS_ID}:0`],
        tracks: p.tracks.map((t) => (t.keys ? { ...t, keys: { ...t.keys, type: "chromatic" as const, sourceTrack: id }, duck: { ...t.duck!, on: true, input: `${id}:4` } } : t)),
      },
    });
    removeTrack(id);
    const after = get().project;
    expect(after.tracks.map((t) => t.id)).toEqual([DRUMS_ID, KEYS_ID]);
    expect(Object.keys(after.patterns[0].clips)).toEqual([DRUMS_ID]);
    expect(after.sidechain).toEqual([`${DRUMS_ID}:0`]);
    expect(after.tracks[1].duck).toMatchObject({ on: true, input: null });
    expect(keysOf(after).sourceTrack).toBe(DRUMS_ID);
    expect(get().selectedTrack).toBe(DRUMS_ID);
    expect(get().drumTrack).toBe(DRUMS_ID);
    undo();
    expect(get().project.tracks.map((t) => t.id)).toContain(id);
  });

  it("selecting a keys track hands it the keybed but leaves the pads on the drum track", () => {
    reset();
    const k = addTrack("keys")!;
    selectTrack(DRUMS_ID);
    selectTrack(k);
    expect(get()).toMatchObject({ selectedTrack: k, keysTrack: k, drumTrack: DRUMS_ID });
  });
});

describe("copyPattern / copyClip", () => {
  it("copies bars and every clip with fresh ids, and undo restores the target", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0), ev("b", 96, 3)] }, [KEYS_ID]: { events: [ev("k", 0, 60)] } } };
    p.patterns[3] = { bars: 1, clips: { [DRUMS_ID]: { events: [ev("z", 0, 5)] } } };
    reset(p);
    copyPattern(0, 3);
    const copy = get().project.patterns[3];
    expect(copy.bars).toBe(2);
    const strip = (es: NoteEvent[]) => es.map(({ id: _id, ...e }) => e);
    expect(strip(copy.clips[DRUMS_ID].events)).toEqual(strip(p.patterns[0].clips[DRUMS_ID].events));
    expect(strip(copy.clips[KEYS_ID].events)).toEqual(strip(p.patterns[0].clips[KEYS_ID].events));
    expect(copy.clips[DRUMS_ID].events.some((e) => e.id === "a" || e.id === "b")).toBe(false);
    expect(get().project.patterns[0]).toEqual(p.patterns[0]);
    undo();
    expect(get().project.patterns[3].clips[DRUMS_ID].events.map((e) => e.id)).toEqual(["z"]);
  });

  it("copyClip replaces one track's clip only, with its length", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0), ev("late", 500, 1)] }, [KEYS_ID]: { events: [ev("k", 0, 60)] } } };
    p.patterns[1] = { bars: 1, clips: { [DRUMS_ID]: { events: [ev("z", 0, 5)] }, [KEYS_ID]: { events: [ev("q", 0, 62)] } } };
    reset(p);
    copyClip(0, 1, DRUMS_ID);
    const pat = get().project.patterns[1];
    expect(pat.bars).toBe(2);
    expect(pat.clips[DRUMS_ID]).toMatchObject({ bars: 2 });
    expect(pat.clips[DRUMS_ID].events.map((e) => e.note)).toEqual([0, 1]);
    expect(pat.clips[KEYS_ID]).toMatchObject({ bars: 1 });
    expect(pat.clips[KEYS_ID].events.map((e) => e.id)).toEqual(["q"]);
  });
});

describe("sidechain", () => {
  it("numbers inputs in the order they were made; a keys track turned on picks the first, and loses a removed one", () => {
    reset();
    toggleSidechainInput(DRUMS_ID, 4);
    toggleSidechainInput(DRUMS_ID, 0);
    expect(get().project.sidechain).toEqual([`${DRUMS_ID}:4`, `${DRUMS_ID}:0`]);
    setTrackDuck(KEYS_ID, { on: true });
    expect(get().project.tracks[1].duck).toMatchObject({ on: true, input: `${DRUMS_ID}:4` });
    toggleSidechainInput(DRUMS_ID, 4);
    expect(get().project.sidechain).toEqual([`${DRUMS_ID}:0`]);
    expect(get().project.tracks[1].duck!.input).toBeNull();
    undo();
    expect(get().project.tracks[1].duck!.input).toBe(`${DRUMS_ID}:4`);
  });

  it("lets a drum track duck pad by pad, never its own input pad, and keeps the pads on load", () => {
    reset();
    toggleSidechainInput(DRUMS_ID, 0);
    setTrackDuck(DRUMS_ID, { on: true });
    const drums = () => get().project.tracks[0];
    expect(drums().duck).toMatchObject({ on: true, input: `${DRUMS_ID}:0` });
    expect(padDucks(drums(), 0)).toBe(false); // the kick doesn't duck itself
    expect(padDucks(drums(), 1)).toBe(true);
    setDuckPad(DRUMS_ID, 1, false);
    expect(padDucks(drums(), 1)).toBe(false);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(get().project)));
    expect(loaded.tracks[0].duck.pads!.slice(0, 3)).toEqual([true, false, true]);
    expect(normalizeProject({ tracks: [{ id: "d", kind: "drum", duck: { pads: [false, "x"] } }] }).tracks[0].duck.pads!.slice(0, 3)).toEqual([false, true, true]);
  });

  it("turns a drum track's duck on with another track's input when there is one", () => {
    reset();
    const other = addTrack("drum")!;
    toggleSidechainInput(DRUMS_ID, 0);
    toggleSidechainInput(other, 3);
    setTrackDuck(DRUMS_ID, { on: true });
    expect(get().project.tracks[0].duck.input).toBe(`${other}:3`);
  });
});

describe("track lengths", () => {
  it("keeps each clip's own length on load, and makes the pattern as long as the longest", () => {
    const p = normalizeProject({ ...defaultProject(), patterns: [{ bars: 1, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0), ev("b", 384 * 2, 1)], bars: 3 }, [KEYS_ID]: { events: [ev("c", 384, 60)], bars: 20 } } }] });
    const pat = p.patterns[0];
    expect(pat.bars).toBe(16);
    expect(pat.clips[DRUMS_ID]).toMatchObject({ bars: 3 });
    expect(pat.clips[DRUMS_ID].events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(pat.clips[KEYS_ID]).toMatchObject({ bars: 16 });
  });

  it("shortening every track shortens the pattern; Double repeats one track's notes", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 4, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0), ev("late", 384 * 3, 1)] } } };
    reset(p);
    setTrackBars(0, DRUMS_ID, 1);
    expect(get().project.patterns[0].bars).toBe(4); // keys still 4 bars
    setTrackBars(0, KEYS_ID, 2);
    let pat = get().project.patterns[0];
    expect(pat.bars).toBe(2);
    expect(pat.clips[DRUMS_ID].events.map((e) => e.id)).toEqual(["a"]);
    expect(trackBars(pat, DRUMS_ID)).toBe(1);
    doubleClip(0, DRUMS_ID);
    pat = get().project.patterns[0];
    expect(trackBars(pat, DRUMS_ID)).toBe(2);
    expect(pat.clips[DRUMS_ID].events.map((e) => e.tick)).toEqual([0, 384]);
    expect(trackBars(pat, KEYS_ID)).toBe(2);
  });
});

describe("step grids", () => {
  it("keeps a clip's grid on load, drops an unknown one, and keeps nudges within its half step", () => {
    const nudged = (nudge: number) => ({ ...ev("n", 0, 0), nudge });
    const p = normalizeProject({ ...defaultProject(), patterns: [{ bars: 1, clips: {
      [DRUMS_ID]: { events: [nudged(9)], step: 12 },
      [KEYS_ID]: { events: [], step: 7 },
    } }] });
    const pat = p.patterns[0];
    expect(pat.clips[DRUMS_ID].step).toBe(12);
    expect(pat.clips[DRUMS_ID].events[0].nudge).toBe(5); // 1/32: under half of 12 ticks
    expect(pat.clips[KEYS_ID].step).toBeUndefined();
  });

  it("changes the grid without moving notes, and keeps it through length changes, Double and copies", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { [DRUMS_ID]: { events: [{ ...ev("a", 12, 0), nudge: -10 }, ev("b", 32, 1)] } } };
    reset(p);
    setClipGrid(0, DRUMS_ID, 12);
    let pat = get().project.patterns[0];
    expect(clipStep(pat, DRUMS_ID)).toBe(12);
    expect(pat.clips[DRUMS_ID].events.map((e) => [e.tick, e.nudge])).toEqual([[12, -5], [32, undefined]]);
    setTrackBars(0, DRUMS_ID, 2);
    doubleClip(0, DRUMS_ID);
    copyClip(0, 1, DRUMS_ID);
    expect(clipStep(get().project.patterns[0], DRUMS_ID)).toBe(12);
    expect(clipStep(get().project.patterns[1], DRUMS_ID)).toBe(12);
    setClipGrid(0, DRUMS_ID, 24);
    pat = get().project.patterns[0];
    expect(pat.clips[DRUMS_ID].step).toBeUndefined();
    expect(trackBars(pat, DRUMS_ID)).toBe(4);
  });

  it("counts the Launchkey's pages per grid", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { [DRUMS_ID]: { events: [] }, [KEYS_ID]: { events: [], step: 12 } } };
    reset(p);
    const pat = get().project.patterns[0];
    expect(stepPages(pat, DRUMS_ID)).toBe(2); // a bar of 16ths a page
    expect(stepPages(pat, KEYS_ID)).toBe(4); // half a bar of 32nds a page
    setClipGrid(0, KEYS_ID, 32);
    expect(stepPages(get().project.patterns[0], KEYS_ID)).toBe(2); // a bar of 8th triplets
    setClipGrid(0, KEYS_ID, 16);
    expect(stepPages(get().project.patterns[0], KEYS_ID)).toBe(4); // half a bar of 16th triplets
  });

  it("doubles up to 16 bars", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 8, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0)], bars: 8 } } };
    reset(p);
    doubleClip(0, DRUMS_ID);
    expect(trackBars(get().project.patterns[0], DRUMS_ID)).toBe(16);
    doubleClip(0, DRUMS_ID);
    expect(trackBars(get().project.patterns[0], DRUMS_ID)).toBe(16);
    expect(clipOf(get().project.patterns[0], DRUMS_ID).events).toHaveLength(2);
  });
});

describe("addTrack with pads", () => {
  it("adds a named drum track with its pads in one undo step and puts it on the pads", () => {
    reset();
    const pads = [{ ...defaultPad(0), sampleId: "x", start: 0.5 }];
    const id = addTrack("drum", { name: "Chop 1", pads })!;
    const t = get().project.tracks.find((x) => x.id === id)!;
    expect(t.name).toBe("Chop 1");
    expect(t.pads).toHaveLength(16);
    expect(t.pads[0]).toMatchObject({ sampleId: "x", start: 0.5 });
    expect(t.pads[1].sampleId).toBeNull();
    expect(get().drumTrack).toBe(id);
    expect(get().undo).toHaveLength(1);
    undo();
    expect(get().project.tracks).toHaveLength(2);
  });

  it("refuses a ninth track", () => {
    reset();
    while (get().project.tracks.length < MAX_TRACKS) addTrack("drum");
    expect(addTrack("drum", { pads: [] })).toBeNull();
  });
});

describe("keys sample and LFO", () => {
  it("fills in defaults for projects saved before they existed, and clamps junk", () => {
    const p = normalizeProject({ tracks: [{ id: "k", kind: "keys", keys: { type: "sample", lfo: { vibDepth: 7, filterRate: "x" } } }] });
    const k = p.tracks.find((t) => t.kind === "keys")!.keys!;
    expect(k.type).toBe("sample");
    expect(k.sample).toEqual(keysOf(defaultProject()).sample);
    expect(k.lfo).toEqual({ ...keysOf(defaultProject()).lfo, vibDepth: 1 });
  });
});

describe("stepTrack", () => {
  it("steps through the tracks, wrapping, and gives a drum track the pads and a keys track the keybed", () => {
    reset();
    const id = addTrack("drum")!;
    selectTrack(DRUMS_ID);
    expect(stepTrack(1).id).toBe(KEYS_ID);
    expect(get()).toMatchObject({ selectedTrack: KEYS_ID, keysTrack: KEYS_ID, drumTrack: DRUMS_ID });
    expect(stepTrack(1).id).toBe(id);
    expect(get()).toMatchObject({ selectedTrack: id, drumTrack: id });
    expect(stepTrack(1).id).toBe(DRUMS_ID);
    expect(stepTrack(-1).id).toBe(id);
  });
});

describe("kit name on drum tracks", () => {
  it("is kept for drum tracks and dropped for keys tracks", () => {
    const p = normalizeProject({ tracks: [{ id: "d", kind: "drum", kit: "Lo-Fi Breeze A" }, { id: "k", kind: "keys", kit: "x" }] });
    expect(p.tracks.map((t) => t.kit)).toEqual(["Lo-Fi Breeze A", ""]);
    expect(normalizeProject({ tracks: [{ id: "d", kind: "drum" }] }).tracks[0].kit).toBe("");
  });

  it("is set by addTrack", () => {
    reset();
    const id = addTrack("drum", { kit: "Factory" })!;
    expect(get().project.tracks.find((t) => t.id === id)!.kit).toBe("Factory");
  });
});

describe("damaged values", () => {
  it("replaces pad and synth values of the wrong type or range with defaults (a NaN in an AudioParam throws)", () => {
    const p = normalizeProject({
      tracks: [
        { id: "d", kind: "drum", pads: [{ pitch: "x", cutoff: Number.NaN, pan: 9, mode: "weird", choke: 2.4, name: "", sampleId: 5, extra: 1 }] },
        { id: "k", kind: "keys", keys: { synth: { cutoff: "open", attack: -1, wave: "noise", junk: true }, zones: [{ sampleId: "s", root: 300 }, { sampleId: 3 }], rogue: 1 } },
      ],
    });
    const pad = p.tracks[0].pads[0];
    expect(pad).toMatchObject({ pitch: 0, cutoff: 1, pan: 1, mode: "oneshot", choke: 2, name: "Pad 1", sampleId: null });
    expect("extra" in pad).toBe(false);
    const k = keysOf(p);
    const d = keysOf(defaultProject());
    expect(k.synth).toEqual({ ...d.synth, attack: 0.001 });
    expect(k.zones).toEqual([{ sampleId: "s", root: 127 }]);
    expect("rogue" in k).toBe(false);
  });
});

describe("fixSelection and resetSession", () => {
  it("points the selection at tracks that exist", () => {
    reset();
    set({ selectedTrack: "gone", drumTrack: "gone", keysTrack: "gone", chop: null, currentPattern: 5, stepPage: 3, songMode: true });
    fixSelection();
    expect(get()).toMatchObject({ selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID });
    resetSession();
    expect(get()).toMatchObject({ currentPattern: 0, stepPage: 0, songMode: false, queuedPattern: null, selectedPad: 0 });
  });
});

describe("recorded takes", () => {
  it("undo as one step: the notes of a take are added without undo steps after markUndo", () => {
    reset();
    markUndo();
    addEvent(0, DRUMS_ID, { tick: 0, note: 0, vel: 100, len: 24 });
    addEvent(0, DRUMS_ID, { tick: 96, note: 1, vel: 100, len: 24 });
    expect(get().undo).toHaveLength(1);
    expect(clipOf(get().project.patterns[0], DRUMS_ID).events).toHaveLength(2);
    undo();
    expect(clipOf(get().project.patterns[0], DRUMS_ID).events).toHaveLength(0);
  });
});

describe("the keys' sound", () => {
  it("a new sound is an undo step (also on the selected track's undo), a tweak isn't", () => {
    reset();
    const keys = () => get().project.tracks.find((t) => t.id === KEYS_ID)!.keys!;
    const before = keys();
    updateKeys({ type: "multi", zones: [{ sampleId: "s1", root: 60 }], multiName: "Piano" }, KEYS_ID, true);
    updateKeys({ volume: 0.3 }, KEYS_ID);
    expect(keys()).toMatchObject({ type: "multi", volume: 0.3 });
    expect(undoTrack(KEYS_ID)).toBe(true);
    expect(keys().type).toBe(before.type);
    updateKeys({ type: "multi", zones: [{ sampleId: "s1", root: 60 }], multiName: "Piano" }, KEYS_ID, true);
    undo();
    expect(keys().type).toBe(before.type);
  });
});

describe("editing a step", () => {
  const events = () => clipOf(get().project.patterns[0], DRUMS_ID).events;

  it("changes the velocity and nudge of the step's notes for that pad only, within their ranges", () => {
    reset();
    set({ project: { ...get().project, patterns: get().project.patterns.map((pat, i) => (i === 0 ? { ...pat, clips: { [DRUMS_ID]: { events: [ev("a", 24, 0), ev("b", 24, 1), ev("c", 48, 0)] } } } : pat)) } });
    expect(editStep(0, DRUMS_ID, 24, 24, 0, 20, 4)).toMatchObject({ id: "a", vel: 120, nudge: 4 });
    expect(editStep(0, DRUMS_ID, 24, 24, 0, 50, 20)).toMatchObject({ vel: 127, nudge: 11 });
    expect(editStep(0, DRUMS_ID, 24, 24, 0, -500, -30)).toMatchObject({ vel: 1, nudge: -11 });
    expect(events().filter((e) => e.id !== "a").every((e) => e.vel === 100 && e.nudge === undefined)).toBe(true);
    // Back on the grid: no nudge kept.
    editStep(0, DRUMS_ID, 24, 24, 0, 0, 11);
    expect(events().find((e) => e.id === "a")).not.toHaveProperty("nudge");
    expect(editStep(0, DRUMS_ID, 72, 24, 0, 10, 0)).toBeUndefined();
  });

  it("changes the length of the step's notes, from a tick to the clip's length", () => {
    reset();
    set({ project: { ...get().project, patterns: get().project.patterns.map((pat, i) => (i === 0 ? { ...pat, clips: { [DRUMS_ID]: { events: [ev("a", 24, 0), ev("b", 24, 1)] } } } : pat)) } });
    const len = events().find((e) => e.id === "a")!.len;
    expect(editStep(0, DRUMS_ID, 24, 24, 0, 0, 0, 6)).toMatchObject({ id: "a", vel: 100, len: len + 6 });
    expect(editStep(0, DRUMS_ID, 24, 24, 0, 0, 0, -1000)).toMatchObject({ len: 1 });
    expect(editStep(0, DRUMS_ID, 24, 24, 0, 0, 0, 1e6)?.len).toBe(trackLength(get().project.patterns[0], DRUMS_ID));
    expect(events().find((e) => e.id === "b")!.len).toBe(len); // the other pad's note
  });

  it("keeps a nudge when loading, clamped, and drops a zero one", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { [DRUMS_ID]: { events: [{ ...ev("a", 0, 0), nudge: -5 }, { ...ev("b", 24, 0), nudge: 40 }, { ...ev("c", 48, 0), nudge: 0 }] } } };
    const out = clipOf(normalizeProject(JSON.parse(JSON.stringify(p))).patterns[0], DRUMS_ID).events;
    expect(out.map((e) => e.nudge)).toEqual([-5, 11, undefined]);
    expect(out[2]).not.toHaveProperty("nudge");
  });
});

describe("undo and redo", () => {
  it("redoes what was undone, and a new change clears what could be redone", () => {
    reset();
    updateProject((p) => ({ ...p, bpm: 100 }));
    updateProject((p) => ({ ...p, bpm: 110 }));
    undo();
    expect(get().project.bpm).toBe(100);
    undo();
    expect(get().project.bpm).toBe(defaultProject().bpm);
    redo();
    expect(get().project.bpm).toBe(100);
    redo();
    expect(get().project.bpm).toBe(110);
    redo();
    expect(get().project.bpm).toBe(110);
    undo();
    expect(get().project.bpm).toBe(100);
    // A knob move (not undoable itself) after an undo: redo would lose it, so there is nothing to redo.
    updateProject((p) => ({ ...p, swing: 60 }), false);
    expect(get().redo).toHaveLength(0);
    redo();
    expect(get().project).toMatchObject({ bpm: 100, swing: 60 });
  });
});

describe("undo on one track (Shift + Func)", () => {
  const notes = (id: string, pattern = 0) => clipOf(get().project.patterns[pattern], id).events.map((e) => e.note);

  it("takes back the track's last change and leaves newer changes on other tracks", () => {
    reset();
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 }, true);
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 }, true);
    expect(undoTrack(KEYS_ID)).toBe(true);
    expect(notes(KEYS_ID)).toEqual([]);
    expect(notes(DRUMS_ID)).toEqual([1]);
    expect(trackUndoSteps(get(), KEYS_ID)).toBe(0);
  });

  it("keeps a later project-wide undo from bringing the change back", () => {
    reset();
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 }, true);
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 }, true);
    undoTrack(KEYS_ID);
    // Only the drum step is left in the history; undoing it leaves the keys empty too.
    expect(get().undo).toHaveLength(1);
    undo();
    expect([notes(KEYS_ID), notes(DRUMS_ID)]).toEqual([[], []]);
  });

  it("is put back by Redo", () => {
    reset();
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 }, true);
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 }, true);
    undoTrack(KEYS_ID);
    redo();
    expect([notes(KEYS_ID), notes(DRUMS_ID)]).toEqual([[60], [1]]);
  });

  it("restores one track of a step that changed several, and keeps the step for the others", () => {
    reset();
    markUndo();
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 });
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 });
    undoTrack(KEYS_ID);
    expect([notes(KEYS_ID), notes(DRUMS_ID)]).toEqual([[], [1]]);
    expect(trackUndoSteps(get(), DRUMS_ID)).toBe(1);
    undoTrack(DRUMS_ID);
    expect(notes(DRUMS_ID)).toEqual([]);
  });

  it("follows the track's loop length back, and the pattern's with it", () => {
    reset();
    setTrackBars(0, KEYS_ID, 4);
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 }, true);
    undoTrack(KEYS_ID);
    expect(trackBars(get().project.patterns[0], KEYS_ID)).toBe(1);
    expect(get().project.patterns[0].bars).toBe(1);
  });

  it("says when the track has nothing to undo", () => {
    reset();
    addEvent(0, DRUMS_ID, { tick: 0, note: 1, vel: 100, len: 24 }, true);
    expect(undoTrack(KEYS_ID)).toBe(false);
    expect(notes(DRUMS_ID)).toEqual([1]);
  });

  it("removes a track it made only when that is the newest change", () => {
    reset();
    const id = addTrack("drum")!;
    expect(undoTrack(id)).toBe(true);
    expect(get().project.tracks.some((t) => t.id === id)).toBe(false);
    const id2 = addTrack("drum")!;
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 }, true);
    expect(undoTrack(id2)).toBe(false);
  });
});

describe("undo on one track keeps what wasn't part of the step", () => {
  it("takes back a recorded pass but not a knob turned since", () => {
    set({ project: defaultProject(), undo: [], redo: [], selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID });
    addEvent(0, KEYS_ID, { tick: 0, note: 60, vel: 100, len: 24 }, true);
    updateProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === KEYS_ID ? { ...t, level: 0.3 } : t)) }), false);
    undoTrack(KEYS_ID);
    expect(clipOf(get().project.patterns[0], KEYS_ID).events).toEqual([]);
    expect(get().project.tracks.find((t) => t.id === KEYS_ID)!.level).toBe(0.3);
  });
});
