// Running as the desktop app (Electron) or in a browser. Shared code asks here and never imports Electron.
import type { MorselNative } from "./nativeApi";

declare global {
  interface Window {
    morselNative?: MorselNative;
  }
}

/** The desktop app's bridge, or undefined in a browser (and in tests). */
export const native: MorselNative | undefined = typeof window !== "undefined" ? window.morselNative : undefined;

export const isNative = () => native !== undefined;
