import { describe, expect, it } from "vitest";
import {
  DRUMS_ID, KEYS_ID, addTrack, canRemoveTrack, copyClip, copyPattern, defaultPad, defaultProject, get, migrateV1, normalizeProject, removeTrack, selectTrack, set, stepTrack, undo,
} from "./store";
import { DUCK_ALL, MAX_TRACKS, PATTERN_COUNT, type NoteEvent, type Project } from "./types";

const ev = (id: string, tick: number, note: number): NoteEvent => ({ id, tick, note, vel: 100, len: 10 });
const reset = (p: Project = defaultProject()) => set({ project: p, undo: [], selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID });
const keysOf = (p: Project) => p.tracks.find((t) => t.kind === "keys")!.keys!;

describe("normalizeProject", () => {
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
      patterns: [{ bars: 9, clips: { d: { events: [ev("a", 0, 0), { id: "b", tick: -5, note: 0 }, ev("c", 0, 99), null] } } }],
      song: [{ pattern: 3, repeats: 2 }, { pattern: 99, repeats: 1 }, "x"],
    });
    expect(p.bpm).toBe(240);
    expect(p.swing).toBe(defaultProject().swing);
    expect(p.patterns[0].bars).toBe(4);
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

  it("resets a duck target or source that points at a missing track", () => {
    const d = normalizeProject({ tracks: [{ id: "d", kind: "drum" }, { id: "k", kind: "keys" }], duck: { on: true, sourceTrack: "nope", sourcePad: 40, target: "nope:3", depth: 3 } }).duck;
    expect(d).toMatchObject({ on: true, sourceTrack: "d", sourcePad: 15, target: DUCK_ALL, depth: 1 });
    expect(normalizeProject({ tracks: [{ id: "d", kind: "drum" }, { id: "k", kind: "keys" }], duck: { target: "d:3" } }).duck.target).toBe("d:3");
    expect(normalizeProject({ tracks: [{ id: "d", kind: "drum" }, { id: "k", kind: "keys" }], duck: { target: "k:3" } }).duck.target).toBe(DUCK_ALL); // keys tracks have no pads
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

  it("moves the ducker over", () => {
    expect(normalizeProject(v1).duck).toMatchObject({ on: true, sourceTrack: DRUMS_ID, sourcePad: 2, target: KEYS_ID, depth: 0.5 });
    expect(normalizeProject({ ...v1, duck: { target: 7 } }).duck.target).toBe(`${DRUMS_ID}:7`);
    expect(normalizeProject({ ...v1, duck: { target: -1 } }).duck.target).toBe(DUCK_ALL);
    expect(normalizeProject({ name: "Old" }).duck).toEqual(defaultProject().duck);
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
        duck: { ...p.duck, sourceTrack: id, target: `${id}:4` },
        tracks: p.tracks.map((t) => (t.keys ? { ...t, keys: { ...t.keys, type: "chromatic" as const, sourceTrack: id } } : t)),
      },
    });
    removeTrack(id);
    const after = get().project;
    expect(after.tracks.map((t) => t.id)).toEqual([DRUMS_ID, KEYS_ID]);
    expect(Object.keys(after.patterns[0].clips)).toEqual([DRUMS_ID]);
    expect(after.duck).toMatchObject({ sourceTrack: DRUMS_ID, target: DUCK_ALL });
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

  it("copyClip replaces one track's clip only, trimmed to the target's length", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 2, clips: { [DRUMS_ID]: { events: [ev("a", 0, 0), ev("late", 500, 1)] }, [KEYS_ID]: { events: [ev("k", 0, 60)] } } };
    p.patterns[1] = { bars: 1, clips: { [DRUMS_ID]: { events: [ev("z", 0, 5)] }, [KEYS_ID]: { events: [ev("q", 0, 62)] } } };
    reset(p);
    copyClip(0, 1, DRUMS_ID);
    const pat = get().project.patterns[1];
    expect(pat.bars).toBe(1);
    expect(pat.clips[DRUMS_ID].events.map((e) => e.note)).toEqual([0]);
    expect(pat.clips[KEYS_ID].events.map((e) => e.id)).toEqual(["q"]);
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
