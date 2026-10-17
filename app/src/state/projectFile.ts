// Single-file project export: project JSON plus all referenced samples (16-bit PCM, base64).
import type { engine as Engine } from "../audio/engine";
import { engine } from "../audio/engine";
import { defaultProject, get, normalizePads, set, updateProject } from "./store";
import { sequencer } from "../seq/sequencer";
import { listKits, saveKit } from "./persist";
import type { Pad, Project } from "./types";

interface FileSample { name: string; sampleRate: number; channels: string[] }
interface ProjectFile { format: "launchkit"; version: 1; project: Project; samples: Record<string, FileSample> }

function usedSampleIds(p: Project) {
  const ids = new Set<string>();
  p.pads.forEach((pad) => pad.sampleId && ids.add(pad.sampleId));
  p.keys.zones.forEach((z) => ids.add(z.sampleId));
  return ids;
}

function toB64(data: Float32Array) {
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i])) * 0x7fff;
  const bytes = new Uint8Array(pcm.buffer);
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

export async function exportProject(): Promise<Blob> {
  const s = get();
  const samples: Record<string, FileSample> = {};
  for (const id of usedSampleIds(s.project)) {
    const buf = engine.buffer(id);
    if (!buf) continue;
    samples[id] = {
      name: s.samples[id]?.name ?? id,
      sampleRate: buf.sampleRate,
      channels: Array.from({ length: buf.numberOfChannels }, (_, c) => toB64(buf.getChannelData(c))),
    };
  }
  const file: ProjectFile = { format: "launchkit", version: 1, project: s.project, samples };
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
    const existing = library.find((s) => {
      const b = eng.buffer(s.id);
      return s.name === name && s.folder === folder && !!b && sameAudio(b, buffer);
    });
    idMap.set(oldId, existing ? existing.id : await eng.addBuffer(name, buffer, folder));
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
  if (!isObj(data)) throw new Error("Not a LaunchKit file");
  return data;
}

/** First free kit name: "Name", then "Name (2)", "Name (3)", ... */
async function freeKitName(name: string) {
  const taken = new Set(await listKits());
  let n = name, i = 2;
  while (taken.has(n)) n = `${name} (${i++})`;
  return n;
}

/** Load a kit file onto the pads, add its samples to the library and save it under its name. Returns the name. */
export async function importKit(f: File, eng: typeof Engine) {
  const file = await readJson(f);
  if (file.format !== "launchkit-kit") throw new Error("Not a LaunchKit kit");
  if (!Array.isArray(file.pads)) throw new Error("Kit has no pads");
  const decoded = decodeSamples(file.samples);
  const folder = typeof file.folder === "string" ? file.folder : undefined;
  const idMap = await addSamples(eng, decoded, folder);
  const pads = normalizePads((file.pads as unknown[]).map((p) => (isObj(p) ? (p as Partial<Pad>) : {})))
    .map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null }));
  const name = await freeKitName(typeof file.name === "string" && file.name.trim() ? file.name.trim() : f.name.replace(/\..*$/, ""));
  await saveKit(name, pads);
  updateProject((p) => ({ ...p, pads }));
  set({ status: `Loaded kit ${name}` });
  return name;
}

export async function importProject(f: File, eng: typeof Engine) {
  const file = await readJson(f);
  if (file.format !== "launchkit") throw new Error("Not a LaunchKit project");
  if (!isObj(file.project)) throw new Error("File has no project");
  const decoded = decodeSamples(file.samples);
  const p = { ...defaultProject(), ...(file.project as Partial<Project>) };
  if (!Array.isArray(p.pads) || !Array.isArray(p.patterns) || !isObj(p.keys) || !Array.isArray(p.keys.zones)) throw new Error("Project is damaged");
  const idMap = await addSamples(eng, decoded);
  p.pads = normalizePads(p.pads).map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null }));
  p.keys = { ...p.keys, zones: p.keys.zones.flatMap((z) => (idMap.has(z.sampleId) ? [{ ...z, sampleId: idMap.get(z.sampleId)! }] : [])) };
  if (get().playing) sequencer.stop();
  set({ project: p, undo: [], status: `Imported ${p.name}` });
}
