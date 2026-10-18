// What Browse (Launchkey) and the on-screen sample picker list: the library tree, saved kits and connected folders.
import { engine } from "../audio/engine";
import { get } from "../state/store";
import { DISK, fileSample, isDiskPath, listDisk, previewFile, rootPath, stopFilePreview } from "./disk";
import { KITS, ROOT, listDir, type Entry } from "./tree";

export interface Listing { entries: Entry[]; note?: string }

/** Entries at `path`. `kits` null leaves the Kits folder out (the sample picker). */
export function listAt(path: string, kits: string[] | null): Listing {
  if (path === ROOT) {
    const top = listDir(ROOT, [], []).filter((e) => kits || e.name !== KITS);
    return { entries: [...top, ...get().folders.map((f): Entry => ({ kind: "folder", name: f.name, path: rootPath(f.name) }))] };
  }
  if (isDiskPath(path)) return listDisk(path);
  return { entries: listDir(path, Object.values(get().samples), kits ?? []) };
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

export function previewEntry(e: Entry | undefined) {
  stopPreview();
  if (e?.kind === "sample") engine.preview(e.id);
  else if (e?.kind === "file") previewFile(e.path);
}

export function stopPreview() {
  stopFilePreview();
  engine.stopPreview();
}
