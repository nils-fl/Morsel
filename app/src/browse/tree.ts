// Virtual folder tree over the sample library + saved kits (pure, no DOM/MIDI).
import { STOCK_KITS, type SampleInfo } from "../state/types";

export type Entry =
  | { kind: "folder"; name: string; path: string }
  | { kind: "sample"; id: string; name: string }
  /** An audio file in a connected folder (browse/disk.ts). */
  | { kind: "file"; name: string; path: string }
  | { kind: "kit"; name: string }
  /** An Ableton Live preset in the connected Live library: a Drum Rack (kit) or a sampled instrument (ableton/). */
  | { kind: "preset"; name: string; path: string; preset: "kit" | "instrument" };

export const ROOT = "";
export const SAMPLES = "Samples";
export const KITS = "Kits";
export const FAVORITES = "Favorites";

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? ROOT : path.slice(0, i);
}

export function listDir(path: string, samples: SampleInfo[], kits: string[]): Entry[] {
  if (path === ROOT) {
    return [
      { kind: "folder", name: SAMPLES, path: SAMPLES },
      { kind: "folder", name: KITS, path: KITS },
    ];
  }
  if (path === KITS) {
    // The built-in kits first, in their own order (Factory, then the genres), then the saved ones.
    const saved = kits.filter((k) => !STOCK_KITS.includes(k)).map((name) => ({ kind: "kit" as const, name })).sort(byName);
    return [...STOCK_KITS.map((name) => ({ kind: "kit" as const, name })), ...saved];
  }
  if (path !== SAMPLES && !path.startsWith(SAMPLES + "/")) return [];

  const rel = path === SAMPLES ? "" : path.slice(SAMPLES.length + 1);
  const folders = new Map<string, Entry>();
  const items: Entry[] = [];
  for (const s of samples) {
    const f = s.folder ?? "";
    if (f === rel) {
      items.push({ kind: "sample", id: s.id, name: s.name });
    } else if (rel === "" || f.startsWith(rel + "/")) {
      const rest = rel === "" ? f : f.slice(rel.length + 1);
      const name = rest.split("/")[0];
      if (name && !folders.has(name)) folders.set(name, { kind: "folder", name, path: `${path}/${name}` });
    }
  }
  return [...[...folders.values()].sort(byName), ...items.sort(byName)];
}

/** An entry's identity, as favorites store it: "sample:<id>", "file:<path>", "folder:<path>", "kit:<name>". */
export const entryKey = (e: Entry) => `${e.kind}:${e.kind === "sample" ? e.id : e.kind === "kit" ? e.name : e.path}`;

/**
 * The starred entries that are still there: library samples by id, library folders, and files and folders in the
 * connected folders named in `roots`. Folders first, then by name.
 */
export function favoriteEntries(keys: string[], samples: Record<string, { name: string }>, roots: string[]): Entry[] {
  const out: Entry[] = [];
  for (const key of keys) {
    const i = key.indexOf(":");
    const kind = key.slice(0, i), rest = key.slice(i + 1);
    const last = rest.split("/").pop() ?? rest;
    if (kind === "sample") {
      if (samples[rest]) out.push({ kind: "sample", id: rest, name: samples[rest].name });
      continue;
    }
    const disk = rest.startsWith("disk:");
    if (disk && !roots.includes(rest.slice(5).split("/")[0])) continue;
    if (kind === "folder" && (disk || rest.startsWith(SAMPLES))) out.push({ kind: "folder", name: last.replace(/^disk:/, ""), path: rest });
    else if (kind === "file" && disk) out.push({ kind: "file", name: last.replace(/\.[^.]+$/, ""), path: rest });
  }
  const folders = out.filter((e) => e.kind === "folder").sort(byName);
  return [...folders, ...out.filter((e) => e.kind !== "folder").sort(byName)];
}

const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The paths with every word of `query` in them (any case). Ones with every word in the last part (the file name)
 * come first, then by name. Up to `limit`.
 */
export function searchPaths(paths: string[], query: string, limit = Infinity): string[] {
  const words = tokens(query);
  if (!words.length) return [];
  const named: string[] = [], pathed: string[] = [];
  for (const p of paths) {
    const low = p.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    const last = low.slice(low.lastIndexOf("/") + 1);
    (words.every((w) => last.includes(w)) ? named : pathed).push(p);
  }
  const byLast = (a: string, b: string) => byName({ name: a.slice(a.lastIndexOf("/") + 1) }, { name: b.slice(b.lastIndexOf("/") + 1) });
  return [...named.sort(byLast), ...pathed.sort(byLast)].slice(0, limit);
}

/** Trim from the left so the tail of the path stays visible. */
export function fitPath(path: string, width = 16): string {
  return path.length <= width ? path : ".." + path.slice(path.length - (width - 2));
}

export function fitName(name: string, width = 16): string {
  return name.length <= width ? name : name.slice(0, width - 1) + "~";
}

/** Two-part line: left text, right-aligned suffix, exactly fitting `width`. */
export function fitLine(left: string, right: string, width = 16): string {
  const room = Math.max(0, width - right.length - 1);
  const l = fitPath(left, room);
  return l + " ".repeat(Math.max(1, width - l.length - right.length)) + right;
}

const initial = (e: Entry) => e.name.charAt(0).toUpperCase();

/** Index of the first entry with the next (dir=1) or previous (dir=-1) initial letter. */
export function jumpLetter(entries: Entry[], index: number, dir: 1 | -1): number {
  if (!entries.length) return 0;
  const cur = initial(entries[index]);
  if (dir > 0) {
    for (let i = index + 1; i < entries.length; i++) if (initial(entries[i]) !== cur) return i;
    return index;
  }
  // Back: go to the start of the current letter group, or the previous group's start.
  let i = index;
  while (i > 0 && initial(entries[i - 1]) === cur) i--;
  if (i < index) return i;
  if (i === 0) return 0;
  const prev = initial(entries[i - 1]);
  i--;
  while (i > 0 && initial(entries[i - 1]) === prev) i--;
  return i;
}

/** Cursor + folder history; going up restores the cursor where you left the parent. */
export class Cursor {
  path = ROOT;
  index = 0;
  private history: number[] = [];

  enter(path: string) {
    this.history.push(this.index);
    this.path = path;
    this.index = 0;
  }

  up(): boolean {
    if (this.path === ROOT) return false;
    this.path = parentOf(this.path);
    this.index = this.history.pop() ?? 0;
    return true;
  }

  move(delta: number, count: number) {
    this.index = count ? Math.max(0, Math.min(count - 1, this.index + delta)) : 0;
  }
}
