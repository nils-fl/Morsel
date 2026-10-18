// Short "name: value" messages. In modes with a bitmap screen they are drawn into the frame
// (a text popup would replace the graphic on the device); otherwise they use the text popup.
import { launchkey } from "../midi/launchkey";
import { get } from "../state/store";
import type { HwMode } from "../state/types";
import type { DuckCurve, FilterCurve } from "../display/widgets";

const OVERLAY_MS = 1000;

export const hasScreen = (m: HwMode) => m === "browse" || m === "play" || m === "step" || m === "chop";

/** Extra graphics drawn with a message (bitmap screens only). */
export type Visual = ({ kind: "filter" } & FilterCurve) | ({ kind: "duck" } & DuckCurve);

let overlay: { name: string; value: string; visual?: Visual; until: number } | null = null;

export function showTemp(name: string, value: string, visual?: Visual) {
  if (hasScreen(get().hwMode) && launchkey.bitmapSupported !== false) {
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
