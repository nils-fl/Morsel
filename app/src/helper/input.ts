// Touch on the helper screen, in its own pixels (layout.ts). One entry point for the in-app canvas now and the screen
// box's touch panel later. In the chop view it does what the Sample tab's editor does (ui/ChopEditor.tsx): grab a
// marker and drag it, drag empty waveform to scroll, tap to add a marker; a long press on a marker removes it (no
// double-click on a touch screen). Dragging an encoder cell up or down turns that encoder, exactly as turning it on the Launchkey.
// In Perform mode the 16 cells are pads: hold one to play its effect (a touch has no pressure: a fixed amount), Shift
// held latches a Pad FX instead.
import { addMarker, clampView, moveMarker, removeMarker, zeroCrossing } from "../audio/chop";
import { chopBuffer, minSpan, updateChop } from "../modes/chop";
import { turnHwEncoder } from "../modes/controller";
import { performPadDown, performPadUp, performToggleLatch } from "../modes/perform";
import { get } from "../state/store";
import { GRAB_LANE, GRAB_WAVE, LANE, OVERVIEW, WAVE, encoderAt, fracAt, inRect, mainRect, markerAt, padCellAt } from "./layout";
import type { HelperView } from "./view";

/** Markers stay at least this far apart (seconds), as in the editor. */
const MIN_GAP_S = 0.01;
/** Movement (screen px) before a tap becomes a drag. */
const DRAG_PX = 6;
/** Screen px of drag per encoder detent. */
const DETENT_PX = 8;
/** Holding a marker this long without moving it removes it. */
export const LONG_PRESS_MS = 550;

// What is on the screen now: touches act on what was last drawn.
let shown: Pick<HelperView, "main" | "strip"> | null = null;
export function helperShown(v: Pick<HelperView, "main" | "strip">) {
  shown = v;
}

/** The encoder cell under (x, y), or -1: the big grid when the main area is the encoders, else the strip. */
function encoderUnder(x: number, y: number) {
  if (shown?.main.kind === "encoders") return encoderAt("grid", x, y);
  return shown?.strip ? encoderAt("strip", x, y) : -1;
}
const chopShown = () => shown?.main.kind === "chop";

type Gesture =
  | { kind: "marker"; i: number; x0: number; moved: boolean }
  | { kind: "tap" | "pan"; x0: number; view: [number, number] }
  | { kind: "overview" }
  | { kind: "enc"; i: number; y: number }
  | { kind: "perform"; pad: number };

let gesture: Gesture | null = null;
let longPress: ReturnType<typeof setTimeout> | null = null;

/** The encoder being dragged on the helper screen (drawn highlighted), or null. */
export const helperActiveEncoder = () => (gesture?.kind === "enc" ? gesture.i : null);

function cancelLongPress() {
  if (longPress) clearTimeout(longPress);
  longPress = null;
}

function chopContext() {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return null;
  const data = buf.getChannelData(0);
  return { c, minGap: MIN_GAP_S / buf.duration, min: minSpan(buf), snap: (f: number) => zeroCrossing(data, Math.max(0, Math.min(1, f))) };
}

function centreOverview(x: number) {
  const ctx = chopContext();
  if (!ctx) return;
  const f = Math.max(0, Math.min(1, (x - OVERVIEW.x) / OVERVIEW.w));
  const span = ctx.c.view[1] - ctx.c.view[0];
  updateChop({ view: clampView(f - span / 2, span, ctx.min) });
}

/** Velocity of a touch on a Perform cell: a touch has no pressure, so the effect plays at this fixed amount. */
const TOUCH_VEL = 100;

/** A pointer (finger, mouse) going down, moving or coming up at (x, y) on the helper screen. `fine`: Shift held. */
export function helperPointer(phase: "down" | "move" | "up", x: number, y: number, fine = false) {
  if (phase === "down") return down(x, y, fine);
  const g = gesture;
  if (!g) return;
  if (phase === "move") return move(g, x, y, fine);
  cancelLongPress();
  gesture = null;
  if (g.kind === "perform") return performPadUp(g.pad);
  if (g.kind !== "tap") return;
  // A tap on empty waveform adds a marker there.
  const ctx = chopContext();
  if (!ctx) return;
  const m = ctx.snap(fracAt(x, ctx.c.view));
  const next = addMarker(ctx.c.markers, m, ctx.minGap);
  updateChop({ markers: next, sel: next !== ctx.c.markers ? next.indexOf(m) : null });
}

function down(x: number, y: number, fine = false) {
  cancelLongPress();
  if (gesture?.kind === "perform") performPadUp(gesture.pad);
  gesture = null;
  const enc = encoderUnder(x, y);
  if (enc >= 0) {
    gesture = { kind: "enc", i: enc, y };
    return;
  }
  if (shown?.main.kind === "grid" && get().hwMode === "perform") {
    const pad = padCellAt(mainRect(!!shown.strip), x, y);
    if (pad < 0) return;
    // Shift: latch a Pad FX on or off (as Shift-click on the Perform tab); else hold to play it.
    if (fine && get().perform.bank === "pad") return performToggleLatch(pad);
    performPadDown(pad, TOUCH_VEL);
    gesture = { kind: "perform", pad };
    return;
  }
  const ctx = chopShown() ? chopContext() : null;
  if (!ctx) return;
  if (inRect(OVERVIEW, x, y)) {
    gesture = { kind: "overview" };
    centreOverview(x);
    return;
  }
  const inLane = inRect(LANE, x, y);
  if (!inLane && !inRect(WAVE, x, y)) return;
  const i = markerAt(ctx.c.markers, ctx.c.view, x, inLane ? GRAB_LANE : GRAB_WAVE);
  if (i >= 0) {
    updateChop({ sel: i });
    gesture = { kind: "marker", i, x0: x, moved: false };
    longPress = setTimeout(() => {
      longPress = null;
      const g = gesture, c = get().chop;
      if (g?.kind !== "marker" || g.moved || !c) return;
      gesture = null;
      // The region's two ends stay; the inner markers go.
      if (g.i > 0 && g.i < c.markers.length - 1) updateChop({ markers: removeMarker(c.markers, g.i), sel: null });
    }, LONG_PRESS_MS);
  } else if (!inLane) gesture = { kind: "tap", x0: x, view: ctx.c.view };
}

function move(g: Gesture, x: number, y: number, fine: boolean) {
  if (g.kind === "perform") return;
  if (g.kind === "enc") {
    const d = Math.trunc((g.y - y) / DETENT_PX);
    if (!d) return;
    g.y -= d * DETENT_PX;
    for (let k = 0; k < Math.abs(d); k++) turnHwEncoder(g.i, Math.sign(d), fine);
    return;
  }
  if (g.kind === "overview") return centreOverview(x);
  const ctx = chopContext();
  if (!ctx) return;
  if (g.kind === "marker") {
    if (!g.moved && Math.abs(x - g.x0) < DRAG_PX) return;
    g.moved = true;
    cancelLongPress();
    updateChop({ markers: moveMarker(ctx.c.markers, g.i, ctx.snap(fracAt(x, ctx.c.view)), ctx.minGap) });
    return;
  }
  if (g.kind === "tap" && Math.abs(x - g.x0) < DRAG_PX) return;
  // Dragging empty waveform scrolls it.
  const pan: Gesture = { kind: "pan", x0: g.x0, view: g.view };
  gesture = pan;
  const span = pan.view[1] - pan.view[0];
  updateChop({ view: clampView(pan.view[0] - ((x - pan.x0) / WAVE.w) * span, span, ctx.min) });
}

/** A mouse wheel at (x, y): turns the encoder under it; on the waveform, zooms around x. Up = more. */
export function helperWheel(x: number, y: number, detents: number, fine = false) {
  const enc = encoderUnder(x, y);
  if (enc >= 0) {
    for (let k = 0; k < Math.abs(detents); k++) turnHwEncoder(enc, Math.sign(detents), fine);
    return;
  }
  const ctx = chopShown() ? chopContext() : null;
  if (!ctx || !inRect(WAVE, x, y)) return;
  const [v0, v1] = ctx.c.view, span = v1 - v0;
  const f = fracAt(x, ctx.c.view);
  const next = span * Math.exp(-detents * 0.15);
  updateChop({ view: clampView(f - ((f - v0) / span) * next, next, ctx.min) });
}

/** Drop a gesture in progress (the pointer was lost, or the screen was hidden). */
export function helperCancel() {
  cancelLongPress();
  if (gesture?.kind === "perform") performPadUp(gesture.pad);
  gesture = null;
}
