// Full-screen layouts. Plain data in, Frame out: no store, MIDI or DOM.
// Every mode screen has the same header: the selected track on the left, "P<n> <STATE>" (pattern and
// transport) on the right, so Play / Record always show. The footer names the mode or encoder page.
import { Frame, H, W, textWidth } from "./frame";
import { HEADER_H, ROW_H, duckPanel, footer, header, list, stepRow, waveform, type DuckCurve, type ListItem, type Peaks } from "./widgets";
import type { HwMode, TrackKind } from "../state/types";

export interface BrowserView {
  /** The track Func loads onto, e.g. "T1 Drums". */
  track: string;
  /** The pad on a drum track ("P3"); empty on a keys track (the keys). */
  target: string;
  folder: string;
  index: number;
  items: ListItem[];
}

/** Header: the track (and pad) Func loads onto, and the position in the folder. Footer: the folder. */
export function browserScreen(v: BrowserView): Frame {
  const f = new Frame();
  const pos = v.items.length ? `${v.index + 1}/${v.items.length}` : "0/0";
  header(f, v.track, v.target ? `${v.target} ${pos}` : pos);
  list(f, HEADER_H + 1, Math.floor((H - HEADER_H - 1 - 9) / ROW_H), v.items, v.index);
  footer(f, "BROWSE", v.folder || "Top");
  return f;
}

export interface PadView {
  track: string; // e.g. "T1 Drums"
  pad: number;
  name: string;
  peaks: Peaks | null;
  start: number;
  end: number;
  status: string; // e.g. "P1 PLAY"
  pageTag: string; // encoder page, e.g. "PAD2"
  pageInfo: string; // that page's values
}

export function padScreen(v: PadView): Frame {
  const f = new Frame();
  header(f, v.track, v.status);
  f.textFit(2, HEADER_H + 2, `${v.pad + 1} ${v.name}`, W - 4);
  waveform(f, 0, HEADER_H + 11, W, 32, v.peaks, v.start, v.end);
  footer(f, v.pageTag, v.pageInfo);
  return f;
}

export interface StepView {
  track: string; // e.g. "T1 Drums"
  status: string; // e.g. "P1 PLAY"
  item: string; // what the steps write: the pad (drum track) or the note (keys track)
  bar: string; // where the page on the pads starts: "3", or "3.3" when a page is half a bar
  bars: number;
  steps: boolean[]; // the steps of the page on the pads
  perRow?: number; // steps in a pad row: 8, or 6 on a triplet grid
  playhead: number; // step index within the page, or -1
  pageTag: string; // encoder page
  pageInfo: string; // that page's values
}

export function stepScreen(v: StepView): Frame {
  const f = new Frame();
  header(f, v.track, v.status);
  // Mirrors the pads: top row = steps 1-8, bottom row = 9-16 (rows of 6 from the left on a triplet grid).
  const n = v.perRow ?? 8;
  const size = 13, gap = 3, x0 = Math.floor((W - (8 * size + 7 * gap)) / 2);
  stepRow(f, x0, 14, size, gap, v.steps.slice(0, n), v.playhead, 0);
  stepRow(f, x0, 14 + size + 4, size, gap, v.steps.slice(n, 2 * n), v.playhead, n);
  const bar = `B${v.bar}/${v.bars}`;
  const bw = textWidth(bar);
  f.text(W - 2 - bw, 46, bar);
  f.textFit(2, 46, v.item, W - 4 - bw - 6);
  footer(f, v.pageTag, v.pageInfo);
  return f;
}

export interface ChopScreenView {
  name: string;
  peaks: Peaks | null;
  markers: number[]; // positions within the visible window (0..1 on screen)
  sel: number | null;
  playhead: number | null; // within the window, or null
  slices: number;
  page: "sample" | "chop";
  /** Chop page footer: the selected chop ("7 F#3 +3st CH") or zoom and position. */
  info: string;
  /** Sample page: the region's length ("4 bars"), its tempo and the tempo it stretches to. */
  tempo: { length: string; from: string; to: string; seconds: string };
}

/** Chop page: the zoomed waveform with its markers. Sample page: the waveform with start and end, the region's length
 *  and tempo, the stretch target, and what Func and Scene do there. */
export function chopScreen(v: ChopScreenView): Frame {
  const f = new Frame();
  const tempo = v.page === "sample";
  header(f, v.name, tempo ? v.tempo.length : `${v.slices} SL`);
  const y = HEADER_H + 2, h = tempo ? 26 : 40;
  waveform(f, 0, y, W, h, v.peaks, 0, 1);
  const px = (m: number) => Math.round(m * (W - 1));
  v.markers.forEach((m, i) => {
    if (m < 0 || m > 1) return;
    const x = px(m);
    if (i === v.sel) {
      // Selected: solid, with a notch on top.
      f.vline(x, y, y + h - 1);
      f.hline(x - 2, x + 2, y);
      f.hline(x - 1, x + 1, y + 1);
    } else for (let j = y; j < y + h; j += 2) f.set(x, j);
  });
  if (v.playhead !== null && v.playhead >= 0 && v.playhead <= 1) {
    const x = px(v.playhead);
    for (let j = y; j < y + h; j++) f.set(x, j, (j >> 1) % 2);
  }
  if (tempo) {
    const sw = textWidth(v.tempo.seconds);
    f.text(W - 2 - sw, y + h + 3, v.tempo.seconds);
    f.textFit(2, y + h + 3, `${v.tempo.from} > ${v.tempo.to} BPM`, W - 4 - sw - 6);
    footer(f, "SAMPLE", "Fn=keep");
  } else footer(f, "CHOP", v.info);
  return f;
}

export interface DuckView extends DuckCurve {
  track: string; // e.g. "T1 Drums"
  status: string; // e.g. "P1 PLAY"
  on: boolean;
  source: string; // e.g. "P1 Kick"
  target: string; // e.g. "P9 Bass", "All"
  level: number; // current ducker gain of the target, 0..1
  summary: string; // e.g. "On T1P1>All 85%"
}

export function duckScreen(v: DuckView): Frame {
  const f = new Frame();
  header(f, v.track, v.status);
  f.textFit(2, HEADER_H + 2, `${v.source} > ${v.target}`, W - 4);
  const y = HEADER_H + 11, h = H - 9 - y - 2;
  duckPanel(f, 0, y, W - 10, h, v);
  // Live gain reduction: the bar grows down from the top as the target ducks.
  f.rect(W - 8, y, 8, h);
  f.fillRect(W - 6, y + 2, 4, Math.round((h - 4) * Math.max(0, Math.min(1, 1 - v.level))));
  if (!v.on) for (let j = y + 1; j < y + h - 1; j++) for (let i = 1; i < W - 11; i++) if ((i + j) % 2 === 0) f.set(i, j, 0);
  footer(f, "DUCK", v.summary);
  return f;
}

export interface KeysView {
  presets: { label: string; user?: boolean }[];
  /** Current item; -1 highlights nothing (e.g. a drum track playing pads that aren't a saved kit). */
  index: number;
  title: string; // preset label, e.g. "Warm Pad*" (header when there is no track)
  status: string; // e.g. "P1 PLAY"
  summary: string;
  /** Header on a keys track ("T2 Keys 1"); without one the header shows the preset. */
  track?: string;
  /** Footer tag (the encoder page), "KEYS" by default. */
  tag?: string;
  /** Presets in folders: the folder line above the list ("Bass", "3/14"); `presets` then holds that folder's presets. */
  folder?: { name: string; pos: string };
}

/** A keys track (or the Keys / Kit encoder page): the preset list around the current one, like the sample browser. */
export function keysScreen(v: KeysView): Frame {
  const f = new Frame();
  header(f, v.track ?? `KEYS ${v.title}`, v.status);
  let rows = Math.floor((H - HEADER_H - 1 - 9) / ROW_H);
  let y = HEADER_H + 1;
  if (v.folder) {
    // Like a Browse folder: icon, name, and the position in the folder on the right.
    const pw = textWidth(v.folder.pos);
    list(f, y, 1, [{ label: v.folder.name, folder: true }], -1);
    f.fillRect(W - pw - 4, y, pw + 4, ROW_H, 0);
    f.text(W - pw - 2, y + 1, v.folder.pos);
    f.hline(0, W - 1, y + ROW_H - 1);
    y += ROW_H;
    rows--;
  }
  list(f, y, rows, v.presets.map((p) => ({ label: p.user ? `${p.label} (mine)` : p.label })), v.index);
  footer(f, v.tag ?? "KEYS", v.summary);
  return f;
}

export interface GridCell {
  label: string; // 1-2 characters
  fill: boolean; // drawn solid (selected / on)
  mark?: boolean; // a bar under the label (e.g. a pattern with notes)
  dim?: boolean; // dotted outline (empty / off)
}

export interface GridView {
  title: string; // header left, e.g. "T1 Drums"
  status: string; // header right, e.g. "P1 PLAY"
  cells: GridCell[]; // by pad index: 0-7 bottom row, 8-15 top row, like the pads
  tag: string; // the mode, e.g. "TRACK"
  info: string;
  note?: string; // replaces the grid, e.g. "Drum tracks only"
}

/** Track, Mixer and Pattern modes: the 16 pads as two rows of cells, laid out like the hardware. */
export function gridScreen(v: GridView): Frame {
  const f = new Frame();
  header(f, v.title, v.status);
  if (v.note) {
    f.textFit(2, HEADER_H + 16, v.note, W - 4);
  } else {
    const cw = 14, gap = 2, ch = 19, x0 = 1, rows = [HEADER_H + 3, HEADER_H + 3 + ch + 3];
    for (let i = 0; i < 16; i++) {
      const c = v.cells[i];
      if (!c) continue;
      const x = x0 + (i % 8) * (cw + gap), y = rows[i >= 8 ? 0 : 1];
      if (c.fill) f.fillRect(x, y, cw, ch);
      else if (c.dim) for (let k = 0; k < cw; k += 2) { f.set(x + k, y); f.set(x + k, y + ch - 1); }
      else f.rect(x, y, cw, ch);
      if (c.dim && !c.fill) for (let k = 0; k < ch; k += 2) { f.set(x, y + k); f.set(x + cw - 1, y + k); }
      const tw = c.label.length * 6 - 1;
      f.text(x + Math.floor((cw - tw) / 2), y + 4, c.label, c.fill ? 0 : 1);
      if (c.mark) f.hline(x + 3, x + cw - 4, y + ch - 4, c.fill ? 0 : 1);
    }
  }
  footer(f, v.tag, v.info);
  return f;
}

export interface EncoderCell {
  name: string;
  value: string;
  level: number; // 0..1 position in the parameter's range
}

export interface EncoderView {
  title: string; // header left, e.g. "T2 Keys 1"
  status: string; // header right, e.g. "P1 PLAY"
  tag: string; // the page, e.g. "LFO"
  info: string; // the page's summary
  cells: (EncoderCell | null)[]; // encoders 1-8; null = unused
  /** Encoder being turned: its cell is drawn inverted. */
  active?: number;
}

const SHORT: Record<string, string> = {
  "Vib Rate": "VibRt", "Vib Depth": "VibDp", "Filt Rate": "FltRt", "Filt Depth": "FltDp", Volume: "Vol",
  Quantize: "Quant", Repeat: "Rept", Release: "Rel", Attack: "Atk", Cutoff: "Cut", Resonance: "Reso",
  "Source pad": "Pad", Sample: "Smpl", Preset: "Prst", Detune: "Detn", Filter: "Filt",
};
/** At most 5 characters: a known short form, or the name without spaces, cut. */
export const shortName = (name: string) => (SHORT[name] ?? name.replace(/\s+/g, "")).slice(0, 5);
const SHORT_VALUES: Record<string, string> = { Lowpass: "LP", Highpass: "HP", Bandpass: "BP" };
/** "2.51 kHz" → "2.51k", "20 ct" → "20ct", "1.2 oct" → "1.2", "Lowpass" → "LP": values squeezed into 5 characters, a unit after a number dropped when it doesn't fit. */
export function shortValue(v: string) {
  const known = SHORT_VALUES[v];
  if (known) return known;
  const s = v.replace(/±/g, "").replace(/\s+/g, "").replace(/kHz$/, "k");
  return (s.length > 5 ? s.replace(/(?<=\d)[a-z%]+$/i, "") : s).slice(0, 5);
}

/** An encoder page as the 8 encoders: two rows of four, each with name, value and a level bar. */
export function encoderScreen(v: EncoderView): Frame {
  const f = new Frame();
  header(f, v.title, v.status);
  const ROW_Y = [HEADER_H + 1, HEADER_H + 24];
  v.cells.slice(0, 8).forEach((c, i) => {
    if (!c) return;
    const x = (i % 4) * 32 + 1, y = ROW_Y[i < 4 ? 0 : 1];
    f.text(x, y, shortName(c.name));
    f.text(x, y + 8, shortValue(c.value));
    f.rect(x, y + 17, 29, 4);
    const w = Math.round(27 * Math.max(0, Math.min(1, c.level)));
    if (w) f.fillRect(x + 1, y + 18, w, 2);
    if (i === v.active) f.invert(x - 1, y - 1, 31, 22);
  });
  footer(f, v.tag, v.info);
  return f;
}

// ---------- shift map ----------

/** One line of the shift map: the button (at most 6 characters) and what Shift + it does (at most 13). */
export type ShiftRow = [key: string, action: string];

/** What Shift does with each button in this mode, for the screen while Shift is held. `onFolder`: Browse has a folder
 *  highlighted (Shift + Func puts it on the pads / the keys) rather than an item (Shift + Func loads it and leaves). */
export function shiftRows(mode: HwMode, kind: TrackKind, sampling: boolean, onFolder = true): ShiftRow[] {
  const rec: ShiftRow = ["Rec", sampling ? "Stop sampling" : "Sample"];
  const play: ShiftRow = ["Play", mode === "chop" ? "Play/stop seq" : "Metronome"];
  const track: ShiftRow = ["Pad ^v", "Track -/+"];
  // Browse keeps Scene as "up a folder" with Shift held too.
  if (mode === "browse") return [play, rec, ["Func", !onFolder ? "Load + exit" : kind === "drum" ? "Folder>pads" : "Folder>multi"], ["Scene", "Up folder"], ["Enc ^", "Exit browse"], ["Enc v", "Chop sample"]];
  if (mode === "chop") return [play, rec, ["Func", "Undo"], ["Scene", "Remove marker"], ["Enc 8", "Choke all"], ["Enc v", "Exit chop"]];
  return [
    play,
    rec,
    ["Func", "Undo"],
    ["Scene", mode === "step" && kind === "drum" ? "Clear pad" : "Clear track"],
    track,
    kind === "drum" ? ["Enc ^v", "Browse/Sample"] : ["Enc ^", "Browse"],
  ];
}

/** Two 16-character lines for the device's own text popup while Shift is held (when the bitmap can't show). */
export function shiftCoverText(mode: HwMode, kind: TrackKind, onFolder = true): [string, string] {
  if (mode === "browse") return [!onFolder ? "Fn=Load + exit" : kind === "drum" ? "Fn=Folder>pads" : "Fn=Folder>multi", "Enc^=Exit v=Smpl"];
  if (mode === "chop") return ["Scn=Del marker", "Encv=Exit chop"];
  return ["Play=Met Rec=Smp", "Fn=Undo Scn=Clr"];
}

export interface ShiftView {
  rows: ShiftRow[];
  /** What Shift does to the encoders, for the header ("enc=fine" by default). */
  enc?: string;
}

/** The shift map's header hint: Browse jumps by 8 with encoder 2. */
export const shiftEncHint = (mode: HwMode) => (mode === "browse" ? "enc2=by 8" : "enc=fine");

/** The shift map: six rows of "button: action". */
export function shiftScreen(v: ShiftView): Frame {
  const f = new Frame();
  header(f, "SHIFT", v.enc ?? "enc=fine");
  v.rows.slice(0, 6).forEach(([key, action], r) => {
    const y = HEADER_H + 1 + r * ROW_H;
    f.textFit(2, y, key, 40);
    f.textFit(44, y, action, W - 44 - 2);
  });
  return f;
}
