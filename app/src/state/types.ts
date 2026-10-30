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
  // Sound shaping. Each one's default (0, or a 12 dB slope) leaves the synth as it was before they existed.
  sub: number; // 0..1, sine one octave below osc 1
  noise: number; // 0..1, white noise into the filter
  drive: number; // 0..1, saturation after the filter
  slope: 12 | 24; // filter slope in dB/octave
  keyTrack: number; // 0..1, the cutoff follows the note (1 = an octave per octave, around C4)
  velFilter: number; // 0..1, how much velocity scales the filter envelope
  filterDecay: number; // seconds; 0 = the filter follows the amp envelope, else it closes fully over this time
}

export interface Zone {
  sampleId: string;
  root: number; // MIDI note
  /** The keys it plays on (from an Ableton Live instrument); without them, the nearest root plays. */
  lo?: number;
  hi?: number;
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
/** The effects of a track's FX rack, in their default chain order. */
export const FX_KINDS = ["filter", "eq", "drive", "comp", "chorus", "delay", "reverb", "crush"] as const;
export type FxKind = (typeof FX_KINDS)[number];

/** A track's FX rack: every effect once, in the order the sound goes through them; those switched on are in the chain. */
export interface TrackFx {
  /** The chain order, each kind once: the FX page's encoders 1-8. */
  order: FxKind[];
  on: Record<FxKind, boolean>;
  filter: { type: "lp" | "hp" | "bp"; cutoff: number; resonance: number }; // 0..1
  /** Bands in dB (-15..15); midFreq 0..1 = 200 Hz..5 kHz. */
  eq: { low: number; mid: number; high: number; midFreq: number };
  /** amount 0..1, tone 0..1 (dark..open), mix 0..1. */
  drive: { amount: number; tone: number; mix: number };
  /** threshold dB (-60..0), ratio 1..20, attack and release in seconds, makeup dB (0..24). */
  comp: { threshold: number; ratio: number; attack: number; release: number; makeup: number };
  /** rate Hz (0.05..5), depth and mix 0..1. */
  chorus: { rate: number; depth: number; mix: number };
  /** time in 16ths (1..16), feedback, tone and mix 0..1; pingpong: repeats bounce left and right. */
  delay: { time: number; feedback: number; tone: number; mix: number; pingpong: boolean };
  /** size, decay, tone and mix 0..1. */
  reverb: { size: number; decay: number; tone: number; mix: number };
  /** bits 1..16; rate 0..1 (1 = the full sample rate, 0 = a 32nd of it); mix 0..1. */
  crush: { bits: number; rate: number; mix: number };
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
  /** Ducked by a sidechain input: a keys track as a whole, a drum track pad by pad. */
  duck: TrackDuck;
  /** A chop track (made from Chop): its chops, which its keys play (C3 = chop 1). Null on other tracks. */
  chops: TrackChops | null;
}

/** The chops a chop track keeps on its keys: the sample, its markers and each chop's pitch and choke (in `group`). */
export interface TrackChops {
  sampleId: string;
  markers: number[];
  slices: SliceOpts[];
  group: number;
}

/** Drum notes from here on are a chop track's key chops: note KEY_CHOP0 + k = chop k (the pads are 0..15). */
export const KEY_CHOP0 = PAD_COUNT;
/** The most chops Chop makes (audio/chop.ts MAX_CHOPS), all of them on a chop track's keys. */
export const MAX_KEY_CHOPS = 32;
export const isKeyChop = (note: number) => note >= KEY_CHOP0;

/** A note in a clip. On drum tracks `note` is the pad index (0..15), or a key chop (KEY_CHOP0 + k) on a chop track. */
export interface NoteEvent {
  id: string;
  tick: number;
  note: number;
  vel: number; // 1..127
  len: number; // ticks
  /** Micro-timing: sounds this many ticks off `tick` (under half its clip's step), which stays on its step. Missing = 0. */
  nudge?: number;
}

export interface Clip {
  events: NoteEvent[];
  /** The clip's own loop length (1-16 bars); missing = the pattern's length. Clips loop on their own while playing. */
  bars?: number;
  /** The step grid it is edited on, in ticks per step (timing.ts GRID_OPTIONS); missing = 1/16. Only editing uses it. */
  step?: number;
}

/** A sequence: one clip per track (by track id; a track without one is silent here). */
export interface Pattern {
  /** The longest clip: the pattern switches and counts its song repeats after this many bars. */
  bars: number;
  clips: Record<string, Clip>;
}

export interface Returns {
  /** size, decay, predelay (0..1 = 0..80 ms), tone (dark..bright) and level, all 0..1. */
  reverb: { size: number; decay: number; predelay: number; tone: number; level: number };
  /** time in 16ths (1..16); pingpong: repeats bounce left and right instead of each side echoing itself. */
  delay: { time: number; feedback: number; tone: number; level: number; pingpong: boolean };
}

export interface SongStep {
  pattern: number;
  repeats: number;
}

/** Master level of a new project (and of one saved before it could be set). */
export const DEFAULT_MASTER_LEVEL = 0.9;

export interface Project {
  name: string;
  bpm: number;
  swing: number; // 50..75 (%)
  tracks: Track[];
  patterns: Pattern[];
  song: SongStep[];
  /** Sidechain inputs, in order (Input 1, Input 2, …): drum pads whose hits duck the keys tracks listening to them. */
  sidechain: SidechainInput[];
  returns: Returns;
  /** Master level before the glue compressor and limiter, 0..1. */
  masterLevel: number;
  /** The master's glue compressor: off by default (it pumps the mix); on for the old, glued sound. */
  masterGlue: boolean;
}

/** A sidechain input: one pad of a drum track, as `${trackId}:${pad}`. */
export type SidechainInput = string;

/** A track's sidechain ducker: each hit of its input dips the track (on a drum track, the pads in `pads`) and lets it recover. */
export interface TrackDuck {
  on: boolean;
  input: SidechainInput | null;
  depth: number; // 0..1
  attack: number; // seconds, 0..0.05
  hold: number; // seconds at full depth before recovering, 0..0.5
  release: number; // seconds, 0.02..1
  /** Drum tracks: which pads dip (16 flags). The input pad itself never dips. */
  pads?: boolean[];
}

export type HwMode = "play" | "step" | "track" | "mute" | "pattern" | "browse" | "chop";

/** "Track" shows the selected track: the drum rack or the keys instrument. */
// The guide is an overlay (Guide button, ?) and the Lab opens from Preferences, so the tabs are all about the music.
export const TABS = ["Track", "Chop", "Sequencer", "Mixer", "Song"] as const;
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

/** A chop's own sound, carried onto the pad it is put on. */
export interface SliceOpts {
  pitch: number; // semitones
  /** Cuts the other chops (and pads) with choke on, like an MPC chop. */
  choke: boolean;
}

export const DEFAULT_SLICE: SliceOpts = { pitch: 0, choke: true };

/** Chop editor session, shared by the Chop tab and the Launchkey (encoders, keys, pads, screen). */
export interface ChopSession {
  sampleId: string;
  /** Sorted slice boundaries (N + 1 markers = N slices); the first and last bound the region. */
  markers: number[];
  /** One per slice, in order: kept in step with the markers by updateChop. */
  slices: SliceOpts[];
  /** Visible window, fractions 0..1 of the sample. */
  view: [number, number];
  /** Selected marker index, or null. */
  sel: number | null;
  /** Pad the first slice is sent to. */
  firstPad: number;
  /** How chops are placed: equal steps (`count` of them) or at the hits (at most `count`, found with sensitivity `sens` 0..1). */
  detect: "equal" | "hits";
  count: number;
  sens: number;
  /** Drum track that key + pad puts chops on (made by the first one) and the choke group they share there. */
  rack: { id: string; group: number } | null;
  /** The Launchkey's Sample page (scroll, zoom, start, end, keep, tempo and stretch) or Chop page (markers and chops). */
  page: "sample" | "chop";
  /** The region's length in beats; null = guessed from its length and the project tempo. */
  beats: number | null;
  /** Tempo the region is stretched to. */
  toBpm: number;
  /** The sample before the last stretch, to go back to. */
  from?: { sampleId: string; markers: number[]; slices: SliceOpts[]; beats: number | null };
  /** The sample split into its drums and the rest (audio/hpss.ts): the one shown is the one `sampleId` is. */
  stems?: Stems;
}

export interface Stems {
  full: string;
  drums: string;
  noDrums: string;
}
export type Stem = keyof Stems;

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
