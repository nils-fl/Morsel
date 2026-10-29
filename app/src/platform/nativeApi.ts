// The desktop app's bridge (electron/preload.ts → window.morselNative). Types only: the preload and the page share them.

/** A folder entry in a connected folder. */
export interface NativeEntry { name: string; dir: boolean }

/** A folder call's result. `err` is a DOMException name, so the page handles it like the web's folder errors. */
export type NativeResult<T> = { ok: T } | { err: "NotFoundError" | "NotAllowedError" | "Error"; message?: string };

/** What the app menu asks the page to do. */
export type MenuCommand = "preferences" | "newProject" | "undo" | "redo" | "toggleTheme" | "toggleTips" | "toggleLibrary" | "guide";

export interface MorselNative {
  /** Preferences as saved when the window opened (pref key → value). */
  prefs: Record<string, unknown>;
  setPref(key: string, value: unknown): void;
  /** The folder picker. Picked folders are the only ones the app reads. Undefined when cancelled. */
  pickFolder(defaultPath?: string): Promise<{ name: string; path: string } | undefined>;
  /** Ableton Live's library (its Core Library folder), found in /Applications and then readable; undefined without
   *  Live. */
  findLiveLibrary(): Promise<{ name: string; path: string } | undefined>;
  /** Stop reading a folder picked before. */
  forgetFolder(path: string): void;
  listFolder(path: string): Promise<NativeResult<NativeEntry[]>>;
  readFile(path: string): Promise<NativeResult<Uint8Array>>;
  /** Keep the Mac from napping the app while the transport plays. */
  setPlaying(playing: boolean): void;
  onMenu(fn: (cmd: MenuCommand) => void): () => void;
  /** Runs before the window closes; the window waits for it (a few seconds at most). */
  onFlush(fn: () => Promise<void>): void;
}
