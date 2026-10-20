// Single-file project export: project JSON plus all referenced samples (16-bit PCM, base64).
import type { engine as Engine } from "../audio/engine";
import { engine } from "../audio/engine";
import { toInt16 } from "../audio/pcm";
import { PROJECT_VERSION, drumTrack, get, usedSampleIds, normalizePads, normalizeProject, resetSession, set, updateTrack } from "./store";
import { sequencer } from "../seq/sequencer";
import { cancelKitLoad } from "../actions";
import { releaseAll, setHwMode } from "../modes/controller";
import { listKits, saveKit } from "./persist";
import { STOCK_KITS, type Pad, type Project } from "./types";
import { KIT_FORMAT, PROJECT_FORMAT, isKitFormat, isProjectFormat } from "./fileFormat";

interface FileSample { name: string; sampleRate: number; channels: string[] }
interface ProjectFile { format: typeof PROJECT_FORMAT; version: number; project: Project; samples: Record<string, FileSample> }

function toB64(data: Float32Array) {
  const bytes = new Uint8Array(toInt16(data).buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  return Float32Array.from(pcm, (v) => v / 0x7fff);
}

async function encodeSamples(ids: Iterable<string>) {
  const samples: Record<string, FileSample> = {};
  for (const id of ids) {
    const buf = await engine.ensure(id);
    if (!buf) continue;
    samples[id] = {
      name: get().samples[id]?.name ?? id,
      sampleRate: buf.sampleRate,
      channels: Array.from({ length: buf.numberOfChannels }, (_, c) => toB64(buf.getChannelData(c))),
    };
  }
  return samples;
}

export async function exportProject(): Promise<Blob> {
  const project = get().project;
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, project, samples: await encodeSamples(usedSampleIds(project)) };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

/** A kit file (the format importKit reads) with the pads and their samples. */
export async function exportKit(name: string, pads: Pad[]): Promise<Blob> {
  const ids = new Set(pads.flatMap((pad) => (pad.sampleId ? [pad.sampleId] : [])));
  const file = { format: KIT_FORMAT, version: 1, name, pads, samples: await encodeSamples(ids) };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Decode and check every sample before anything touches the library, so a bad file changes nothing. */
function decodeSamples(samples: unknown): Map<string, { name: string; buffer: AudioBuffer }> {
  if (!isObj(samples)) throw new Error("Missing samples");
  const out = new Map<string, { name: string; buffer: AudioBuffer }>();
  for (const [id, s] of Object.entries(samples)) {
    if (!isObj(s) || !Array.isArray(s.channels) || !s.channels.length || s.channels.length > 32) throw new Error(`Sample ${id}: no audio channels`);
    const rate = s.sampleRate;
    if (typeof rate !== "number" || !(rate >= 3000 && rate <= 768000)) throw new Error(`Sample ${id}: bad sample rate`);
    let chans: Float32Array<ArrayBuffer>[];
    try {
      chans = s.channels.map((c) => fromB64(String(c)));
    } catch {
      throw new Error(`Sample ${id}: corrupt audio data`);
    }
    if (!chans[0].length || chans.some((c) => c.length !== chans[0].length)) throw new Error(`Sample ${id}: corrupt audio data`);
    const buffer = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: rate });
    chans.forEach((d, c) => buffer.copyToChannel(d, c));
    out.set(id, { name: typeof s.name === "string" ? s.name : id, buffer });
  }
  return out;
}

function sameAudio(a: AudioBuffer, b: AudioBuffer) {
  if (a.length !== b.length || a.sampleRate !== b.sampleRate || a.numberOfChannels !== b.numberOfChannels) return false;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/** Add decoded samples to the library, reusing an identical sample (same name, folder and audio) when there is one. */
async function addSamples(eng: typeof Engine, decoded: Map<string, { name: string; buffer: AudioBuffer }>, folder?: string) {
  const idMap = new Map<string, string>();
  const library = Object.values(get().samples);
  for (const [oldId, { name, buffer }] of decoded) {
    let existing: string | undefined;
    for (const s of library) {
      if (s.name !== name || s.folder !== folder) continue;
      const b = await eng.ensure(s.id);
      if (b && sameAudio(b, buffer)) {
        existing = s.id;
        break;
      }
    }
    idMap.set(oldId, existing ?? (await eng.addBuffer(name, buffer, folder)));
  }
  return idMap;
}

async function readJson(f: File): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = JSON.parse(await f.text());
  } catch {
    throw new Error("Not a JSON file");
  }
  if (!isObj(data)) throw new Error("Not a Morsel file");
  return data;
}

/** First free kit name: "Name", then "Name (2)", "Name (3)", ... */
async function freeKitName(name: string) {
  const taken = new Set([...(await listKits()), ...STOCK_KITS]);
  let n = name, i = 2;
  while (taken.has(n)) n = `${name} (${i++})`;
  return n;
}

/** Load a kit file onto the selected drum track's pads, add its samples to the library and save it under its name. Returns the name. */
export async function importKit(f: File, eng: typeof Engine) {
  const file = await readJson(f);
  if (!isKitFormat(file.format)) throw new Error("Not a Morsel kit");
  if (typeof file.version === "number" && file.version > PROJECT_VERSION) throw new Error("Made by a newer Morsel");
  if (!Array.isArray(file.pads)) throw new Error("Kit has no pads");
  const decoded = decodeSamples(file.samples);
  const folder = typeof file.folder === "string" ? file.folder : undefined;
  const idMap = await addSamples(eng, decoded, folder);
  const pads = normalizePads((file.pads as unknown[]).map((p) => (isObj(p) ? (p as Partial<Pad>) : {})))
    .map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null }));
  const name = await freeKitName(typeof file.name === "string" && file.name.trim() ? file.name.trim() : f.name.replace(/\..*$/, ""));
  await saveKit(name, pads);
  set({ kits: [...get().kits, name].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })) });
  updateTrack(drumTrack().id, (t) => ({ ...t, pads, kit: name }), true);
  set({ status: `Loaded kit ${name} on ${drumTrack().name}` });
  return name;
}

export async function importProject(f: File, eng: typeof Engine) {
  const file = await readJson(f);
  if (!isProjectFormat(file.format)) throw new Error("Not a Morsel project");
  if (!isObj(file.project)) throw new Error("File has no project");
  if (typeof file.version === "number" && file.version > PROJECT_VERSION) throw new Error("Made by a newer Morsel");
  const decoded = decodeSamples(file.samples);
  const p = normalizeProject(file.project);
  const idMap = await addSamples(eng, decoded);
  p.tracks = p.tracks.map((t) => ({
    ...t,
    pads: t.pads.map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null })),
    keys: t.keys && {
      ...t.keys,
      zones: t.keys.zones.flatMap((z) => (idMap.has(z.sampleId) ? [{ ...z, sampleId: idMap.get(z.sampleId)! }] : [])),
      sample: { ...t.keys.sample, sampleId: t.keys.sample.sampleId ? idMap.get(t.keys.sample.sampleId) ?? null : null },
    },
  }));
  if (get().playing) sequencer.stop();
  cancelKitLoad();
  const drums = p.tracks.find((t) => t.kind === "drum")!.id;
  const keys = p.tracks.find((t) => t.kind === "keys")!.id;
  // A fresh session on the new project: pattern 1, Play mode, nothing held or queued from the old one.
  releaseAll();
  resetSession();
  setHwMode("play");
  set({ project: p, undo: [], selectedTrack: drums, drumTrack: drums, keysTrack: keys, status: `Imported ${p.name}` });
}
