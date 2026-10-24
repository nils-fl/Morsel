// The library drawer (ui/Library.tsx): open or closed and how wide, per browser like the tips, and what its rows
// carry when they're dragged onto a pad or the Keys panel.
import type { Entry } from "../browse/tree";
import { inRange, isBoolean, pref } from "../state/prefs";
import { get, set } from "../state/store";

const openPref = pref("morsel.library", false, isBoolean);
export const DRAWER_MIN = 280, DRAWER_MAX = 720;
const widthPref = pref("morsel.libraryWidth", 360, inRange(DRAWER_MIN, DRAWER_MAX));

export const savedLibrary = () => openPref.get();
export const savedDrawerWidth = () => widthPref.get();

/** Open or close the drawer (index.css makes room for it off data-library) and remember it. */
export function applyLibrary(open: boolean) {
  if (open) document.documentElement.dataset.library = "";
  else delete document.documentElement.dataset.library;
  set({ library: open });
  openPref.set(open);
}

export const toggleLibrary = () => applyLibrary(!get().library);

/** The drawer's width; `save` false while dragging, so only where it's let go is remembered. */
export function applyDrawerWidth(px: number, save = true) {
  const w = Math.round(Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, px)));
  document.documentElement.style.setProperty("--drawer-w", `${w}px`);
  if (save) widthPref.set(w);
  return w;
}

/** The drag type of a drawer row: the entry as JSON. */
export const ENTRY_MIME = "application/x-morsel-entry";

export function dragEntry(dt: DataTransfer, e: Entry) {
  dt.setData(ENTRY_MIME, JSON.stringify(e));
  dt.effectAllowed = "copy";
}

/** The drawer entry being dropped, if that's what it is. */
export function droppedEntry(dt: DataTransfer): Entry | undefined {
  const raw = dt.getData(ENTRY_MIME);
  if (!raw) return;
  try {
    const e = JSON.parse(raw) as Entry;
    return e && typeof e === "object" && typeof e.name === "string" && ["sample", "file", "folder"].includes(e.kind) ? e : undefined;
  } catch {
    return undefined;
  }
}
