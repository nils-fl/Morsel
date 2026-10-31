import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A one-second silent buffer stands in for the chopped sample.
vi.mock("../audio/engine", () => ({
  engine: {
    buffer: () => ({ length: 44100, duration: 1, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(44100) }),
    ctx: { currentTime: 0 },
    chopVoice: () => 0,
    stopPreview: () => {},
  },
}));
vi.mock("../actions", () => ({ allPresets: () => [], applyPreset: () => {}, currentKit: () => "", kitNames: () => [], stepKit: () => "" }));
vi.mock("../seq/sequencer", () => ({ sequencer: { trackTickAt: () => null } }));
// The controller (the Launchkey's side) is stood in for: what its screen shows, and the encoder turns it gets.
const hw = vi.hoisted(() => ({ turned: [] as [number, number][], model: null as unknown, overlay: null as unknown }));
vi.mock("../modes/controller", () => ({
  turnHwEncoder: (i: number, d: number) => hw.turned.push([i, d]),
  currentModel: () => hw.model,
  heldStepList: () => [],
  statusText: () => "P1 STOP",
  trackLabel: () => "T1 Drums",
}));
vi.mock("../modes/notify", () => ({ activeOverlay: () => hw.overlay }));
// Perform's pads: what the helper screen's touches play.
const pf = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../modes/perform", () => ({
  performPadDown: (p: number) => pf.calls.push(`down ${p}`),
  performPadUp: (p: number) => pf.calls.push(`up ${p}`),
  performToggleLatch: (p: number) => pf.calls.push(`latch ${p}`),
}));

import { newChop } from "../modes/chop";
import { BAR_TICKS } from "../seq/timing";
import { DRUMS_ID, KEYS_ID, defaultProject, get, set, updateTrack } from "../state/store";
import type { NoteEvent } from "../state/types";
import { drawHelper } from "./draw";
import { LONG_PRESS_MS, helperCancel, helperPointer, helperShown, helperWheel } from "./input";
import { LANE, WAVE, encoderAt, gridCell, mainRect, markerAt, padCell, stripCell, xOf } from "./layout";
import { stepOverview, trackRows } from "./overview";
import { PALETTE } from "./palette";
import { buildView, rangePeaks, type HelperView, type Main } from "./view";

const laneY = LANE.y + LANE.h / 2;
const waveY = WAVE.y + WAVE.h / 2;
const chop = () => get().chop!;
const xAt = (f: number) => xOf(f, chop().view);
const cells8 = (n: number) => Array.from({ length: 8 }, (_, i) => (i < n ? { name: `E${i + 1}`, value: "1", t: 0.5, bipolar: false, active: false } : null));

/** Sample mode open on a chop with three chops (markers at 0, ¼, ½, 1), shown on the helper screen. */
function session(view: [number, number] = [0, 1]) {
  set({ hwMode: "chop", chop: { ...newChop("s", [0, 0.25, 0.5, 1]), page: "chop", view } });
  helperShown(buildView());
}

beforeEach(() => {
  set({ project: defaultProject(), undo: [], redo: [], selectedTrack: DRUMS_ID, drumTrack: DRUMS_ID, keysTrack: KEYS_ID, hwMode: "play", chop: null, shift: false });
  hw.turned.length = 0;
  pf.calls.length = 0;
  hw.model = null;
  hw.overlay = null;
  helperCancel();
});
afterEach(() => vi.useRealTimers());

describe("helper layout", () => {
  it("finds the marker nearest a touch, within the radius", () => {
    const view: [number, number] = [0, 1];
    expect(markerAt([0, 0.25, 0.5, 1], view, xOf(0.25, view) + 8, 22)).toBe(1);
    expect(markerAt([0, 0.25, 0.5, 1], view, xOf(0.25, view) + 30, 22)).toBe(-1);
  });
  it("finds the encoder under a touch in the strip and in the big grid", () => {
    const s = stripCell(3), g = gridCell(6);
    expect(encoderAt("strip", s.x + 5, s.y + 5)).toBe(3);
    expect(encoderAt("grid", g.x + g.w / 2, g.y + g.h / 2)).toBe(6);
    expect(encoderAt("strip", 400, waveY)).toBe(-1);
  });
  it("gives touch targets at least 64 px", () => {
    for (const r of [stripCell(0), gridCell(0), LANE]) expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(64);
  });
});

describe("helper view", () => {
  it("shows the chop with its encoders in Sample mode", () => {
    set({ hwMode: "chop", chop: { ...newChop("s", [0, 0.5, 1]), page: "chop" } });
    const v = buildView();
    expect(v.main.kind).toBe("chop");
    expect(v.strip?.cells.filter(Boolean).length).toBe(8);
    expect(v.header.mode).toBe("SAMPLE");
  });

  it("makes the encoders the main area on an encoder page, lighting up the turned one instead of a popup", () => {
    hw.model = { kind: "encoders", v: { title: "T1", status: "", tag: "MIX", info: "", cells: [{ name: "Lvl", value: "80", level: 0.8 }, null, null, null, null, null, null, null] } };
    hw.overlay = { name: "Lvl", value: "80", encoder: 0, until: Infinity };
    const v = buildView();
    expect(v.main.kind).toBe("encoders");
    expect(v.strip).toBeNull();
    expect(v.popup).toBeNull();
    expect(v.main.kind === "encoders" && v.main.cells[0]?.active).toBe(true);
  });

  it("shows a Launchkey message without an encoder as a popup", () => {
    hw.model = { kind: "pad", v: { track: "T1", pad: 0, name: "Kick", peaks: null, start: 0, end: 1, status: "", pageTag: "PAD", pageInfo: "" } };
    hw.overlay = { name: "Bar", value: "2 / 4", until: Infinity };
    const v = buildView();
    expect(v.popup).toMatchObject({ name: "Bar", value: "2 / 4" });
    expect(v.strip).not.toBeNull();
  });

  it("gives Browse a long list and no encoder strip", () => {
    set({ hwMode: "browse" });
    hw.model = { kind: "browser", v: { track: "T1 Drums", target: "P3", folder: "Drums/Kicks", index: 20, items: Array.from({ length: 40 }, (_, i) => ({ label: `k${i}` })) } };
    const v = buildView();
    expect(v.strip).toBeNull();
    expect(v.main).toMatchObject({ kind: "list", heading: "Drums/Kicks", pos: "21/40", index: 20 });
  });

  it("shows the Shift map while Shift is held, in any mode", () => {
    set({ hwMode: "chop", chop: newChop("s"), shift: true });
    hw.model = { kind: "shift", v: { rows: [["Func", "Undo"]], enc: "enc=fine" } };
    expect(buildView().main.kind).toBe("shift");
    expect(buildView().header.mode).toBe("SHIFT");
  });
});

describe("step overview", () => {
  const ev = (tick: number, note: number, vel: number) => ({ id: `${tick}:${note}`, tick, note, vel, len: 24 }) as unknown as NoteEvent;
  it("puts each step's loudest note of the selected pad at its place in the clip", () => {
    const span = BAR_TICKS / 16;
    const o = stepOverview([ev(BAR_TICKS, 0, 127), ev(BAR_TICKS + 4 * span, 0, 64), ev(BAR_TICKS + 4 * span, 1, 127), ev(BAR_TICKS + 4 * span + 2, 0, 100)], {
      bars: 2, span, drum: true, note: 0, pageFirst: 16, pageLen: 16, playTick: 5 * span, heldTicks: [BAR_TICKS],
    });
    expect(o.perBar).toBe(16);
    expect(o.vel).toHaveLength(32);
    expect(o.vel[16]).toBe(1);
    expect(o.vel[20]).toBeCloseTo(100 / 127);
    expect(o.vel.filter((v) => v !== null)).toHaveLength(2);
    expect(o.playhead).toBe(5);
    expect(o.held).toEqual([16]);
  });
  it("counts 12 steps a bar on a triplet grid", () => {
    expect(stepOverview([], { bars: 1, span: BAR_TICKS / 12, drum: false, note: 0, pageFirst: 0, pageLen: 12, playTick: null, heldTicks: [] }).perBar).toBe(12);
  });
});

describe("track overview", () => {
  it("shows mute, solo and what is heard", () => {
    updateTrack(KEYS_ID, { solo: true }, false);
    const rows = trackRows(get().project, 0, DRUMS_ID, () => null);
    const drums = rows.find((r) => r.kind === "drum")!, keys = rows.find((r) => r.kind === "keys")!;
    expect(drums.selected).toBe(true);
    expect(keys.solo).toBe(true);
    expect(keys.audible).toBe(true);
    expect(drums.audible).toBe(false);
  });
});

describe("helper touch in Sample mode", () => {
  it("drags a marker from its handle, keeping the markers in order", () => {
    session();
    helperPointer("down", xAt(0.25), laneY);
    expect(chop().sel).toBe(1);
    helperPointer("move", xAt(0.4), laneY);
    helperPointer("up", xAt(0.4), laneY);
    const m = chop().markers;
    expect(m).toHaveLength(4);
    expect(m[1]).toBeCloseTo(0.4, 2);
    expect([...m].sort((a, b) => a - b)).toEqual(m);
  });

  it("adds a marker where the waveform is tapped", () => {
    session();
    helperPointer("down", xAt(0.75), waveY);
    helperPointer("up", xAt(0.75), waveY);
    const m = chop().markers;
    expect(m).toHaveLength(5);
    expect(m[3]).toBeCloseTo(0.75, 2);
    expect(chop().sel).toBe(3);
  });

  it("removes an inner marker held still, but not the region's ends", () => {
    vi.useFakeTimers();
    session();
    helperPointer("down", xAt(0.5), laneY);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    helperPointer("up", xAt(0.5), laneY);
    expect(chop().markers).toEqual([0, 0.25, 1]);
    helperPointer("down", xAt(1), laneY);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    helperPointer("up", xAt(1), laneY);
    expect(chop().markers).toEqual([0, 0.25, 1]);
  });

  it("doesn't remove a marker that was moved before the long press", () => {
    vi.useFakeTimers();
    session();
    helperPointer("down", xAt(0.5), laneY);
    helperPointer("move", xAt(0.6), laneY);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    helperPointer("up", xAt(0.6), laneY);
    expect(chop().markers).toHaveLength(4);
  });

  it("scrolls when empty waveform is dragged, without adding a marker", () => {
    session([0.6, 0.8]);
    const x0 = WAVE.x + WAVE.w / 2;
    helperPointer("down", x0, waveY);
    helperPointer("move", x0 - WAVE.w / 4, waveY);
    helperPointer("up", x0 - WAVE.w / 4, waveY);
    expect(chop().view[0]).toBeCloseTo(0.65, 5);
    expect(chop().markers).toHaveLength(4);
  });

  it("zooms the waveform with the wheel", () => {
    session();
    helperWheel(WAVE.x + WAVE.w / 2, waveY, 3);
    const [v0, v1] = chop().view;
    expect(v1 - v0).toBeLessThan(1);
  });

  it("ignores waveform touches when the chop isn't shown", () => {
    session();
    helperShown({ main: { kind: "boot" }, strip: null });
    helperPointer("down", xAt(0.75), waveY);
    helperPointer("up", xAt(0.75), waveY);
    expect(chop().markers).toHaveLength(4);
  });
});

describe("helper encoders", () => {
  it("turns the strip's encoder like the Launchkey's, a detent per 8 px, up = more", () => {
    helperShown({ main: { kind: "boot" }, strip: { cells: cells8(8) } });
    const c = stripCell(2);
    helperPointer("down", c.x + 20, c.y + 40);
    helperPointer("move", c.x + 20, c.y + 40 - 17);
    helperPointer("move", c.x + 20, c.y + 40 - 8);
    helperPointer("up", c.x + 20, c.y + 40 - 8);
    expect(hw.turned).toEqual([[2, 1], [2, 1], [2, -1]]);
  });
  it("turns the big grid's encoders when the main area is the encoders", () => {
    helperShown({ main: { kind: "encoders", heading: "MIX", info: "", cells: cells8(8) }, strip: null });
    const c = gridCell(5);
    helperWheel(c.x + 10, c.y + 10, 2);
    expect(hw.turned).toEqual([[5, 1], [5, 1]]);
  });
});

describe("helper drawing", () => {
  /** A 2D context that records every colour it is given. */
  function recorder() {
    const colors = new Set<string>();
    const target = {
      measureText: (s: string) => ({ width: s.length * 8 }),
      set fillStyle(c: string) { colors.add(c); },
      set strokeStyle(c: string) { colors.add(c); },
    };
    const g = new Proxy(target, {
      get: (t, k) => (k in t ? Reflect.get(t, k) : () => {}),
      set: (t, k, v) => (k in t ? Reflect.set(t, k, v) : true),
    });
    return { g: g as unknown as CanvasRenderingContext2D, colors };
  }
  const header = { track: "T1 Drums", mode: "PLAY", page: "ENC 2/8 Pad", status: "P1 PLAY", pos: "2.3", bpm: "120 BPM", playing: true, recording: false };
  const peaks = rangePeaks(Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 10)), 0, 2000, 776);
  const curve = { depth: 0.8, attack: 0.01, hold: 0.05, release: 0.2 };
  const mains: Main[] = [
    { kind: "boot" },
    { kind: "list", heading: "Kits", pos: "3/30", note: "Factory", items: Array.from({ length: 30 }, (_, i) => ({ label: `k${i}`, folder: i < 3, user: i === 5 })), index: 2 },
    { kind: "pad", pad: 0, name: "Kick", peaks, start: 0.1, end: 0.9, info: "Pitch 0" },
    { kind: "pad", pad: 1, name: "Empty", peaks: null, start: 0, end: 1, info: "" },
    { kind: "duck", v: { ...curve, track: "T1", status: "", on: false, source: "P1 Kick", target: "All", level: 0.6, summary: "Off" } },
    { kind: "encoders", heading: "MIX", info: "Levels", cells: [...cells8(5).slice(0, 5), null, null, { name: "Pan", value: "L20", t: 0.3, bipolar: true, active: true }] },
    { kind: "grid", heading: "Patterns", info: "", cells: Array.from({ length: 16 }, (_, i) => ({ label: `${i + 1}`, sub: "1 bar", fill: i === 0, mark: i < 3, dim: i === 4 })) },
    { kind: "tracks", info: "", add: "+ Add a track", rows: trackRows(defaultProject(), 0, DRUMS_ID, () => 96) },
    { kind: "steps", item: "Pad 1 · Kick", bar: "Bar 1/2", o: { bars: 2, perBar: 16, vel: Array.from({ length: 32 }, (_, i) => (i % 4 ? null : 0.8)), pageFirst: 0, pageLen: 16, playhead: 3, held: [4] } },
    { kind: "chop", view: [0.1, 0.9], markers: [0, 0.25, 0.5, 1], sel: 1, playhead: 0.4, peaks, overview: rangePeaks(new Float32Array(100), 0, 100, 560), info: "3 chops" },
    { kind: "shift", rows: [["Func", "Undo"], ["Scene", "Clear"]], enc: "enc=fine" },
  ];

  it("draws every view only in the palette's colours", () => {
    for (const main of mains) {
      const views: HelperView[] = [
        { header, main, strip: { cells: cells8(6) }, popup: null },
        { header, main, strip: null, popup: { name: "Cutoff", value: "2.1k", visual: { kind: "filter", lpHz: 2100, hpHz: 80, qDb: 3 } } },
        { header, main, strip: null, popup: { name: "Depth", value: "80%", visual: { kind: "duck", ...curve } } },
        { header, main, strip: null, popup: { name: "Bar", value: "2 / 4" } },
      ];
      for (const v of views) {
        const { g, colors } = recorder();
        drawHelper(g, v);
        expect(colors.size).toBeGreaterThan(2);
        for (const c of colors) expect(PALETTE).toContain(c);
      }
    }
  });

  it("works out min/max per column", () => {
    const p = rangePeaks(Float32Array.from([0.5, -0.5, 0.2, 0.9]), 0, 4, 2);
    expect([...p.max]).toEqual([0.5, 0.8999999761581421]);
    expect([...p.min]).toEqual([-0.5, 0]);
  });
});

describe("helper touch in Perform mode", () => {
  /** The Perform grid on screen (with the encoder strip under it), and the centre of pad cell i. */
  function perform() {
    set({ hwMode: "perform" });
    const cells = Array.from({ length: 16 }, () => ({ label: "", sub: "", fill: false, mark: false, dim: false }));
    helperShown({ main: { kind: "grid", heading: "Pad FX", info: "", cells }, strip: { cells: cells8(3) } });
    const area = mainRect(true);
    return (i: number) => {
      const r = padCell(i, area);
      return [r.x + r.w / 2, r.y + r.h / 2] as const;
    };
  }

  it("holding a cell plays its pad until let go (pads 9-16 on top)", () => {
    const at = perform();
    helperPointer("down", ...at(12));
    helperPointer("move", at(12)[0] + 20, at(12)[1]);
    helperPointer("up", ...at(12));
    expect(pf.calls).toEqual(["down 12", "up 12"]);
    expect(padCell(12, mainRect(true)).y).toBeLessThan(padCell(4, mainRect(true)).y);
  });

  it("Shift-tap latches instead, and a lost pointer lets go", () => {
    const at = perform();
    helperPointer("down", ...at(5), true);
    helperPointer("up", ...at(5), true);
    helperPointer("down", ...at(2));
    helperCancel();
    expect(pf.calls).toEqual(["latch 5", "down 2", "up 2"]);
  });

  it("the encoder strip still turns encoders in Perform mode", () => {
    perform();
    const r = stripCell(1);
    helperPointer("down", r.x + r.w / 2, r.y + 20);
    helperPointer("move", r.x + r.w / 2, r.y - 20);
    expect(pf.calls).toEqual([]);
    expect(hw.turned.length).toBeGreaterThan(0);
  });
});
