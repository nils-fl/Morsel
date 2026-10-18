// Keys synth presets: a factory set plus the user's own (saved in IndexedDB, listed in the store).
import type { SynthParams, Wave } from "../state/types";

export interface SynthPreset {
  name: string;
  params: SynthParams;
  user?: boolean;
}

type Row = [name: string, wave: Wave, wave2: Wave, detune: number, osc2Level: number, cutoff: number, resonance: number,
  envAmount: number, attack: number, decay: number, sustain: number, release: number, volume: number];

// cutoff 0..1 is 20 Hz..20 kHz on a log scale (0.45 ≈ 450 Hz, 0.7 ≈ 2.6 kHz); envAmount opens it by up to 6 octaves.
const ROWS: Row[] = [
  ["Init", "sawtooth", "square", 7, 0.5, 0.45, 0.2, 0.4, 0.005, 0.3, 0.6, 0.25, 0.6],
  ["Sub Bass", "sine", "sine", -1200, 0.5, 0.35, 0, 0.1, 0.003, 0.4, 0.9, 0.08, 0.8],
  ["Acid Bass", "sawtooth", "square", 0, 0, 0.3, 0.85, 0.7, 0.002, 0.18, 0.1, 0.08, 0.6],
  ["Reese", "sawtooth", "sawtooth", 18, 1, 0.4, 0.25, 0.1, 0.01, 0.5, 0.9, 0.2, 0.55],
  ["Pluck", "sawtooth", "triangle", 5, 0.5, 0.35, 0.3, 0.65, 0.001, 0.2, 0, 0.25, 0.65],
  ["Saw Lead", "sawtooth", "sawtooth", 9, 0.8, 0.6, 0.3, 0.3, 0.005, 0.4, 0.8, 0.2, 0.5],
  ["Square Lead", "square", "sine", 1200, 0.4, 0.55, 0.2, 0.25, 0.005, 0.3, 0.8, 0.15, 0.45],
  ["Brass", "sawtooth", "sawtooth", 6, 0.7, 0.38, 0.15, 0.55, 0.06, 0.5, 0.7, 0.2, 0.5],
  ["Stab", "sawtooth", "square", 7, 0.6, 0.45, 0.5, 0.6, 0.001, 0.25, 0.2, 0.15, 0.55],
  ["Soft Keys", "triangle", "sine", 1200, 0.25, 0.55, 0.05, 0.2, 0.002, 0.9, 0.3, 0.5, 0.6],
  ["Organ", "sine", "square", 1200, 0.3, 0.7, 0, 0, 0.005, 0.1, 1, 0.05, 0.45],
  ["Bell", "sine", "triangle", 1900, 0.5, 0.9, 0.1, 0, 0.001, 1.4, 0, 1.2, 0.55],
  ["Chiptune", "square", "square", 1200, 0.25, 1, 0, 0, 0.001, 0.1, 0.8, 0.05, 0.35],
  ["Warm Pad", "sawtooth", "triangle", 10, 0.7, 0.4, 0.1, 0.2, 0.9, 1.2, 0.8, 1.5, 0.45],
  ["Strings", "sawtooth", "sawtooth", 14, 1, 0.55, 0.05, 0.1, 0.4, 0.8, 0.9, 0.9, 0.4],
  ["Dark Drone", "sawtooth", "sawtooth", -1205, 0.8, 0.25, 0.4, 0.15, 1.5, 2, 0.9, 2.5, 0.45],
];

export const FACTORY_PRESETS: SynthPreset[] = ROWS.map(([name, wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume]) => ({
  name,
  params: { wave, wave2, detune, osc2Level, cutoff, resonance, envAmount, attack, decay, sustain, release, volume },
}));

/** True when the synth no longer matches the preset it was loaded from. */
export function presetEdited(synth: SynthParams, preset: SynthPreset | undefined) {
  if (!preset) return true;
  return (Object.keys(preset.params) as (keyof SynthParams)[]).some((k) => {
    const a = synth[k], b = preset.params[k];
    return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 1e-6 : a !== b;
  });
}
