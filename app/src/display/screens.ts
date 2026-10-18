// Full-screen layouts. Plain data in, Frame out: no store, MIDI or DOM.
import { Frame, H, W } from "./frame";
import { HEADER_H, ROW_H, duckPanel, footer, header, list, stepRow, waveform, type DuckCurve, type ListItem, type Peaks } from "./widgets";

export interface BrowserView {
  folder: string;
  index: number;
  items: ListItem[];
  targetPad: number;
}

export function browserScreen(v: BrowserView): Frame {
  const f = new Frame();
  const pos = v.items.length ? `${v.index + 1}/${v.items.length}` : "0/0";
  header(f, `${v.folder || "Browse"}`, `P${v.targetPad + 1} ${pos}`);
  list(f, HEADER_H + 1, Math.floor((H - HEADER_H - 1) / ROW_H), v.items, v.index);
  return f;
}

export interface PadView {
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
  header(f, `${v.pad + 1} ${v.name}`, v.status);
  waveform(f, 0, HEADER_H + 2, W, 40, v.peaks, v.start, v.end);
  footer(f, v.pageTag, v.pageInfo);
  return f;
}

export interface StepView {
  pattern: number;
  track: string;
  bar: number;
  bars: number;
  steps: boolean[]; // 16 steps of the visible bar
  playhead: number; // step index within this bar, or -1
  status: string;
  pageTag: string;
}

export function stepScreen(v: StepView): Frame {
  const f = new Frame();
  header(f, `P${v.pattern + 1} ${v.track}`, `B${v.bar + 1}/${v.bars}`);
  // Mirrors the pads: top row = steps 1-8, bottom row = 9-16.
  const size = 13, gap = 3, x0 = Math.floor((W - (8 * size + 7 * gap)) / 2);
  stepRow(f, x0, 14, size, gap, v.steps.slice(0, 8), v.playhead, 0);
  stepRow(f, x0, 14 + size + 4, size, gap, v.steps.slice(8, 16), v.playhead, 8);
  footer(f, v.pageTag, v.status);
  return f;
}

export interface ChopScreenView {
  name: string;
  peaks: Peaks | null;
  markers: number[]; // positions within the visible window (0..1 on screen)
  sel: number | null;
  playhead: number | null; // within the window, or null
  slices: number;
  zoom: number;
  at: string; // time of the selected marker (or the view start)
}

export function chopScreen(v: ChopScreenView): Frame {
  const f = new Frame();
  header(f, v.name, `${v.slices} SL`);
  const y = HEADER_H + 2, h = 40;
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
  footer(f, "CHOP", `${v.zoom < 10 ? v.zoom.toFixed(1) : Math.round(v.zoom)}x ${v.sel !== null ? `M${v.sel + 1} ` : ""}${v.at}`);
  return f;
}

export interface DuckView extends DuckCurve {
  on: boolean;
  source: string; // e.g. "P1 Kick"
  target: string; // e.g. "P9 Bass", "All"
  level: number; // current ducker gain of the target, 0..1
  summary: string;
}

export function duckScreen(v: DuckView): Frame {
  const f = new Frame();
  header(f, "SIDECHAIN", v.on ? "ON" : "OFF");
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
  index: number; // current preset
  title: string; // preset label, e.g. "Warm Pad*"
  note: string; // right side of the header, e.g. "SYNTH" or "PAD SMP"
  summary: string;
}

/** Keys encoder page: the preset list around the current one, like the sample browser. */
export function keysScreen(v: KeysView): Frame {
  const f = new Frame();
  header(f, `KEYS ${v.title}`, v.note);
  const rows = Math.floor((H - HEADER_H - 1 - 9) / ROW_H);
  list(f, HEADER_H + 1, rows, v.presets.map((p) => ({ label: p.user ? `${p.label} (mine)` : p.label })), v.index);
  footer(f, "KEYS", v.summary);
  return f;
}
