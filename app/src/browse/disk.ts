// Connected folders: browsed in place, nothing is copied until a file is used. In a browser they come through the
// File System Access API (Chrome/Edge), in the desktop app from the file system.
// Paths look like "disk:Sample Packs/Drums/Kick 1.wav"; the first part is the connected folder's name.
import { engine } from "../audio/engine";
import { native } from "../platform/native";
import type { MorselNative, NativeResult } from "../platform/nativeApi";
import { deleteFolderIndex, loadFolderIndex, loadFolders, saveFolderIndex, saveFolders, type StoredFolder } from "../state/persist";
import { get, set, type FolderAccess } from "../state/store";
import { moveFavorites } from "./favorites";
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

/** Where a connected folder's files come from. Errors are DOMExceptions named as the web API names them. */
interface DiskBackend {
  supported(): boolean;
  /** The folder picker (needs a click in a browser), opened at `at` if given. Undefined when cancelled. */
  pick(at?: StoredFolder): Promise<StoredFolder | undefined>;
  same(a: StoredFolder, b: StoredFolder): Promise<boolean>;
  access(f: StoredFolder): Promise<FolderAccess>;
  /** Ask for read access again (needs a click in a browser). */
  reconnect(f: StoredFolder): Promise<FolderAccess>;
  forget(f: StoredFolder): void;
  /** The entries of a folder `parts` below the connected one. */
  list(f: StoredFolder, parts: string[]): Promise<{ name: string; dir: boolean }[]>;
  file(f: StoredFolder, parts: string[]): Promise<File>;
}

async function webDir(f: StoredFolder, parts: string[]) {
  let h = f.handle!;
  for (const p of parts) h = await h.getDirectoryHandle(p);
  return h;
}

// The browser keeps the handle and asks for the permission again after a restart.
const web: DiskBackend = {
  supported: () => typeof window !== "undefined" && "showDirectoryPicker" in window,
  async pick() {
    const handle = await window.showDirectoryPicker!({ id: "morsel-samples", mode: "read" }).catch(() => undefined);
    return handle && { name: handle.name, handle };
  },
  same: (a, b) => a.handle!.isSameEntry(b.handle!),
  async access(f) {
    try {
      return (await f.handle!.queryPermission?.({ mode: "read" })) ?? "granted";
    } catch {
      return "missing";
    }
  },
  async reconnect(f) {
    try {
      return (await f.handle!.requestPermission?.({ mode: "read" })) ?? "granted";
    } catch (err) {
      // Gone from disk, or the browser wouldn't ask (no click to ask with): then Reconnect stays.
      return (err as DOMException).name === "NotFoundError" ? "missing" : "prompt";
    }
  },
  forget() {},
  async list(f, parts) {
    const out: { name: string; dir: boolean }[] = [];
    for await (const h of (await webDir(f, parts)).values()) out.push({ name: h.name, dir: h.kind === "directory" });
    return out;
  },
  async file(f, parts) {
    return (await (await webDir(f, parts.slice(0, -1))).getFileHandle(parts.at(-1)!)).getFile();
  },
};

function unwrap<T>(r: NativeResult<T>): T {
  if ("ok" in r) return r.ok;
  throw new DOMException(r.message ?? "Can't read folder", r.err);
}

// The desktop app keeps the folder's path; folders picked once stay readable.
const desktop = (n: MorselNative): DiskBackend => {
  const at = (f: StoredFolder, parts: string[]) => [f.path!, ...parts].join("/");
  const access = async (f: StoredFolder): Promise<FolderAccess> => {
    const r = await n.listFolder(f.path!);
    return "ok" in r ? "granted" : r.err === "NotFoundError" ? "missing" : "prompt";
  };
  return {
    supported: () => true,
    async pick(again) {
      const picked = await n.pickFolder(again?.path);
      return picked && { name: picked.name, path: picked.path };
    },
    same: async (a, b) => a.path === b.path,
    access,
    async reconnect(f) {
      // Picking the folder again lets the app read it; another folder leaves this one as it was.
      const picked = await n.pickFolder(f.path);
      return picked?.path === f.path ? access(f) : "prompt";
    },
    forget: (f) => n.forgetFolder(f.path!),
    list: async (f, parts) => unwrap(await n.listFolder(at(f, parts))),
    file: async (f, parts) => new File([unwrap(await n.readFile(at(f, parts))) as Uint8Array<ArrayBuffer>], parts.at(-1)!),
  };
};

const backend = native ? desktop(native) : web;

export const DISK = "disk:";
export const isDiskPath = (path: string) => path.startsWith(DISK);
export const rootPath = (name: string) => DISK + name;
export const diskSupported = () => backend.supported();

const AUDIO = /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i;

interface Root extends StoredFolder { access: FolderAccess }
let roots: Root[] = [];
const listings = new Map<string, Entry[]>();
const failed = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

const rootOf = (path: string) => roots.find((r) => r.name === path.slice(DISK.length).split("/")[0]);
const partsOf = (path: string) => path.slice(DISK.length).split("/").slice(1);
const publish = () => set({ folders: roots.map((r) => ({ name: r.name, access: r.access })) });
const bump = () => set({ diskTick: get().diskTick + 1 });
const persist = () => saveFolders(roots.map(({ name, handle, path }) => ({ name, handle, path })));

/** Drop cached listings of a folder and everything below it. */
function forget(path: string) {
  for (const m of [listings, failed]) for (const k of [...m.keys()]) if (k === path || k.startsWith(path + "/")) m.delete(k);
}

export async function initDisk() {
  if (!diskSupported()) return;
  roots = await Promise.all((await loadFolders()).map(async (f) => ({ ...f, access: await backend.access(f) })));
  publish();
  if (!native && roots.some((r) => r.access === "prompt")) reconnectOnFirstClick();
}

/**
 * A browser forgets the folders' permission when it restarts, and only asks for it again from a click. The first click
 * or key press on the page (the one that also starts audio) asks for all of them, so one click brings back both.
 * Folders it doesn't get back keep their Reconnect button.
 */
function reconnectOnFirstClick() {
  const once = () => {
    window.removeEventListener("pointerdown", once, true);
    window.removeEventListener("keydown", once, true);
    void reconnectForgotten();
  };
  window.addEventListener("pointerdown", once, true);
  window.addEventListener("keydown", once, true);
}

async function reconnectForgotten() {
  const asked = roots.filter((r) => r.access === "prompt");
  // All asked at once, while the click still counts.
  const results = await Promise.all(asked.map((r) => backend.reconnect(r)));
  asked.forEach((r, i) => {
    r.access = results[i];
    forget(rootPath(r.name));
  });
  publish();
  bump();
  const back = asked.filter((r) => r.access === "granted").map((r) => r.name);
  if (back.length) set({ status: `Reconnected ${back.join(", ")}` });
}

/** The folder picker (needs a click in a browser). Returns the connected folder's name, or undefined when cancelled. */
export async function connectFolder(): Promise<string | undefined> {
  const picked = await backend.pick();
  if (!picked) return;
  // The same folder again: it's already there, so just read it afresh.
  for (const r of roots) {
    if (await backend.same(r, picked)) {
      r.access = "granted";
      forget(rootPath(r.name));
      publish();
      bump();
      return r.name;
    }
  }
  let name = picked.name, i = 2;
  while (roots.some((r) => r.name === name)) name = `${picked.name} (${i++})`;
  roots.push({ ...picked, name, access: "granted" });
  await persist();
  publish();
  set({ status: `Connected ${name}. Nothing is copied until you use a sample.` });
  return name;
}

/** Ask for read access again; browsers forget it when they restart. Needs a click. */
export async function reconnectFolder(name: string) {
  const r = roots.find((x) => x.name === name);
  if (!r) return;
  r.access = await backend.reconnect(r);
  forget(rootPath(name));
  publish();
  bump();
}

/** Forget a connected folder. Samples already used from it stay in the library. */
export async function disconnectFolder(name: string) {
  for (const r of roots) if (r.name === name) backend.forget(r);
  roots = roots.filter((r) => r.name !== name);
  forget(rootPath(name));
  await persist();
  publish();
  bump();
  await deleteFolderIndex(name).catch(() => undefined);
}

/** Read a connected folder afresh: its listings are dropped and loaded again when they're shown. */
export function refreshFolder(name: string) {
  forget(rootPath(name));
  bump();
}

/** A name another connected folder doesn't have, or why it can't be used. */
export function folderNameProblem(name: string, current?: string): string | undefined {
  const n = name.trim();
  if (!n) return "Give it a name";
  if (n.includes("/")) return "No slashes in the name";
  if (n !== current && roots.some((r) => r.name === n)) return "Another folder has that name";
}

/**
 * Call a connected folder something else. Only Morsel's name changes (the folder on disk stays as it is), so the
 * samples copied from it, the favorites in it and its search index follow it.
 */
export async function renameFolder(name: string, to: string) {
  const r = roots.find((x) => x.name === name);
  const next = to.trim();
  if (!r || next === name || folderNameProblem(next, name)) return;
  const from = rootPath(name), dest = rootPath(next);
  const moved = (p: string) => (p === from || p.startsWith(from + "/") ? dest + p.slice(from.length) : p);
  r.name = next;
  forget(from);
  await persist();
  const samples = { ...get().samples };
  for (const [id, x] of Object.entries(samples)) if (x.src && moved(x.src) !== x.src) samples[id] = { ...x, src: moved(x.src) };
  set({ samples });
  moveFavorites(from, dest);
  publish();
  bump();
  const index = await loadFolderIndex(name).catch(() => undefined);
  if (index) {
    await saveFolderIndex(next, { ...index, files: index.files.map(moved) });
    await deleteFolderIndex(name);
  }
}

/**
 * Every audio file in a connected folder and its subfolders, as disk paths. `onCount` hears how many so far.
 * Folders that can't be read are skipped; a folder that can't be read at all throws.
 */
export async function walkFolder(name: string, onCount: (files: number) => void): Promise<string[]> {
  const root = roots.find((r) => r.name === name);
  if (!root) throw new Error("Not connected");
  const files: string[] = [];
  const todo: string[][] = [[]];
  let seen = 0;
  while (todo.length) {
    const parts = todo.shift()!;
    let list: { name: string; dir: boolean }[];
    try {
      list = await backend.list(root, parts);
    } catch (err) {
      if (!parts.length) throw err;
      continue;
    }
    for (const h of list) {
      if (h.name.startsWith(".")) continue;
      if (h.dir) todo.push([...parts, h.name]);
      else if (AUDIO.test(h.name)) files.push([rootPath(name), ...parts, h.name].join("/"));
      // Let playback and the UI breathe in big packs.
      if (++seen % 200 === 0) {
        onCount(files.length);
        await new Promise((r) => setTimeout(r));
      }
    }
  }
  onCount(files.length);
  return files;
}

function loadListing(path: string): Promise<void> {
  let p = pending.get(path);
  if (p) return p;
  p = (async () => {
    try {
      const folders: Entry[] = [], files: Entry[] = [];
      const root = rootOf(path);
      if (!root) throw new Error("Not connected");
      for (const h of await backend.list(root, partsOf(path))) {
        if (h.name.startsWith(".")) continue;
        if (h.dir) folders.push({ kind: "folder", name: h.name, path: `${path}/${h.name}` });
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
  const root = rootOf(path);
  if (!root) throw new Error("Not connected");
  return backend.file(root, partsOf(path));
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

/** Files bigger than this aren't decoded just to draw them. */
const INFO_MAX_BYTES = 50e6;

/** A file's size, and its audio when it's small enough to decode for a look. Throws when it can't be read. */
export async function fileDetails(path: string): Promise<{ size: number; buffer?: AudioBuffer }> {
  const have = decoded.get(path);
  const file = await fileOf(path);
  if (have) return { size: file.size, buffer: have };
  return { size: file.size, buffer: file.size <= INFO_MAX_BYTES ? await decodeFile(path, file) : undefined };
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
