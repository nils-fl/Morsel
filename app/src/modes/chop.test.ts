import { beforeEach, describe, expect, it, vi } from "vitest";

// A one-second silent buffer stands in for the chopped sample; auditions and pad hits are recorded.
const played = vi.hoisted(() => ({ chops: [] as { offset: number; rate?: number; choke?: boolean }[], pads: [] as [string, number][], added: [] as string[], splits: 0 }));
vi.mock("../audio/engine", () => ({
  engine: {
    buffer: () => ({ length: 44100, duration: 1, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(44100) }),
    addBuffer: async (name: string) => {
      played.added.push(name);
      return `id:${name}`;
    },
    ctx: { currentTime: 0 },
    chopVoice: (_id: string, offset: number, _dur: number, o: { rate?: number; choke?: boolean }) => {
      played.chops.push({ offset, ...o });
      return 0;
    },
    stopPreview: () => {},
    voices: { pad: (track: string, pad: number) => played.pads.push([track, pad]) },
  },
}));

vi.mock("../audio/hpss", () => ({
  hpssAsync: async (channels: Float32Array[]) => {
    played.splits++;
    return { drums: channels, harmonic: channels };
  },
}));
vi.stubGlobal("AudioBuffer", class {
  constructor(o: { length: number }) {
    Object.assign(this, o);
  }
  copyToChannel() {}
});

import { CHOP_KEY0, chopStem, shownStem, chopEncoder, chopSetPage, chopKeyDown, chopKeysReleased, chopKeyUp, chopMarkerArrows, chopPad, chopRack, chopStepMarker, newChop, updateChop } from "./chop";
import { DRUMS_ID, KEYS_ID, defaultProject, get, set } from "../state/store";
import { DEFAULT_SLICE } from "../state/types";

/** A chop on its Chop page with three chops (markers at 0, ¼, ½, 1). */
const session = (sel: number | null) => set({ chop: { ...newChop("s", [0, 0.25, 0.5, 1]), page: "chop", sel, count: 8 } });

beforeEach(() => {
  set({ project: defaultProject(), undo: [], redo: [], selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID });
  chopKeysReleased();
  played.chops = [];
  played.pads = [];
  played.added = [];
  played.splits = 0;
});

describe("chop marker stepping (encoder 3, Pad up / down)", () => {
  it("starts at the first or last marker when none is selected", () => {
    session(null);
    chopStepMarker(1);
    expect(get().chop!.sel).toBe(0);
    session(null);
    chopStepMarker(-1);
    expect(get().chop!.sel).toBe(3);
  });
  it("stops at both ends", () => {
    session(0);
    chopStepMarker(-1);
    expect(get().chop!.sel).toBe(0);
    session(3);
    chopStepMarker(1);
    expect(get().chop!.sel).toBe(3);
  });
  it("lights only the arrows that lead somewhere", () => {
    session(0);
    expect(chopMarkerArrows()).toEqual({ up: false, down: true });
    session(3);
    expect(chopMarkerArrows()).toEqual({ up: true, down: false });
    session(null);
    expect(chopMarkerArrows()).toEqual({ up: true, down: true });
  });
});

describe("chops on the keys", () => {
  it("plays chop k on the k-th key from C3 with its pitch and choke, and selects it", () => {
    session(null);
    updateChop({ slices: [DEFAULT_SLICE, { pitch: 3, choke: false }, DEFAULT_SLICE] });
    chopKeyDown(CHOP_KEY0 + 1, 127);
    expect(played.chops).toEqual([{ offset: 0.25, rate: Math.pow(2, 3 / 12), gain: 1, choke: false, loop: undefined }]);
    expect(get().chop!.sel).toBe(1);
  });
  it("ignores keys past the last chop", () => {
    session(null);
    chopKeyDown(CHOP_KEY0 + 3, 100);
    chopKeyDown(CHOP_KEY0 - 1, 100);
    expect(played.chops).toEqual([]);
  });
  it("keeps each chop's settings when a marker splits it", () => {
    session(null);
    updateChop({ slices: [DEFAULT_SLICE, { pitch: -5, choke: false }, DEFAULT_SLICE] });
    updateChop({ markers: [0, 0.25, 0.4, 0.5, 1] });
    expect(get().chop!.slices.map((o) => o.pitch)).toEqual([0, -5, -5, 0]);
  });
});

describe("key + pad", () => {
  const tracks = () => get().project.tracks;

  it("makes a rack on the first one and puts the chop on that pad", () => {
    session(null);
    updateChop({ slices: [DEFAULT_SLICE, { pitch: 2, choke: true }, DEFAULT_SLICE] });
    const before = tracks().length;
    chopKeyDown(CHOP_KEY0 + 1, 100);
    chopPad(4, 100);
    expect(tracks()).toHaveLength(before + 1);
    const rack = chopRack()!;
    expect(rack.name).toBe("Chop 1");
    expect(rack.pads[4]).toMatchObject({ sampleId: "s", start: 0.25, end: 0.5, pitch: 2, choke: 1, name: "Chop 2", mode: "oneshot" });
    expect(rack.pads.filter((p) => p.sampleId)).toHaveLength(1);
  });

  it("puts later chops on the same rack, in any order, choke off as 0", () => {
    session(null);
    updateChop({ slices: [{ pitch: 0, choke: false }, DEFAULT_SLICE, DEFAULT_SLICE] });
    chopKeyDown(CHOP_KEY0 + 2, 100);
    chopPad(0, 100);
    chopKeyUp(CHOP_KEY0 + 2);
    const n = tracks().length;
    chopKeyDown(CHOP_KEY0, 100);
    chopPad(1, 100);
    expect(tracks()).toHaveLength(n);
    const pads = chopRack()!.pads;
    expect([pads[0].start, pads[1].start]).toEqual([0.5, 0]);
    expect([pads[0].choke, pads[1].choke]).toEqual([1, 0]);
  });

  it("keeps every chop on the new chop track for its keys, following later edits", () => {
    session(null);
    const slices = [DEFAULT_SLICE, { pitch: 2, choke: false }, DEFAULT_SLICE];
    updateChop({ slices });
    chopKeyDown(CHOP_KEY0 + 1, 100);
    chopPad(4, 100);
    expect(chopRack()!.chops).toEqual({ sampleId: "s", markers: [0, 0.25, 0.5, 1], slices, group: 1 });
    updateChop({ markers: [0, 0.3, 0.5, 1] });
    expect(chopRack()!.chops!.markers).toEqual([0, 0.3, 0.5, 1]);
    // Scrolling the view doesn't touch the track.
    const before = chopRack()!.chops;
    updateChop({ view: [0, 0.5] });
    expect(chopRack()!.chops).toBe(before);
  });

  it("plays the rack's pad when no key is held", () => {
    session(null);
    chopKeyDown(CHOP_KEY0, 100);
    chopPad(2, 100);
    chopKeyUp(CHOP_KEY0);
    chopPad(2, 90);
    expect(played.pads).toEqual([[chopRack()!.id, 2]]);
  });

  it("is one undo step each", () => {
    session(null);
    const undo = get().undo.length;
    chopKeyDown(CHOP_KEY0, 100);
    chopPad(0, 100);
    chopPad(1, 100);
    expect(get().undo.length).toBe(undo + 2);
  });
});

describe("pitch and choke encoders (7, 8)", () => {
  it("edit the selected chop", () => {
    session(1);
    chopEncoder(6, 1, false);
    chopEncoder(6, 1, false);
    chopEncoder(7, -1, false);
    expect(get().chop!.slices[1]).toEqual({ pitch: 2, choke: false });
    expect(get().chop!.slices[0]).toEqual(DEFAULT_SLICE);
  });
  it("set every chop's choke with Shift", () => {
    session(null);
    chopEncoder(7, -1, true);
    expect(get().chop!.slices.every((o) => !o.choke)).toBe(true);
  });
  it("do nothing without a chop selected (or on the region's end)", () => {
    session(3);
    chopEncoder(6, 1, false);
    expect(get().chop!.slices.every((o) => o.pitch === 0)).toBe(true);
  });
});

describe("Sample page", () => {
  it("is where a new chop opens: no chops yet, the whole sample as the region", () => {
    set({ chop: newChop("s") });
    expect(get().chop).toMatchObject({ page: "sample", markers: [0, 1], detect: "equal" });
  });
  it("trims the region with encoders 3 and 4, dropping markers it passes", () => {
    session(null);
    updateChop({ page: "sample", view: [0, 1] });
    for (let i = 0; i < 40; i++) chopEncoder(2, 1, false);
    const m = get().chop!.markers;
    expect(m[0]).toBeGreaterThan(0.25);
    expect(m).toHaveLength(3);
    for (let i = 0; i < 20; i++) chopEncoder(3, -1, false);
    expect(get().chop!.markers.at(-1)).toBeLessThan(1);
  });
  it("guesses the length, then takes the one set on encoder 5", () => {
    set({ project: { ...defaultProject(), bpm: 90 } });
    session(null);
    updateChop({ page: "sample" });
    // 1 s: the guess is 1 bar (240 BPM, the closest to 90 of 1, 2, 4… bars); one detent adds a beat.
    chopEncoder(4, 1, false);
    expect(get().chop!.beats).toBe(5);
    chopEncoder(4, -1, true);
    expect(get().chop!.beats).toBe(1);
  });
  it("sets the target tempo on encoder 6 (Shift: tenths)", () => {
    set({ project: { ...defaultProject(), bpm: 90 } });
    session(null);
    updateChop({ page: "sample" });
    chopEncoder(5, 1, false);
    chopEncoder(5, 1, true);
    expect(get().chop!.toBpm).toBeCloseTo(91.1);
  });
});

describe("Chop page", () => {
  it("places equal steps across the region the first time it opens", () => {
    set({ chop: { ...newChop("s"), markers: [0.2, 0.6] } });
    chopSetPage("chop");
    const m = get().chop!.markers;
    expect(m).toHaveLength(17); // 16 steps
    expect(m[0]).toBeCloseTo(0.2);
    expect(m[16]).toBeCloseTo(0.6);
    expect(m[1] - m[0]).toBeCloseTo(0.4 / 16, 3);
  });
  it("leaves chops already made alone", () => {
    session(null);
    updateChop({ page: "sample" });
    chopSetPage("chop");
    expect(get().chop!.markers).toEqual([0, 0.25, 0.5, 1]);
  });
  it("sets the number of steps on encoder 5", () => {
    session(null);
    chopEncoder(4, -1, false); // 8 -> 7
    expect(get().chop!.markers).toHaveLength(8);
    expect(get().chop!.count).toBe(7);
  });
  it("chops by Equal at the left end of encoder 6, at the hits further right", () => {
    session(null);
    chopEncoder(5, 1, false);
    expect(get().chop).toMatchObject({ detect: "hits", sens: 0.1 });
    chopEncoder(5, 1, false);
    expect(get().chop!.sens).toBeCloseTo(0.2);
    chopEncoder(5, -1, false);
    chopEncoder(5, -1, false);
    expect(get().chop!.detect).toBe("equal");
    expect(get().chop!.markers).toHaveLength(9); // back to 8 equal steps
  });
});

describe("the view follows the selected marker", () => {
  const centre = () => (get().chop!.view[0] + get().chop!.view[1]) / 2;

  it("keeps a moving marker in the middle, the waveform scrolling under it", () => {
    session(2);
    updateChop({ view: [0.4, 0.6] });
    for (let i = 0; i < 20; i++) chopEncoder(3, 1, false);
    expect(centre()).toBeCloseTo(get().chop!.markers[2], 6);
    expect(get().chop!.view[1] - get().chop!.view[0]).toBeCloseTo(0.2, 6); // same zoom
  });

  it("centres a marker picked with encoder 3 or a key", () => {
    session(null);
    updateChop({ view: [0.6, 0.8] });
    chopKeyDown(CHOP_KEY0 + 1, 100);
    expect(centre()).toBeCloseTo(0.25, 6);
    chopEncoder(2, 1, false);
    expect(centre()).toBeCloseTo(0.5, 6);
  });

  it("stops at the sample's start and end, where the marker can't be centred", () => {
    session(null);
    updateChop({ view: [0.4, 0.6] });
    chopEncoder(2, 1, false); // marker 1, at 0
    expect(get().chop!.view).toEqual([0, expect.closeTo(0.2, 6)]);
    session(3);
    updateChop({ view: [0.2, 0.4] });
    chopEncoder(2, -1, false);
    chopEncoder(2, 1, false); // marker 4, at the end
    expect(get().chop!.view[1]).toBeCloseTo(1, 6);
  });
});

describe("changing a chop after it is on a pad", () => {
  it("changes the pads holding it too", () => {
    session(null);
    chopKeyDown(CHOP_KEY0 + 1, 100);
    chopPad(3, 100);
    chopPad(7, 100); // the same chop on two pads
    chopEncoder(7, -1, false); // choke off
    chopEncoder(6, 1, false); // +1 st
    const pads = chopRack()!.pads;
    expect([pads[3].choke, pads[7].choke]).toEqual([0, 0]);
    expect([pads[3].pitch, pads[7].pitch]).toEqual([1, 1]);
  });
  it("Shift + encoder 8 sets every chop's pads", () => {
    session(null);
    chopKeyDown(CHOP_KEY0, 100);
    chopPad(0, 100);
    chopKeyUp(CHOP_KEY0);
    chopKeyDown(CHOP_KEY0 + 2, 100);
    chopPad(1, 100);
    chopEncoder(7, -1, true);
    expect(chopRack()!.pads.slice(0, 2).map((p) => p.choke)).toEqual([0, 0]);
    chopEncoder(7, 1, true);
    expect(chopRack()!.pads.slice(0, 2).map((p) => p.choke)).toEqual([1, 1]);
  });
});

describe("stems (Sample page, encoder 7)", () => {
  it("splits the sample once, adds both stems and switches with the markers where they were", async () => {
    session(null);
    set({ samples: { s: { id: "s", name: "Loop", folder: "Breaks" } } });
    await chopStem("noDrums");
    const c = get().chop!;
    expect(played.splits).toBe(1);
    expect(played.added).toEqual(["Loop drums", "Loop no drums"]);
    expect(c.sampleId).toBe("id:Loop no drums");
    expect(c.markers).toEqual([0, 0.25, 0.5, 1]);
    expect(shownStem(c)).toBe("noDrums");
    await chopStem("drums");
    await chopStem("full");
    expect(played.splits).toBe(1);
    expect(get().chop!.sampleId).toBe("s");
  });

  it("steps through Full, Drums, No drums on encoder 7", async () => {
    session(null);
    updateChop({ page: "sample" });
    chopEncoder(6, 1, false);
    await vi.waitFor(() => expect(shownStem(get().chop!)).toBe("drums"));
    chopEncoder(6, 1, false);
    expect(shownStem(get().chop!)).toBe("noDrums");
    chopEncoder(6, -1, false);
    chopEncoder(6, -1, false);
    expect(get().chop!.sampleId).toBe("s");
  });

  it("moves a chop track's keys to the stem", async () => {
    session(null);
    chopKeyDown(CHOP_KEY0, 100);
    chopPad(0, 100);
    chopKeyUp(CHOP_KEY0);
    await chopStem("drums");
    expect(chopRack()!.chops!.sampleId).toBe(get().chop!.sampleId);
    expect(chopRack()!.chops!.sampleId).not.toBe("s");
  });
});
