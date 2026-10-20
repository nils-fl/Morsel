export const PAD_COUNT = 16;
export const MAX_TRACKS = 8;
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

/** "sample" mode: one sample of its own, played across the keys from its root note. */
export interface KeysSample {
  sampleId: string | null;
  root: number; // MIDI note that plays the sample at its own pitch
  attack: number; // seconds
  release: number; // seconds
  cutoff: number; // 0..1 lowpass (1 = open)
  resonance: number; // 0..1
}

/** Two LFOs on every note of a keys track (rates in Hz; depth 0 = off). */
export interface KeysLfo {
  vibRate: number; // 0.1..20
  vibDepth: number; // 0..1 = 0..100 cents of vibrato
  filterRate: number; // 0.1..20
  filterDepth: number; // 0..1 = 0..±2 octaves on the filter cutoff
}

export interface KeysInstrument {
  type: "synth" | "chromatic" | "multi" | "sample";
  /** Drum track and pad whose sample "chromatic" plays across the keyboard. */
  sourceTrack: string;
  sourcePad: number;
  zones: Zone[];
  multiName: string;
  /** Name of the synth preset last loaded (the synth may have been edited since). */
  preset: string;
  synth: SynthParams;
  sample: KeysSample;
  lfo: KeysLfo;
  volume: number;
}

export type TrackKind = "drum" | "keys";

/** Insert effects of a track, in signal order. Neutral values leave the sound untouched. */
export interface TrackFx {
  filter: "off" | "lp" | "hp" | "bp";
  cutoff: number; // 0..1
  resonance: number; // 0..1
  eqLow: number; // dB, -15..15
  eqMid: number;
  eqHigh: number;
  drive: number; // 0..1
  comp: number; // 0..1 amount (0 = off)
}

export interface Track {
  id: string;
  name: string;
  color: number; // Launchkey palette index
  kind: TrackKind;
  /** Drum tracks: the 16 pads. Keys tracks: empty. */
  pads: Pad[];
  /** Drum tracks: name of the kit last loaded onto the pads ("" for none, e.g. a chop or a folder). */
  kit: string;
  /** Keys tracks only. */
  keys: KeysInstrument | null;
  /** Mute / solo of the pads inside a drum rack. */
  padMutes: boolean[];
  padSolos: boolean[];
  level: number; // 0..1
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  /** Post-fader sends to the shared reverb (A) and delay (B), 0..1. */
  sendA: number;
  sendB: number;
  fx: TrackFx;
}

/** A note in a clip. On drum tracks `note` is the pad index (0..15). */
export interface NoteEvent {
  id: string;
  tick: number;
  note: number;
  vel: number; // 1..127
  len: number; // ticks
}

export interface Clip {
  events: NoteEvent[];
}

/** A sequence: a length and one clip per track (by track id; a track without one is silent here). */
export interface Pattern {
  bars: number;
  clips: Record<string, Clip>;
}

export interface Returns {
  reverb: { size: number; decay: number; level: number }; // size, decay 0..1; level 0..1
  delay: { time: number; feedback: number; tone: number; level: number }; // time in 16ths (1..16)
}

export interface SongStep {
  pattern: number;
  repeats: number;
}

export interface Project {
  name: string;
  bpm: number;
  swing: number; // 50..75 (%)
  tracks: Track[];
  patterns: Pattern[];
  song: SongStep[];
  duck: DuckSettings;
  returns: Returns;
}

/**
 * Who a duck dips: every pad and track but the source (DUCK_ALL), a whole track (its id),
 * or one pad of a drum track (`${trackId}:${pad}`).
 */
export type DuckTarget = string;

/** Sidechain ducker: hits on the source pad dip the target. */
export interface DuckSettings {
  on: boolean;
  sourceTrack: string; // a drum track
  sourcePad: number; // 0..15
  target: DuckTarget;
  depth: number; // 0..1
  attack: number; // seconds, 0..0.05
  hold: number; // seconds at full depth before recovering, 0..0.5
  release: number; // seconds, 0.02..1
}

export const DUCK_ALL = "all";

export type HwMode = "play" | "step" | "track" | "mute" | "pattern" | "browse" | "chop";

/** "Track" shows the selected track: the drum rack or the keys instrument. */
export const TABS = ["Track", "Chop", "Sequencer", "Mixer", "Song", "Help", "Lab"] as const;
export type Tab = (typeof TABS)[number];

/** The synthesized kit that is always there, listed first among the kits (its samples live in the library folder of the same name). */
export const FACTORY_KIT = "Factory";

/** Built-in synthesized kits (audio/kit.ts), listed before the saved ones; their names can't be used for saved kits.
 *  The genre kits' samples go in "Factory/<kit>" when first loaded. */
export const STOCK_KITS = [FACTORY_KIT, "Lo-Fi", "Boom Bap", "Hip Hop", "Trap", "Drill", "House", "Techno", "DnB", "Electro"];

/** Library folder of a stock kit's samples. */
export const stockFolder = (kit: string) => (kit === FACTORY_KIT ? FACTORY_KIT : `${FACTORY_KIT}/${kit}`);

export type SampleSource = "input" | "master" | "tab";
/** Where a sampled take lands. */
export type SampleTarget = "chop" | "pad";

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
  /** Automatic markers: most slices (Transients) or slice count (Equal), and transient sensitivity 0..1. */
  count: number;
  sens: number;
}

export interface SampleInfo {
  id: string;
  name: string;
  /** Virtual folder, e.g. "Drums/Kicks" ("" or missing = top level). */
  folder?: string;
  /** Where it came from in a connected folder (browse/disk.ts path), so loading the same file again reuses it. */
  src?: string;
  /** Stored as 16-bit (audio/pcm.ts). Older samples are 32-bit float until the library is compacted. */
  pcm16?: true;
}
