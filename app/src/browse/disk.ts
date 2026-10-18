// Connected folders (File System Access API, Chrome/Edge): browsed in place, nothing is copied until a file is used.
// Paths look like "disk:Sample Packs/Drums/Kick 1.wav"; the first part is the connected folder's name.
import { engine } from "../audio/engine";
import { loadFolders, saveFolders, type StoredFolder } from "../state/persist";
import { get, set, type FolderAccess } from "../state/store";
import { byName, type Entry } from "./tree";

// Not in TypeScript's DOM types yet (Chromium only).
declare global {
  interface Window {
    showDirectoryPicker?(opts?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(d: { mode: "read" }): Promise<PermissionState>;
    requestPermission?(d: { mode: "read" }): Promise<PermissionState>;
  }
}

export const DISK = "disk:";
export const isDiskPath = (path: string) => path.startsWith(DISK);
export const rootPath = (name: string) => DISK + name;
export const diskSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

const AUDIO = /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i;

interface Root extends StoredFolder { access: FolderAccess }
let roots: Root[] = [];
const listings = new Map<string, Entry[]>();
const failed = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

const rootOf = (path: string) => roots.find((r) => r.name === path.slice(DISK.length).split("/")[0]);
const publish = () => set({ folders: roots.map((r) => ({ name: r.name, access: r.access })) });
const bump = () => set({ diskTick: get().diskTick + 1 });
const persist = () => saveFolders(roots.map(({ name, handle }) => ({ name, handle })));

/** Drop cached listings of a folder and everything below it. */
function forget(path: string) {
  for (const m of [listings, failed]) for (const k of [...m.keys()]) if (k === path || k.startsWith(path + "/")) m.delete(k);
}

async function access(h: FileSystemDirectoryHandle): Promise<FolderAccess> {
  try {
    return (await h.queryPermission?.({ mode: "read" })) ?? "granted";
  } catch {
    return "missing";
  }
}

export async function initDisk() {
  if (!diskSupported()) return;
  roots = await Promise.all((await loadFolders()).map(async (f) => ({ ...f, access: await access(f.handle) })));
  publish();
}

/** Chrome's folder picker (needs a click). Returns the connected folder's name, or undefined when cancelled. */
export async function connectFolder(): Promise<string | undefined> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ id: "morsel-samples", mode: "read" });
  } catch {
    return;
  }
  // The same folder again: it's already there, so just read it afresh.
  for (const r of roots) {
    if (await r.handle.isSameEntry(handle)) {
      r.access = "granted";
      forget(rootPath(r.name));
      publish();
      bump();
      return r.name;
    }
  }
  let name = handle.name, i = 2;
  while (roots.some((r) => r.name === name)) name = `${handle.name} (${i++})`;
  roots.push({ name, handle, access: "granted" });
  await persist();
  publish();
  set({ status: `Connected ${name}. Nothing is copied until you use a sample.` });
  return name;
}

/** Ask for read access again; browsers forget it when they restart. Needs a click. */
export async function reconnectFolder(name: string) {
  const r = roots.find((x) => x.name === name);
  if (!r) return;
  try {
    r.access = (await r.handle.requestPermission?.({ mode: "read" })) ?? "granted";
  } catch {
    r.access = "missing";
  }
  forget(rootPath(name));
  publish();
  bump();
}

/** Forget a connected folder. Samples already used from it stay in the library. */
export async function disconnectFolder(name: string) {
  roots = roots.filter((r) => r.name !== name);
  forget(rootPath(name));
  await persist();
  publish();
  bump();
}

async function dirHandle(path: string) {
  const [, ...parts] = path.slice(DISK.length).split("/");
  let h = rootOf(path)?.handle;
  if (!h) throw new Error("Not connected");
  for (const p of parts) h = await h.getDirectoryHandle(p);
  return h;
}

function loadListing(path: string): Promise<void> {
  let p = pending.get(path);
  if (p) return p;
  p = (async () => {
    try {
      const folders: Entry[] = [], files: Entry[] = [];
      for await (const h of (await dirHandle(path)).values()) {
        if (h.name.startsWith(".")) continue;
        if (h.kind === "directory") folders.push({ kind: "folder", name: h.name, path: `${path}/${h.name}` });
        else if (AUDIO.test(h.name)) files.push({ kind: "file", name: h.name.replace(/\.[^.]+$/, ""), path: `${path}/${h.name}` });
      }
      listings.set(path, [...folders.sort(byName), ...files.sort(byName)]);
    } catch (err) {
      const root = rootOf(path);
      const e = err as DOMException;
      if (root && e.name === "NotAllowedError") {
        root.access = "prompt";
        publish();
      } else if (root && e.name === "NotFoundError" && path === rootPath(root.name)) {
        root.access = "missing";
        publish();
      } else failed.set(path, "Can't read folder");
    } finally {
      pending.delete(path);
      bump();
    }
  })();
  pending.set(path, p);
  return p;
}

/** A connected folder's entries, or a note while it loads or can't be read. Loads in the background (bumps diskTick). */
export function listDisk(path: string): { entries: Entry[]; note?: string } {
  const root = rootOf(path);
  if (!root) return { entries: [], note: "Not connected" };
  if (root.access === "missing") return { entries: [], note: "Folder not found" };
  if (root.access !== "granted") return { entries: [], note: "Reconnect on screen" };
  const have = listings.get(path);
  if (have) return { entries: have };
  const err = failed.get(path);
  if (err) return { entries: [], note: err };
  void loadListing(path);
  return { entries: [], note: "Loading…" };
}

/** The listing, waiting for it to load. */
export async function listDiskNow(path: string): Promise<Entry[]> {
  if (!listings.has(path)) await loadListing(path);
  return listings.get(path) ?? [];
}

async function fileOf(path: string) {
  const i = path.lastIndexOf("/");
  return (await (await dirHandle(path.slice(0, i))).getFileHandle(path.slice(i + 1))).getFile();
}

// The last few decoded originals, so scrolling back and loading what you just heard is instant.
const decoded = new Map<string, AudioBuffer>();

async function decodeFile(path: string, file?: File) {
  let buf = decoded.get(path);
  if (!buf) {
    buf = await engine.decode(file ?? (await fileOf(path)));
    decoded.set(path, buf);
    if (decoded.size > 8) decoded.delete(decoded.keys().next().value!);
  }
  return buf;
}

let previewReq = 0;

/** Audition a file: the decoded original when it's at hand, else streamed (starts at once, any length). */
export function previewFile(path: string) {
  const req = ++previewReq;
  engine.stopPreview();
  const have = decoded.get(path);
  if (have) return void engine.previewBuffer(have);
  fileOf(path).then((f) => req === previewReq && engine.previewFile(f), () => undefined);
}

export function stopFilePreview() {
  previewReq++;
}

/** Copy a file into the library and return the sample. The same file again reuses that sample. */
export async function fileSample(path: string): Promise<string> {
  const known = Object.values(get().samples).find((s) => s.src === path);
  if (known && (await engine.ensure(known.id))) return known.id;
  const parts = path.slice(DISK.length).split("/");
  const name = parts.pop()!.replace(/\.[^.]+$/, "");
  return engine.addBuffer(name, await decodeFile(path), parts.join("/"), path);
}
