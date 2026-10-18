import { del, get as idbGet, keys, set as idbSet } from "idb-keyval";
import type { Pad, Project, SampleInfo, SynthParams } from "./types";
import { defaultKeys, normalizePads } from "./store";

export interface StoredSample {
  name: string;
  folder?: string;
  sampleRate: number;
  channels: Float32Array[];
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
  const out = await Promise.all(names.map(async (name) => ({ name, params: await idbGet<Partial<SynthParams>>(`synthPreset:${name}`) })));
  // Fill in any fields a preset saved by an older version lacks.
  return out
    .flatMap((p) => (p.params && typeof p.params === "object" ? [{ name: p.name, params: { ...defaultKeys().synth, ...p.params } }] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type SampleIndex = Record<string, SampleInfo>;
