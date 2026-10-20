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

/** Sound shaping on top of a row (see SynthParams); left out = off, so a row alone is the plain 2-oscillator synth. */
interface Shape { sub?: number; noise?: number; drive?: number; slope?: 12 | 24; kt?: number; vf?: number; fd?: number }

type Row = [name: string, wave: Wave, wave2: Wave, detune: number, osc2Level: number, cutoff: number, resonance: number,
  envAmount: number, attack: number, decay: number, sustain: number, release: number, volume: number, shape?: Shape];

// cutoff 0..1 is 20 Hz..20 kHz on a log scale (0.3 ≈ 160 Hz, 0.45 ≈ 450 Hz, 0.6 ≈ 1.3 kHz, 0.7 ≈ 2.6 kHz);
// envAmount opens it by up to 6 octaves. Detune is osc 2 in cents: 1200 = an octave up, 700 a fifth,
// 300 / 400 a minor / major third (chord stabs). Shape: kt = key tracking, vf = velocity to filter,
// fd = the filter's own decay (it closes fully, so plucks stay plucky while the amp sustains).
// Names are what projects remember, so keep existing ones when moving presets around.
const BANK: [folder: string, rows: Row[]][] = [
  ["Basic", [
    ["Init", "sawtooth", "square", 7, 0.5, 0.45, 0.2, 0.4, 0.005, 0.3, 0.6, 0.25, 0.6],
    ["Saw", "sawtooth", "sawtooth", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.64],
    ["Square", "square", "square", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.37],
    ["Triangle", "triangle", "triangle", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.54],
    ["Sine", "sine", "sine", 0, 0, 1, 0, 0, 0.003, 0.3, 1, 0.1, 0.44],
  ]],
  ["Bass", [
    ["Sub Bass", "sine", "triangle", 0, 0.15, 0.5, 0, 0, 0.003, 0.5, 1, 0.08, 0.36, { drive: 0.15 }],
    ["808 Sub", "sine", "sine", 0, 0, 0.5, 0, 0, 0.001, 1.6, 0, 0.4, 0.45, { drive: 0.35 }],
    ["Acid Bass", "sawtooth", "square", 0, 0, 0.27, 0.8, 0.65, 0.002, 0.3, 0.7, 0.08, 0.47, { slope: 24, fd: 0.22, vf: 0.5, drive: 0.3 }],
    ["Acid Squelch", "square", "sawtooth", 0, 0, 0.22, 0.92, 0.85, 0.002, 0.3, 0.6, 0.1, 0.45, { fd: 0.3, vf: 0.7, drive: 0.45 }],
    ["Reese", "sawtooth", "sawtooth", 14, 1, 0.42, 0.2, 0.1, 0.01, 0.5, 1, 0.2, 0.36, { slope: 24, sub: 0.5, drive: 0.25, kt: 0.2 }],
    ["Dark Reese", "sawtooth", "sawtooth", 22, 1, 0.33, 0.3, 0.05, 0.02, 0.6, 1, 0.25, 0.35, { slope: 24, sub: 0.6, drive: 0.35 }],
    ["Moog Bass", "sawtooth", "square", -1200, 0.6, 0.3, 0.35, 0.5, 0.002, 0.3, 0.8, 0.1, 0.44, { slope: 24, fd: 0.35, vf: 0.4, drive: 0.2, sub: 0.3 }],
    ["Square Bass", "square", "square", -1200, 0.5, 0.36, 0.15, 0.35, 0.002, 0.25, 0.8, 0.08, 0.34, { slope: 24, fd: 0.3, sub: 0.3 }],
    ["Rubber Bass", "triangle", "sine", -1200, 0.6, 0.3, 0.45, 0.5, 0.002, 0.3, 0.6, 0.1, 0.56, { fd: 0.18, vf: 0.5 }],
    ["Pluck Bass", "sawtooth", "triangle", -1200, 0.5, 0.26, 0.3, 0.6, 0.001, 0.4, 0, 0.12, 0.8, { slope: 24, fd: 0.15, sub: 0.4 }],
    ["Funk Bass", "square", "sawtooth", 5, 0.4, 0.3, 0.55, 0.55, 0.001, 0.3, 0.6, 0.06, 0.34, { slope: 24, fd: 0.12, vf: 0.7 }],
    ["House Organ Bass", "sine", "square", 1200, 0.25, 0.4, 0.1, 0.3, 0.002, 0.25, 0.3, 0.06, 0.78, { sub: 0.3, fd: 0.1 }],
    ["Fat Saw Bass", "sawtooth", "sawtooth", -1193, 0.9, 0.4, 0.2, 0.35, 0.003, 0.35, 0.9, 0.12, 0.38, { slope: 24, sub: 0.5, drive: 0.3, fd: 0.4 }],
    ["Deep House Bass", "triangle", "square", 0, 0.3, 0.32, 0.25, 0.4, 0.002, 0.3, 0.5, 0.1, 0.51, { slope: 24, sub: 0.5, fd: 0.2, vf: 0.4 }],
  ]],
  ["Lead", [
    ["Saw Lead", "sawtooth", "sawtooth", 9, 0.8, 0.6, 0.3, 0.3, 0.005, 0.4, 0.8, 0.2, 0.46, { kt: 0.5, vf: 0.4, drive: 0.15 }],
    ["Square Lead", "square", "sine", 1200, 0.4, 0.55, 0.2, 0.25, 0.005, 0.3, 0.8, 0.15, 0.39, { kt: 0.5 }],
    ["Chiptune", "square", "square", 1200, 0.25, 1, 0, 0, 0.001, 0.1, 0.8, 0.05, 0.44],
    ["Hoover", "sawtooth", "sawtooth", -1210, 1, 0.55, 0.15, 0.3, 0.03, 0.6, 0.85, 0.4, 0.39, { slope: 24, sub: 0.4, drive: 0.3 }],
    ["Fifth Lead", "sawtooth", "sawtooth", 700, 0.7, 0.58, 0.25, 0.3, 0.005, 0.4, 0.8, 0.2, 0.59, { kt: 0.4 }],
    ["Mono Lead", "sawtooth", "square", 3, 0.5, 0.45, 0.45, 0.5, 0.003, 0.3, 0.75, 0.12, 0.41, { slope: 24, fd: 0.5, vf: 0.5, kt: 0.5, drive: 0.2 }],
    ["Screamer", "sawtooth", "square", 12, 0.6, 0.5, 0.75, 0.5, 0.005, 0.5, 0.7, 0.2, 0.41, { drive: 0.6, kt: 0.4 }],
    ["Whistle", "sine", "sine", 1200, 0.12, 0.8, 0, 0, 0.04, 0.3, 0.9, 0.25, 0.47, { noise: 0.05, kt: 0.5 }],
    ["Soft Lead", "triangle", "triangle", 6, 0.6, 0.55, 0.1, 0.15, 0.03, 0.5, 0.8, 0.3, 0.42, { kt: 0.3, vf: 0.3 }],
    ["Trance Lead", "sawtooth", "sawtooth", 20, 1, 0.62, 0.2, 0.25, 0.005, 0.6, 0.75, 0.35, 0.51, { kt: 0.4, vf: 0.3 }],
  ]],
  ["Keys", [
    ["Soft Keys", "triangle", "sine", 1200, 0.25, 0.55, 0.05, 0.25, 0.002, 1.2, 0.3, 0.5, 0.64, { vf: 0.6, kt: 0.4, fd: 0.8 }],
    ["E-Piano", "sine", "triangle", 1200, 0.25, 0.55, 0.05, 0.35, 0.001, 1.5, 0.15, 0.5, 0.54, { vf: 0.8, fd: 0.5, kt: 0.4 }],
    ["Organ", "sine", "square", 1200, 0.3, 0.7, 0, 0, 0.005, 0.1, 1, 0.05, 0.4, { sub: 0.4 }],
    ["Church Organ", "sine", "sine", 1902, 0.6, 0.75, 0, 0, 0.08, 0.1, 1, 0.6, 0.36, { sub: 0.5 }],
    ["Jazz Organ", "sine", "triangle", 2400, 0.35, 0.6, 0.05, 0.3, 0.003, 0.15, 0.9, 0.06, 0.39, { sub: 0.4, drive: 0.2, fd: 0.15 }],
    ["Clav", "square", "sawtooth", 0, 0.4, 0.45, 0.4, 0.6, 0.001, 0.4, 0.15, 0.08, 0.5, { fd: 0.12, vf: 0.7, kt: 0.6 }],
    ["House Piano", "triangle", "sawtooth", 1200, 0.3, 0.5, 0.15, 0.45, 0.001, 0.8, 0.15, 0.35, 0.75, { fd: 0.4, vf: 0.6, kt: 0.5 }],
    ["Toy Piano", "triangle", "sine", 2400, 0.4, 0.75, 0.1, 0.3, 0.001, 0.5, 0, 0.4, 0.8, { fd: 0.2 }],
    ["Lofi Keys", "triangle", "sawtooth", 8, 0.2, 0.35, 0.1, 0.25, 0.004, 1, 0.35, 0.5, 0.45, { drive: 0.2, noise: 0.03, vf: 0.5, fd: 0.6 }],
  ]],
  ["Pluck", [
    ["Pluck", "sawtooth", "triangle", 5, 0.5, 0.3, 0.3, 0.7, 0.001, 0.35, 0, 0.25, 0.8, { fd: 0.15, vf: 0.6, kt: 0.5 }],
    ["Bell", "sine", "triangle", 1900, 0.5, 0.9, 0.1, 0, 0.001, 1.4, 0, 1.2, 0.55, { kt: 0.2 }],
    ["Glass Bell", "sine", "sine", 2400, 0.6, 0.85, 0.2, 0.2, 0.001, 1.8, 0, 1.6, 0.48, { vf: 0.4 }],
    ["Marimba", "sine", "triangle", 2400, 0.25, 0.6, 0, 0.3, 0.001, 0.4, 0, 0.3, 0.8, { fd: 0.08, kt: 0.5 }],
    ["Kalimba", "triangle", "sine", 1900, 0.3, 0.55, 0.1, 0.4, 0.001, 0.6, 0, 0.45, 0.8, { fd: 0.1, kt: 0.4 }],
    ["Harp", "triangle", "sawtooth", 1200, 0.2, 0.45, 0.1, 0.5, 0.001, 1, 0, 0.9, 0.76, { fd: 0.3, kt: 0.5 }],
    ["Square Pluck", "square", "square", 1200, 0.3, 0.3, 0.4, 0.7, 0.001, 0.25, 0, 0.2, 0.79, { fd: 0.12, kt: 0.4 }],
    ["Arp Pluck", "sawtooth", "sawtooth", 12, 0.8, 0.3, 0.45, 0.6, 0.001, 0.2, 0, 0.15, 0.79, { slope: 24, fd: 0.1, vf: 0.5, kt: 0.5 }],
    ["Chord Pluck", "sawtooth", "sawtooth", 700, 0.7, 0.32, 0.35, 0.6, 0.001, 0.35, 0, 0.3, 0.8, { fd: 0.2, kt: 0.4 }],
  ]],
  ["Pad", [
    ["Warm Pad", "sawtooth", "triangle", 10, 0.7, 0.4, 0.1, 0.2, 0.9, 1.2, 0.8, 1.5, 0.39, { slope: 24, kt: 0.3 }],
    ["Strings", "sawtooth", "sawtooth", 14, 1, 0.55, 0.05, 0.1, 0.4, 0.8, 0.9, 0.9, 0.41, { kt: 0.4 }],
    ["Slow Strings", "sawtooth", "sawtooth", 9, 1, 0.48, 0.05, 0.15, 1.5, 1.5, 0.9, 2, 0.37, { kt: 0.4 }],
    ["Choir", "triangle", "sine", 1205, 0.5, 0.5, 0.15, 0.1, 0.6, 1, 0.85, 1.4, 0.43, { noise: 0.08, kt: 0.3 }],
    ["Glass Pad", "triangle", "sine", 1907, 0.5, 0.7, 0.2, 0.15, 0.7, 1.5, 0.8, 2, 0.48, { noise: 0.03 }],
    ["Fifth Pad", "sawtooth", "sawtooth", 702, 0.7, 0.42, 0.15, 0.15, 0.8, 1.2, 0.85, 1.8, 0.47, { slope: 24, kt: 0.3 }],
    ["Sweep Pad", "sawtooth", "sawtooth", 16, 1, 0.2, 0.5, 0.7, 2, 2, 0.6, 2.5, 0.37, { slope: 24 }],
    ["Dream Pad", "sine", "triangle", 1212, 0.6, 0.55, 0.1, 0.1, 1.2, 1.5, 0.9, 2.8, 0.39, { noise: 0.04 }],
    ["Dark Pad", "sawtooth", "square", -1195, 0.6, 0.28, 0.3, 0.15, 1, 1.5, 0.9, 2.2, 0.36, { slope: 24, sub: 0.3 }],
    ["Air Pad", "triangle", "sawtooth", 7, 0.3, 0.6, 0.2, 0.1, 1.2, 1.5, 0.85, 2.5, 0.51, { noise: 0.15, kt: 0.3 }],
  ]],
  ["Brass", [
    ["Brass", "sawtooth", "sawtooth", 6, 0.7, 0.38, 0.15, 0.55, 0.06, 0.5, 0.7, 0.2, 0.55, { vf: 0.6, kt: 0.4 }],
    ["Horn Swell", "sawtooth", "sawtooth", 5, 0.7, 0.3, 0.1, 0.6, 0.35, 1, 0.8, 0.4, 0.48, { vf: 0.4, kt: 0.4 }],
    ["Stab", "sawtooth", "square", 7, 0.6, 0.45, 0.5, 0.6, 0.001, 0.3, 0.2, 0.15, 0.66, { fd: 0.2 }],
    ["Rave Stab", "sawtooth", "sawtooth", 700, 0.8, 0.5, 0.35, 0.5, 0.001, 0.3, 0.15, 0.2, 0.8, { drive: 0.3, fd: 0.25 }],
    ["Minor Stab", "sawtooth", "sawtooth", 300, 0.8, 0.45, 0.3, 0.5, 0.001, 0.3, 0.1, 0.2, 0.8, { fd: 0.25 }],
    ["Major Stab", "sawtooth", "square", 400, 0.7, 0.45, 0.3, 0.5, 0.001, 0.3, 0.1, 0.2, 0.8, { fd: 0.25 }],
    ["Dub Chord", "sawtooth", "sawtooth", 300, 0.8, 0.35, 0.55, 0.45, 0.001, 0.3, 0, 0.6, 0.8, { slope: 24, fd: 0.2 }],
  ]],
  ["FX", [
    ["Dark Drone", "sawtooth", "sawtooth", -1205, 0.8, 0.25, 0.4, 0.15, 1.5, 2, 0.9, 2.5, 0.45, { slope: 24, sub: 0.3, noise: 0.05 }],
    ["Laser", "square", "sine", 2400, 0.5, 0.15, 0.9, 1, 0.001, 0.2, 0, 0.15, 0.4],
    ["Zap", "sawtooth", "square", -2400, 0.5, 0.1, 0.85, 1, 0.001, 0.08, 0, 0.1, 0.45],
    ["Sci-Fi", "square", "sawtooth", 1100, 0.7, 0.3, 0.75, 0.6, 0.3, 1.5, 0.4, 1.5, 0.31],
    ["Underwater", "triangle", "sawtooth", 50, 0.8, 0.18, 0.7, 0.2, 0.2, 1, 0.8, 1, 0.6],
    ["Metallic", "square", "square", 1100, 1, 0.65, 0.3, 0.2, 0.001, 1, 0.1, 1.2, 0.35],
    ["Riser", "sawtooth", "sawtooth", 30, 1, 0.1, 0.6, 1, 2, 2, 1, 1, 0.4, { noise: 0.3 }],
  ]],
];

export const FACTORY_PRESETS: SynthPreset[] = BANK.flatMap(([folder, rows]) =>
  rows.map(([name, wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume, x = {}]) => ({
    name,
    folder,
    params: {
      wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume,
      sub: x.sub ?? 0, noise: x.noise ?? 0, drive: x.drive ?? 0, slope: x.slope ?? 12,
      keyTrack: x.kt ?? 0, velFilter: x.vf ?? 0, filterDecay: x.fd ?? 0,
    },
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
