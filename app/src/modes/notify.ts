// Short "name: value" messages. Every mode draws a bitmap screen, so they are drawn into the frame
// (a text popup would replace the graphic on the device); the text popup is the fallback when the
// device can't show bitmaps.
import { launchkey } from "../midi/launchkey";
import type { DuckCurve, FilterCurve } from "../display/widgets";

const OVERLAY_MS = 1000;

/** Extra graphics drawn with a message (bitmap screens only). */
export type Visual = ({ kind: "filter" } & FilterCurve) | ({ kind: "duck" } & DuckCurve);

let overlay: { name: string; value: string; visual?: Visual; until: number } | null = null;

export function showTemp(name: string, value: string, visual?: Visual) {
  if (launchkey.bitmapSupported !== false) {
    overlay = { name, value, visual, until: performance.now() + OVERLAY_MS };
  } else {
    launchkey.showTemporary(name, value);
  }
}

/** The message to draw into the current frame, if any. */
export function activeOverlay() {
  if (overlay && performance.now() > overlay.until) overlay = null;
  return overlay;
}
