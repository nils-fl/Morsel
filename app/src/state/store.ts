import { createStore } from "zustand/vanilla";
import type { SynthPreset } from "../audio/synthPresets";
import { useStore } from "zustand";
import { COLOR } from "../midi/protocol";
import { BAR_TICKS, MAX_NUDGE } from "../seq/timing";
import type { ChopSession, Clip, HwMode, KeysInstrument, KeysLfo, KeysSample, NoteEvent, Pad, Pattern, Project, Returns, SampleInfo, SampleSource, SampleTarget, SidechainInput, SynthParams, Tab, Track, TrackDuck, TrackFx, TrackKind, Wave, Zone } from "./types";
import { MAX_TRACKS, PAD_COUNT, PATTERN_COUNT } from "./types";

export const PAD_COLORS = [
  COLOR.red, COLOR.orange, COLOR.yellow, COLOR.lime, COLOR.green, COLOR.mint, COLOR.cyan, COLOR.sky,
  COLOR.blue, COLOR.purple, COLOR.magenta, COLOR.pink, COLOR.red, COLOR.orange, COLOR.yellow, COLOR.green,
];

export const defaultPad = (i: number): Pad => ({
  name: `Pad ${i + 1}`,
  sampleId: null,
  color: PAD_COLORS[i],
  start: 0,
  end: 1,
  pitch: 0,
  attack: 0,
  decay: 1.5,
  cutoff: 1,
  hpCutoff: 0,
  resonance: 0,
  pan: 0,
  volume: 0.8,
  mode: "oneshot",
  choke: 0,
  reverse: false,
});

/** Fill in fields added after a project/kit was saved, and drop values of the wrong type or out of range (a NaN in an AudioParam throws inside the scheduler). */
export const normalizePads = (pads: unknown[]): Pad[] =>
  Array.from({ length: PAD_COUNT }, (_, i) => normalizePad(pads[i], defaultPad(i)));

function normalizePad(raw: unknown, d: Pad): Pad {
  const p = isObj(raw) ? raw : {};
  return {
    name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 24) : d.name,
    sampleId: typeof p.sampleId === "string" ? p.sampleId : null,
    color: Math.round(num(p.color, 0, 127, d.color)),
    start: num(p.start, 0, 1, d.start),
    end: num(p.end, 0, 1, d.end),
    pitch: num(p.pitch, -24, 24, d.pitch),
    attack: num(p.attack, 0, 1, d.attack),
    decay: num(p.decay, 0.02, 2, d.decay),
    cutoff: num(p.cutoff, 0, 1, d.cutoff),
    hpCutoff: num(p.hpCutoff, 0, 1, d.hpCutoff),
    resonance: num(p.resonance, 0, 1, d.resonance),
    pan: num(p.pan, -1, 1, d.pan),
    volume: num(p.volume, 0, 1, d.volume),
    mode: p.mode === "gate" ? "gate" : "oneshot",
    choke: Math.round(num(p.choke, 0, 4, d.choke)),
    reverse: bool(p.reverse, d.reverse),
  };
}

const WAVES: Wave[] = ["sawtooth", "square", "sine", "triangle"];
const wave = (v: unknown, d: Wave): Wave => (WAVES.includes(v as Wave) ? (v as Wave) : d);

/** A saved synth (keys track or preset) on top of the defaults, every number checked. */
export function normalizeSynth(raw: unknown, d: SynthParams = defaultKeys().synth): SynthParams {
  const s = isObj(raw) ? raw : {};
  return {
    wave: wave(s.wave, d.wave),
    wave2: wave(s.wave2, d.wave2),
    detune: num(s.detune, -2400, 2400, d.detune),
    osc2Level: num(s.osc2Level, 0, 1, d.osc2Level),
    cutoff: num(s.cutoff, 0, 1, d.cutoff),
    resonance: num(s.resonance, 0, 1, d.resonance),
    envAmount: num(s.envAmount, 0, 1, d.envAmount),
    attack: num(s.attack, 0.001, 2, d.attack),
    decay: num(s.decay, 0.01, 5, d.decay),
    sustain: num(s.sustain, 0, 1, d.sustain),
    release: num(s.release, 0.01, 3, d.release),
    volume: num(s.volume, 0, 1, d.volume),
    sub: num(s.sub, 0, 1, d.sub),
    noise: num(s.noise, 0, 1, d.noise),
    drive: num(s.drive, 0, 1, d.drive),
    slope: s.slope === 24 || s.slope === 12 ? s.slope : d.slope,
    keyTrack: num(s.keyTrack, 0, 1, d.keyTrack),
    velFilter: num(s.velFilter, 0, 1, d.velFilter),
    filterDecay: num(s.filterDecay, 0, 2, d.filterDecay),
  };
}

export const defaultKeys = (): KeysInstrument => ({
  type: "synth",
  sourceTrack: "drums",
  sourcePad: 0,
  zones: [],
  multiName: "",
  preset: "Init",
  volume: 0.7,
  synth: {
    wave: "sawtooth",
    wave2: "square",
    detune: 7,
    osc2Level: 0.5,
    cutoff: 0.45,
    resonance: 0.2,
    envAmount: 0.4,
    attack: 0.005,
    decay: 0.3,
    sustain: 0.6,
    release: 0.25,
    volume: 0.6,
    sub: 0,
    noise: 0,
    drive: 0,
    slope: 12,
    keyTrack: 0,
    velFilter: 0,
    filterDecay: 0,
  },
  sample: { sampleId: null, root: 60, attack: 0.005, release: 0.3, cutoff: 1, resonance: 0 },
  lfo: { vibRate: 5, vibDepth: 0, filterRate: 2, filterDepth: 0 },
});

export const defaultFx = (): TrackFx => ({ filter: "off", cutoff: 1, resonance: 0, eqLow: 0, eqMid: 0, eqHigh: 0, drive: 0, comp: 0 });

/** Colours of tracks 1-8 (track strip, Track mode pads). */
export const TRACK_COLORS = [COLOR.red, COLOR.purple, COLOR.orange, COLOR.cyan, COLOR.yellow, COLOR.blue, COLOR.green, COLOR.pink];

export function defaultTrack(kind: TrackKind, id: string, index = 0, name?: string): Track {
  return {
    id,
    name: name ?? (kind === "drum" ? "Drums" : "Keys"),
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    kind,
    pads: kind === "drum" ? Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i)) : [],
    kit: "",
    keys: kind === "keys" ? defaultKeys() : null,
    padMutes: Array(PAD_COUNT).fill(false),
    padSolos: Array(PAD_COUNT).fill(false),
    level: 1,
    pan: 0,
    mute: false,
    solo: false,
    sendA: 0,
    sendB: 0,
    fx: defaultFx(),
    duck: defaultDuck(kind),
  };
}

/** Defaults that audibly pump: a quarter-note-ish dip at most tempos. */
export const defaultDuck = (kind: TrackKind = "keys"): TrackDuck => ({
  on: false, input: null, depth: 0.85, attack: 0.005, hold: 0.06, release: 0.3,
  ...(kind === "drum" ? { pads: Array<boolean>(PAD_COUNT).fill(true) } : {}),
});

/** Whether a pad of a drum track dips when its duck's input is hit (never the input pad itself). */
export function padDucks(t: Track, pad: number) {
  if (t.kind !== "drum" || !(t.duck.pads?.[pad] ?? true)) return false;
  return t.duck.input !== inputOf(t.id, pad);
}

/** Ids of the two tracks a fresh (or migrated v1) project starts with. */
export const DRUMS_ID = "drums";
export const KEYS_ID = "keys";

export const emptyPattern = (): Pattern => ({ bars: 1, clips: {} });

export const defaultReturns = (): Returns => ({
  reverb: { size: 0.5, decay: 0.5, level: 0.8 },
  delay: { time: 3, feedback: 0.35, tone: 0.6, level: 0.8 },
});

export const defaultProject = (): Project => ({
  name: "Untitled",
  bpm: 92,
  swing: 54,
  tracks: [defaultTrack("drum", DRUMS_ID, 0), defaultTrack("keys", KEYS_ID, 1)],
  patterns: Array.from({ length: PATTERN_COUNT }, emptyPattern),
  song: [{ pattern: 0, repeats: 1 }],
  sidechain: [],
  returns: defaultReturns(),
});

/** Bumped when the saved project shape changes (3: keys sample source, LFO, kit names; 4: sidechain inputs, ducks per keys track); files from a newer version are refused, older ones get defaults. */
export const PROJECT_VERSION = 4;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
/** Exactly `length` entries: saved values where they have the right type, defaults for the rest. */
const fixedArray = <T>(v: unknown, length: number, fallback: T, ok: (x: unknown) => boolean): T[] =>
  Array.from({ length }, (_, i) => (Array.isArray(v) && ok(v[i]) ? (v[i] as T) : fallback));
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/**
 * v1 projects had one drum rack (`pads`, tracks 0-15) and one Keys instrument (track 16), with every track's
 * notes in one list per pattern. Turn that into a Drums and a Keys track with a clip each.
 */
export function migrateV1(raw: Record<string, unknown>): Record<string, unknown> {
  const at = (key: string, i: number) => (Array.isArray(raw[key]) ? (raw[key] as unknown[])[i] : undefined);
  const range = (key: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => at(key, from + i));
  const drums = { ...defaultTrack("drum", DRUMS_ID, 0), pads: raw.pads, padMutes: range("mutes", 0, PAD_COUNT), padSolos: range("solos", 0, PAD_COUNT) };
  const keys = {
    ...defaultTrack("keys", KEYS_ID, 1),
    keys: isObj(raw.keys) ? { ...raw.keys, sourceTrack: DRUMS_ID } : undefined,
    mute: at("mutes", 16), solo: at("solos", 16), level: at("levels", 16),
  };
  const patterns = (Array.isArray(raw.patterns) ? raw.patterns : []).map((pat) => {
    if (!isObj(pat)) return pat;
    const events = Array.isArray(pat.events) ? pat.events.filter(isObj) : [];
    const drumEvents = events.filter((e) => typeof e.track === "number" && e.track >= 0 && e.track < PAD_COUNT).map(({ track, ...e }) => ({ ...e, note: track }));
    const keyEvents = events.filter((e) => e.track === 16).map(({ track: _t, ...e }) => e);
    return { bars: pat.bars, clips: { [DRUMS_ID]: { events: drumEvents }, [KEYS_ID]: { events: keyEvents } } };
  });
  return { ...raw, tracks: [drums, keys], patterns };
}

function normalizeKeys(raw: unknown, drumIds: string[]): KeysInstrument {
  const d = defaultKeys();
  const keys = isObj(raw) ? raw : {};
  return {
    type: keys.type === "chromatic" || keys.type === "multi" || keys.type === "sample" ? keys.type : "synth",
    sourceTrack: typeof keys.sourceTrack === "string" && drumIds.includes(keys.sourceTrack) ? keys.sourceTrack : drumIds[0] ?? "",
    sourcePad: Math.round(num(keys.sourcePad, 0, PAD_COUNT - 1, d.sourcePad)),
    preset: typeof keys.preset === "string" ? keys.preset : d.preset,
    multiName: typeof keys.multiName === "string" ? keys.multiName : d.multiName,
    volume: num(keys.volume, 0, 1, d.volume),
    zones: Array.isArray(keys.zones)
      ? keys.zones.flatMap((z): Zone[] => (isObj(z) && typeof z.sampleId === "string" && typeof z.root === "number" && Number.isFinite(z.root) ? [{ sampleId: z.sampleId, root: Math.round(Math.max(0, Math.min(127, z.root))) }] : []))
      : [],
    synth: normalizeSynth(keys.synth, d.synth),
    sample: normalizeKeysSample(keys.sample, d.sample),
    lfo: normalizeLfo(keys.lfo, d.lfo),
  };
}

function normalizeKeysSample(raw: unknown, d: KeysSample): KeysSample {
  const s = isObj(raw) ? raw : {};
  return {
    sampleId: typeof s.sampleId === "string" ? s.sampleId : null,
    root: Math.round(num(s.root, 0, 127, d.root)),
    attack: num(s.attack, 0, 2, d.attack),
    release: num(s.release, 0.01, 2, d.release),
    cutoff: num(s.cutoff, 0, 1, d.cutoff),
    resonance: num(s.resonance, 0, 1, d.resonance),
  };
}

function normalizeLfo(raw: unknown, d: KeysLfo): KeysLfo {
  const l = isObj(raw) ? raw : {};
  return {
    vibRate: num(l.vibRate, 0.1, 20, d.vibRate),
    vibDepth: num(l.vibDepth, 0, 1, d.vibDepth),
    filterRate: num(l.filterRate, 0.1, 20, d.filterRate),
    filterDepth: num(l.filterDepth, 0, 1, d.filterDepth),
  };
}

function normalizeFx(raw: unknown): TrackFx {
  const d = defaultFx();
  if (!isObj(raw)) return d;
  return {
    filter: raw.filter === "lp" || raw.filter === "hp" || raw.filter === "bp" ? raw.filter : "off",
    cutoff: num(raw.cutoff, 0, 1, d.cutoff),
    resonance: num(raw.resonance, 0, 1, d.resonance),
    eqLow: num(raw.eqLow, -15, 15, 0),
    eqMid: num(raw.eqMid, -15, 15, 0),
    eqHigh: num(raw.eqHigh, -15, 15, 0),
    drive: num(raw.drive, 0, 1, 0),
    comp: num(raw.comp, 0, 1, 0),
  };
}

function normalizeTrack(raw: Record<string, unknown>, index: number, ids: Set<string>): Track | null {
  const kind: TrackKind | null = raw.kind === "drum" || raw.kind === "keys" ? raw.kind : null;
  if (!kind) return null;
  let id = typeof raw.id === "string" && raw.id ? raw.id : newId();
  if (ids.has(id)) id = newId();
  ids.add(id);
  const d = defaultTrack(kind, id, index);
  return {
    ...d,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 24) : d.name,
    color: typeof raw.color === "number" ? raw.color : d.color,
    pads: kind === "drum" ? normalizePads(Array.isArray(raw.pads) ? raw.pads : []) : [],
    kit: kind === "drum" && typeof raw.kit === "string" ? raw.kit.slice(0, 40) : "",
    keys: null, // filled in once the drum track ids are known
    padMutes: fixedArray(raw.padMutes, PAD_COUNT, false, (x) => typeof x === "boolean"),
    padSolos: fixedArray(raw.padSolos, PAD_COUNT, false, (x) => typeof x === "boolean"),
    level: num(raw.level, 0, 1, d.level),
    pan: num(raw.pan, -1, 1, d.pan),
    mute: bool(raw.mute, false),
    solo: bool(raw.solo, false),
    sendA: num(raw.sendA, 0, 1, 0),
    sendB: num(raw.sendB, 0, 1, 0),
    fx: normalizeFx(raw.fx),
    duck: normalizeTrackDuck(raw.duck, kind),
  };
}

/** The input is checked once the project's inputs are known. */
function normalizeTrackDuck(raw: unknown, kind: TrackKind): TrackDuck {
  const d = defaultDuck(kind);
  if (!isObj(raw)) return d;
  return {
    on: bool(raw.on, d.on),
    input: typeof raw.input === "string" ? raw.input : null,
    depth: num(raw.depth, 0, 1, d.depth),
    attack: num(raw.attack, 0, 0.05, d.attack),
    hold: num(raw.hold, 0, 0.5, d.hold),
    release: num(raw.release, 0.02, 1, d.release),
    ...(d.pads ? { pads: d.pads.map((on, i) => (Array.isArray(raw.pads) ? bool(raw.pads[i], on) : on)) } : {}),
  };
}

function normalizeTracks(raw: unknown): Track[] {
  const ids = new Set<string>();
  const list = (Array.isArray(raw) ? raw : []).filter(isObj).slice(0, MAX_TRACKS).flatMap((t, i) => normalizeTrack(t, i, ids) ?? []);
  // Pads and the keybed always have something to play.
  if (!list.some((t) => t.kind === "drum")) list.unshift(defaultTrack("drum", ids.has(DRUMS_ID) ? newId() : DRUMS_ID, 0));
  if (!list.some((t) => t.kind === "keys")) list.splice(Math.min(list.length, MAX_TRACKS - 1), 0, defaultTrack("keys", ids.has(KEYS_ID) ? newId() : KEYS_ID, 1));
  const tracks = list.slice(0, MAX_TRACKS);
  const drumIds = tracks.filter((t) => t.kind === "drum").map((t) => t.id);
  const rawById = new Map((Array.isArray(raw) ? raw : []).filter(isObj).map((t) => [t.id, t]));
  return tracks.map((t) => (t.kind === "keys" ? { ...t, keys: normalizeKeys(rawById.get(t.id)?.keys, drumIds) } : t));
}

function normalizeClip(raw: unknown, track: Track, patternBars: number, seen: Set<string>): Clip {
  const own = isObj(raw) && raw.bars !== undefined ? num(Math.round(Number(raw.bars)), 1, 4, patternBars) : undefined;
  const bars = own ?? patternBars;
  const events = (isObj(raw) && Array.isArray(raw.events) ? raw.events : []).flatMap((e): NoteEvent[] => {
    if (!isObj(e) || typeof e.tick !== "number" || e.tick < 0 || e.tick >= bars * BAR_TICKS) return [];
    if (track.kind === "drum" && (typeof e.note !== "number" || e.note < 0 || e.note >= PAD_COUNT)) return [];
    // Old "Double" copies shared ids with their originals; give any repeat a fresh one.
    let id = typeof e.id === "string" ? e.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const ev: NoteEvent = { id, tick: e.tick, note: Math.round(num(e.note, 0, 127, 60)), vel: num(e.vel, 1, 127, 100), len: num(e.len, 1, Number.MAX_SAFE_INTEGER, 1) };
    const nudge = Math.round(num(e.nudge, -MAX_NUDGE, MAX_NUDGE, 0));
    return [nudge ? { ...ev, nudge } : ev];
  });
  return own === undefined ? { events } : { events, bars: own };
}

function normalizePattern(raw: unknown, tracks: Track[], seen: Set<string>): Pattern {
  if (!isObj(raw)) return emptyPattern();
  const bars = num(Math.round(Number(raw.bars)), 1, 4, 1);
  const clips: Record<string, Clip> = {};
  for (const t of tracks) {
    const c = isObj(raw.clips) ? raw.clips[t.id] : undefined;
    if (c !== undefined) clips[t.id] = normalizeClip(c, t, bars, seen);
  }
  // The pattern is as long as its longest clip.
  return { bars: Math.max(bars, ...Object.values(clips).map((c) => c.bars ?? 1)), clips };
}

/** Sidechain inputs that are pads of existing drum tracks, each once. */
function normalizeSidechain(raw: unknown, tracks: Track[]): SidechainInput[] {
  const ok = (x: unknown): x is string => {
    if (typeof x !== "string") return false;
    const { track, pad } = parseInput(x);
    return tracks.some((t) => t.id === track && t.kind === "drum") && Number.isInteger(pad) && pad >= 0 && pad < PAD_COUNT;
  };
  return [...new Set(Array.isArray(raw) ? raw.filter(ok) : [])];
}

/** Keys tracks listen to inputs that exist, or to none. */
const fixDuckInputs = (tracks: Track[], sidechain: SidechainInput[]): Track[] =>
  tracks.map((t) => (t.duck.input !== null && !sidechain.includes(t.duck.input) ? { ...t, duck: { ...t.duck, input: null } } : t));

function normalizeReturns(raw: unknown): Returns {
  const d = defaultReturns();
  const r = isObj(raw) && isObj(raw.reverb) ? raw.reverb : {};
  const l = isObj(raw) && isObj(raw.delay) ? raw.delay : {};
  return {
    reverb: { size: num(r.size, 0, 1, d.reverb.size), decay: num(r.decay, 0, 1, d.reverb.decay), level: num(r.level, 0, 1, d.reverb.level) },
    delay: { time: Math.round(num(l.time, 1, 16, d.delay.time)), feedback: num(l.feedback, 0, 0.95, d.delay.feedback), tone: num(l.tone, 0, 1, d.delay.tone), level: num(l.level, 0, 1, d.delay.level) },
  };
}

/** A sidechain input's drum track and pad. */
export function parseInput(input: SidechainInput): { track: string; pad: number } {
  const i = input.lastIndexOf(":");
  return { track: input.slice(0, i), pad: Number(input.slice(i + 1)) };
}
export const inputOf = (trackId: string, pad: number): SidechainInput => `${trackId}:${pad}`;

/** Rebuild a saved or imported project on top of the defaults, so fields added later (or damaged ones) can't break playback. */
export function normalizeProject(input: unknown): Project {
  const d = defaultProject();
  if (!isObj(input)) return d;
  const raw = Array.isArray(input.tracks) ? input : migrateV1(input);
  const base = normalizeTracks(raw.tracks);
  const sidechain = normalizeSidechain(raw.sidechain, base);
  const tracks = fixDuckInputs(base, sidechain);
  const seen = new Set<string>();
  return {
    name: typeof raw.name === "string" ? raw.name : d.name,
    bpm: num(raw.bpm, 40, 240, d.bpm),
    swing: num(raw.swing, 50, 75, d.swing),
    tracks,
    patterns: Array.from({ length: PATTERN_COUNT }, (_, i) => normalizePattern(Array.isArray(raw.patterns) ? raw.patterns[i] : undefined, tracks, seen)),
    song: Array.isArray(raw.song)
      ? raw.song.flatMap((st) => (isObj(st) && typeof st.pattern === "number" && st.pattern >= 0 && st.pattern < PATTERN_COUNT ? [{ pattern: st.pattern, repeats: num(st.repeats, 1, 64, 1) }] : []))
      : d.song,
    sidechain,
    returns: normalizeReturns(raw.returns),
  };
}

/** granted: readable. prompt: needs a click (Reconnect) after a browser restart. missing: moved or deleted. */
export type FolderAccess = "granted" | "prompt" | "denied" | "missing";

/** A question shown in the in-app dialog (state/confirm.ts, ui/ConfirmDialog.tsx). */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Label of the button that goes ahead, e.g. "Delete". */
  ok: string;
  /** Can't be undone: the button is red and Cancel has the focus. */
  danger?: boolean;
}

export interface AppState {
  project: Project;
  samples: Record<string, SampleInfo>;
  /** Bumped when sample audio finishes loading (engine.ensure), so waveforms redraw. */
  bufferTick: number;
  /** Connected folders (browse/disk.ts) and whether the browser lets us read them right now. */
  folders: { name: string; access: FolderAccess }[];
  /** Bumped when a connected folder's listing arrives. */
  diskTick: number;
  /** The user's saved Keys synth presets (factory ones live in audio/synthPresets.ts). */
  userPresets: SynthPreset[];
  // transport
  playing: boolean;
  recording: boolean;
  countIn: boolean;
  metronome: boolean;
  songMode: boolean;
  currentPattern: number;
  queuedPattern: number | null;
  quantize: number;
  repeatRate: number;
  // selection / hardware
  /** Pad being edited, on the drum track. */
  selectedPad: number;
  /** Track being edited (track strip, step sequencer, encoder pages). */
  selectedTrack: string;
  /** Drum track the pads play: the selected track when it is a drum track, else the last one that was. */
  drumTrack: string;
  /** Keys track the keybed plays, chosen the same way. */
  keysTrack: string;
  hwMode: HwMode;
  /** Mode to return to when leaving Browse. */
  prevHwMode: HwMode;
  encPage: number;
  stepPage: number;
  shift: boolean;
  connected: boolean;
  status: string;
  sampling: "idle" | "waiting" | "recording";
  sampleSource: SampleSource;
  /** A browser tab is shared and ready for takes. */
  tabShared: boolean;
  /** Where a take lands: the Chop editor or the selected pad. */
  sampleTarget: SampleTarget;
  /** Open tab of the on-screen UI. */
  tab: Tab;
  /** Colour theme of the on-screen UI (ui/theme.ts). */
  theme: "dark" | "light";
  /** Explanatory tips shown in the panels (ui/tips.ts). */
  tips: boolean;
  chop: ChopSession | null;
  /** Names of the saved kits (the factory kit is not among them). */
  kits: string[];
  /** The open confirmation dialog. */
  confirm: ConfirmRequest | null;
  /** False while the browser keeps audio suspended (no click or key press on the page yet). */
  audioReady: boolean;
  undo: Project[];
}

export const store = createStore<AppState>(() => ({
  project: defaultProject(),
  samples: {},
  bufferTick: 0,
  folders: [],
  diskTick: 0,
  userPresets: [],
  playing: false,
  recording: false,
  countIn: false,
  metronome: false,
  songMode: false,
  currentPattern: 0,
  queuedPattern: null,
  quantize: 24,
  repeatRate: 24,
  selectedPad: 0,
  selectedTrack: DRUMS_ID,
  drumTrack: DRUMS_ID,
  keysTrack: KEYS_ID,
  hwMode: "play",
  prevHwMode: "play",
  encPage: 0,
  stepPage: 0,
  shift: false,
  connected: false,
  status: "",
  sampling: "idle",
  sampleSource: "input",
  tabShared: false,
  sampleTarget: "chop",
  tab: "Track",
  theme: "light",
  tips: false,
  chop: null,
  kits: [],
  confirm: null,
  audioReady: false,
  undo: [],
}));

export const useApp = <T,>(sel: (s: AppState) => T) => useStore(store, sel);
export const get = () => store.getState();
export const set = (p: Partial<AppState>) => store.setState(p);

/** Samples a project plays: they must be loaded (engine.ensure) and go into its file. */
export function usedSampleIds(p: Project) {
  const ids = new Set<string>();
  for (const t of p.tracks) {
    t.pads.forEach((pad) => pad.sampleId && ids.add(pad.sampleId));
    t.keys?.zones.forEach((z) => ids.add(z.sampleId));
    if (t.keys?.sample.sampleId) ids.add(t.keys.sample.sampleId);
  }
  return ids;
}

// ---------- project mutations ----------

export function updateProject(fn: (p: Project) => Project, undoable = true) {
  const s = get();
  const next = fn(s.project);
  if (next === s.project) return;
  set({ project: next, undo: undoable ? [...s.undo.slice(-49), s.project] : s.undo });
}

/** Remember the project as it is now as an undo step, for changes made in many small non-undoable edits (a recorded take). */
export function markUndo() {
  const s = get();
  set({ undo: [...s.undo.slice(-49), s.project] });
}

export function undo() {
  const s = get();
  const prev = s.undo[s.undo.length - 1];
  if (prev) set({ project: prev, undo: s.undo.slice(0, -1) });
}

// ---------- tracks ----------

export const trackById = (p: Project, id: string) => p.tracks.find((t) => t.id === id);

/** The drum track the pads play (falls back to the first one, e.g. after an undo removed it). */
export const drumTrack = (s: AppState = get()): Track =>
  s.project.tracks.find((t) => t.id === s.drumTrack && t.kind === "drum") ?? s.project.tracks.find((t) => t.kind === "drum")!;

/** The keys track the keybed plays. */
export const keysTrack = (s: AppState = get()): Track =>
  s.project.tracks.find((t) => t.id === s.keysTrack && t.kind === "keys") ?? s.project.tracks.find((t) => t.kind === "keys")!;

/** The selected track (falls back to the drum track). */
export const selectedTrack = (s: AppState = get()): Track => trackById(s.project, s.selectedTrack) ?? drumTrack(s);

/** The selected drum track's pads. */
export const drumPads = (s: AppState = get()) => drumTrack(s).pads;

/** Select a track; a drum track also takes over the pads, a keys track the keybed. */
export function selectTrack(id: string) {
  const t = trackById(get().project, id);
  if (!t) return;
  set({ selectedTrack: id, ...(t.kind === "drum" ? { drumTrack: id } : { keysTrack: id }) });
}

/** Point the selected / pads / keybed track ids at tracks that exist (after a reload, an undo or an import removed one). */
export function fixSelection() {
  const s = get();
  const patch: Partial<AppState> = {};
  if (!trackById(s.project, s.selectedTrack)) patch.selectedTrack = drumTrack(s).id;
  if (drumTrack(s).id !== s.drumTrack) patch.drumTrack = drumTrack(s).id;
  if (keysTrack(s).id !== s.keysTrack) patch.keysTrack = keysTrack(s).id;
  if (Object.keys(patch).length) set(patch);
}

/** Back to the start of a session: pattern 1, pads on bar 1, no chop, no queued switch (a new project was loaded). */
export function resetSession() {
  set({ chop: null, currentPattern: 0, queuedPattern: null, stepPage: 0, songMode: false, selectedPad: 0, recording: false, encPage: 0 });
}

/** Select the next (dir = 1) or previous (dir = -1) track, wrapping around. Returns it. */
export function stepTrack(dir: 1 | -1): Track {
  const s = get(), tracks = s.project.tracks;
  const i = tracks.findIndex((t) => t.id === selectedTrack(s).id);
  const t = tracks[(i + dir + tracks.length) % tracks.length];
  selectTrack(t.id);
  return t;
}

export function updateTrack(id: string, fn: Partial<Track> | ((t: Track) => Track), undoable = false) {
  updateProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id !== id ? t : typeof fn === "function" ? fn(t) : { ...t, ...fn })) }), undoable);
}

export function updatePad(i: number, patch: Partial<Pad>, undoable = false, trackId = drumTrack().id) {
  updateTrack(trackId, (t) => ({ ...t, pads: t.pads.map((pad, j) => (j === i ? { ...pad, ...patch } : pad)) }), undoable);
}

/** Replace the pads of a drum track (the selected one by default). */
export function updatePads(fn: (pads: Pad[]) => Pad[], undoable = true, trackId = drumTrack().id) {
  updateTrack(trackId, (t) => ({ ...t, pads: fn(t.pads) }), undoable);
}

export function updateKeys(patch: Partial<KeysInstrument>, trackId = keysTrack().id) {
  updateTrack(trackId, (t) => (t.keys ? { ...t, keys: { ...t.keys, ...patch } } : t));
}

export const canAddTrack = (p: Project) => p.tracks.length < MAX_TRACKS;
/** The last drum track and the last keys track stay, so the pads and the keybed always have an instrument. */
export const canRemoveTrack = (p: Project, id: string) => {
  const t = trackById(p, id);
  return !!t && p.tracks.filter((x) => x.kind === t.kind).length > 1;
};

/** Add a track (up to 8), optionally with its name and pads, and select it. One undo step. Returns its id. */
export function addTrack(kind: TrackKind, opts: { name?: string; pads?: Pad[]; kit?: string } = {}): string | null {
  const p = get().project;
  if (!canAddTrack(p)) return null;
  const id = newId();
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const t = defaultTrack(kind, id, p.tracks.length, opts.name ?? `${kind === "drum" ? "Drums" : "Keys"} ${n}`);
  if (opts.pads && kind === "drum") t.pads = normalizePads(opts.pads);
  if (opts.kit && kind === "drum") t.kit = opts.kit;
  if (t.keys) t.keys.sourceTrack = drumTrack().id;
  updateProject((pr) => ({ ...pr, tracks: [...pr.tracks, t] }));
  selectTrack(id);
  return id;
}

/** Remove a track with its clips and sidechain inputs. Chromatic keys fall back to another drum track. Undoable. */
export function removeTrack(id: string) {
  const p = get().project;
  if (!canRemoveTrack(p, id)) return;
  updateProject((pr) => {
    const tracks = pr.tracks.filter((t) => t.id !== id);
    const firstDrum = tracks.find((t) => t.kind === "drum")!.id;
    const sidechain = pr.sidechain.filter((x) => parseInput(x).track !== id);
    return {
      ...pr,
      tracks: fixDuckInputs(tracks.map((t) => (t.keys && t.keys.sourceTrack === id ? { ...t, keys: { ...t.keys, sourceTrack: firstDrum } } : t)), sidechain),
      patterns: pr.patterns.map((pat) => {
        const { [id]: _gone, ...clips } = pat.clips;
        // It may have been the longest clip.
        return { bars: Math.max(1, ...tracks.map((t) => clips[t.id]?.bars ?? pat.bars)), clips };
      }),
      sidechain,
    };
  });
  const s = get();
  if (s.selectedTrack === id) set({ selectedTrack: drumTrack().id });
  if (s.drumTrack === id) set({ drumTrack: drumTrack().id });
  if (s.keysTrack === id) set({ keysTrack: keysTrack().id });
}

export function moveTrack(id: string, dir: -1 | 1) {
  updateProject((p) => {
    const i = p.tracks.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.tracks.length) return p;
    const tracks = [...p.tracks];
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    return { ...p, tracks };
  }, false);
}

// ---------- patterns and clips ----------

export function updatePattern(index: number, fn: (pat: Pattern) => Pattern, undoable = true) {
  updateProject((p) => ({ ...p, patterns: p.patterns.map((pat, j) => (j === index ? fn(pat) : pat)) }), undoable);
}

const EMPTY_CLIP: Clip = { events: [] };
export const clipOf = (pat: Pattern, trackId: string): Clip => pat.clips[trackId] ?? EMPTY_CLIP;
export const patternHasNotes = (pat: Pattern) => Object.values(pat.clips).some((c) => c.events.length > 0);

export function updateClip(patternIndex: number, trackId: string, fn: (events: NoteEvent[]) => NoteEvent[], undoable = true) {
  updatePattern(patternIndex, (pat) => {
    const clip = clipOf(pat, trackId);
    return { ...pat, clips: { ...pat.clips, [trackId]: { ...clip, events: fn(clip.events) } } };
  }, undoable);
}

/** The pattern's length in ticks: its longest clip. */
export const patternLength = (pat: Pattern) => pat.bars * BAR_TICKS;
/** A track's loop length in a pattern, in bars and in ticks. */
export const trackBars = (pat: Pattern, trackId: string) => pat.clips[trackId]?.bars ?? pat.bars;
export const trackLength = (pat: Pattern, trackId: string) => trackBars(pat, trackId) * BAR_TICKS;

/**
 * Give every track's clip its own length (from `lengths`, else what it has now), drop notes past the ends, and make
 * the pattern as long as its longest clip.
 */
export function resizeClips(pat: Pattern, tracks: Track[], lengths: Record<string, number> = {}): Pattern {
  const clips: Pattern["clips"] = {};
  for (const t of tracks) {
    const bars = Math.max(1, Math.min(4, Math.round(lengths[t.id] ?? trackBars(pat, t.id))));
    clips[t.id] = { events: clipOf(pat, t.id).events.filter((e) => e.tick < bars * BAR_TICKS), bars };
  }
  return { bars: Math.max(1, ...Object.values(clips).map((c) => c.bars!)), clips };
}

/** Set one track's loop length (1-4 bars) in a pattern; notes past its new end are dropped. */
export function setTrackBars(index: number, trackId: string, bars: number, undoable = true) {
  const pat = get().project.patterns[index];
  if (trackBars(pat, trackId) === bars) return;
  updatePattern(index, (p) => resizeClips(p, get().project.tracks, { [trackId]: bars }), undoable);
  const s = get();
  if (index === s.currentPattern && trackId === s.selectedTrack && s.stepPage >= bars) set({ stepPage: Math.max(0, bars - 1) });
}

/** Double a track's clip: its notes repeat after its current length (up to 4 bars). */
export function doubleClip(index: number, trackId: string) {
  const pat = get().project.patterns[index];
  const bars = trackBars(pat, trackId);
  if (bars * 2 > 4) return;
  const shift = bars * BAR_TICKS;
  updatePattern(index, (p) => {
    const events = clipOf(p, trackId).events;
    const doubled = { ...p, clips: { ...p.clips, [trackId]: { events: [...events, ...events.map((e) => ({ ...e, id: newId(), tick: e.tick + shift }))] } } };
    return resizeClips(doubled, get().project.tracks, { [trackId]: bars * 2 });
  });
}

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function addEvent(patternIndex: number, trackId: string, ev: Omit<NoteEvent, "id">, undoable = false): NoteEvent {
  const full = { ...ev, id: newId() };
  updateClip(patternIndex, trackId, (events) => [...events, full], undoable);
  return full;
}

export function setEventLength(patternIndex: number, trackId: string, id: string, len: number) {
  updateClip(patternIndex, trackId, (events) => events.map((e) => (e.id === id ? { ...e, len: Math.max(1, len) } : e)), false);
}

/**
 * Toggle a step: removes the events inside [tick, tick+span), else adds one. On a drum track only the
 * pad `note` counts; on a keys track any note in the step does.
 */
export function toggleStep(patternIndex: number, trackId: string, tick: number, span: number, note: number, vel = 100) {
  const drum = trackById(get().project, trackId)?.kind === "drum";
  updateClip(patternIndex, trackId, (events) => {
    const hit = stepEvents(events, drum, tick, span, note);
    if (hit.length) {
      const ids = new Set(hit.map((e) => e.id));
      return events.filter((e) => !ids.has(e.id));
    }
    return [...events, { id: newId(), tick, note, vel, len: span }];
  });
}

/** The notes inside [tick, tick+span) that a step edits: on a drum track only pad `note`'s, on a keys track all. */
export function stepEvents(events: NoteEvent[], drum: boolean, tick: number, span: number, note: number) {
  return events.filter((e) => (!drum || e.note === note) && e.tick >= tick && e.tick < tick + span);
}

/**
 * Change the velocity and nudge of a step's notes by `dVel` / `dNudge` (clamped to 1..127 and ±MAX_NUDGE).
 * Returns the step's first note as it is now, if there is one.
 */
export function editStep(patternIndex: number, trackId: string, tick: number, span: number, note: number, dVel: number, dNudge: number, undoable = true) {
  const drum = trackById(get().project, trackId)?.kind === "drum";
  const ids = new Set(stepEvents(clipOf(get().project.patterns[patternIndex], trackId).events, drum, tick, span, note).map((e) => e.id));
  if (!ids.size) return undefined;
  updateClip(patternIndex, trackId, (events) => events.map((e) => {
    if (!ids.has(e.id)) return e;
    const vel = Math.max(1, Math.min(127, e.vel + dVel));
    const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, (e.nudge ?? 0) + dNudge));
    const { nudge: _old, ...rest } = e;
    return nudge ? { ...rest, vel, nudge } : { ...rest, vel };
  }), undoable);
  return clipOf(get().project.patterns[patternIndex], trackId).events.find((e) => ids.has(e.id));
}

/** Clear a track's clip in a pattern, or only one pad's notes when `pad` is given. */
export function clearTrack(patternIndex: number, trackId: string, pad?: number) {
  updateClip(patternIndex, trackId, (events) => (pad === undefined ? [] : events.filter((e) => e.note !== pad)));
}

const freshIds = (c: Clip): Clip => ({ ...c, events: c.events.map((e) => ({ ...e, id: newId() })) });

/** Overwrite pattern `to` with a copy of `from` (fresh event ids, so the two never share notes). Undoable. */
export function copyPattern(from: number, to: number) {
  if (from === to) return;
  updatePattern(to, () => {
    const src = get().project.patterns[from];
    return { bars: src.bars, clips: Object.fromEntries(Object.entries(src.clips).map(([id, c]) => [id, freshIds(c)])) };
  });
}

/** Overwrite one track's clip in pattern `to` with its clip from `from`, length included. Undoable. */
export function copyClip(from: number, to: number, trackId: string) {
  if (from === to) return;
  const p = get().project;
  const src = freshIds(clipOf(p.patterns[from], trackId));
  const bars = trackBars(p.patterns[from], trackId);
  updatePattern(to, (pat) => resizeClips({ ...pat, clips: { ...pat.clips, [trackId]: src } }, p.tracks, { [trackId]: bars }));
}

// ---------- sidechain ----------

/** Make a drum pad a sidechain input (the next number), or stop it being one; tracks listening to it stop ducking. */
export function toggleSidechainInput(trackId: string, pad: number) {
  const input = inputOf(trackId, pad);
  updateProject((p) => {
    const sidechain = p.sidechain.includes(input) ? p.sidechain.filter((x) => x !== input) : [...p.sidechain, input];
    return { ...p, sidechain, tracks: fixDuckInputs(p.tracks, sidechain) };
  });
}

/** Change a track's ducker. Turning it on without an input picks the first one (on a drum track, one of another track's pads if there is one). */
export function setTrackDuck(trackId: string, patch: Partial<TrackDuck>) {
  updateProject((p) => ({
    ...p,
    tracks: p.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const duck = { ...t.duck, ...patch };
      if (duck.on && duck.input === null) duck.input = p.sidechain.find((x) => parseInput(x).track !== t.id) ?? p.sidechain[0] ?? null;
      return { ...t, duck };
    }),
  }), false);
}

/** Whether a pad of a drum track dips with the track's ducker. */
export function setDuckPad(trackId: string, pad: number, on: boolean) {
  const t = trackById(get().project, trackId);
  if (!t?.duck.pads || t.duck.pads[pad] === on) return;
  setTrackDuck(trackId, { pads: t.duck.pads.map((x, i) => (i === pad ? on : x)) });
}

// ---------- mute / solo ----------

/** Track-level mute and solo. */
export function trackAudible(p: Project, trackId: string) {
  const t = trackById(p, trackId);
  if (!t) return false;
  return p.tracks.some((x) => x.solo) ? t.solo : !t.mute;
}

/** Pad-level mute and solo inside a drum rack. */
export function padAudible(t: Track, pad: number) {
  return t.padSolos.some(Boolean) ? t.padSolos[pad] : !t.padMutes[pad];
}

export function toggleTrackFlag(trackId: string, key: "mute" | "solo") {
  updateTrack(trackId, (t) => ({ ...t, [key]: !t[key] }));
}

export function togglePadFlag(trackId: string, pad: number, key: "padMutes" | "padSolos") {
  updateTrack(trackId, (t) => ({ ...t, [key]: t[key].map((v, i) => (i === pad ? !v : v)) }));
}
