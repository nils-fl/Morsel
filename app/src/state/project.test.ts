import { describe, expect, it } from "vitest";
import { defaultProject, normalizeProject } from "./store";
import { PATTERN_COUNT, TRACK_COUNT } from "./types";

describe("normalizeProject", () => {
  it("returns the defaults for junk", () => {
    expect(normalizeProject(undefined)).toEqual(defaultProject());
    expect(normalizeProject("nope")).toEqual(defaultProject());
  });

  it("fills in fields an older project doesn't have", () => {
    const p = normalizeProject({ name: "Old", bpm: 120, levels: [0.5, 0.5], keys: { type: "chromatic", synth: { cutoff: 0.9 } } });
    expect(p.name).toBe("Old");
    expect(p.bpm).toBe(120);
    expect(p.levels).toHaveLength(TRACK_COUNT);
    expect(p.levels.slice(0, 3)).toEqual([0.5, 0.5, 1]);
    expect(p.mutes).toHaveLength(TRACK_COUNT);
    expect(p.patterns).toHaveLength(PATTERN_COUNT);
    expect(p.keys.type).toBe("chromatic");
    expect(p.keys.synth.cutoff).toBe(0.9);
    expect(p.keys.synth.release).toBe(defaultProject().keys.synth.release);
    expect(p.keys.zones).toEqual([]);
  });

  it("gives old projects the default ducker and clamps saved duck settings", () => {
    expect(normalizeProject({ name: "Old" }).duck).toEqual(defaultProject().duck);
    expect(normalizeProject({ duck: "junk" }).duck).toEqual(defaultProject().duck);
    const d = normalizeProject({ duck: { on: true, source: 40, target: 7, depth: 3, attack: -1, release: 0.5 } }).duck;
    expect(d).toEqual({ on: true, source: 15, target: 7, depth: 1, attack: 0, release: 0.5 });
    expect(normalizeProject({ duck: { target: -1 } }).duck.target).toBe(-1); // all others
  });

  it("clamps values and drops broken events and song steps", () => {
    const p = normalizeProject({
      bpm: 9999,
      swing: "x",
      patterns: [{ bars: 9, events: [{ id: "a", tick: 0, track: 0, note: 36, vel: 100, len: 10 }, { id: "b", tick: -5, track: 0 }, { id: "c", tick: 0, track: 99 }, null] }],
      song: [{ pattern: 3, repeats: 2 }, { pattern: 99, repeats: 1 }, "x"],
    });
    expect(p.bpm).toBe(240);
    expect(p.swing).toBe(defaultProject().swing);
    expect(p.patterns[0].bars).toBe(4);
    expect(p.patterns[0].events.map((e) => e.id)).toEqual(["a"]);
    expect(p.song).toEqual([{ pattern: 3, repeats: 2 }]);
  });

  it("gives repeated event ids (from the old Double button) fresh ones", () => {
    const ev = (id: string, tick: number) => ({ id, tick, track: 0, note: 36, vel: 100, len: 10 });
    const p = normalizeProject({ patterns: [{ bars: 4, events: [ev("x", 0), ev("xd", 100), ev("xd", 200), ev("x", 300)] }] });
    const ids = p.patterns[0].events.map((e) => e.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(0, 2)).toEqual(["x", "xd"]);
  });
});
