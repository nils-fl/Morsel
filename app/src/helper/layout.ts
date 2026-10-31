// The helper screen's geometry, in its own pixels (800x480, the 4.3" box's panel). Drawing and touch both read it, so
// what is drawn is what is hit. Touch targets are at least 64 px (about 7.5 mm on the panel) where they can be.
export const SW = 800;
export const SH = 480;

export interface Rect { x: number; y: number; w: number; h: number }
export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Track, mode, encoder page, transport, position and tempo. */
export const HEADER: Rect = { x: 0, y: 0, w: SW, h: 40 };
/** The 8 encoders of what the encoders do right now, along the bottom (left out when the main area is the encoders). */
export const STRIP: Rect = { x: 0, y: 392, w: SW, h: SH - 392 };
export const STRIP_CELL_W = SW / 8;
export const stripCell = (i: number): Rect => ({ x: STRIP.x + i * STRIP_CELL_W, y: STRIP.y, w: STRIP_CELL_W, h: STRIP.h });

/** Between the header and the strip, or down to the bottom without one. */
export const mainRect = (strip: boolean): Rect => ({ x: 0, y: HEADER.h, w: SW, h: (strip ? STRIP.y : SH) - HEADER.h });
/** The main area's first line (what the list or grid is, its position); the content starts under it. */
export const TITLE_H = 40;
export const PAD = 12;

// ---------- big encoder grid (encoder pages, held steps outside Step) ----------

export const GRID: Rect = { x: 8, y: HEADER.h + TITLE_H, w: SW - 16, h: SH - HEADER.h - TITLE_H - 8 };
export const GRID_GAP = 6;
export function gridCell(i: number): Rect {
  const w = (GRID.w - 3 * GRID_GAP) / 4, h = (GRID.h - GRID_GAP) / 2;
  return { x: GRID.x + (i % 4) * (w + GRID_GAP), y: GRID.y + Math.floor(i / 4) * (h + GRID_GAP), w, h };
}

/** One of the 16 pad cells of a grid main area (Mute, Pattern, Perform), laid out like the pads: 8-15 on top, 0-7
 *  below. `area` is the main area (mainRect). */
export function padCell(i: number, area: Rect): Rect {
  const top = area.y + TITLE_H + 4, gap = 6, w = (SW - 2 * PAD - 7 * gap) / 8, h = (area.y + area.h - top - 10 - gap) / 2;
  return { x: PAD + (i % 8) * (w + gap), y: i >= 8 ? top : top + h + gap, w, h };
}

/** The pad cell under (x, y), or -1. */
export function padCellAt(area: Rect, x: number, y: number) {
  for (let i = 0; i < 16; i++) if (inRect(padCell(i, area), x, y)) return i;
  return -1;
}

/** The encoder under (x, y): in the big grid when the main area is the encoders, else in the strip; -1 for none. */
export function encoderAt(on: "grid" | "strip", x: number, y: number): number {
  for (let i = 0; i < 8; i++) if (inRect(on === "grid" ? gridCell(i) : stripCell(i), x, y)) return i;
  return -1;
}

// ---------- chop (Sample mode; always with the strip) ----------

/** The whole sample, with the visible window: tap or drag to move the window. */
export const OVERVIEW: Rect = { x: PAD, y: 48, w: 560, h: 28 };
/** Region length, tempo and chop count, beside the overview. */
export const INFO: Rect = { x: 584, y: 48, w: SW - PAD - 584, h: 28 };
export const WAVE: Rect = { x: PAD, y: 84, w: SW - 2 * PAD, h: 236 };
/** Under the waveform: a handle per marker and the chops' numbers. The handles are the easy place to grab a marker. */
export const LANE: Rect = { x: PAD, y: 320, w: SW - 2 * PAD, h: 64 };

/** How close (screen px) to a marker a touch grabs it: in the lane, and on the waveform itself. */
export const GRAB_LANE = 22;
export const GRAB_WAVE = 10;

/** Screen x of sample fraction `f` in the waveform, for the visible window `view`. */
export const xOf = (f: number, view: readonly [number, number]) => WAVE.x + ((f - view[0]) / (view[1] - view[0])) * WAVE.w;
/** Sample fraction at screen x (clamped to the waveform). */
export function fracAt(x: number, view: readonly [number, number]) {
  const t = Math.max(0, Math.min(1, (x - WAVE.x) / WAVE.w));
  return view[0] + t * (view[1] - view[0]);
}

/** The marker nearest x within `radius` screen px, or -1. */
export function markerAt(markers: readonly number[], view: readonly [number, number], x: number, radius: number) {
  let best = -1, bestD = radius;
  markers.forEach((m, i) => {
    const d = Math.abs(xOf(m, view) - x);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
