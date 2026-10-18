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
});
