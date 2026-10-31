// Paints a HelperView onto an 800x480 2D context, in the screen's own pixels and only in palette colours (palette.ts).
// No store, no DOM: the same function will draw the frames the screen box gets.
import { duckGainAt } from "../audio/duck";
import type { DuckView } from "../display/screens";
import { highpassDb, lowpassDb, type DuckCurve, type FilterCurve, type Peaks } from "../display/widgets";
import {
  GRAB_LANE, HEADER, INFO, LANE, OVERVIEW, PAD, SH, STRIP, SW, TITLE_H, WAVE, gridCell, mainRect, padCell, stripCell, xOf, type Rect,
} from "./layout";
import { P } from "./palette";
import type { BigCell, EncCell, Header, HelperView, ListMain, Main, Popup } from "./view";
import type { StepOverview, TrackRow } from "./overview";

type G = CanvasRenderingContext2D;

const SANS = "Archivo, system-ui, sans-serif";

function rect(g: G, r: Rect, color: string) {
  g.fillStyle = color;
  g.fillRect(r.x, r.y, r.w, r.h);
}

function frame(g: G, r: Rect, color: string, width = 2) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width);
}

/** `text` cut with an ellipsis to fit `max` px in the current font. */
function fit(g: G, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let n = text.length;
  while (n > 0 && g.measureText(`${text.slice(0, n)}…`).width > max) n--;
  return `${text.slice(0, n)}…`;
}

function text(g: G, s: string, x: number, y: number, color: string, px: number, o: { weight?: number; align?: CanvasTextAlign; max?: number } = {}) {
  g.font = `${o.weight ?? 500} ${px}px ${SANS}`;
  g.fillStyle = color;
  g.textAlign = o.align ?? "left";
  g.textBaseline = "middle";
  g.fillText(o.max ? fit(g, s, o.max) : s, x, y);
}

function dot(g: G, x: number, y: number, r: number, color: string) {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

// ---------- header, title line, strip, popup ----------

function header(g: G, h: Header) {
  rect(g, HEADER, P.panel);
  const mid = HEADER.h / 2;
  text(g, h.track, 14, mid, P.text, 17, { weight: 700, max: 168 });
  // The mode as a chip.
  g.font = `700 13px ${SANS}`;
  const mw = g.measureText(h.mode).width + 16;
  rect(g, { x: 190, y: 9, w: mw, h: 22 }, h.mode === "SHIFT" ? P.accent : P.grid);
  text(g, h.mode, 190 + mw / 2, mid + 1, h.mode === "SHIFT" ? P.bg : P.text, 13, { weight: 700, align: "center" });
  text(g, h.page, 190 + mw + 12, mid, P.dim, 15, { max: 520 - (190 + mw + 12) });
  dot(g, 538, mid, 6, h.recording ? P.rec : h.playing ? P.play : P.knobTrack);
  text(g, h.status, 552, mid, P.text, 15, { weight: 600 });
  text(g, h.pos, 690, mid, P.accent, 15, { weight: 600, align: "right" });
  text(g, h.bpm, SW - 14, mid, P.dim, 15, { align: "right" });
}

/** The main area's first line: what it shows on the left, a note on the right. */
function titleLine(g: G, top: number, left: string, right: string, leftColor: string = P.text) {
  const mid = top + TITLE_H / 2;
  text(g, left, PAD + 2, mid, leftColor, 18, { weight: 700, max: 420 });
  text(g, right, SW - PAD - 2, mid, P.dim, 15, { align: "right", max: 340 });
}

function bar(g: G, r: Rect, e: EncCell) {
  rect(g, r, P.knobTrack);
  const from = e.bipolar ? 0.5 : 0;
  const a = Math.min(from, e.t), b = Math.max(from, e.t);
  rect(g, { x: r.x + a * r.w, y: r.y, w: Math.max(2, (b - a) * r.w), h: r.h }, e.active ? P.accent : P.fill);
}

function strip(g: G, cells: (EncCell | null)[]) {
  rect(g, STRIP, P.bg);
  cells.forEach((e, i) => {
    const r = stripCell(i);
    const inner = { x: r.x + 3, y: r.y + 4, w: r.w - 6, h: r.h - 7 };
    rect(g, inner, e?.active ? P.grid : P.panel);
    const cx = inner.x + inner.w / 2;
    text(g, String(i + 1), inner.x + 6, inner.y + 10, P.knobTrack, 11);
    if (!e) {
      text(g, "—", cx, inner.y + inner.h / 2, P.knobTrack, 18, { align: "center" });
      return;
    }
    text(g, e.name, cx, inner.y + 18, P.dim, 14, { align: "center", max: inner.w - 10 });
    text(g, e.value, cx, inner.y + 44, P.text, 19, { weight: 600, align: "center", max: inner.w - 8 });
    bar(g, { x: inner.x + 10, y: inner.y + inner.h - 15, w: inner.w - 20, h: 6 }, e);
  });
}

const F_MIN = 20, F_MAX = 20000, DB_TOP = 18, DB_BOTTOM = -36;

function filterCurve(g: G, r: Rect, c: FilterCurve) {
  rect(g, r, P.bg);
  const yFor = (db: number) => r.y + ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * r.h;
  const xFor = (hz: number) => r.x + (Math.log(Math.max(F_MIN, Math.min(F_MAX, hz)) / F_MIN) / Math.log(F_MAX / F_MIN)) * r.w;
  rect(g, { x: r.x, y: yFor(0), w: r.w, h: 1 }, P.grid);
  for (const hz of [100, 1000, 10000]) rect(g, { x: xFor(hz), y: r.y, w: 1, h: r.h }, P.grid);
  for (const hz of [c.lpHz, c.hpHz]) if (hz !== null) rect(g, { x: xFor(hz) - 1, y: r.y, w: 2, h: r.h }, P.accent);
  g.strokeStyle = P.wave;
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i <= r.w; i += 2) {
    const hz = F_MIN * Math.pow(F_MAX / F_MIN, i / r.w);
    let db = 0;
    if (c.lpHz !== null) db += lowpassDb(hz, c.lpHz, c.qDb);
    if (c.hpHz !== null) db += highpassDb(hz, c.hpHz, c.qDb);
    const y = Math.max(r.y, Math.min(r.y + r.h, yFor(db)));
    if (i === 0) g.moveTo(r.x + i, y);
    else g.lineTo(r.x + i, y);
  }
  g.stroke();
}

function duckCurve(g: G, r: Rect, c: DuckCurve) {
  rect(g, r, P.bg);
  const yFor = (gain: number) => r.y + 4 + (1 - Math.max(0, Math.min(1, gain))) * (r.h - 8);
  const lead = r.w * 0.08;
  rect(g, { x: r.x, y: yFor(1 - c.depth), w: r.w, h: 1 }, P.grid);
  rect(g, { x: r.x + lead, y: r.y, w: 1, h: r.h }, P.grid);
  g.strokeStyle = P.wave;
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i <= r.w; i += 2) {
    const y = yFor(duckGainAt(((i - lead) / (r.w - lead)) * 1, c));
    if (i === 0) g.moveTo(r.x + i, y);
    else g.lineTo(r.x + i, y);
  }
  g.stroke();
}

/** A Launchkey message, big, over the main area: name and value, with its curve when it has one. */
function popup(g: G, p: Popup, area: Rect) {
  const w = 560, h = p.visual ? Math.min(area.h - 24, 300) : 120;
  const r = { x: (SW - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  rect(g, r, P.panel);
  frame(g, r, P.accent, 2);
  text(g, p.name, r.x + 20, r.y + 30, P.dim, 18, { max: w - 40 });
  text(g, p.value, r.x + w - 20, r.y + 30, P.text, 26, { weight: 700, align: "right", max: w / 2 });
  if (!p.visual) return;
  const cr = { x: r.x + 20, y: r.y + 60, w: w - 40, h: h - 80 };
  if (p.visual.kind === "filter") filterCurve(g, cr, p.visual);
  else duckCurve(g, cr, p.visual);
}

// ---------- main areas ----------

function peaksIn(g: G, p: Peaks, r: Rect, color: (x: number) => string) {
  const mid = r.y + r.h / 2, half = r.h / 2;
  for (let x = 0; x < p.min.length && x < r.w; x++) {
    const hi = Math.min(1, p.max[x]), lo = Math.max(-1, p.min[x]);
    g.fillStyle = color(r.x + x);
    g.fillRect(r.x + x, mid - hi * half, 1, Math.max(1, (hi - lo) * half));
  }
}

function list(g: G, m: ListMain, area: Rect) {
  titleLine(g, area.y, m.heading, `${m.note}   ${m.pos}`);
  const ROW = 30, top = area.y + TITLE_H, rows = Math.floor((area.h - TITLE_H - 6) / ROW);
  // The cursor stays a third of the way down, like scrolling a list on a phone.
  const first = Math.max(0, Math.min(m.items.length - rows, m.index - Math.floor(rows / 3)));
  for (let r = 0; r < rows && first + r < m.items.length; r++) {
    const i = first + r, it = m.items[i], y = top + r * ROW;
    const on = i === m.index;
    if (on) rect(g, { x: PAD, y, w: SW - 2 * PAD, h: ROW - 2 }, P.grid);
    if (it.folder) {
      // A folder tab.
      rect(g, { x: PAD + 12, y: y + 9, w: 7, h: 3 }, on ? P.accent : P.dim);
      rect(g, { x: PAD + 12, y: y + 11, w: 16, h: 10 }, on ? P.accent : P.dim);
    }
    text(g, it.user ? `${it.label}  (mine)` : it.label, PAD + 38, y + ROW / 2 - 1, on ? P.text : it.folder ? P.text : P.marker, 17, {
      weight: on ? 700 : 500, max: SW - 2 * PAD - 60,
    });
    if (on) rect(g, { x: PAD, y, w: 4, h: ROW - 2 }, P.accent);
  }
  // Where the window is in a long list.
  if (m.items.length > rows) {
    const track = { x: SW - 6, y: top, w: 3, h: rows * ROW };
    rect(g, track, P.grid);
    rect(g, { x: track.x, y: top + (first / m.items.length) * track.h, w: 3, h: Math.max(8, (rows / m.items.length) * track.h) }, P.dim);
  }
}

function pad(g: G, m: Extract<Main, { kind: "pad" }>, area: Rect) {
  titleLine(g, area.y, `Pad ${m.pad + 1} · ${m.name}`, m.info);
  const r = { x: WAVE.x, y: area.y + TITLE_H + 4, w: WAVE.w, h: area.y + area.h - (area.y + TITLE_H + 4) - 12 };
  rect(g, r, P.shade);
  if (!m.peaks) {
    text(g, "No sample", SW / 2, r.y + r.h / 2, P.dim, 20, { align: "center" });
    return;
  }
  const a = r.x + Math.min(m.start, m.end) * r.w, b = r.x + Math.max(m.start, m.end) * r.w;
  rect(g, { x: a, y: r.y, w: b - a, h: r.h }, P.bg);
  rect(g, { x: r.x, y: r.y + r.h / 2, w: r.w, h: 1 }, P.grid);
  peaksIn(g, m.peaks, r, (x) => (x >= a && x <= b ? P.wave : P.waveDim));
  for (const x of [a, b]) rect(g, { x: Math.round(x) - 1, y: r.y, w: 2, h: r.h }, P.marker);
}

function duck(g: G, v: DuckView, area: Rect) {
  titleLine(g, area.y, `${v.source} > ${v.target}`, v.summary, v.on ? P.text : P.dim);
  const top = area.y + TITLE_H + 4, h = area.y + area.h - top - 12;
  duckCurve(g, { x: PAD, y: top, w: SW - 2 * PAD - 40, h }, v);
  // Live gain reduction: grows down from the top as the target ducks.
  const m = { x: SW - PAD - 28, y: top, w: 28, h };
  rect(g, m, P.panel);
  rect(g, { x: m.x + 4, y: m.y + 4, w: m.w - 8, h: (m.h - 8) * Math.max(0, Math.min(1, 1 - v.level)) }, P.accent);
  if (!v.on) text(g, "OFF", SW / 2 - 20, top + h / 2, P.dim, 28, { weight: 700, align: "center" });
}

const SWEEP = (135 * Math.PI) / 180;

function encoders(g: G, m: Extract<Main, { kind: "encoders" }>, area: Rect) {
  titleLine(g, area.y, m.heading, m.info);
  m.cells.forEach((e, i) => {
    const r = gridCell(i);
    rect(g, r, e?.active ? P.grid : P.panel);
    const cx = r.x + r.w / 2;
    text(g, String(i + 1), r.x + 10, r.y + 14, P.knobTrack, 13);
    if (!e) {
      text(g, "—", cx, r.y + r.h / 2, P.knobTrack, 22, { align: "center" });
      return;
    }
    text(g, e.name, cx, r.y + 26, P.dim, 18, { align: "center", max: r.w - 16 });
    const cy = r.y + r.h / 2 + 4, rad = Math.min(r.w, r.h) * 0.24;
    const at = (t: number) => -Math.PI / 2 - SWEEP + t * 2 * SWEEP;
    g.lineCap = "round";
    g.lineWidth = 9;
    g.strokeStyle = P.knobTrack;
    g.beginPath();
    g.arc(cx, cy, rad, at(0), at(1));
    g.stroke();
    const from = e.bipolar ? 0.5 : 0;
    if (Math.abs(e.t - from) > 0.002) {
      g.strokeStyle = e.active ? P.accent : P.fill;
      g.beginPath();
      g.arc(cx, cy, rad, at(Math.min(from, e.t)), at(Math.max(from, e.t)));
      g.stroke();
    }
    g.lineCap = "butt";
    text(g, e.value, cx, r.y + r.h - 26, P.text, 24, { weight: 600, align: "center", max: r.w - 16 });
  });
}

/** 16 cells laid out like the pads: cells 8-15 on top, 0-7 below. */
function grid(g: G, m: Extract<Main, { kind: "grid" }>, area: Rect) {
  titleLine(g, area.y, m.heading, m.info);
  m.cells.forEach((c: BigCell | null, i) => {
    if (!c) return;
    const r = padCell(i, area);
    rect(g, r, c.fill ? P.fill : P.panel);
    if (c.dim) frame(g, r, P.accent, 2);
    const ink = c.fill ? P.bg : P.text;
    text(g, c.label, r.x + r.w / 2, r.y + r.h / 2 - 12, ink, 26, { weight: 700, align: "center" });
    text(g, c.sub, r.x + r.w / 2, r.y + r.h - 18, c.fill ? P.bg : P.dim, 13, { align: "center", max: r.w - 8 });
    if (c.mark) rect(g, { x: r.x + 14, y: r.y + r.h / 2 + 12, w: r.w - 28, h: 4 }, c.fill ? P.bg : P.wave);
  });
}

function tracks(g: G, m: Extract<Main, { kind: "tracks" }>, area: Rect) {
  titleLine(g, area.y, "Tracks", m.info);
  const top = area.y + TITLE_H, ROW = Math.min(44, (area.h - TITLE_H - 8) / Math.max(1, m.rows.length + (m.add ? 1 : 0)));
  const clip = { x: 420, w: SW - PAD - 420 };
  m.rows.forEach((t: TrackRow, i) => {
    const y = top + i * ROW, mid = y + ROW / 2 - 1;
    rect(g, { x: PAD, y, w: SW - 2 * PAD, h: ROW - 3 }, t.selected ? P.grid : P.panel);
    if (t.selected) rect(g, { x: PAD, y, w: 4, h: ROW - 3 }, P.accent);
    const ink = t.audible ? P.text : P.dim;
    text(g, `${t.number}`, PAD + 16, mid, P.dim, 15, { weight: 600 });
    text(g, t.name, PAD + 38, mid, ink, 16, { weight: t.selected ? 700 : 500, max: 150 });
    text(g, t.kind === "drum" ? "DRUMS" : "KEYS", 214, mid, P.dim, 12, { weight: 600 });
    if (t.mute) text(g, "M", 268, mid, P.rec, 15, { weight: 700 });
    if (t.solo) text(g, "S", 286, mid, P.accent, 15, { weight: 700 });
    // Level.
    rect(g, { x: 310, y: mid - 3, w: 90, h: 6 }, P.knobTrack);
    rect(g, { x: 310, y: mid - 3, w: 90 * Math.max(0, Math.min(1, t.level)), h: 6 }, t.audible ? P.fill : P.dim);
    // The clip: its bars, where its notes are, where it plays.
    const cy = y + 5, ch = ROW - 13;
    rect(g, { x: clip.x, y: cy, w: clip.w, h: ch }, P.bg);
    for (let b = 1; b < t.bars; b++) rect(g, { x: clip.x + (b / t.bars) * clip.w, y: cy, w: 1, h: ch }, P.grid);
    for (const n of t.notes) rect(g, { x: clip.x + n * clip.w, y: cy + 3, w: 2, h: ch - 6 }, t.audible ? P.wave : P.waveDim);
    if (t.playhead !== null) rect(g, { x: clip.x + t.playhead * clip.w - 1, y: cy, w: 2, h: ch }, P.playhead);
    text(g, `${t.bars}`, clip.x - 8, mid, P.dim, 12, { align: "right" });
  });
  if (m.add) text(g, m.add, PAD + 38, top + m.rows.length * ROW + ROW / 2 - 1, P.accent, 15, { weight: 600 });
}

function steps(g: G, m: Extract<Main, { kind: "steps" }>, area: Rect) {
  const o: StepOverview = m.o;
  titleLine(g, area.y, m.item, m.bar);
  const top = area.y + TITLE_H + 2, labelW = 34;
  const rowH = Math.min(120, (area.y + area.h - top - 8) / o.bars);
  const x0 = PAD + labelW, w = (SW - PAD - x0) / o.perBar;
  const beat = o.perBar % 4 === 0 ? o.perBar / 4 : o.perBar % 3 === 0 ? o.perBar / 3 : o.perBar;
  const held = new Set(o.held);
  for (let b = 0; b < o.bars; b++) {
    const y = top + b * rowH;
    text(g, `${b + 1}`, PAD + labelW / 2 - 2, y + rowH / 2, P.dim, Math.min(15, rowH - 2), { align: "center" });
    for (let k = 0; k < o.perBar; k++) {
      const i = b * o.perBar + k;
      // A small gap between beats, so the bar reads in counts.
      const x = x0 + k * w + (k % beat === 0 ? 2 : 0);
      const r = { x, y: y + 1, w: w - 2 - (k % beat === 0 ? 2 : 0), h: rowH - 3 };
      const onPage = i >= o.pageFirst && i < o.pageFirst + o.pageLen;
      rect(g, r, held.has(i) ? P.accent : onPage ? P.sliceAlt : P.panel);
      const v = o.vel[i];
      if (v !== null) rect(g, { x: r.x + 2, y: r.y + r.h - Math.max(3, (r.h - 4) * v) - 2, w: r.w - 4, h: Math.max(3, (r.h - 4) * v) }, held.has(i) ? P.bg : P.fill);
      if (i === o.playhead) frame(g, r, P.playhead, 2);
    }
  }
  // The page on the pads, outlined.
  const firstBar = Math.floor(o.pageFirst / o.perBar), lastBar = Math.floor((o.pageFirst + o.pageLen - 1) / o.perBar);
  for (let b = firstBar; b <= lastBar && b < o.bars; b++) {
    const a = Math.max(o.pageFirst, b * o.perBar) - b * o.perBar, e = Math.min(o.pageFirst + o.pageLen, (b + 1) * o.perBar) - b * o.perBar;
    frame(g, { x: x0 + a * w - 1, y: top + b * rowH - 1, w: (e - a) * w + 2, h: rowH + 1 }, P.accent, 2);
  }
}

function chop(g: G, m: Extract<Main, { kind: "chop" }>) {
  const [v0, v1] = m.view;
  const ends: [number, number] = [m.markers[0], m.markers[m.markers.length - 1]];
  const clip = (x: number) => Math.max(WAVE.x, Math.min(WAVE.x + WAVE.w, x));

  // Overview: the whole sample, the visible window outlined.
  rect(g, OVERVIEW, P.panel);
  peaksIn(g, m.overview, OVERVIEW, () => P.dim);
  frame(g, { x: OVERVIEW.x + v0 * OVERVIEW.w, y: OVERVIEW.y, w: Math.max(4, (v1 - v0) * OVERVIEW.w), h: OVERVIEW.h }, P.accent, 2);
  text(g, m.info, INFO.x + INFO.w, INFO.y + INFO.h / 2, P.dim, 15, { align: "right", max: INFO.w });

  // Waveform: outside the region shaded, the chops in alternating bands, the region's peaks bright.
  rect(g, WAVE, P.shade);
  const ra = clip(xOf(ends[0], m.view)), rb = clip(xOf(ends[1], m.view));
  for (let k = 0; k < m.markers.length - 1; k++) {
    const a = clip(xOf(m.markers[k], m.view)), b = clip(xOf(m.markers[k + 1], m.view));
    if (b > a) rect(g, { x: a, y: WAVE.y, w: b - a, h: WAVE.h }, k % 2 ? P.sliceAlt : P.bg);
  }
  rect(g, { x: WAVE.x, y: WAVE.y + WAVE.h / 2, w: WAVE.w, h: 1 }, P.grid);
  peaksIn(g, m.peaks, WAVE, (x) => (x >= ra && x <= rb ? P.wave : P.waveDim));

  // Lane: the chops' numbers between the markers.
  rect(g, LANE, P.panel);
  for (let k = 0; k < m.markers.length - 1; k++) {
    const a = Math.max(xOf(m.markers[k], m.view), WAVE.x), b = Math.min(xOf(m.markers[k + 1], m.view), WAVE.x + WAVE.w);
    if (b - a >= 28) text(g, String(k + 1), (a + b) / 2, LANE.y + LANE.h - 18, P.dim, 15, { align: "center" });
  }

  // Markers: a line through the waveform and a handle in the lane, the selected one in the accent colour.
  m.markers.forEach((mk, i) => {
    const x = Math.round(xOf(mk, m.view));
    if (x < WAVE.x - GRAB_LANE || x > WAVE.x + WAVE.w + GRAB_LANE) return;
    const bound = i === 0 || i === m.markers.length - 1;
    g.fillStyle = i === m.sel ? P.accent : P.marker;
    if (x >= WAVE.x && x <= WAVE.x + WAVE.w) g.fillRect(x - (bound ? 1 : 0), WAVE.y, bound ? 3 : 2, WAVE.h);
    const hx = Math.max(LANE.x, Math.min(LANE.x + LANE.w, x));
    g.beginPath();
    g.moveTo(hx, LANE.y);
    g.lineTo(hx + 10, LANE.y + 12);
    g.lineTo(hx + 10, LANE.y + 30);
    g.lineTo(hx - 10, LANE.y + 30);
    g.lineTo(hx - 10, LANE.y + 12);
    g.closePath();
    g.fill();
  });

  if (m.playhead !== null && m.playhead >= v0 && m.playhead <= v1) rect(g, { x: Math.round(xOf(m.playhead, m.view)) - 1, y: WAVE.y, w: 2, h: WAVE.h }, P.playhead);
}

function shift(g: G, m: Extract<Main, { kind: "shift" }>, area: Rect) {
  titleLine(g, area.y, "Shift +", m.enc, P.accent);
  const ROW = Math.min(48, (area.h - TITLE_H - 8) / Math.max(1, m.rows.length));
  m.rows.forEach(([key, action], i) => {
    const y = area.y + TITLE_H + i * ROW;
    rect(g, { x: PAD, y, w: SW - 2 * PAD, h: ROW - 4 }, P.panel);
    text(g, key, PAD + 16, y + ROW / 2 - 2, P.accent, 20, { weight: 700 });
    text(g, action, PAD + 170, y + ROW / 2 - 2, P.text, 20, { max: SW - 2 * PAD - 190 });
  });
}

function boot(g: G, area: Rect) {
  text(g, "MORSEL", SW / 2, area.y + area.h / 2, P.dim, 48, { weight: 800, align: "center" });
}

/** The whole helper screen for `v`. */
export function drawHelper(g: G, v: HelperView) {
  rect(g, { x: 0, y: 0, w: SW, h: SH }, P.bg);
  header(g, v.header);
  const area = mainRect(!!v.strip);
  const m = v.main;
  switch (m.kind) {
    case "boot": boot(g, area); break;
    case "list": list(g, m, area); break;
    case "pad": pad(g, m, area); break;
    case "duck": duck(g, m.v, area); break;
    case "encoders": encoders(g, m, area); break;
    case "grid": grid(g, m, area); break;
    case "tracks": tracks(g, m, area); break;
    case "steps": steps(g, m, area); break;
    case "chop": chop(g, m); break;
    case "shift": shift(g, m, area); break;
  }
  if (v.strip) strip(g, v.strip.cells);
  if (v.popup) popup(g, v.popup, area);
}

