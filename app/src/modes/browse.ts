// MPC-style BROWSE mode on the Launchkey display: pick samples/kits for the selected pad.
import { engine } from "../audio/engine";
import { Cursor, KITS, fitLine, fitName, jumpLetter, listDir, type Entry } from "../browse/tree";
import { COLOR, type LedMode } from "../midi/protocol";
import { listKits, loadKit } from "../state/persist";
import { drumPads, get, updatePad, updateProject } from "../state/store";
import { showTemp } from "./notify";

const PREVIEW_DELAY_MS = 150;
const MAX_STEP = 3; // clamp fast encoder turns

const cursor = new Cursor();
let kits: string[] = [];
let previewTimer = 0;

// The screen redraws every 33 ms and asks for the list several times per frame; only rebuild
// (filter + sort the whole library) when the folder, the library or the kit list changes.
let cache: { path: string; samples: object; kits: string[]; list: Entry[] } | null = null;

function entries(): Entry[] {
  const samples = get().samples;
  if (!cache || cache.path !== cursor.path || cache.samples !== samples || cache.kits !== kits) {
    cache = { path: cursor.path, samples, kits, list: listDir(cursor.path, Object.values(samples), kits) };
  }
  return cache.list;
}

function current(): Entry | undefined {
  return entries()[cursor.index];
}

function schedulePreview() {
  clearTimeout(previewTimer);
  engine.stopPreview();
  const e = current();
  if (e?.kind === "sample") previewTimer = window.setTimeout(() => engine.preview(e.id), PREVIEW_DELAY_MS);
}

export async function enterBrowse() {
  kits = await listKits();
  const list = entries();
  cursor.index = Math.min(cursor.index, Math.max(0, list.length - 1));
}

export function exitBrowse() {
  clearTimeout(previewTimer);
  engine.stopPreview();
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
  if (e.kind === "sample") {
    updatePad(pad, { sampleId: e.id, name: fitName(e.name, 12), start: 0, end: 1, reverse: false }, true);
    showTemp(`LOADED > PAD ${pad + 1}`, fitName(e.name));
  } else {
    const pads = await loadKit(e.name);
    if (pads) {
      updateProject((p) => ({ ...p, pads }));
      showTemp("KIT LOADED", fitName(e.name));
    }
  }
}

/** Scene button: up one folder. */
export function browseUp() {
  if (cursor.up()) schedulePreview();
}

export function browseDisplay(): [string, string] {
  const list = entries();
  const name = cursor.path || "Browse";
  if (!list.length) return [fitLine(name, "0/0"), "(empty)"];
  const e = list[cursor.index];
  return [fitLine(name.split("/").pop()!, `${cursor.index + 1}/${list.length}`), e.kind === "folder" ? fitName(">" + e.name) : fitName(e.name)];
}

export function browseView() {
  return {
    folder: cursor.path.split("/").pop() ?? "",
    index: cursor.index,
    items: entries().map((e) => ({ label: e.name, folder: e.kind === "folder" })),
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
  const e = current();
  if (e?.kind === "sample") engine.preview(e.id);
}
