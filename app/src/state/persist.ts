import { del, get as idbGet, keys, set as idbSet } from "idb-keyval";
import type { Project, SampleInfo } from "./types";
import { normalizePads } from "./store";

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
export async function saveKit(name: string, pads: Project["pads"]) {
  await idbSet(`kit:${name}`, pads);
}

export async function loadKit(name: string): Promise<Project["pads"] | undefined> {
  const pads = await idbGet<Project["pads"]>(`kit:${name}`);
  return pads && normalizePads(pads);
}

export async function listKits(): Promise<string[]> {
  return (await keys()).map(String).filter((k) => k.startsWith("kit:")).map((k) => k.slice(4));
}

export type SampleIndex = Record<string, SampleInfo>;
