// Project and kit export: a zip with the project (or kit) as JSON and every referenced sample as a 16-bit WAV in
// samples/. Single-file JSON exports from before (samples as base64 16-bit PCM) still import.
import { strFromU8, strToU8, unzip, zip, type Unzipped, type Zippable } from "fflate";
import type { engine as Engine } from "../audio/engine";
import { engine } from "../audio/engine";
import { encodeChannels, sameAudio } from "../audio/pcm";
import { readWav, writeWav } from "../audio/wav";
import { DRUMS_ID, PROJECT_VERSION, defaultProject, drumTrack, get, usedSampleIds, normalizePads, normalizeProject, resetSession, set, updateTrack } from "./store";
import { sequencer } from "../seq/sequencer";
import { cancelKitLoad, factoryPads } from "../actions";
import { releaseAll, setHwMode } from "../modes/controller";
import { listKits, saveKit } from "./persist";
import { ask } from "./confirm";
import { FACTORY_KIT, STOCK_KITS, type Pad, type Project } from "./types";
import { KIT_FORMAT, PROJECT_FORMAT, ZIP_JSON, isKitFormat, isProjectFormat, sampleFileName } from "./fileFormat";

/** A sample in the JSON: its name and its WAV in the zip. */
interface FileSample { name: string; file: string }
interface ProjectFile { format: typeof PROJECT_FORMAT; version: number; project: Project; samples: Record<string, FileSample> }

// On sample kits the fastest deflate level takes off nearly as much as the default (tails and silence, about a third).
const WAV_LEVEL = 1;

function fromB64(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  return Float32Array.from(pcm, (v) => v / 0x7fff);
}

async function encodeSamples(ids: Iterable<string>) {
  const samples: Record<string, FileSample> = {};
  const wavs: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  for (const id of ids) {
    const buf = await engine.ensure(id);
    if (!buf) continue;
    const name = get().samples[id]?.name ?? id;
    const file = sampleFileName(name, taken);
    wavs[file] = writeWav(encodeChannels(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))), buf.sampleRate);
    samples[id] = { name, file };
  }
  return { samples, wavs };
}

async function zipFile(json: object, wavs: Record<string, Uint8Array>): Promise<Blob> {
  const entries: Zippable = { [ZIP_JSON]: strToU8(JSON.stringify(json)) };
  for (const [file, data] of Object.entries(wavs)) entries[file] = [data, { level: WAV_LEVEL }];
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(entries, (err, out) => (err ? reject(err) : resolve(out))));
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export async function exportProject(): Promise<Blob> {
  const project = get().project;
  const { samples, wavs } = await encodeSamples(usedSampleIds(project));
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, project, samples };
  return zipFile(file, wavs);
}

/** A kit file (the format importKit reads) with the pads and their samples. */
export async function exportKit(name: string, pads: Pad[]): Promise<Blob> {
  const { samples, wavs } = await encodeSamples(new Set(pads.flatMap((pad) => (pad.sampleId ? [pad.sampleId] : []))));
  return zipFile({ format: KIT_FORMAT, version: 1, name, pads, samples }, wavs);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A sample's audio from the file: its WAV in the zip, or base64 channels in a JSON export from before. */
function sampleAudio(id: string, s: Record<string, unknown>, wavs: Unzipped): { rate: unknown; chans: Float32Array<ArrayBuffer>[] } {
  if (typeof s.file === "string") {
    const bytes = wavs[s.file];
    if (!bytes) throw new Error(`Sample ${id}: ${s.file} is missing`);
    try {
      const { sampleRate, channels } = readWav(bytes);
      return { rate: sampleRate, chans: channels };
    } catch (err) {
      throw new Error(`Sample ${id}: ${(err as Error).message}`);
    }
  }
  if (!Array.isArray(s.channels)) throw new Error(`Sample ${id}: no audio channels`);
  try {
    return { rate: s.sampleRate, chans: s.channels.map((c) => fromB64(String(c))) };
  } catch {
    throw new Error(`Sample ${id}: corrupt audio data`);
  }
}

/** Decode and check every sample before anything touches the library, so a bad file changes nothing. */
function decodeSamples(samples: unknown, wavs: Unzipped): Map<string, { name: string; buffer: AudioBuffer }> {
  if (!isObj(samples)) throw new Error("Missing samples");
  const out = new Map<string, { name: string; buffer: AudioBuffer }>();
  for (const [id, s] of Object.entries(samples)) {
    if (!isObj(s)) throw new Error(`Sample ${id}: no audio channels`);
    const { rate, chans } = sampleAudio(id, s, wavs);
    if (!chans.length || chans.length > 32) throw new Error(`Sample ${id}: no audio channels`);
    if (typeof rate !== "number" || !(rate >= 3000 && rate <= 768000)) throw new Error(`Sample ${id}: bad sample rate`);
    if (!chans[0].length || chans.some((c) => c.length !== chans[0].length)) throw new Error(`Sample ${id}: corrupt audio data`);
    const buffer = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: rate });
    chans.forEach((d, c) => buffer.copyToChannel(d, c));
    out.set(id, { name: typeof s.name === "string" ? s.name : id, buffer });
  }
  return out;
}

const channels = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
const sameBuffer = (a: AudioBuffer, b: AudioBuffer) => a.sampleRate === b.sampleRate && sameAudio(channels(a), channels(b));

/**
 * Add decoded samples to the library, reusing a sample with the same name and audio when there is one: in `folder`
 * if possible (so a kit's samples stay in its folder), else in any folder. Projects and exported kits carry no folder,
 * so without that a project re-imported, or a kit exported and imported again, would copy every sample.
 */
async function addSamples(eng: typeof Engine, decoded: Map<string, { name: string; buffer: AudioBuffer }>, folder?: string) {
  const idMap = new Map<string, string>();
  const library = Object.values(get().samples);
  for (const [oldId, { name, buffer }] of decoded) {
    let existing: string | undefined;
    const candidates = library.filter((s) => s.name === name).sort((a, b) => Number(b.folder === folder) - Number(a.folder === folder));
    for (const s of candidates) {
      const b = await eng.ensure(s.id);
      if (b && sameBuffer(b, buffer)) {
        existing = s.id;
        break;
      }
    }
    idMap.set(oldId, existing ?? (await eng.addBuffer(name, buffer, folder)));
  }
  return idMap;
}

/** The file's JSON and, for a zip, its WAVs by path. */
async function readFile(f: File): Promise<{ file: Record<string, unknown>; wavs: Unzipped }> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let json = bytes;
  let wavs: Unzipped = {};
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // "PK": a zip. Only the JSON and the samples are unpacked.
    try {
      wavs = await new Promise<Unzipped>((resolve, reject) =>
        unzip(bytes, { filter: (e) => e.name === ZIP_JSON || e.name.startsWith("samples/") }, (err, out) => (err ? reject(err) : resolve(out))));
    } catch {
      throw new Error("Corrupt zip file");
    }
    if (!wavs[ZIP_JSON]) throw new Error("Not a Morsel file");
    json = wavs[ZIP_JSON];
  }
  let data: unknown;
  try {
    data = JSON.parse(strFromU8(json));
  } catch {
    throw new Error("Not a Morsel file");
  }
  if (!isObj(data)) throw new Error("Not a Morsel file");
  return { file: data, wavs };
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
  const { file, wavs } = await readFile(f);
  if (!isKitFormat(file.format)) throw new Error("Not a Morsel kit");
  if (typeof file.version === "number" && file.version > PROJECT_VERSION) throw new Error("Made by a newer Morsel");
  if (!Array.isArray(file.pads)) throw new Error("Kit has no pads");
  const decoded = decodeSamples(file.samples, wavs);
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

/** Swap in another project as a fresh session: pattern 1, Play mode, nothing held or queued from the old one, no undo. */
function openProject(p: Project, status: string) {
  if (get().playing) sequencer.stop();
  cancelKitLoad();
  const drums = p.tracks.find((t) => t.kind === "drum")!.id;
  const keys = p.tracks.find((t) => t.kind === "keys")!.id;
  releaseAll();
  resetSession();
  setHwMode("play");
  set({ project: p, undo: [], redo: [], selectedTrack: drums, drumTrack: drums, keysTrack: keys, status });
}

/** Replace the project with a new one (the Factory kit and an empty Keys track, like a first start), after asking. */
export async function newProject() {
  const { name } = get().project;
  if (!(await ask({
    title: "New project",
    message: `Start a new project? “${name}” is replaced and can't be brought back with Undo, so export it first to keep it.\n\n` +
      "Its samples stay in the library, and saved kits and presets aren't touched.",
    ok: "New project",
    danger: true,
  }))) return;
  const p = defaultProject();
  const pads = await factoryPads();
  p.tracks = p.tracks.map((t) => (t.id === DRUMS_ID ? { ...t, pads, kit: FACTORY_KIT } : t));
  openProject(p, "New project");
}

export async function importProject(f: File, eng: typeof Engine) {
  const { file, wavs } = await readFile(f);
  if (!isProjectFormat(file.format)) throw new Error("Not a Morsel project");
  if (!isObj(file.project)) throw new Error("File has no project");
  if (typeof file.version === "number" && file.version > PROJECT_VERSION) throw new Error("Made by a newer Morsel");
  const decoded = decodeSamples(file.samples, wavs);
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
  openProject(p, `Imported ${p.name}`);
}
