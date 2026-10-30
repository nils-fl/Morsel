// MPC-style BROWSE mode on the Launchkey display: pick samples/kits for the selected pad, or (keys track) the sample
// the keys play.
import { Cursor, KITS, fitLine, fitName, jumpLetter, type Entry } from "../browse/tree";
import { entrySample, folderLabel, folderSamples, folderToMulti, isSampleFolder, listAt, previewEntry, stopPreview, type Listing } from "../browse/source";
import { COLOR, type LedMode } from "../midi/protocol";
import { loadLivePreset, loadNamedKit, samplesToPads } from "../actions";
import { decodeFile, livePreset, liveSamplePath } from "../browse/disk";
import { engine } from "../audio/engine";
import { newChop } from "./chop";
import { listKits } from "../state/persist";
import { drumPads, drumTrack, get, selectedTrack, set, updateKeys, updatePad } from "../state/store";
import { showTemp } from "./notify";
import { PAD_COUNT, type KeysInstrument, type Zone } from "../state/types";
import { rootFromName } from "../ui/notes";

const PREVIEW_DELAY_MS = 150;
const MAX_STEP = 3; // clamp fast encoder turns

const cursor = new Cursor();
let kits: string[] = [];
let previewTimer = 0;

// The screen redraws every 33 ms and asks for the list several times per frame; only rebuild
// (filter + sort the whole library) when the folder, the library, the kits or a connected folder changes.
let cache: { path: string; samples: object; kits: string[]; keys: boolean; disk: number; folders: object; favorites: string[]; listing: Listing } | null = null;

/** Browsing for a keys track: no Kits folder, and samples go on the keys instead of a pad. */
const forKeys = () => selectedTrack().kind === "keys";

function listing(): Listing {
  const { samples, diskTick: disk, folders, favorites } = get();
  const keys = forKeys();
  if (!cache || cache.path !== cursor.path || cache.samples !== samples || cache.kits !== kits || cache.keys !== keys || cache.disk !== disk ||
    cache.folders !== folders || cache.favorites !== favorites) {
    cache = { path: cursor.path, samples, kits, keys, disk, folders, favorites, listing: listAt(cursor.path, keys ? null : kits, keys ? "keys" : "drum") };
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
  scheduleAudition();
}

// Keys track: the keys play the highlighted sound (a sample, a file, a Live instrument) across the keyboard, read
// into memory when the cursor rests on it and never kept; until it's read, and on a folder, they play the track.
let audition: { entry: Entry; track: string; keys: KeysInstrument } | null = null;
let auditionReq = 0;
let auditionTimer = 0;

function dropAudition() {
  clearTimeout(auditionTimer);
  auditionReq++;
  audition = null;
  engine.setPassing(new Map());
}

function scheduleAudition() {
  dropAudition();
  const e = current();
  if (forKeys() && e && e.kind !== "folder") auditionTimer = window.setTimeout(() => void prepareAudition(e), PREVIEW_DELAY_MS);
}

/** Read the sound `e` and make it the keys' audition instrument, with the track's own settings (volume, filter, LFO). */
async function prepareAudition(e: Entry) {
  const req = auditionReq;
  const t = selectedTrack();
  if (!t.keys) return;
  const buffers = new Map<string, AudioBuffer>();
  const read = async (path: string) => {
    const id = `browse:${path}`;
    if (!buffers.has(id)) buffers.set(id, await decodeFile(path));
    return id;
  };
  let keys: KeysInstrument | null = null;
  try {
    if (e.kind === "sample" || e.kind === "file") {
      let id: string | null = null;
      if (e.kind === "file") id = await read(e.path);
      else {
        const buf = await engine.read(e.id);
        if (buf) buffers.set((id = `browse:${e.id}`), buf);
      }
      if (id) keys = { ...t.keys, type: "sample", sample: { ...t.keys.sample, sampleId: id, root: rootFromName(e.name) ?? t.keys.sample.root } };
    } else if (e.kind === "preset" && e.preset === "instrument") {
      const preset = await livePreset(e.path);
      if (preset?.kind !== "instrument" || req !== auditionReq) return;
      const zones = await Promise.all(preset.zones.map(async (z): Promise<Zone | null> => {
        const id = await read(liveSamplePath(e.path, z.sample)).catch(() => null);
        return id ? { sampleId: id, root: z.root, lo: z.lo, hi: z.hi } : null;
      }));
      const playable = zones.filter((z) => z !== null);
      if (playable.length) keys = { ...t.keys, type: "multi", zones: playable, multiName: preset.name };
    }
  } catch {
    return; // unreadable: the keys stay on the track's own sound
  }
  if (req !== auditionReq || !keys) return;
  engine.setPassing(buffers);
  audition = { entry: e, track: t.id, keys };
}

/** What the keys play in Browse: the highlighted sound, once it's read, for the keys track it was read for. */
export function browseKeys(trackId: string): KeysInstrument | undefined {
  return audition && audition.entry === current() && audition.track === trackId ? audition.keys : undefined;
}

export async function enterBrowse() {
  kits = await listKits();
  const list = entries();
  cursor.index = Math.min(cursor.index, Math.max(0, list.length - 1));
  scheduleAudition();
}

export function exitBrowse() {
  clearTimeout(previewTimer);
  stopPreview();
  dropAudition();
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

/** Function button: open a folder, or load the item onto the selected pad (keys track: as the keys' sample). */
export async function browseEnter() {
  const e = current();
  if (!e) return;
  if (e.kind === "folder") {
    cursor.enter(e.path);
    if (e.path === KITS) kits = await listKits();
    schedulePreview();
    return;
  }
  const done = await loadItem(e);
  if (done) showTemp(...done.popup);
}

/** Load a sample, file or kit onto the selected pad, the keys or the drum track: what the popup says, and whether it loaded. */
async function loadItem(e: Exclude<Entry, { kind: "folder" }>): Promise<{ popup: [string, string]; loaded: boolean } | null> {
  const pad = get().selectedPad;
  if (e.kind === "preset") {
    // An Ableton Live kit or instrument: onto the selected track when it's the right kind, else the first that is.
    const t = selectedTrack();
    const popup = await loadLivePreset(e.path, (e.preset === "kit") === (t.kind === "drum") ? t.id : undefined);
    return popup ? { popup, loaded: true } : { popup: ["Can't load", fitName(e.name)], loaded: false };
  }
  if (e.kind === "sample" || e.kind === "file") {
    const track = selectedTrack();
    let sampleId: string;
    try {
      sampleId = await entrySample(e);
    } catch (err) {
      set({ status: `${e.name}: ${(err as Error).message}` });
      return { popup: ["Can't load", fitName(e.name)], loaded: false };
    }
    if (track.keys) {
      // The keys track becomes a sample one; a note in the name ("Bass_C2") is the root, as in the Keys panel.
      updateKeys({ type: "sample", sample: { ...track.keys.sample, sampleId, root: rootFromName(e.name) ?? track.keys.sample.root } }, track.id, true);
      return { popup: ["LOADED > KEYS", fitName(e.name)], loaded: true };
    }
    updatePad(pad, { sampleId, name: fitName(e.name, 12), start: 0, end: 1, reverse: false }, true);
    return { popup: [`LOADED > PAD ${pad + 1}`, fitName(e.name)], loaded: true };
  }
  if (forKeys()) return { popup: ["Kits", "Drum track only"], loaded: false }; // a starred kit in Favorites
  return (await loadNamedKit(e.name)) ? { popup: ["KIT LOADED", fitName(e.name)], loaded: true } : null;
}

/**
 * Shift + Encoder page ⌄: open the highlighted sample in Chop (on its Sample page), without loading it
 * onto a pad or the keys. The sample already open in Chop stays as it is. Resolves true when Chop has it.
 */
export async function browseChop(): Promise<boolean> {
  const e = current();
  if (e?.kind !== "sample" && e?.kind !== "file") {
    showTemp("Sample", "Pick a sample");
    return false;
  }
  let id: string;
  try {
    id = await entrySample(e);
  } catch (err) {
    set({ status: `${e.name}: ${(err as Error).message}` });
    showTemp("Can't load", fitName(e.name));
    return false;
  }
  const buf = engine.buffer(id);
  if (!buf) return false;
  if (get().chop?.sampleId === id) {
    set({ tab: "Chop" });
    return true;
  }
  // On Chop's Sample page: trim it first, then chop it on the Chop page.
  set({ chop: { ...newChop(id), firstPad: 0 }, tab: "Chop", status: `${e.name}: start and end on encoders 3 and 4 (Func keeps only that), then Encoder page down to chop it` });
  showTemp("Sample", "Trim, Enc v: chop");
  return true;
}

/** The highlighted entry can be chopped (Shift + Encoder page ⌄). */
export const browseOnSample = () => {
  const e = current();
  return e?.kind === "sample" || e?.kind === "file";
};

/** The highlighted entry is a folder (Shift + Function puts it on the pads) rather than an item (load and leave). */
export const browseOnFolder = () => current()?.kind === "folder";

/** Shift + Function: a sample, file or kit loads and Browse closes (`leave`, then the popup); a folder goes on the pads
 *  or becomes the multisample, as browseLoadFolder. */
export async function browseShiftEnter(leave: () => void) {
  const e = current();
  if (!e) return;
  if (e.kind === "folder") return browseLoadFolder();
  const done = await loadItem(e);
  if (done?.loaded && get().hwMode === "browse") leave();
  if (done) showTemp(...done.popup);
}

/** Shift + Function on a sample folder: its first 16 samples become the drum track's kit, or (keys track) its
 *  note-named samples the multisample. */
export async function browseLoadFolder() {
  const e = current();
  if (e?.kind !== "folder" || !isSampleFolder(e.path)) return showTemp("Browse", "Pick a folder");
  showTemp("Loading", fitName(e.name));
  if (forKeys()) {
    const n = await folderToMulti(e.path, selectedTrack().id);
    return showTemp(n ? `MULTI > ${n} ZONES` : fitName(e.name), n ? fitName(e.name) : "No note names");
  }
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
    target: forKeys() ? "" : `P${get().selectedPad + 1}`,
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
  // Keys track: any pad auditions the highlighted sample.
  if (forKeys()) return Array.from({ length: PAD_COUNT }, () => ({ color: COLOR.dimWhite }));
  return drumPads(s).map((pad, i) =>
    i === s.selectedPad ? { color: COLOR.white, mode: "flash" as const } : { color: pad.sampleId ? COLOR.dimWhite : COLOR.off },
  );
}

/** Pad press in browse (after selecting the pad on a drum track): audition the highlighted sample. */
export function browsePad() {
  previewEntry(current());
}
