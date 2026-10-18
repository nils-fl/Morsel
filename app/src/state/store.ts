import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { COLOR } from "../midi/protocol";
import { BAR_TICKS } from "../seq/timing";
import type { ChopSession, DuckSettings, HwMode, KeysInstrument, NoteEvent, Pad, Pattern, Project, SampleInfo, SampleSource, Tab, TabTarget } from "./types";
import { DUCK_ALL, KEYS_TRACK, PAD_COUNT, PATTERN_COUNT, TRACK_COUNT } from "./types";

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
  sourcePad: 0,
  zones: [],
  multiName: "",
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

export const emptyPattern = (): Pattern => ({ bars: 1, events: [] });

export const defaultProject = (): Project => ({
  name: "Untitled",
  bpm: 92,
  swing: 54,
  pads: Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i)),
  keys: defaultKeys(),
  patterns: Array.from({ length: PATTERN_COUNT }, emptyPattern),
  song: [{ pattern: 0, repeats: 1 }],
  mutes: Array(TRACK_COUNT).fill(false),
  solos: Array(TRACK_COUNT).fill(false),
  levels: Array(TRACK_COUNT).fill(1),
  duck: { on: false, source: 0, target: DUCK_ALL, depth: 0.7, attack: 0.005, release: 0.2 },
});

/** Bumped when the saved project shape changes; files from a newer version are refused. */
export const PROJECT_VERSION = 1;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
/** Exactly `length` entries: saved values where they have the right type, defaults for the rest. */
const fixedArray = <T>(v: unknown, length: number, fallback: T, ok: (x: unknown) => boolean): T[] =>
  Array.from({ length }, (_, i) => (Array.isArray(v) && ok(v[i]) ? (v[i] as T) : fallback));

function normalizePattern(raw: unknown, seen: Set<string>): Pattern {
  if (!isObj(raw)) return emptyPattern();
  const bars = num(Math.round(Number(raw.bars)), 1, 4, 1);
  const events = (Array.isArray(raw.events) ? raw.events : []).flatMap((e): NoteEvent[] => {
    if (!isObj(e) || typeof e.tick !== "number" || e.tick < 0 || e.tick >= bars * BAR_TICKS) return [];
    if (typeof e.track !== "number" || e.track < 0 || e.track >= TRACK_COUNT) return [];
    // Old "Double" copies shared ids with their originals; give any repeat a fresh one.
    let id = typeof e.id === "string" ? e.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return [{ id, tick: e.tick, track: e.track, note: num(e.note, 0, 127, 60), vel: num(e.vel, 1, 127, 100), len: num(e.len, 1, Number.MAX_SAFE_INTEGER, 1) }];
  });
  return { bars, events };
}

function normalizeDuck(raw: unknown, d: DuckSettings): DuckSettings {
  if (!isObj(raw)) return d;
  return {
    on: typeof raw.on === "boolean" ? raw.on : d.on,
    source: Math.round(num(raw.source, 0, PAD_COUNT - 1, d.source)),
    target: Math.round(num(raw.target, DUCK_ALL, TRACK_COUNT - 1, d.target)),
    depth: num(raw.depth, 0, 1, d.depth),
    attack: num(raw.attack, 0, 0.05, d.attack),
    release: num(raw.release, 0.02, 1, d.release),
  };
}

/** Rebuild a saved or imported project on top of the defaults, so fields added later (or damaged ones) can't break playback. */
export function normalizeProject(raw: unknown): Project {
  const d = defaultProject();
  if (!isObj(raw)) return d;
  const keys = isObj(raw.keys) ? raw.keys : {};
  const seen = new Set<string>();
  return {
    name: typeof raw.name === "string" ? raw.name : d.name,
    bpm: num(raw.bpm, 40, 240, d.bpm),
    swing: num(raw.swing, 50, 75, d.swing),
    pads: normalizePads(Array.isArray(raw.pads) ? raw.pads.map((p) => (isObj(p) ? p : {})) : []),
    keys: {
      ...d.keys,
      ...keys,
      sourcePad: num(keys.sourcePad, 0, PAD_COUNT - 1, d.keys.sourcePad),
      zones: Array.isArray(keys.zones) ? keys.zones.filter((z) => isObj(z) && typeof z.sampleId === "string" && typeof z.root === "number") : [],
      synth: { ...d.keys.synth, ...(isObj(keys.synth) ? keys.synth : {}) },
    } as KeysInstrument,
    patterns: Array.from({ length: PATTERN_COUNT }, (_, i) => normalizePattern(Array.isArray(raw.patterns) ? raw.patterns[i] : undefined, seen)),
    song: Array.isArray(raw.song)
      ? raw.song.flatMap((st) => (isObj(st) && typeof st.pattern === "number" && st.pattern >= 0 && st.pattern < PATTERN_COUNT ? [{ pattern: st.pattern, repeats: num(st.repeats, 1, 64, 1) }] : []))
      : d.song,
    mutes: fixedArray(raw.mutes, TRACK_COUNT, false, (x) => typeof x === "boolean"),
    solos: fixedArray(raw.solos, TRACK_COUNT, false, (x) => typeof x === "boolean"),
    levels: fixedArray(raw.levels, TRACK_COUNT, 1, (x) => typeof x === "number" && x >= 0 && x <= 1),
    duck: normalizeDuck(raw.duck, d.duck),
  };
}

export interface AppState {
  project: Project;
  samples: Record<string, SampleInfo>;
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
  selectedPad: number;
  selectedTrack: number;
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
  chop: ChopSession | null;
  /** False while the browser keeps audio suspended (no click or key press on the page yet). */
  audioReady: boolean;
  undo: Project[];
}

export const store = createStore<AppState>(() => ({
  project: defaultProject(),
  samples: {},
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
  selectedTrack: 0,
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

export function updatePad(i: number, patch: Partial<Pad>, undoable = false) {
  updateProject((p) => ({ ...p, pads: p.pads.map((pad, j) => (j === i ? { ...pad, ...patch } : pad)) }), undoable);
}

export function updateKeys(patch: Partial<KeysInstrument>) {
  updateProject((p) => ({ ...p, keys: { ...p.keys, ...patch } }), false);
}

export function updatePattern(index: number, fn: (pat: Pattern) => Pattern, undoable = true) {
  updateProject((p) => ({ ...p, patterns: p.patterns.map((pat, j) => (j === index ? fn(pat) : pat)) }), undoable);
}

export const patternLength = (pat: Pattern) => pat.bars * BAR_TICKS;

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function addEvent(patternIndex: number, ev: Omit<NoteEvent, "id">, undoable = false): NoteEvent {
  const full = { ...ev, id: newId() };
  updatePattern(patternIndex, (pat) => ({ ...pat, events: [...pat.events, full] }), undoable);
  return full;
}

export function setEventLength(patternIndex: number, id: string, len: number) {
  updatePattern(patternIndex, (pat) => ({
    ...pat,
    events: pat.events.map((e) => (e.id === id ? { ...e, len: Math.max(1, len) } : e)),
  }), false);
}

// Toggle a step on a track: removes any event inside [tick, tick+span), else adds one.
export function toggleStep(patternIndex: number, track: number, tick: number, span: number, note = 60, vel = 100) {
  updatePattern(patternIndex, (pat) => {
    const hit = pat.events.filter((e) => e.track === track && e.tick >= tick && e.tick < tick + span);
    if (hit.length) {
      const ids = new Set(hit.map((e) => e.id));
      return { ...pat, events: pat.events.filter((e) => !ids.has(e.id)) };
    }
    return { ...pat, events: [...pat.events, { id: newId(), tick, track, note, vel, len: span }] };
  });
}

export function clearTrack(patternIndex: number, track: number) {
  updatePattern(patternIndex, (pat) => ({ ...pat, events: pat.events.filter((e) => e.track !== track) }));
}

/** Overwrite pattern `to` with a copy of `from` (fresh event ids, so the two never share notes). Undoable. */
export function copyPattern(from: number, to: number) {
  if (from === to) return;
  updatePattern(to, () => {
    const src = get().project.patterns[from];
    return { bars: src.bars, events: src.events.map((e) => ({ ...e, id: newId() })) };
  });
}

export function trackAudible(p: Project, track: number) {
  const anySolo = p.solos.some(Boolean);
  return anySolo ? p.solos[track] : !p.mutes[track];
}

export function toggleArray(key: "mutes" | "solos", track: number) {
  updateProject((p) => ({ ...p, [key]: p[key].map((v, i) => (i === track ? !v : v)) }), false);
}

export { KEYS_TRACK };
