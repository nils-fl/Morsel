// Short "name: value" messages. Every mode draws a bitmap screen, so they are drawn into the frame
// (a text popup would replace the graphic on the device); the text popup is the fallback when the
// device can't show bitmaps.
import { launchkey } from "../midi/launchkey";
import type { DuckCurve, FilterCurve } from "../display/widgets";

const OVERLAY_MS = 1000;

/** Extra graphics drawn with a message (bitmap screens only). */
export type Visual = ({ kind: "filter" } & FilterCurve) | ({ kind: "duck" } & DuckCurve);

export interface Overlay {
  name: string;
  value: string;
  visual?: Visual;
  /** The encoder that was turned (0-7): screens that show the encoders highlight its cell instead of a popup. */
  encoder?: number;
  until: number;
}

export interface ShowOpts {
  visual?: Visual;
  encoder?: number;
  /** Stay until releaseHold() (a button held down). */
  hold?: boolean;
}

let overlay: Overlay | null = null;

export function showTemp(name: string, value: string, opts: ShowOpts = {}) {
  if (launchkey.bitmapSupported !== false) {
    overlay = { name, value, visual: opts.visual, encoder: opts.encoder, until: opts.hold ? Infinity : performance.now() + OVERLAY_MS };
  } else {
    launchkey.showTemporary(name, value);
  }
}

/** Clear a held message (does nothing to a timed one). */
export function releaseHold() {
  if (overlay && overlay.until === Infinity) overlay = null;
}

/** The message to draw into the current frame, if any. */
export function activeOverlay() {
  if (overlay && performance.now() > overlay.until) overlay = null;
  return overlay;
}
