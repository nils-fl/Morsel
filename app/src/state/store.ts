import { createStore } from "zustand/vanilla";
import type { SynthPreset } from "../audio/synthPresets";
import { useStore } from "zustand";
import { COLOR } from "../midi/protocol";
import { BAR_TICKS } from "../seq/timing";
import type { ChopSession, Clip, DuckSettings, DuckTarget, HwMode, KeysInstrument, NoteEvent, Pad, Pattern, Project, Returns, SampleInfo, SampleSource, Tab, TabTarget, Track, TrackFx, TrackKind, Zone } from "./types";
import { DUCK_ALL, MAX_TRACKS, PAD_COUNT, PATTERN_COUNT } from "./types";

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

/** Fill in fields added after a project/kit was saved. */
export const normalizePads = (pads: Partial<Pad>[]): Pad[] =>
  Array.from({ length: PAD_COUNT }, (_, i) => ({ ...defaultPad(i), ...pads[i] }));

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
  },
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
  };
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
  // Defaults that audibly pump: a quarter-note-ish dip at most tempos.
  duck: { on: false, sourceTrack: DRUMS_ID, sourcePad: 0, target: DUCK_ALL, depth: 0.85, attack: 0.005, hold: 0.06, release: 0.3 },
  returns: defaultReturns(),
});

/** Bumped when the saved project shape changes; files from a newer version are refused. */
export const PROJECT_VERSION = 2;

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
  const duck = isObj(raw.duck) ? raw.duck : {};
  const oldTarget = typeof duck.target === "number" ? duck.target : -1;
  const target = oldTarget === 16 ? KEYS_ID : oldTarget >= 0 && oldTarget < PAD_COUNT ? `${DRUMS_ID}:${oldTarget}` : DUCK_ALL;
  return {
    ...raw,
    tracks: [drums, keys],
    patterns,
    duck: { ...duck, sourceTrack: DRUMS_ID, sourcePad: duck.source, target },
  };
}

function normalizeKeys(raw: unknown, drumIds: string[]): KeysInstrument {
  const d = defaultKeys();
  const keys = isObj(raw) ? raw : {};
  return {
    ...d,
    ...keys,
    type: keys.type === "chromatic" || keys.type === "multi" ? keys.type : "synth",
    sourceTrack: typeof keys.sourceTrack === "string" && drumIds.includes(keys.sourceTrack) ? keys.sourceTrack : drumIds[0] ?? "",
    sourcePad: Math.round(num(keys.sourcePad, 0, PAD_COUNT - 1, d.sourcePad)),
    preset: typeof keys.preset === "string" ? keys.preset : d.preset,
    multiName: typeof keys.multiName === "string" ? keys.multiName : d.multiName,
    volume: num(keys.volume, 0, 1, d.volume),
    zones: Array.isArray(keys.zones) ? keys.zones.filter((z): z is Zone => isObj(z) && typeof z.sampleId === "string" && typeof z.root === "number") : [],
    synth: { ...d.synth, ...(isObj(keys.synth) ? keys.synth : {}) },
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
    pads: kind === "drum" ? normalizePads(Array.isArray(raw.pads) ? raw.pads.map((p) => (isObj(p) ? p : {})) : []) : [],
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

function normalizeClip(raw: unknown, track: Track, bars: number, seen: Set<string>): Clip {
  const events = (isObj(raw) && Array.isArray(raw.events) ? raw.events : []).flatMap((e): NoteEvent[] => {
    if (!isObj(e) || typeof e.tick !== "number" || e.tick < 0 || e.tick >= bars * BAR_TICKS) return [];
    if (track.kind === "drum" && (typeof e.note !== "number" || e.note < 0 || e.note >= PAD_COUNT)) return [];
    // Old "Double" copies shared ids with their originals; give any repeat a fresh one.
    let id = typeof e.id === "string" ? e.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return [{ id, tick: e.tick, note: Math.round(num(e.note, 0, 127, 60)), vel: num(e.vel, 1, 127, 100), len: num(e.len, 1, Number.MAX_SAFE_INTEGER, 1) }];
  });
  return { events };
}

function normalizePattern(raw: unknown, tracks: Track[], seen: Set<string>): Pattern {
  if (!isObj(raw)) return emptyPattern();
  const bars = num(Math.round(Number(raw.bars)), 1, 4, 1);
  const clips: Record<string, Clip> = {};
  for (const t of tracks) {
    const c = isObj(raw.clips) ? raw.clips[t.id] : undefined;
    if (c !== undefined) clips[t.id] = normalizeClip(c, t, bars, seen);
  }
  return { bars, clips };
}

function normalizeDuck(raw: unknown, d: DuckSettings, tracks: Track[]): DuckSettings {
  if (!isObj(raw)) return { ...d, sourceTrack: tracks.find((t) => t.kind === "drum")!.id };
  const drums = tracks.filter((t) => t.kind === "drum");
  const sourceTrack = drums.find((t) => t.id === raw.sourceTrack)?.id ?? drums[0].id;
  return {
    on: bool(raw.on, d.on),
    sourceTrack,
    sourcePad: Math.round(num(raw.sourcePad, 0, PAD_COUNT - 1, d.sourcePad)),
    target: typeof raw.target === "string" && duckTargetValid(tracks, raw.target) ? raw.target : DUCK_ALL,
    depth: num(raw.depth, 0, 1, d.depth),
    attack: num(raw.attack, 0, 0.05, d.attack),
    hold: num(raw.hold, 0, 0.5, d.hold),
    release: num(raw.release, 0.02, 1, d.release),
  };
}

function normalizeReturns(raw: unknown): Returns {
  const d = defaultReturns();
  const r = isObj(raw) && isObj(raw.reverb) ? raw.reverb : {};
  const l = isObj(raw) && isObj(raw.delay) ? raw.delay : {};
  return {
    reverb: { size: num(r.size, 0, 1, d.reverb.size), decay: num(r.decay, 0, 1, d.reverb.decay), level: num(r.level, 0, 1, d.reverb.level) },
    delay: { time: Math.round(num(l.time, 1, 16, d.delay.time)), feedback: num(l.feedback, 0, 0.95, d.delay.feedback), tone: num(l.tone, 0, 1, d.delay.tone), level: num(l.level, 0, 1, d.delay.level) },
  };
}

/** Split a duck target into its track and (for one pad) pad. */
export function parseDuckTarget(t: DuckTarget): { track: string; pad: number | null } | null {
  if (t === DUCK_ALL) return null;
  const i = t.lastIndexOf(":");
  return i < 0 ? { track: t, pad: null } : { track: t.slice(0, i), pad: Number(t.slice(i + 1)) };
}

function duckTargetValid(tracks: Track[], t: string) {
  if (t === DUCK_ALL) return true;
  const parsed = parseDuckTarget(t)!;
  const track = tracks.find((x) => x.id === parsed.track);
  if (!track) return false;
  return parsed.pad === null || (track.kind === "drum" && Number.isInteger(parsed.pad) && parsed.pad >= 0 && parsed.pad < PAD_COUNT);
}

/** Rebuild a saved or imported project on top of the defaults, so fields added later (or damaged ones) can't break playback. */
export function normalizeProject(input: unknown): Project {
  const d = defaultProject();
  if (!isObj(input)) return d;
  const raw = Array.isArray(input.tracks) ? input : migrateV1(input);
  const tracks = normalizeTracks(raw.tracks);
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
    duck: normalizeDuck(raw.duck, d.duck, tracks),
    returns: normalizeReturns(raw.returns),
  };
}

export interface AppState {
  project: Project;
  samples: Record<string, SampleInfo>;
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
  tabTarget: TabTarget;
  /** Open tab of the on-screen UI. */
  tab: Tab;
  /** Colour theme of the on-screen UI (ui/theme.ts). */
  theme: "dark" | "light";
  chop: ChopSession | null;
  /** False while the browser keeps audio suspended (no click or key press on the page yet). */
  audioReady: boolean;
  undo: Project[];
}

export const store = createStore<AppState>(() => ({
  project: defaultProject(),
  samples: {},
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
  tabTarget: "pad",
  tab: "Pads",
  theme: "dark",
  chop: null,
  audioReady: false,
  undo: [],
}));

export const useApp = <T,>(sel: (s: AppState) => T) => useStore(store, sel);
export const get = () => store.getState();
export const set = (p: Partial<AppState>) => store.setState(p);

// ---------- project mutations ----------

export function updateProject(fn: (p: Project) => Project, undoable = true) {
  const s = get();
  const next = fn(s.project);
  if (next === s.project) return;
  set({ project: next, undo: undoable ? [...s.undo.slice(-49), s.project] : s.undo });
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

/** Add a track (up to 8) and select it. Returns its id. */
export function addTrack(kind: TrackKind): string | null {
  const p = get().project;
  if (!canAddTrack(p)) return null;
  const id = newId();
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const t = defaultTrack(kind, id, p.tracks.length, `${kind === "drum" ? "Drums" : "Keys"} ${n}`);
  if (t.keys) t.keys.sourceTrack = drumTrack().id;
  updateProject((pr) => ({ ...pr, tracks: [...pr.tracks, t] }));
  selectTrack(id);
  return id;
}

/** Remove a track with its clips. References to it (duck, chromatic keys) fall back to another track. Undoable. */
export function removeTrack(id: string) {
  const p = get().project;
  if (!canRemoveTrack(p, id)) return;
  updateProject((pr) => {
    const tracks = pr.tracks.filter((t) => t.id !== id);
    const firstDrum = tracks.find((t) => t.kind === "drum")!.id;
    const target = parseDuckTarget(pr.duck.target);
    return {
      ...pr,
      tracks: tracks.map((t) => (t.keys && t.keys.sourceTrack === id ? { ...t, keys: { ...t.keys, sourceTrack: firstDrum } } : t)),
      patterns: pr.patterns.map((pat) => {
        const { [id]: _gone, ...clips } = pat.clips;
        return { ...pat, clips };
      }),
      duck: {
        ...pr.duck,
        sourceTrack: pr.duck.sourceTrack === id ? firstDrum : pr.duck.sourceTrack,
        target: target?.track === id ? DUCK_ALL : pr.duck.target,
      },
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
  updatePattern(patternIndex, (pat) => ({ ...pat, clips: { ...pat.clips, [trackId]: { events: fn(clipOf(pat, trackId).events) } } }), undoable);
}

export const patternLength = (pat: Pattern) => pat.bars * BAR_TICKS;

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
    const hit = events.filter((e) => (!drum || e.note === note) && e.tick >= tick && e.tick < tick + span);
    if (hit.length) {
      const ids = new Set(hit.map((e) => e.id));
      return events.filter((e) => !ids.has(e.id));
    }
    return [...events, { id: newId(), tick, note, vel, len: span }];
  });
}

/** Clear a track's clip in a pattern, or only one pad's notes when `pad` is given. */
export function clearTrack(patternIndex: number, trackId: string, pad?: number) {
  updateClip(patternIndex, trackId, (events) => (pad === undefined ? [] : events.filter((e) => e.note !== pad)));
}

const freshIds = (c: Clip): Clip => ({ events: c.events.map((e) => ({ ...e, id: newId() })) });

/** Overwrite pattern `to` with a copy of `from` (fresh event ids, so the two never share notes). Undoable. */
export function copyPattern(from: number, to: number) {
  if (from === to) return;
  updatePattern(to, () => {
    const src = get().project.patterns[from];
    return { bars: src.bars, clips: Object.fromEntries(Object.entries(src.clips).map(([id, c]) => [id, freshIds(c)])) };
  });
}

/** Overwrite one track's clip in pattern `to` with its clip from `from` (notes past `to`'s length are dropped). Undoable. */
export function copyClip(from: number, to: number, trackId: string) {
  if (from === to) return;
  const p = get().project;
  const len = patternLength(p.patterns[to]);
  const src = freshIds(clipOf(p.patterns[from], trackId));
  updateClip(to, trackId, () => src.events.filter((e) => e.tick < len));
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
