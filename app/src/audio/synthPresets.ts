// Keys synth presets: a factory set plus the user's own (saved in IndexedDB, listed in the store).
import type { SynthParams, Wave } from "../state/types";

export interface SynthPreset {
  name: string;
  params: SynthParams;
  /** Folder in the preset list ("Bass", "Pad"…); the user's own presets are in "Mine". */
  folder: string;
  user?: boolean;
}

export const USER_FOLDER = "Mine";

type Row = [name: string, wave: Wave, wave2: Wave, detune: number, osc2Level: number, cutoff: number, resonance: number,
  envAmount: number, attack: number, decay: number, sustain: number, release: number, volume: number];

// cutoff 0..1 is 20 Hz..20 kHz on a log scale (0.45 ≈ 450 Hz, 0.7 ≈ 2.6 kHz); envAmount opens it by up to 6 octaves.
// Detune is osc 2 in cents: 1200 = an octave up, 700 a fifth, 300 / 400 a minor / major third (chord stabs).
// Names are what projects remember, so keep existing ones when moving presets around.
const BANK: [folder: string, rows: Row[]][] = [
  ["Basic", [
    ["Init", "sawtooth", "square", 7, 0.5, 0.45, 0.2, 0.4, 0.005, 0.3, 0.6, 0.25, 0.6],
    ["Saw", "sawtooth", "sawtooth", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.45],
    ["Square", "square", "square", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.4],
    ["Triangle", "triangle", "triangle", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.65],
    ["Sine", "sine", "sine", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.7],
  ]],
  ["Bass", [
    ["Sub Bass", "sine", "sine", -1200, 0.5, 0.35, 0, 0.1, 0.003, 0.4, 0.9, 0.08, 0.8],
    ["808 Sub", "sine", "triangle", 0, 0.3, 0.4, 0, 0.15, 0.001, 1.6, 0, 0.5, 0.85],
    ["Acid Bass", "sawtooth", "square", 0, 0, 0.3, 0.85, 0.7, 0.002, 0.18, 0.1, 0.08, 0.6],
    ["Acid Squelch", "square", "sawtooth", 0, 0, 0.25, 0.95, 0.85, 0.002, 0.25, 0.05, 0.1, 0.5],
    ["Reese", "sawtooth", "sawtooth", 18, 1, 0.4, 0.25, 0.1, 0.01, 0.5, 0.9, 0.2, 0.55],
    ["Dark Reese", "sawtooth", "sawtooth", 25, 1, 0.3, 0.35, 0.05, 0.02, 0.6, 1, 0.25, 0.6],
    ["Moog Bass", "sawtooth", "square", -1200, 0.6, 0.32, 0.35, 0.45, 0.002, 0.3, 0.4, 0.1, 0.65],
    ["Square Bass", "square", "square", -1200, 0.5, 0.38, 0.15, 0.3, 0.002, 0.25, 0.6, 0.08, 0.55],
    ["Rubber Bass", "triangle", "sine", -1200, 0.6, 0.3, 0.5, 0.5, 0.002, 0.2, 0.3, 0.1, 0.75],
    ["Pluck Bass", "sawtooth", "triangle", -1200, 0.5, 0.28, 0.3, 0.6, 0.001, 0.15, 0, 0.12, 0.7],
    ["Funk Bass", "square", "sawtooth", 5, 0.4, 0.33, 0.55, 0.55, 0.001, 0.12, 0.35, 0.06, 0.6],
    ["House Organ Bass", "sine", "square", 1200, 0.25, 0.4, 0.1, 0.3, 0.002, 0.22, 0.2, 0.06, 0.7],
    ["Fat Saw Bass", "sawtooth", "sawtooth", -1193, 0.9, 0.42, 0.2, 0.35, 0.003, 0.35, 0.7, 0.12, 0.5],
  ]],
  ["Lead", [
    ["Saw Lead", "sawtooth", "sawtooth", 9, 0.8, 0.6, 0.3, 0.3, 0.005, 0.4, 0.8, 0.2, 0.5],
    ["Square Lead", "square", "sine", 1200, 0.4, 0.55, 0.2, 0.25, 0.005, 0.3, 0.8, 0.15, 0.45],
    ["Chiptune", "square", "square", 1200, 0.25, 1, 0, 0, 0.001, 0.1, 0.8, 0.05, 0.35],
    ["Hoover", "sawtooth", "sawtooth", -1210, 1, 0.55, 0.15, 0.3, 0.03, 0.6, 0.85, 0.4, 0.45],
    ["Fifth Lead", "sawtooth", "sawtooth", 700, 0.7, 0.58, 0.25, 0.3, 0.005, 0.4, 0.8, 0.2, 0.45],
    ["Mono Lead", "sawtooth", "square", 3, 0.5, 0.48, 0.45, 0.45, 0.003, 0.3, 0.6, 0.12, 0.5],
    ["Screamer", "sawtooth", "square", 12, 0.6, 0.5, 0.8, 0.5, 0.005, 0.5, 0.7, 0.2, 0.4],
    ["Whistle", "sine", "sine", 1200, 0.15, 0.8, 0, 0, 0.04, 0.3, 0.9, 0.25, 0.6],
    ["Soft Lead", "triangle", "triangle", 6, 0.6, 0.55, 0.1, 0.15, 0.03, 0.5, 0.8, 0.3, 0.6],
    ["Trance Lead", "sawtooth", "sawtooth", 20, 1, 0.62, 0.2, 0.25, 0.005, 0.6, 0.75, 0.35, 0.4],
  ]],
  ["Keys", [
    ["Soft Keys", "triangle", "sine", 1200, 0.25, 0.55, 0.05, 0.2, 0.002, 0.9, 0.3, 0.5, 0.6],
    ["E-Piano", "sine", "triangle", 1200, 0.3, 0.6, 0.05, 0.25, 0.001, 1.2, 0.2, 0.6, 0.7],
    ["Organ", "sine", "square", 1200, 0.3, 0.7, 0, 0, 0.005, 0.1, 1, 0.05, 0.45],
    ["Church Organ", "sine", "sine", 1902, 0.6, 0.75, 0, 0, 0.08, 0.1, 1, 0.6, 0.5],
    ["Jazz Organ", "sine", "triangle", 2400, 0.35, 0.65, 0.05, 0.1, 0.003, 0.15, 0.9, 0.06, 0.5],
    ["Clav", "square", "sawtooth", 0, 0.4, 0.45, 0.4, 0.6, 0.001, 0.25, 0.1, 0.08, 0.5],
    ["House Piano", "triangle", "sawtooth", 1200, 0.3, 0.5, 0.15, 0.45, 0.001, 0.6, 0.15, 0.35, 0.6],
    ["Toy Piano", "triangle", "sine", 2400, 0.4, 0.75, 0.1, 0.3, 0.001, 0.5, 0, 0.4, 0.6],
    ["Lofi Keys", "triangle", "sawtooth", 8, 0.2, 0.35, 0.1, 0.2, 0.004, 1, 0.35, 0.5, 0.7],
  ]],
  ["Pluck", [
    ["Pluck", "sawtooth", "triangle", 5, 0.5, 0.35, 0.3, 0.65, 0.001, 0.2, 0, 0.25, 0.65],
    ["Bell", "sine", "triangle", 1900, 0.5, 0.9, 0.1, 0, 0.001, 1.4, 0, 1.2, 0.55],
    ["Glass Bell", "sine", "sine", 2400, 0.6, 0.85, 0.2, 0.2, 0.001, 1.8, 0, 1.6, 0.5],
    ["Marimba", "sine", "triangle", 2400, 0.25, 0.6, 0, 0.3, 0.001, 0.35, 0, 0.3, 0.75],
    ["Kalimba", "triangle", "sine", 1900, 0.3, 0.55, 0.1, 0.4, 0.001, 0.5, 0, 0.45, 0.7],
    ["Harp", "triangle", "sawtooth", 1200, 0.2, 0.45, 0.1, 0.5, 0.001, 0.9, 0, 0.9, 0.65],
    ["Square Pluck", "square", "square", 1200, 0.3, 0.3, 0.4, 0.7, 0.001, 0.15, 0, 0.2, 0.5],
    ["Arp Pluck", "sawtooth", "sawtooth", 12, 0.8, 0.3, 0.45, 0.6, 0.001, 0.12, 0, 0.15, 0.55],
    ["Chord Pluck", "sawtooth", "sawtooth", 700, 0.7, 0.32, 0.35, 0.6, 0.001, 0.25, 0, 0.3, 0.5],
  ]],
  ["Pad", [
    ["Warm Pad", "sawtooth", "triangle", 10, 0.7, 0.4, 0.1, 0.2, 0.9, 1.2, 0.8, 1.5, 0.45],
    ["Strings", "sawtooth", "sawtooth", 14, 1, 0.55, 0.05, 0.1, 0.4, 0.8, 0.9, 0.9, 0.4],
    ["Slow Strings", "sawtooth", "sawtooth", 9, 1, 0.48, 0.05, 0.15, 1.5, 1.5, 0.9, 2, 0.4],
    ["Choir", "triangle", "sine", 1205, 0.5, 0.5, 0.15, 0.1, 0.6, 1, 0.85, 1.4, 0.55],
    ["Glass Pad", "triangle", "sine", 1907, 0.5, 0.7, 0.2, 0.15, 0.7, 1.5, 0.8, 2, 0.5],
    ["Fifth Pad", "sawtooth", "sawtooth", 702, 0.7, 0.42, 0.15, 0.15, 0.8, 1.2, 0.85, 1.8, 0.4],
    ["Sweep Pad", "sawtooth", "sawtooth", 16, 1, 0.2, 0.5, 0.7, 2, 2, 0.6, 2.5, 0.4],
    ["Dream Pad", "sine", "triangle", 1212, 0.6, 0.55, 0.1, 0.1, 1.2, 1.5, 0.9, 2.8, 0.55],
    ["Dark Pad", "sawtooth", "square", -1195, 0.6, 0.28, 0.3, 0.15, 1, 1.5, 0.9, 2.2, 0.5],
  ]],
  ["Brass", [
    ["Brass", "sawtooth", "sawtooth", 6, 0.7, 0.38, 0.15, 0.55, 0.06, 0.5, 0.7, 0.2, 0.5],
    ["Horn Swell", "sawtooth", "sawtooth", 5, 0.7, 0.3, 0.1, 0.6, 0.35, 1, 0.8, 0.4, 0.5],
    ["Stab", "sawtooth", "square", 7, 0.6, 0.45, 0.5, 0.6, 0.001, 0.25, 0.2, 0.15, 0.55],
    ["Rave Stab", "sawtooth", "sawtooth", 700, 0.8, 0.5, 0.35, 0.5, 0.001, 0.3, 0.15, 0.2, 0.45],
    ["Minor Stab", "sawtooth", "sawtooth", 300, 0.8, 0.45, 0.3, 0.5, 0.001, 0.3, 0.1, 0.2, 0.45],
    ["Major Stab", "sawtooth", "square", 400, 0.7, 0.45, 0.3, 0.5, 0.001, 0.3, 0.1, 0.2, 0.45],
    ["Dub Chord", "sawtooth", "sawtooth", 300, 0.8, 0.35, 0.55, 0.45, 0.001, 0.2, 0, 0.6, 0.45],
  ]],
  ["FX", [
    ["Dark Drone", "sawtooth", "sawtooth", -1205, 0.8, 0.25, 0.4, 0.15, 1.5, 2, 0.9, 2.5, 0.45],
    ["Laser", "square", "sine", 2400, 0.5, 0.15, 0.9, 1, 0.001, 0.2, 0, 0.15, 0.4],
    ["Zap", "sawtooth", "square", -2400, 0.5, 0.1, 0.85, 1, 0.001, 0.08, 0, 0.1, 0.45],
    ["Sci-Fi", "square", "sawtooth", 1100, 0.7, 0.3, 0.75, 0.6, 0.3, 1.5, 0.4, 1.5, 0.35],
    ["Underwater", "triangle", "sawtooth", 50, 0.8, 0.18, 0.7, 0.2, 0.2, 1, 0.8, 1, 0.6],
    ["Metallic", "square", "square", 1100, 1, 0.65, 0.3, 0.2, 0.001, 1, 0.1, 1.2, 0.35],
    ["Riser", "sawtooth", "sawtooth", 30, 1, 0.1, 0.6, 1, 2, 2, 1, 1, 0.4],
  ]],
];

export const FACTORY_PRESETS: SynthPreset[] = BANK.flatMap(([folder, rows]) =>
  rows.map(([name, wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume]) => ({
    name,
    folder,
    params: { wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume },
  })),
);

/** Folder names in list order. */
export const presetFolders = (list: SynthPreset[]) => [...new Set(list.map((p) => p.folder))];

/** Index of the first preset in the next (dir 1) or previous (dir -1) folder; going back first returns to the start of this one. */
export function jumpFolder(list: SynthPreset[], index: number, dir: 1 | -1): number {
  if (!list.length) return 0;
  const i = Math.max(0, Math.min(list.length - 1, index));
  const folder = list[i].folder;
  if (dir > 0) {
    const next = list.findIndex((p, j) => j > i && p.folder !== folder);
    return next < 0 ? i : next;
  }
  let start = i;
  while (start > 0 && list[start - 1].folder === folder) start--;
  if (start < i || start === 0) return start;
  const prev = list[start - 1].folder;
  start--;
  while (start > 0 && list[start - 1].folder === prev) start--;
  return start;
}

/** True when the synth no longer matches the preset it was loaded from. */
export function presetEdited(synth: SynthParams, preset: SynthPreset | undefined) {
  if (!preset) return true;
  return (Object.keys(preset.params) as (keyof SynthParams)[]).some((k) => {
    const a = synth[k], b = preset.params[k];
    return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 1e-6 : a !== b;
  });
}
