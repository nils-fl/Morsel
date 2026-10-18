export const PAD_COUNT = 16;
export const KEYS_TRACK = 16;
export const TRACK_COUNT = 17;
export const PATTERN_COUNT = 16;

export interface Pad {
  name: string;
  sampleId: string | null;
  color: number; // Launchkey palette index
  start: number; // 0..1
  end: number; // 0..1
  pitch: number; // semitones
  attack: number; // seconds
  decay: number; // seconds (release after gate / tail length for one-shot)
  cutoff: number; // 0..1 (lowpass, 1 = open)
  hpCutoff: number; // 0..1 (highpass, 0 = off)
  resonance: number; // 0..1, shared by both filters
  pan: number; // -1..1
  volume: number; // 0..1
  mode: "oneshot" | "gate";
  choke: number; // 0 = none, 1..4 = group
  reverse: boolean;
}

export type Wave = "sawtooth" | "square" | "sine" | "triangle";

export interface SynthParams {
  wave: Wave;
  wave2: Wave;
  detune: number; // cents for osc 2
  osc2Level: number;
  cutoff: number; // 0..1
  resonance: number; // 0..1
  envAmount: number; // 0..1
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  volume: number;
}

export interface Zone {
  sampleId: string;
  root: number; // MIDI note
}

export interface KeysInstrument {
  type: "synth" | "chromatic" | "multi";
  sourcePad: number;
  zones: Zone[];
  multiName: string;
  synth: SynthParams;
  volume: number;
}

export interface NoteEvent {
  id: string;
  tick: number;
  track: number; // 0..15 pads, 16 keys
  note: number;
  vel: number; // 1..127
  len: number; // ticks
}

export interface Pattern {
  bars: number;
  events: NoteEvent[];
}

export interface SongStep {
  pattern: number;
  repeats: number;
}

export interface Project {
  name: string;
  bpm: number;
  swing: number; // 50..75 (%)
  pads: Pad[];
  keys: KeysInstrument;
  patterns: Pattern[];
  song: SongStep[];
  mutes: boolean[];
  solos: boolean[];
  levels: number[]; // per track 0..1
}

export type HwMode = "play" | "step" | "mixer" | "pattern" | "browse" | "chop";

export const TABS = ["Pads", "Chop", "Sequencer", "Keys", "Song", "Help", "Lab"] as const;
export type Tab = (typeof TABS)[number];

export type SampleSource = "input" | "master" | "tab";

/** Chop editor session, shared by the Chop tab and the Launchkey (encoders, pads, screen). */
export interface ChopSession {
  sampleId: string;
  /** Sorted slice boundaries (N + 1 markers = N slices); the first and last bound the region. */
  markers: number[];
  /** Visible window, fractions 0..1 of the sample. */
  view: [number, number];
  /** Selected marker index, or null. */
  sel: number | null;
  /** Pad the first slice is sent to. */
  firstPad: number;
}

export interface SampleInfo {
  id: string;
  name: string;
  /** Virtual folder, e.g. "Drums/Kicks" ("" or missing = top level). */
  folder?: string;
}
