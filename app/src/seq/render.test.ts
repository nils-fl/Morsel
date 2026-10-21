import { describe, expect, it } from "vitest";
import { orderedEvents } from "./render";
import { DRUMS_ID, KEYS_ID, defaultProject } from "../state/store";
import type { NoteEvent } from "../state/types";

const ev = (id: string, tick: number): NoteEvent => ({ id, tick, note: 0, vel: 100, len: 10 });

describe("orderedEvents", () => {
  it("puts the whole arrangement in time order, whatever order the notes were entered in", () => {
    const p = defaultProject();
    p.patterns[0] = { bars: 1, clips: { [DRUMS_ID]: { events: [ev("late", 300), ev("early", 0)] }, [KEYS_ID]: { events: [ev("mid", 100)] } } };
    p.patterns[1] = { bars: 2, clips: { [KEYS_ID]: { events: [ev("next", 50)] } } };
    const out = orderedEvents(p, [0, 1, 0]);
    expect(out.map((x) => x.event.id)).toEqual(["early", "mid", "late", "next", "early", "mid", "late"]);
    // Absolute ticks: pattern 1 (1 bar = 384 ticks) is followed by pattern 2 (2 bars), then pattern 1 again.
    expect(out.map((x) => x.tick)).toEqual([0, 100, 300, 384 + 50, 384 * 3, 384 * 3 + 100, 384 * 3 + 300]);
    expect(out[1].track.id).toBe(KEYS_ID);
  });

  it("loops each clip at its own length while its pattern repeats, and starts them together when it changes", () => {
    const p = defaultProject();
    const BAR = 384;
    // Drums 3 bars, keys 4: the pattern is 4 bars long, and the drums drift against it.
    p.patterns[0] = { bars: 4, clips: { [DRUMS_ID]: { events: [ev("d", 0)], bars: 3 }, [KEYS_ID]: { events: [ev("k", 0)], bars: 4 } } };
    p.patterns[1] = { bars: 1, clips: { [DRUMS_ID]: { events: [ev("x", 0)] } } };
    const out = orderedEvents(p, [0, 0, 1, 0]);
    const at = (id: string) => out.filter((x) => x.event.id === id).map((x) => x.tick / BAR);
    expect(at("d")).toEqual([0, 3, 6, 9, 12]); // after pattern 2 (bar 9), pattern 1 starts over
    expect(at("k")).toEqual([0, 4, 9]);
    expect(at("x")).toEqual([8]);
  });
});
