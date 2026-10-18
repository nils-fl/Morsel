import { duckGainAt, type DuckEnvelope } from "../audio/duck";
import { Frame, H, W, fitText, textWidth } from "./frame";

export const ROW_H = 9;
export const HEADER_H = 9;

/** Inverted bar: left text, right-aligned text. Returns the left text as drawn (cut with "~" when it didn't fit). */
export function header(f: Frame, left: string, right = "") {
  f.fillRect(0, 0, W, HEADER_H);
  const rw = right ? textWidth(right) : 0;
  if (right) f.text(W - 2 - rw, 1, right, 0);
  return f.textFit(2, 1, left, W - 4 - (right ? rw + 6 : 0), 0);
}

/** First visible row so the cursor stays in view (cursor kept centred where possible). */
export function scrollTop(count: number, cursor: number, rows: number) {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), count - rows));
}

export interface ListItem {
  label: string;
  folder?: boolean;
}

function folderIcon(f: Frame, x: number, y: number, on: number) {
  f.hline(x, x + 2, y, on);
  f.rect(x, y + 1, 7, 5, on);
}

export function list(f: Frame, y0: number, rows: number, items: ListItem[], cursor: number) {
  const top = scrollTop(items.length, cursor, rows);
  const scroll = items.length > rows;
  const width = W - (scroll ? 4 : 0);
  for (let r = 0; r < rows && top + r < items.length; r++) {
    const it = items[top + r];
    const y = y0 + r * ROW_H;
    const sel = top + r === cursor;
    if (sel) f.fillRect(0, y, width, ROW_H);
    const on = sel ? 0 : 1;
    let x = 2;
    if (it.folder) {
      folderIcon(f, x, y + 1, on);
      x += 10;
    }
    f.textFit(x, y + 1, it.label, width - x - 1, on);
  }
  if (scroll) {
    const h = rows * ROW_H;
    const thumb = Math.max(4, Math.round((h * rows) / items.length));
    const pos = Math.round(((h - thumb) * top) / (items.length - rows));
    f.vline(W - 2, y0, y0 + h - 1);
    f.fillRect(W - 3, y0 + pos, 3, thumb);
  }
  if (!items.length) f.text(2, y0 + 1, "(empty)");
}

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

/** Min/max per column over the whole buffer. */
export function computePeaks(data: Float32Array, columns: number): Peaks {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const per = data.length / columns;
  for (let c = 0; c < columns; c++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(c * per), n = Math.min(data.length, Math.floor((c + 1) * per)); i < n; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/** Waveform in a box, with dotted start/end markers (fractions 0..1). */
export function waveform(f: Frame, x: number, y: number, w: number, h: number, peaks: Peaks | null, start: number, end: number) {
  const mid = y + Math.floor(h / 2);
  if (!peaks) {
    f.text(x + 2, mid - 3, "no sample");
    return;
  }
  const half = (h - 1) / 2;
  for (let c = 0; c < w && c < peaks.min.length; c++) {
    const top = Math.round(mid - Math.min(1, peaks.max[c]) * half);
    const bot = Math.round(mid - Math.max(-1, peaks.min[c]) * half);
    f.vline(x + c, Math.min(top, mid), Math.max(bot, mid));
  }
  const a = x + Math.round(Math.min(start, end) * (w - 1));
  const b = x + Math.round(Math.max(start, end) * (w - 1));
  for (let j = y; j < y + h; j++) {
    if (j % 2 === 0) {
      f.set(a, j);
      f.set(b, j);
    }
  }
  // Dim outside the region: clear every other pixel.
  for (let i = x; i < x + w; i++) {
    if (i >= a && i <= b) continue;
    for (let j = y; j < y + h; j++) if ((i + j) % 2 === 0) f.set(i, j, 0);
  }
}

export function meter(f: Frame, x: number, y: number, w: number, h: number, value: number) {
  f.rect(x, y, w, h);
  f.fillRect(x + 1, y + 1, Math.round((w - 2) * Math.max(0, Math.min(1, value))), h - 2);
}

/** A row of step boxes: filled = on, inverted outline = playhead. */
export function stepRow(f: Frame, x: number, y: number, size: number, gap: number, steps: boolean[], playhead: number, offset = 0) {
  steps.forEach((on, i) => {
    const bx = x + i * (size + gap);
    if (on) f.fillRect(bx, y, size, size);
    else f.rect(bx, y, size, size);
    if (offset + i === playhead) {
      f.rect(bx - 1, y - 1, size + 2, size + 2);
      f.invert(bx + 2, y + 2, size - 4, size - 4);
    }
  });
}

/** Magnitude (dB) of a 2-pole lowpass at freq. Q is in dB, like Web Audio's BiquadFilter. */
export function lowpassDb(freq: number, cutoff: number, qDb: number) {
  const q = Math.pow(10, qDb / 20);
  const r = freq / cutoff;
  return -10 * Math.log10((1 - r * r) ** 2 + (r / q) ** 2);
}

/** Magnitude (dB) of a 2-pole highpass (same Q convention). */
export function highpassDb(freq: number, cutoff: number, qDb: number) {
  const r = freq / cutoff;
  return 40 * Math.log10(r) + lowpassDb(freq, cutoff, qDb);
}

const F_MIN = 20, F_MAX = 20000, DB_TOP = 18, DB_BOTTOM = -36;

export interface FilterCurve {
  lpHz: number | null; // null = no lowpass
  hpHz: number | null; // null = no highpass
  qDb: number;
}

/** Response line of LP and HP in series (log frequency axis), dotted lines at each cutoff. */
export function filterPanel(f: Frame, x: number, y: number, w: number, h: number, curve: FilterCurve) {
  f.fillRect(x, y, w, h, 0);
  f.rect(x, y, w, h);
  const ix = x + 1, iw = w - 2, iy = y + 1, ih = h - 2;
  const yFor = (db: number) => iy + Math.round(((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * (ih - 1));
  const xFor = (hz: number) => ix + Math.round((Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / Math.log(F_MAX / F_MIN)) * (iw - 1));
  const y0 = yFor(0);
  for (let i = ix; i < ix + iw; i += 4) f.set(i, y0); // 0 dB reference
  for (const hz of [100, 1000, 10000]) f.vline(xFor(hz), iy + ih - 3, iy + ih - 1); // decade ticks
  for (const hz of [curve.lpHz, curve.hpHz]) {
    if (hz === null) continue;
    const cx = xFor(hz);
    for (let j = iy; j < iy + ih; j += 2) f.set(cx, j);
  }
  let prev = -1;
  for (let c = 0; c < iw; c++) {
    const hz = F_MIN * Math.pow(F_MAX / F_MIN, c / (iw - 1));
    let db = 0;
    if (curve.lpHz !== null) db += lowpassDb(hz, curve.lpHz, curve.qDb);
    if (curve.hpHz !== null) db += highpassDb(hz, curve.hpHz, curve.qDb);
    const cy = yFor(db);
    f.vline(ix + c, prev < 0 ? cy : Math.min(prev, cy), prev < 0 ? cy : Math.max(prev, cy));
    prev = cy;
  }
}

export type DuckCurve = DuckEnvelope;

const DUCK_WINDOW_S = 1;

/** Gain envelope of the ducker (time across, gain up), with a dotted line at the floor. */
export function duckPanel(f: Frame, x: number, y: number, w: number, h: number, curve: DuckCurve) {
  f.fillRect(x, y, w, h, 0);
  f.rect(x, y, w, h);
  const ix = x + 2, iw = w - 4, iy = y + 2, ih = h - 4;
  const yFor = (g: number) => iy + Math.round((1 - Math.max(0, Math.min(1, g))) * (ih - 1));
  const floorY = yFor(1 - curve.depth);
  for (let i = ix; i < ix + iw; i += 3) f.set(i, floorY);
  // A short flat lead-in marks the hit.
  const lead = Math.round(iw * 0.08);
  f.vline(ix + lead, iy + ih - 3, iy + ih - 1);
  let prev = -1;
  for (let c = 0; c < iw; c++) {
    const t = ((c - lead) / (iw - lead)) * DUCK_WINDOW_S;
    const cy = yFor(duckGainAt(t, curve));
    f.vline(ix + c, prev < 0 ? cy : Math.min(prev, cy), prev < 0 ? cy : Math.max(prev, cy));
    prev = cy;
  }
}

/** Bottom line: inverted tag box (e.g. the encoder page), then text. Returns the text as drawn. */
export function footer(f: Frame, tag: string, text: string) {
  const y = H - 9;
  const tw = textWidth(tag) + 4;
  f.fillRect(0, y, tw, 9);
  f.text(2, y + 1, tag, 0);
  return f.textFit(tw + 3, y + 1, text, W - tw - 3);
}

/**
 * Inverted message bar along the bottom: name on the left, value right-aligned. When the two don't fit
 * one line, the bar grows to two lines (name, then value) so instructions are never cut.
 * Returns the two strings as drawn.
 */
export function overlayBar(f: Frame, name: string, value: string): [string, string] {
  if (!value || textWidth(name) + 6 + textWidth(value) <= W - 4) {
    const y = H - 10;
    f.fillRect(0, y, W, 10);
    const vw = value ? textWidth(value) : 0;
    if (value) f.text(W - 2 - vw, y + 2, value, 0);
    return [f.textFit(2, y + 2, name, W - 4 - (value ? vw + 6 : 0), 0), value];
  }
  const y = H - 19;
  f.fillRect(0, y, W, 19);
  return [f.textFit(2, y + 2, name, W - 4, 0), f.textFit(2, y + 11, value, W - 4, 0)];
}

export { fitText };
