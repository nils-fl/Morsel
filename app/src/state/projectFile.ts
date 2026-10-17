// Single-file project export: project JSON plus all referenced samples (16-bit PCM, base64).
import type { engine as Engine } from "../audio/engine";
import { engine } from "../audio/engine";
import { defaultProject, get, normalizePads, set, updateProject } from "./store";
import { saveKit } from "./persist";
import type { Pad, Project } from "./types";

interface FileSample { name: string; sampleRate: number; channels: string[] }
interface ProjectFile { format: "launchkit"; version: 1; project: Project; samples: Record<string, FileSample> }
/** A kit on its own: 16 pads plus their samples (same sample encoding as a project). */
interface KitFile { format: "launchkit-kit"; version: 1; name: string; folder?: string; pads: Partial<Pad>[]; samples: Record<string, FileSample> }

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

async function addSamples(eng: typeof Engine, samples: Record<string, FileSample>, folder?: string) {
  const idMap = new Map<string, string>();
  for (const [oldId, s] of Object.entries(samples)) {
    const chans = s.channels.map(fromB64);
    const buf = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: s.sampleRate });
    chans.forEach((d, c) => buf.copyToChannel(d, c));
    idMap.set(oldId, await eng.addBuffer(s.name, buf, folder));
  }
  return idMap;
}

/** Load a kit file onto the pads, add its samples to the library and save it under its name. Returns the name. */
export async function importKit(f: File, eng: typeof Engine) {
  const file = JSON.parse(await f.text()) as KitFile;
  if (file.format !== "launchkit-kit") throw new Error("Not a LaunchKit kit");
  const idMap = await addSamples(eng, file.samples, file.folder);
  const pads = normalizePads(file.pads).map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null }));
  await saveKit(file.name, pads);
  updateProject((p) => ({ ...p, pads }));
  set({ status: `Loaded kit ${file.name}` });
  return file.name;
}

export async function importProject(f: File, eng: typeof Engine) {
  const file = JSON.parse(await f.text()) as ProjectFile;
  if (file.format !== "launchkit") throw new Error("Not a LaunchKit project");
  const idMap = await addSamples(eng, file.samples);
  const p = { ...defaultProject(), ...file.project };
  p.pads = normalizePads(p.pads).map((pad) => ({ ...pad, sampleId: pad.sampleId ? idMap.get(pad.sampleId) ?? null : null }));
  p.keys = { ...p.keys, zones: p.keys.zones.flatMap((z) => (idMap.has(z.sampleId) ? [{ ...z, sampleId: idMap.get(z.sampleId)! }] : [])) };
  set({ project: p, undo: [], status: `Imported ${p.name}` });
}
