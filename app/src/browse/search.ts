// Search over every connected folder and the library. A connected folder is walked once into an index (kept in
// IndexedDB, so the next visit searches at once) and walked again on Rescan.
import { deleteFolderIndex, loadFolderIndex, saveFolderIndex } from "../state/persist";
import { get, set, store } from "../state/store";
import { DISK, walkFolder } from "./disk";
import { SAMPLES, searchPaths, type Entry } from "./tree";

/** How many results a search shows. */
const SEARCH_LIMIT = 300;

// Indexes read or built this visit, by connected folder name.
const indexes = new Map<string, string[]>();
const scanning = new Map<string, Promise<void>>();

// A folder that went away or got another name: its index is read again under the name it has now.
store.subscribe((s, prev) => {
  if (s.folders === prev.folders) return;
  const names = new Set(s.folders.map((f) => f.name));
  for (const name of [...indexes.keys()]) if (!names.has(name)) indexes.delete(name);
  const scans = Object.fromEntries(Object.entries(s.scans).filter(([name]) => names.has(name)));
  if (Object.keys(scans).length !== Object.keys(s.scans).length) set({ scans });
});

const setScan = (name: string, v: number | "done") => set({ scans: { ...get().scans, [name]: v } });

/** Walk a connected folder into its index, in the background. A walk already going on is joined, not restarted. */
export function scanFolder(name: string): Promise<void> {
  let p = scanning.get(name);
  if (p) return p;
  p = (async () => {
    setScan(name, 0);
    try {
      const files = await walkFolder(name, (n) => setScan(name, n));
      // Disconnected or renamed meanwhile: these paths aren't its paths any more.
      if (!get().folders.some((f) => f.name === name)) return;
      indexes.set(name, files);
      await saveFolderIndex(name, { files, scannedAt: Date.now() });
      setScan(name, "done");
    } catch {
      indexes.delete(name);
      await deleteFolderIndex(name).catch(() => undefined);
      const { [name]: _gone, ...rest } = get().scans;
      set({ scans: rest });
    } finally {
      scanning.delete(name);
    }
  })();
  scanning.set(name, p);
  return p;
}

/** A connected folder's index: read from storage, or walked the first time (in the background). */
async function indexOf(name: string): Promise<string[] | undefined> {
  const have = indexes.get(name);
  if (have) return have;
  const stored = await loadFolderIndex(name).catch(() => undefined);
  if (stored && get().folders.some((f) => f.name === name)) {
    indexes.set(name, stored.files);
    if (get().scans[name] === undefined) setScan(name, "done");
    return stored.files;
  }
  if (!scanning.has(name)) void scanFolder(name);
}

export interface SearchResult { entries: Entry[]; more: boolean }

/**
 * Library samples and files in the readable connected folders matching `query`. Folders still being walked add their
 * files when the walk is done (the drawer searches again when `scans` changes).
 */
export async function search(query: string): Promise<SearchResult> {
  const lib = Object.values(get().samples);
  const libPath = new Map(lib.map((s) => [[SAMPLES, s.folder, s.name].filter(Boolean).join("/"), s]));
  const disk: string[] = [];
  for (const f of get().folders) {
    if (f.access !== "granted") continue;
    const files = await indexOf(f.name);
    if (files) disk.push(...files);
  }
  // The library first, then the connected folders (searched without the "disk:" in front).
  const samples = searchPaths([...libPath.keys()], query, SEARCH_LIMIT + 1).map((p): Entry => {
    const s = libPath.get(p)!;
    return { kind: "sample", id: s.id, name: s.name };
  });
  const files = searchPaths(disk.map((p) => p.slice(DISK.length)), query, SEARCH_LIMIT + 1 - samples.length).map((p): Entry => (
    { kind: "file", name: p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), path: DISK + p }
  ));
  const all = [...samples, ...files];
  return { entries: all.slice(0, SEARCH_LIMIT), more: all.length > SEARCH_LIMIT };
}
