import { describe, expect, it } from "vitest";
import { bitmapSysex, isBitmapAck, SYSEX_HEADER } from "../midi/protocol";
import { font5x7 } from "./fonts";
import { Frame, PACKED_SIZE, fitText } from "./frame";
import { browserScreen, chopScreen, duckScreen, keysScreen, padScreen, stepScreen } from "./screens";
import { BOOT_BURP_MS, BOOT_EAT_MS, BOOT_MS, bootFrame } from "./bootAnim";
import { filterPanel, highpassDb, lowpassDb, scrollTop } from "./widgets";

describe("Frame.pack", () => {
  it("packs to 1216 bytes, all 7-bit", () => {
    const f = new Frame();
    f.fillRect(0, 0, 128, 64);
    const p = f.pack();
    expect(p.length).toBe(PACKED_SIZE);
    expect(p.every((b) => b < 0x80)).toBe(true);
    expect(p[18]).toBe(0b1100000); // last byte: only 2 real pixels (126, 127)
  });
  it("puts pixel (0,0) in bit 6 of byte 0 and (127,y) in byte 18", () => {
    const f = new Frame();
    f.set(0, 0);
    f.set(127, 5);
    const p = f.pack();
    expect(p[0]).toBe(1 << 6);
    expect(p[5 * 19 + 18]).toBe(1 << (6 - (127 % 7)));
  });
});

describe("text", () => {
  it("has all 95 printable glyphs", () => {
    for (let c = 32; c < 127; c++) expect(font5x7.glyph(c)).toHaveLength(5);
    expect(font5x7.glyph(65)).toEqual([0x7e, 0x11, 0x11, 0x11, 0x7e]); // 'A'
  });
  it("truncates to the pixel width with ~", () => {
    expect(fitText("Hello", 29)).toBe("Hello");
    expect(fitText("Hello world", 29)).toBe("Hell~");
  });
});

describe("list scrolling", () => {
  it("keeps the cursor in view", () => {
    expect(scrollTop(3, 2, 6)).toBe(0);
    expect(scrollTop(40, 0, 6)).toBe(0);
    expect(scrollTop(40, 20, 6)).toBe(17);
    expect(scrollTop(40, 39, 6)).toBe(34);
  });
  it("renders the cursor row inverted", () => {
    const f = browserScreen({ folder: "Kicks", index: 0, items: [{ label: "Kick" }, { label: "Snare" }], targetPad: 0 });
    expect(f.get(0, 10)).toBe(1); // selected row background
    expect(f.get(0, 19)).toBe(0); // next row background
  });
});

describe("bitmap sysex", () => {
  it("frames the data", () => {
    const msg = bitmapSysex(0x20, new Uint8Array(PACKED_SIZE));
    expect(msg.slice(0, 8)).toEqual([...SYSEX_HEADER, 0x09, 0x20]);
    expect(msg.length).toBe(6 + 2 + PACKED_SIZE + 1);
    expect(msg[msg.length - 1]).toBe(0xf7);
  });
  it("recognises the ack", () => {
    expect(isBitmapAck([...SYSEX_HEADER, 0x09, 0xf7])).toBe(true); // measured on hardware
    expect(isBitmapAck([...SYSEX_HEADER, 0x09, 0x7f, 0xf7])).toBe(true); // guide's form
    expect(isBitmapAck([...SYSEX_HEADER, 0x09, 0x00, 0xf7])).toBe(false);
  });
});

describe("filter panel", () => {
  it("matches 2-pole filters: Q at cutoff, 12 dB/oct slopes", () => {
    expect(lowpassDb(20, 2000, 0)).toBeCloseTo(0, 2);
    expect(lowpassDb(2000, 2000, 6)).toBeCloseTo(6, 5);
    expect(lowpassDb(16000, 2000, 0) - lowpassDb(8000, 2000, 0)).toBeCloseTo(-12, 0);
    expect(highpassDb(20000, 200, 0)).toBeCloseTo(0, 2);
    expect(highpassDb(200, 200, 6)).toBeCloseTo(6, 5);
    expect(highpassDb(25, 200, 0) - highpassDb(50, 200, 0)).toBeCloseTo(-12, 0);
  });
  const markers = (curve: Parameters<typeof filterPanel>[5]) => {
    const f = new Frame();
    filterPanel(f, 0, 9, 128, 45, curve);
    // dotted cutoff lines: on, off, on, off down the column, just below the frame border
    return [...Array(126).keys()].map((c) => c + 1).filter((x) => f.get(x, 10) && !f.get(x, 11) && f.get(x, 12) && !f.get(x, 13) && f.get(x, 14));
  };
  it("marks each cutoff, ordered HP < LP", () => {
    const m = markers({ lpHz: 5000, hpHz: 200, qDb: 1 });
    expect(m).toHaveLength(2);
    expect(markers({ lpHz: 300, hpHz: null, qDb: 1 })[0]).toBeLessThan(m[1]);
  });
  it("draws a line, not a filled area", () => {
    const f = new Frame();
    filterPanel(f, 0, 9, 128, 45, { lpHz: 1000, hpHz: null, qDb: 1 });
    // bottom-left inside the box (far below the flat passband line) stays empty
    expect(f.get(5, 50)).toBe(0);
  });
});

describe("chop screen", () => {
  const base = { name: "Tab", peaks: null, sel: null, playhead: null, slices: 2, zoom: 1, at: "0.000s" };
  it("draws the selected marker solid and hides markers outside the window", () => {
    const f = chopScreen({ ...base, markers: [0.25, 0.5, 1.5], sel: 1 });
    const x = Math.round(0.5 * 127);
    const col = (cx: number) => Array.from({ length: 40 }, (_, j) => f.get(cx, 11 + j));
    expect(col(x).every(Boolean)).toBe(true); // selected: solid
    const dotted = col(Math.round(0.25 * 127));
    expect(dotted.some(Boolean) && !dotted.every(Boolean)).toBe(true); // others: dotted
  });
});

const lit = (f: { px: Uint8Array }) => f.px.reduce((n, v) => n + v, 0);

describe("boot animation", () => {
  it("plays for its length, then hands back to the normal screen", () => {
    for (const ms of [0, BOOT_EAT_MS / 2, BOOT_EAT_MS + 100, BOOT_BURP_MS + 600]) expect(lit(bootFrame(ms)!)).toBeGreaterThan(50);
    expect(bootFrame(BOOT_MS)).toBeNull();
    expect(bootFrame(-1)).toBeNull();
  });
  it("eats the waveform: less of it is left as the blob moves right", () => {
    expect(lit(bootFrame(BOOT_EAT_MS * 0.9)!)).toBeLessThan(lit(bootFrame(BOOT_EAT_MS * 0.1)!));
  });
});

describe("duck screen", () => {
  const view = { on: true, source: "P1 Kick", target: "P9 Bass", depth: 0.8, attack: 0.005, hold: 0.06, release: 0.2, level: 1, summary: "P1>P9 80%" };
  it("shows more gain reduction when the target is ducked", () => {
    expect(lit(duckScreen({ ...view, level: 0.2 }))).toBeGreaterThan(lit(duckScreen(view)));
  });
});

describe("keys screen", () => {
  it("highlights the current preset in the list", () => {
    const presets = ["Init", "Sub Bass", "Acid Bass", "Reese"].map((label) => ({ label }));
    const a = keysScreen({ presets, index: 0, title: "Init", note: "SYNTH", summary: "" });
    const b = keysScreen({ presets, index: 2, title: "Acid Bass", note: "SYNTH", summary: "" });
    // The selected row is an inverted bar, so moving the cursor changes the picture.
    expect(Array.from(a.px)).not.toEqual(Array.from(b.px));
  });
});

describe("track header", () => {
  // The header is an inverted bar: its unlit pixels are the text.
  const headerText = (f: Frame) => Array.from(f.px.slice(0, 128 * 9));
  const pad = { pad: 4, name: "Snare", peaks: null, start: 0, end: 1, status: "P1 PLAY", pageTag: "PAD", pageInfo: "" };
  const step = { pattern: 0, item: "Snare", bar: 0, bars: 1, steps: Array(16).fill(false), playhead: -1, status: "", pageTag: "PAD" };

  it("names the selected track on the pad and step screens", () => {
    expect(headerText(padScreen({ ...pad, track: "T1 Drums" }))).not.toEqual(headerText(padScreen({ ...pad, track: "T3 Chop 1" })));
    expect(headerText(stepScreen({ ...step, track: "T1 Drums" }))).not.toEqual(headerText(stepScreen({ ...step, track: "T2 Keys 1" })));
  });

  it("shows the keys track instead of the preset when given", () => {
    const presets = [{ label: "Init" }];
    const v = { presets, index: 0, title: "Init", note: "SYNTH", summary: "" };
    expect(headerText(keysScreen({ ...v, track: "T2 Keys 1" }))).not.toEqual(headerText(keysScreen(v)));
  });
});
