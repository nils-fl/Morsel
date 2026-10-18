import { del, delMany, get as idbGet, keys, set as idbSet } from "idb-keyval";
import type { Pad, Project, SampleInfo, SynthParams } from "./types";
import { normalizePads, normalizeSynth } from "./store";

export interface StoredSample {
  name: string;
  folder?: string;
  src?: string;
  sampleRate: number;
  /** 16-bit (audio/pcm.ts); 32-bit float in samples stored before that. */
  channels: (Int16Array | Float32Array)[];
}

const PROJECT_KEY = "project:current";

export async function saveProject(p: Project) {
  await idbSet(PROJECT_KEY, p);
}

export async function loadProject(): Promise<Project | undefined> {
  return idbGet(PROJECT_KEY);
}

export async function saveSample(id: string, s: StoredSample) {
  await idbSet(`sample:${id}`, s);
}

export async function loadSample(id: string): Promise<StoredSample | undefined> {
  return idbGet(`sample:${id}`);
}

export async function deleteSample(id: string) {
  await del(`sample:${id}`);
}

export async function deleteSamples(ids: string[]) {
  await delMany(ids.map((id) => `sample:${id}`));
}

// Names and folders of every sample, so startup lists the library without reading its audio.
const INDEX_KEY = "sampleIndex";

export async function saveSampleIndex(samples: Record<string, SampleInfo>) {
  await idbSet(INDEX_KEY, samples);
}

export async function loadSampleIndex(): Promise<Record<string, SampleInfo> | undefined> {
  return idbGet(INDEX_KEY);
}

// Connected folders: the browser keeps the handle, the permission is asked again after a restart.
export interface StoredFolder { name: string; handle: FileSystemDirectoryHandle }

export async function saveFolders(folders: StoredFolder[]) {
  await idbSet("folders", folders);
}

export async function loadFolders(): Promise<StoredFolder[]> {
  return (await idbGet<StoredFolder[]>("folders")) ?? [];
}

export async function listSampleIds(): Promise<string[]> {
  return (await keys()).map(String).filter((k) => k.startsWith("sample:")).map((k) => k.slice(7));
}

// Named kits = pads only; samples stay shared.
export async function saveKit(name: string, pads: Pad[]) {
  await idbSet(`kit:${name}`, pads);
}

export async function loadKit(name: string): Promise<Pad[] | undefined> {
  const pads = await idbGet<Pad[]>(`kit:${name}`);
  return pads && normalizePads(pads);
}

/** Save a kit's pads under a new name and drop the old one. False when there is no such kit. */
export async function renameKit(from: string, to: string) {
  const pads = await idbGet<Pad[]>(`kit:${from}`);
  if (!pads) return false;
  await idbSet(`kit:${to}`, pads);
  await del(`kit:${from}`);
  return true;
}

export async function deleteKit(name: string) {
  await del(`kit:${name}`);
}

export async function listKits(): Promise<string[]> {
  return (await keys()).map(String).filter((k) => k.startsWith("kit:")).map((k) => k.slice(4));
}

// User synth presets for the Keys instrument.
export async function saveSynthPreset(name: string, params: SynthParams) {
  await idbSet(`synthPreset:${name}`, params);
}

export async function deleteSynthPreset(name: string) {
  await del(`synthPreset:${name}`);
}

export async function loadSynthPresets(): Promise<{ name: string; params: SynthParams }[]> {
  const names = (await keys()).map(String).filter((k) => k.startsWith("synthPreset:")).map((k) => k.slice(12));
  const out = await Promise.all(names.map(async (name) => ({ name, params: await idbGet<unknown>(`synthPreset:${name}`) })));
  // Fill in any fields a preset saved by an older version lacks, and drop damaged values.
  return out
    .flatMap((p) => (p.params && typeof p.params === "object" ? [{ name: p.name, params: normalizeSynth(p.params) }] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
}
