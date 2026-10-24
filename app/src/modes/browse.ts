// MPC-style BROWSE mode on the Launchkey display: pick samples/kits for the selected pad.
import { Cursor, KITS, fitLine, fitName, jumpLetter, type Entry } from "../browse/tree";
import { entrySample, folderLabel, folderSamples, isSampleFolder, listAt, previewEntry, stopPreview, type Listing } from "../browse/source";
import { COLOR, type LedMode } from "../midi/protocol";
import { loadNamedKit, samplesToPads } from "../actions";
import { listKits } from "../state/persist";
import { drumPads, drumTrack, get, set, updatePad } from "../state/store";
import { showTemp } from "./notify";
import { PAD_COUNT } from "../state/types";

const PREVIEW_DELAY_MS = 150;
const MAX_STEP = 3; // clamp fast encoder turns

const cursor = new Cursor();
let kits: string[] = [];
let previewTimer = 0;

// The screen redraws every 33 ms and asks for the list several times per frame; only rebuild
// (filter + sort the whole library) when the folder, the library, the kits or a connected folder changes.
let cache: { path: string; samples: object; kits: string[]; disk: number; folders: object; favorites: string[]; listing: Listing } | null = null;

function listing(): Listing {
  const { samples, diskTick: disk, folders, favorites } = get();
  if (!cache || cache.path !== cursor.path || cache.samples !== samples || cache.kits !== kits || cache.disk !== disk || cache.folders !== folders ||
    cache.favorites !== favorites) {
    cache = { path: cursor.path, samples, kits, disk, folders, favorites, listing: listAt(cursor.path, kits) };
  }
  return cache.listing;
}

const entries = () => listing().entries;

function current(): Entry | undefined {
  return entries()[cursor.index];
}

function schedulePreview() {
  clearTimeout(previewTimer);
  stopPreview();
  const e = current();
  if (e?.kind === "sample" || e?.kind === "file") previewTimer = window.setTimeout(() => previewEntry(e), PREVIEW_DELAY_MS);
}

export async function enterBrowse() {
  kits = await listKits();
  const list = entries();
  cursor.index = Math.min(cursor.index, Math.max(0, list.length - 1));
}

export function exitBrowse() {
  clearTimeout(previewTimer);
  stopPreview();
}

/** Encoders 1 and 8 scroll, 2 and 7 jump by letter, so either hand can browse. */
export function browseEncoder(index: number, delta: number, shift: boolean) {
  const list = entries();
  if (index === 0 || index === 7) {
    cursor.move(Math.max(-MAX_STEP, Math.min(MAX_STEP, delta)), list.length);
  } else if (index === 1 || index === 6) {
    if (shift) cursor.move(Math.sign(delta) * 8, list.length);
    else cursor.index = jumpLetter(list, cursor.index, delta > 0 ? 1 : -1);
  } else return;
  schedulePreview();
}

/** Function button: open a folder, or load the item onto the selected pad. */
export async function browseEnter() {
  const e = current();
  if (!e) return;
  if (e.kind === "folder") {
    cursor.enter(e.path);
    if (e.path === KITS) kits = await listKits();
    schedulePreview();
    return;
  }
  const pad = get().selectedPad;
  if (e.kind === "sample" || e.kind === "file") {
    let sampleId: string;
    try {
      sampleId = await entrySample(e);
    } catch (err) {
      set({ status: `${e.name}: ${(err as Error).message}` });
      return showTemp("Can't load", fitName(e.name));
    }
    updatePad(pad, { sampleId, name: fitName(e.name, 12), start: 0, end: 1, reverse: false }, true);
    showTemp(`LOADED > PAD ${pad + 1}`, fitName(e.name));
  } else if (await loadNamedKit(e.name)) {
    showTemp("KIT LOADED", fitName(e.name));
  }
}

/** Shift + Function on a sample folder: its first 16 samples become the drum track's kit. */
export async function browseFolderToPads() {
  const e = current();
  if (e?.kind !== "folder" || !isSampleFolder(e.path)) return showTemp("Browse", "Pick a folder");
  showTemp("Loading", fitName(e.name));
  const loaded = await folderSamples(e.path, PAD_COUNT);
  if (!loaded.length) return showTemp(fitName(e.name), "No samples");
  const n = samplesToPads(loaded, e.name);
  showTemp(`FOLDER > PADS 1-${n}`, fitName(drumTrack().name));
}

/** Scene button: up one folder. */
export function browseUp() {
  if (cursor.up()) schedulePreview();
}

export function browseDisplay(): [string, string] {
  const { entries: list, note } = listing();
  const name = folderLabel(cursor.path) || "Browse";
  if (!list.length) return [fitLine(name, "0/0"), note ?? "(empty)"];
  const e = list[cursor.index];
  return [fitLine(name, `${cursor.index + 1}/${list.length}`), e.kind === "folder" ? fitName(">" + e.name) : fitName(e.name)];
}

export function browseView() {
  const { entries: list, note } = listing();
  return {
    folder: folderLabel(cursor.path),
    index: cursor.index,
    items: list.length || !note ? list.map((e) => ({ label: e.name, folder: e.kind === "folder" })) : [{ label: note, folder: false }],
  };
}

/** For the button LEDs: Function can open/load, Scene can go up. */
export function browseCan() {
  return { enter: entries().length > 0, up: cursor.path !== "" };
}

export function browseLeds(): { color: number; mode?: LedMode }[] {
  const s = get();
  return drumPads(s).map((pad, i) =>
    i === s.selectedPad ? { color: COLOR.white, mode: "flash" as const } : { color: pad.sampleId ? COLOR.dimWhite : COLOR.off },
  );
}

/** Pad press in browse (after selecting the pad): audition the highlighted sample. */
export function browsePad() {
  previewEntry(current());
}
