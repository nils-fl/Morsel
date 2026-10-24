// What Browse (Launchkey) and the on-screen sample picker list: the library tree, saved kits and connected folders.
import { engine } from "../audio/engine";
import { get, updateKeys } from "../state/store";
import type { Zone } from "../state/types";
import { rootFromName } from "../ui/notes";
import { DISK, fileSample, isDiskPath, listDisk, listDiskNow, previewFile, rootPath, stopFilePreview } from "./disk";
import { FAVORITES, KITS, ROOT, SAMPLES, favoriteEntries, listDir, type Entry } from "./tree";

export interface Listing { entries: Entry[]; note?: string }

/** Entries at `path`. `kits` null leaves the Kits folder out (the sample picker). */
export function listAt(path: string, kits: string[] | null): Listing {
  const { folders, favorites, samples } = get();
  if (path === ROOT) {
    const top = listDir(ROOT, [], []).filter((e) => kits || e.name !== KITS);
    const fav: Entry[] = favorites.length ? [{ kind: "folder", name: FAVORITES, path: FAVORITES }] : [];
    return { entries: [...fav, ...top, ...folders.map((f): Entry => ({ kind: "folder", name: f.name, path: rootPath(f.name) }))] };
  }
  if (path === FAVORITES) {
    const entries = favoriteEntries(favorites, samples, folders.map((f) => f.name));
    return { entries, note: entries.length ? undefined : "Nothing starred" };
  }
  if (isDiskPath(path)) return listDisk(path);
  if (!kits && path === KITS) return { entries: [], note: "Drum tracks only" };
  return { entries: listDir(path, Object.values(samples), kits ?? []) };
}

/** Last part of a path, for headers. */
export const folderLabel = (path: string) => path.split("/").pop()!.replace(DISK, "");

/** The library sample for a sample or file entry, its audio loaded. Throws when it can't be read. */
export async function entrySample(e: Entry): Promise<string> {
  if (e.kind === "file") return fileSample(e.path);
  if (e.kind !== "sample") throw new Error("Not a sample");
  if (!(await engine.ensure(e.id))) throw new Error("Can't load it");
  return e.id;
}

/** Folders whose samples can go on the pads or the keys: library and connected folders, not the root or Kits. */
export const isSampleFolder = (path: string) => isDiskPath(path) || path.startsWith(SAMPLES + "/");

/**
 * The samples in a folder (not its subfolders) that `keep` accepts by name, loaded into the library; up to `limit`.
 * Unreadable ones are skipped.
 */
export async function folderSamples(path: string, limit = Infinity, keep = (_name: string) => true): Promise<{ id: string; name: string }[]> {
  const list = isDiskPath(path) ? await listDiskNow(path) : listAt(path, null).entries;
  const items = list.filter((x) => (x.kind === "sample" || x.kind === "file") && keep(x.name)).slice(0, limit);
  const loaded = await Promise.all(items.map((x) => entrySample(x).then((id) => ({ id, name: x.name }), () => null)));
  return loaded.filter((x) => x !== null);
}

/** A folder's note-named samples ("Piano_C4") as a keys track's multisample; only those are copied into the library.
 *  Returns how many zones it made (0: none, the track is left as it was). */
export async function folderToMulti(path: string, trackId?: string): Promise<number> {
  const named = await folderSamples(path, Infinity, (name) => rootFromName(name) !== null);
  if (!named.length) return 0;
  const zones: Zone[] = named.map((s) => ({ sampleId: s.id, root: rootFromName(s.name)! })).sort((a, b) => a.root - b.root);
  updateKeys({ type: "multi", zones, multiName: folderLabel(path) }, trackId);
  return zones.length;
}

export function previewEntry(e: Entry | undefined) {
  stopPreview();
  if (e?.kind === "sample") engine.preview(e.id);
  else if (e?.kind === "file") previewFile(e.path);
}

export function stopPreview() {
  stopFilePreview();
  engine.stopPreview();
}
