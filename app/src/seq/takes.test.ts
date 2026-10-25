import { beforeEach, describe, expect, it, vi } from "vitest";

// The sequencer's clocks run in workers; none are needed to record into the store.
vi.hoisted(() => vi.stubGlobal("Worker", class { postMessage() {} onmessage = null; }));
vi.mock("../audio/engine", () => ({ engine: { now: 0 } }));
vi.mock("../audio/voices", () => ({ scheduleNote: () => {} }));

import { sequencer } from "./sequencer";
import { DRUMS_ID, KEYS_ID, addEvent, defaultProject, get, set, trackUndoSteps, undoTrack, updateTrack } from "../state/store";

/** A note recorded on `track` in loop pass `pass`, as recordPad / recordKeyOn do. */
const record = (track: string, pass: number, note: number) => {
  (sequencer as unknown as { beginTake: (t: string, p: string) => void }).beginTake(track, `0:${pass}`);
  addEvent(0, track, { tick: note, note, vel: 100, len: 24 });
};
const notes = (track: string) => get().project.patterns[0].clips[track]?.events.map((e) => e.note) ?? [];

beforeEach(() => {
  set({ project: defaultProject(), undo: [], redo: [] });
  sequencer.newTake();
});

describe("recorded takes", () => {
  it("make each loop pass of a track its own undo step", () => {
    record(KEYS_ID, 0, 1);
    record(KEYS_ID, 0, 2);
    record(KEYS_ID, 1, 3);
    expect(trackUndoSteps(get(), KEYS_ID)).toBe(2);
    undoTrack(KEYS_ID);
    expect(notes(KEYS_ID)).toEqual([1, 2]);
  });

  it("let tracks recorded in the same pass be undone one at a time, each in one press", () => {
    record(DRUMS_ID, 0, 1);
    record(KEYS_ID, 0, 60);
    record(DRUMS_ID, 0, 2);
    record(KEYS_ID, 0, 62);
    undoTrack(KEYS_ID);
    expect([notes(KEYS_ID), notes(DRUMS_ID)]).toEqual([[], [1, 2]]);
    undoTrack(DRUMS_ID);
    expect(notes(DRUMS_ID)).toEqual([]);
  });

  it("start a new step after recording is punched in again", () => {
    record(KEYS_ID, 0, 1);
    sequencer.newTake();
    record(KEYS_ID, 0, 2);
    undoTrack(KEYS_ID);
    expect(notes(KEYS_ID)).toEqual([1]);
  });

  it("leave a knob turned after the pass alone when the pass is undone", () => {
    record(KEYS_ID, 0, 1);
    updateTrack(KEYS_ID, { level: 0.25 });
    undoTrack(KEYS_ID);
    expect(notes(KEYS_ID)).toEqual([]);
    expect(get().project.tracks.find((t) => t.id === KEYS_ID)!.level).toBe(0.25);
  });
});
