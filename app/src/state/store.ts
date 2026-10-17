import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { COLOR } from "../midi/protocol";
import { BAR_TICKS } from "../seq/timing";
import type { HwMode, KeysInstrument, NoteEvent, Pad, Pattern, Project, SampleInfo } from "./types";
import { KEYS_TRACK, PAD_COUNT, PATTERN_COUNT, TRACK_COUNT } from "./types";

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
});

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
  sampleSource: "input" | "master";
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

export function trackAudible(p: Project, track: number) {
  const anySolo = p.solos.some(Boolean);
  return anySolo ? p.solos[track] : !p.mutes[track];
}

export function toggleArray(key: "mutes" | "solos", track: number) {
  updateProject((p) => ({ ...p, [key]: p[key].map((v, i) => (i === track ? !v : v)) }), false);
}

export { KEYS_TRACK };
