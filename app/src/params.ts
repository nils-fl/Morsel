// Encoder pages: what each of the 8 encoders edits, with formatting.
import { DECAY_MAX, cutoffHz, padQDb, synthQDb } from "./audio/dsp";
import { eqMidHz, fxChain } from "./audio/fxUnits";
import { reverbSeconds } from "./audio/reverb";
import { crushHold } from "./audio/worklet/crushCore";
import type { Visual } from "./modes/notify";
import { BAR_TICKS, GRID_OPTIONS, MAX_BARS, PPQN, QUANTIZE_OPTIONS, REPEAT_OPTIONS, STEP_TICKS, gridLabel, pageSteps } from "./seq/timing";
import { updatePerform, clipStep, defaultDuck, doubleClip, drumNoteName, drumPads, get, keysStepNote, quantizeToGrid, setFxOn, setFxParams, setClipGrid, stepPages, inputOf, keysTrack, padDucks, parseInput, setDuckPad, setTrackBars, setTrackDuck, toggleSidechainInput, trackBars, selectedTrack, set, trackById, updateKeys, updatePad, updateProject, updateTrack } from "./state/store";
import { FX_KINDS, MAX_TRACKS, PAD_COUNT, isKeyChop, type FxKind, type KeysLfo, type Pad, type SampleInfo, type SidechainInput, type SynthParams, type TrackDuck, type TrackFx, type TrackKind, type Wave } from "./state/types";
import { allPresets, applyPreset, currentKit, kitNames, stepKit } from "./actions";
import { jumpFolder, presetEdited } from "./audio/synthPresets";
import { noteName } from "./ui/notes";
import { FLEX_NAMES, KNOB_FX, PAD_FX, formatParam, type FxParam } from "./audio/perform/catalog";

/** The Knob FX picked. */
const knobName = () => KNOB_FX[get().project.perform.knob.kind]?.name ?? "";

export interface Param {
  name: string;
  value(): number;
  /** Apply one encoder detent (sign = direction, fine = shift held). */
  nudge(delta: number, fine: boolean): void;
  format(): string;
  /** Value range, for drawing the knob on screen. */
  range?: [number, number];
  /** Detents per step, for a param with only a few settings (on/off, bars, grid), so a quick turn doesn't run through
   *  them all. The first detent of a turn steps straight away. */
  detents?: number;
  /** Optional graphic shown on the Launchkey screen while turning. */
  visual?(): Visual;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Detents per step of a param with only a few settings. */
const STEPPED = 4;

function padParam(name: string, key: keyof Pad & ("start" | "end" | "pitch" | "attack" | "decay" | "cutoff" | "hpCutoff" | "resonance" | "pan" | "volume"),
  lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => drumPads()[get().selectedPad][key] as number;
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => updatePad(get().selectedPad, { [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) }),
    format: () => fmt(cur()),
  };
}

/** The selected pad's choke group: Off or 1-4 (pads in a group cut each other off). */
const CHOKE_PARAM: Param = {
  name: "Choke",
  value: () => drumPads()[get().selectedPad].choke,
  range: [0, 4],
  detents: STEPPED,
  nudge: (d) => updatePad(get().selectedPad, { choke: clamp(drumPads()[get().selectedPad].choke + Math.sign(d), 0, 4) }),
  format: () => {
    const g = drumPads()[get().selectedPad].choke;
    return g ? `Group ${g}` : "Off";
  },
};

/** An LFO setting of the keys track; rates move in bigger steps the faster they get. */
function lfoParam(name: string, key: keyof KeysLfo, lo: number, hi: number, step: number, fmt: (v: number) => string, log = false): Param {
  const cur = () => keysNow().lfo[key];
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => {
      const s = step * (fine ? 0.1 : 1);
      const next = log ? cur() * Math.pow(1 + s, d) : cur() + d * s;
      updateKeys({ lfo: { ...keysNow().lfo, [key]: clamp(Math.round(next * 1000) / 1000, lo, hi) } });
    },
    format: () => fmt(cur()),
  };
}

type SynthNumKey = { [K in keyof SynthParams]: SynthParams[K] extends number ? K : never }[keyof SynthParams];

function synthParam(name: string, key: SynthNumKey, lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => keysNow().synth[key] as number;
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => updateKeys({ synth: { ...keysNow().synth, [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) } }),
    format: () => fmt(cur()),
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const rateHz = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`;
export const hz = (c: number) => {
  const f = cutoffHz(c);
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
};
/** A ducker's gain (0..1) as its reduction in dB. */
export const duckText = (gain: number) => (gain > 0.995 ? "0.0 dB" : `${(20 * Math.log10(Math.max(gain, 1e-3))).toFixed(1)} dB`);
const padFilterVisual = (): Visual => {
  const pad = padNow();
  return {
    kind: "filter",
    lpHz: pad.cutoff >= 1 ? null : cutoffHz(pad.cutoff),
    hpHz: pad.hpCutoff <= 0 ? null : cutoffHz(pad.hpCutoff),
    qDb: padQDb(pad.resonance),
  };
};
const synthFilterVisual = (): Visual => {
  const s = keysNow().synth;
  return { kind: "filter", lpHz: cutoffHz(s.cutoff), hpHz: null, qDb: synthQDb(s.resonance) };
};
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

function optionParam(name: string, options: { label: string; ticks: number }[], key: "quantize" | "repeatRate"): Param {
  const idx = () => Math.max(0, options.findIndex((o) => o.ticks === get()[key]));
  return {
    name,
    value: idx,
    range: [0, options.length - 1],
    detents: STEPPED,
    nudge: (d) => set({ [key]: options[clamp(idx() + Math.sign(d), 0, options.length - 1)].ticks }),
    format: () => options[idx()].label,
  };
}

export interface Page {
  name: string;
  /** Short tag for the screen's footer. */
  tag: string;
  params: Param[];
  /** One-line summary of the page's values for the screen footer. */
  summary(): string;
  /** Only shown on tracks of this kind; pages without one are on every track. */
  kind?: TrackKind;
  /** Only in Step mode, where it comes first. */
  stepOnly?: boolean;
  /** An effect's settings: only shown while the track has it on, right after the FX page, in chain order. */
  fx?: FxKind;
  /** Only in Perform mode, where it comes first. */
  performOnly?: boolean;
}

const panText = (v: number) => (Math.abs(v) < 0.01 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
const padNow = () => drumPads()[get().selectedPad];

// ---------- keys synth ----------

const WAVES: Wave[] = ["sawtooth", "square", "triangle", "sine"];
const WAVE_SHORT: Record<Wave, string> = { sawtooth: "Saw", square: "Sqr", triangle: "Tri", sine: "Sin" };
const keysNow = () => keysTrack().keys!;
const presetIndex = () => Math.max(0, allPresets().findIndex((p) => p.name === keysNow().preset));

/** "Warm Pad", with a * once edited (or the sample / "Pad sample" / "Multisample" when Keys isn't the synth). */
export function presetLabel() {
  const k = keysNow();
  if (k.type === "sample") return keysSampleName();
  if (k.type !== "synth") return k.type === "chromatic" ? "Pad sample" : "Multisample";
  const p = allPresets().find((x) => x.name === k.preset);
  return `${k.preset}${presetEdited(k.synth, p) ? "*" : ""}`;
}

const cents = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)} ct`;

// ---------- sidechain ducker ----------

/** "P1 Kick" for a pad of a drum track; with `withTrack`, "Drums P1 Kick". */
export function padLabel(trackId: string, pad: number, withTrack = false) {
  const t = trackById(get().project, trackId);
  if (t && isKeyChop(pad)) return `${withTrack ? `${t.name} ` : ""}${drumNoteName(t, pad)}`;
  return `${withTrack && t ? `${t.name} ` : ""}P${pad + 1} ${t?.pads[pad]?.name ?? ""}`.trim();
}

/** "In2 P1 Kick" (with the track's name when there are several drum tracks), or "None". */
export function inputLabel(input: SidechainInput | null) {
  const p = get().project;
  const n = input === null ? -1 : p.sidechain.indexOf(input);
  if (input === null || n < 0) return "None";
  const { track, pad } = parseInput(input);
  return `In${n + 1} ${padLabel(track, pad, p.tracks.filter((t) => t.kind === "drum").length > 1)}`;
}

/** The selected drum pad's input number (1-based), or 0 when it isn't one. */
const padInput = () => get().project.sidechain.indexOf(inputOf(get().selectedTrack, get().selectedPad)) + 1;

/** The selected track's ducker. */
const duckNow = () => selectedTrack().duck ?? defaultDuck();
/** Drum tracks: how many pads dip ("12p"). */
const duckedPads = () => {
  const t = selectedTrack();
  return t.kind === "drum" ? t.pads.filter((_, i) => padDucks(t, i)).length : 0;
};
export const setDuck = (patch: Partial<TrackDuck>) => setTrackDuck(get().selectedTrack, patch);
export const duckVisual = (): Visual => {
  const d = duckNow();
  return { kind: "duck", depth: d.depth, attack: d.attack, hold: d.hold, release: d.release };
};

function duckParam(name: string, key: "depth" | "attack" | "hold" | "release", lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => duckNow()[key];
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => setDuck({ [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) }),
    format: () => fmt(cur()),
    visual: duckVisual,
  };
}

/** Inputs a keys track can pick, in encoder order: none, then Input 1, 2, … */
const duckInputs = (): (SidechainInput | null)[] => [null, ...get().project.sidechain];

// ---------- the FX rack (selected track) ----------

export const FX_NAMES: Record<FxKind, string> = {
  filter: "Filter", eq: "EQ", drive: "Drive", comp: "Comp", chorus: "Chorus", delay: "Delay", reverb: "Reverb", crush: "Crush",
};
const FX_SHORT: Record<FxKind, string> = { filter: "Flt", eq: "EQ", drive: "Drv", comp: "Cmp", chorus: "Cho", delay: "Dly", reverb: "Rev", crush: "Cr" };
const FX_TAGS: Record<FxKind, string> = { filter: "FLT", eq: "EQ", drive: "DRV", comp: "COMP", chorus: "CHOR", delay: "DLY", reverb: "VERB", crush: "CRSH" };
export const FX_FILTER_NAMES: Record<TrackFx["filter"]["type"], string> = { lp: "Lowpass", hp: "Highpass", bp: "Bandpass" };
/** Delay times in 16ths, for the track delay and the send. */
export const DELAY_TIMES = [1, 2, 3, 4, 6, 8, 12, 16];
export const delayName = (n: number) => ({ 1: "1/16", 2: "1/8", 3: "1/8 dot", 4: "1/4", 6: "1/4 dot", 8: "1/2", 12: "1/2 dot", 16: "1 bar" })[n] ?? `${n}/16`;
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const hzText = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const toneWord = (v: number) => (v < 0.34 ? "Dark" : v < 0.67 ? "Warm" : "Bright");

/** One setting of an effect: a number, one of a few values, or a switch. The encoder pages and the Mixer use them. */
export type FxSetting =
  | { type: "num"; name: string; key: string; lo: number; hi: number; step: number; fmt: (v: number) => string; whole?: boolean }
  | { type: "pick"; name: string; key: string; options: readonly (string | number)[]; fmt: (v: string | number) => string }
  | { type: "switch"; name: string; key: string };
const num = (name: string, key: string, lo: number, hi: number, step: number, fmt: (v: number) => string, whole = false): FxSetting =>
  ({ type: "num", name, key, lo, hi, step, fmt, whole });
const pick = (name: string, key: string, options: readonly (string | number)[], fmt: (v: string | number) => string): FxSetting =>
  ({ type: "pick", name, key, options, fmt });

/** Each effect's settings, in encoder order on its page. */
export const FX_SETTINGS: Record<FxKind, FxSetting[]> = {
  filter: [
    pick("Type", "type", ["lp", "hp", "bp"], (v) => FX_FILTER_NAMES[v as TrackFx["filter"]["type"]]),
    num("Cutoff", "cutoff", 0, 1, 0.01, hz),
    num("Reso", "resonance", 0, 1, 0.01, pct),
  ],
  eq: [num("Low", "low", -15, 15, 0.5, db), num("Mid", "mid", -15, 15, 0.5, db), num("High", "high", -15, 15, 0.5, db), num("Mid Hz", "midFreq", 0, 1, 0.01, (v) => hzText(eqMidHz(v)))],
  drive: [num("Amount", "amount", 0, 1, 0.01, pct), num("Tone", "tone", 0, 1, 0.01, (v) => (v >= 1 ? "Open" : pct(v))), num("Mix", "mix", 0, 1, 0.01, pct)],
  comp: [
    num("Thresh", "threshold", -60, 0, 0.5, (v) => `${v.toFixed(1)} dB`),
    num("Ratio", "ratio", 1, 20, 0.1, (v) => `${v.toFixed(1)}:1`),
    num("Attack", "attack", 0.001, 0.2, 0.001, ms),
    num("Release", "release", 0.02, 1, 0.01, ms),
    num("Makeup", "makeup", 0, 24, 0.5, db),
  ],
  chorus: [num("Rate", "rate", 0.05, 5, 0.05, rateHz), num("Depth", "depth", 0, 1, 0.01, pct), num("Mix", "mix", 0, 1, 0.01, pct)],
  delay: [
    pick("Time", "time", DELAY_TIMES, (v) => delayName(v as number)),
    num("Feedback", "feedback", 0, 0.95, 0.01, pct),
    num("Tone", "tone", 0, 1, 0.01, pct),
    num("Mix", "mix", 0, 1, 0.01, pct),
    { type: "switch", name: "Ping-pong", key: "pingpong" },
  ],
  reverb: [num("Size", "size", 0, 1, 0.01, (v) => `${reverbSeconds(v).toFixed(1)} s`), num("Decay", "decay", 0, 1, 0.01, pct), num("Tone", "tone", 0, 1, 0.01, toneWord), num("Mix", "mix", 0, 1, 0.01, pct)],
  crush: [num("Bits", "bits", 1, 16, 1, (v) => `${v} bit`, true), num("Rate", "rate", 0, 1, 0.01, (v) => `1/${crushHold(v)}`), num("Mix", "mix", 0, 1, 0.01, pct)],
};

/** A setting's value on a track. */
export const fxValue = (fx: TrackFx, kind: FxKind, key: string) => (fx[kind] as unknown as Record<string, number | string | boolean>)[key];
/** Set one of an effect's settings (not an undo step, like other tweaks). */
export const setFxValue = (kind: FxKind, key: string, v: number | string | boolean, trackId?: string) =>
  setFxParams(kind, { [key]: v } as never, trackId);
/** A setting's value shown as text. */
export function fxText(s: FxSetting, v: number | string | boolean) {
  if (s.type === "switch") return v ? "On" : "Off";
  return s.type === "num" ? s.fmt(v as number) : s.fmt(v as string | number);
}

const fxNow = () => selectedTrack().fx;

/** An effect's setting on the selected track as an encoder. */
function fxSettingParam(kind: FxKind, s: FxSetting): Param {
  const cur = () => fxValue(fxNow(), kind, s.key);
  const base = { name: s.name, format: () => fxText(s, cur()) };
  if (s.type === "num") {
    return {
      ...base,
      value: () => cur() as number,
      range: [s.lo, s.hi],
      ...(s.whole && { detents: STEPPED }),
      nudge: (d, fine) => {
        const v = cur() as number;
        setFxValue(kind, s.key, s.whole ? clamp(Math.round(v) + Math.sign(d), s.lo, s.hi) : clamp(v + d * s.step * (fine ? 0.1 : 1), s.lo, s.hi));
      },
    };
  }
  if (s.type === "pick") {
    const i = () => Math.max(0, s.options.indexOf(cur() as string | number));
    return {
      ...base,
      value: i,
      range: [0, s.options.length - 1],
      detents: STEPPED,
      nudge: (d) => setFxValue(kind, s.key, s.options[clamp(i() + Math.sign(d), 0, s.options.length - 1)]),
    };
  }
  return { ...base, value: () => (cur() ? 1 : 0), range: [0, 1], detents: STEPPED, nudge: (d) => setFxValue(kind, s.key, d > 0) };
}

/** The FX page's encoders, one per effect (kept, so a turn's detents add up across redraws): right on, left off. */
const FX_SWITCHES = Object.fromEntries(FX_KINDS.map((k): [FxKind, Param] => [k, {
  name: FX_NAMES[k],
  value: () => (fxNow().on[k] ? 1 : 0),
  range: [0, 1],
  detents: STEPPED,
  nudge: (d) => setFxOn(k, d > 0),
  format: () => (fxNow().on[k] ? "On" : "Off"),
}])) as Record<FxKind, Param>;

/** The FX rack: encoders 1-8 switch the effects on and off, in the chain's order (drag them in the app to change it). */
const FX_PAGE: Page = {
  name: "Track FX",
  tag: "FX",
  summary: () => fxChain(fxNow()).map((k) => FX_SHORT[k]).join(">") || "All off",
  get params() {
    return fxNow().order.map((k) => FX_SWITCHES[k]);
  },
};

/** A page per effect, with its settings; the screen footer sums up the first two. */
const FX_PAGES: Page[] = FX_KINDS.map((k) => ({
  name: FX_NAMES[k],
  tag: FX_TAGS[k],
  fx: k,
  summary: () => FX_SETTINGS[k].slice(0, 2).map((s) => fxText(s, fxValue(fxNow(), k, s.key))).join(" "),
  params: FX_SETTINGS[k].map((s) => fxSettingParam(k, s)),
}));

// ---------- keys page, per sound source ----------

const SYNTH_PARAMS: Param[] = [
  {
    name: "Preset",
    value: presetIndex,
    // A getter: the list grows when you save presets.
    get range(): [number, number] {
      return [0, Math.max(1, allPresets().length - 1)];
    },
    // Shift jumps to the next / previous folder (Bass, Lead, Keys…).
    nudge: (d, fine) => {
      const list = allPresets();
      applyPreset(list[fine ? jumpFolder(list, presetIndex(), d > 0 ? 1 : -1) : clamp(presetIndex() + Math.sign(d), 0, list.length - 1)], freshSoundTurn());
    },
    format: presetLabel,
  },
  {
    name: "Waves",
    value: () => WAVES.indexOf(keysNow().synth.wave) * 4 + WAVES.indexOf(keysNow().synth.wave2),
    range: [0, 15],
    detents: STEPPED,
    nudge: (d) => {
      const s = keysNow().synth;
      const i = clamp(WAVES.indexOf(s.wave) * 4 + WAVES.indexOf(s.wave2) + Math.sign(d), 0, 15);
      updateKeys({ synth: { ...s, wave: WAVES[Math.floor(i / 4)], wave2: WAVES[i % 4] } });
    },
    format: () => `${WAVE_SHORT[keysNow().synth.wave]}+${WAVE_SHORT[keysNow().synth.wave2]}`,
  },
  synthParam("Detune", "detune", -2400, 2400, 5, cents),
  { ...synthParam("Cutoff", "cutoff", 0, 1, 0.01, hz), visual: synthFilterVisual },
  { ...synthParam("Reso", "resonance", 0, 1, 0.01, pct), visual: synthFilterVisual },
  synthParam("Env", "envAmount", 0, 1, 0.01, pct),
  synthParam("Attack", "attack", 0.001, 2, 0.01, ms),
  synthParam("Release", "release", 0.01, 3, 0.02, ms),
];

// Sorted once per library change: the screen asks for it on every redraw.
let sortedFor: object | null = null;
let sorted: SampleInfo[] = [];

/** Library samples in the order the Keys sample picker steps through them. */
export function keysSampleList() {
  const samples = get().samples;
  if (sortedFor !== samples) {
    sortedFor = samples;
    sorted = Object.values(samples).sort((a, b) => `${a.folder ?? ""}/${a.name}`.localeCompare(`${b.folder ?? ""}/${b.name}`, undefined, { numeric: true }));
  }
  return sorted;
}
const keysSampleName = () => {
  const id = keysNow().sample.sampleId;
  return id ? (get().samples[id]?.name ?? "Sample") : "No sample";
};

function sampleParam(name: string, key: "attack" | "release" | "cutoff" | "resonance", lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => keysNow().sample[key];
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => updateKeys({ sample: { ...keysNow().sample, [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) } }),
    format: () => fmt(cur()),
  };
}

const SAMPLE_PARAMS: Param[] = [
  {
    name: "Sample",
    value: () => keysSampleList().findIndex((x) => x.id === keysNow().sample.sampleId),
    get range(): [number, number] {
      return [0, Math.max(1, keysSampleList().length - 1)];
    },
    nudge: (d) => {
      const list = keysSampleList();
      if (!list.length) return;
      const i = list.findIndex((x) => x.id === keysNow().sample.sampleId);
      updateKeys({ sample: { ...keysNow().sample, sampleId: list[clamp(i + Math.sign(d), 0, list.length - 1)].id } }, undefined, freshSoundTurn());
    },
    format: keysSampleName,
  },
  {
    name: "Root",
    value: () => keysNow().sample.root,
    range: [12, 108],
    nudge: (d) => updateKeys({ sample: { ...keysNow().sample, root: clamp(keysNow().sample.root + Math.sign(d), 12, 108) } }),
    format: () => noteName(keysNow().sample.root),
  },
  sampleParam("Attack", "attack", 0, 2, 0.01, ms),
  sampleParam("Release", "release", 0.01, 2, 0.02, ms),
  sampleParam("Cutoff", "cutoff", 0, 1, 0.01, (v) => (v >= 1 ? "Open" : hz(v))),
  sampleParam("Reso", "resonance", 0, 1, 0.01, pct),
];

/** Drum pads a "Pad sample" keys track can play, in track order. */
const sourcePads = () => get().project.tracks.filter((t) => t.kind === "drum").flatMap((t) => t.pads.map((_, pad) => ({ track: t.id, pad })));
const sourcePadIndex = () => sourcePads().findIndex((x) => x.track === keysNow().sourceTrack && x.pad === keysNow().sourcePad);
function sourcePadLabel() {
  const k = keysNow();
  const n = get().project.tracks.findIndex((t) => t.id === k.sourceTrack) + 1;
  return `T${n}P${k.sourcePad + 1} ${trackById(get().project, k.sourceTrack)?.pads[k.sourcePad].name ?? "?"}`;
}

const CHROMATIC_PARAMS: Param[] = [
  {
    name: "Source pad",
    value: sourcePadIndex,
    get range(): [number, number] {
      return [0, Math.max(1, sourcePads().length - 1)];
    },
    detents: STEPPED,
    nudge: (d) => {
      const list = sourcePads();
      const next = list[clamp(sourcePadIndex() + Math.sign(d), 0, list.length - 1)];
      if (next) updateKeys({ sourceTrack: next.track, sourcePad: next.pad }, undefined, freshSoundTurn());
    },
    format: sourcePadLabel,
  },
];

const SWING: Param = {
  name: "Swing",
  value: () => get().project.swing,
  range: [50, 75],
  nudge: (d) => updateProject((p) => ({ ...p, swing: clamp(p.swing + d, 50, 75) }), false),
  format: () => `${get().project.swing}%`,
};
const QUANTIZE = optionParam("Quantize", QUANTIZE_OPTIONS, "quantize");

// ---------- step page ----------

/** The selected track's loop length in the current pattern. */
const curPattern = () => get().project.patterns[get().currentPattern];
const curBars = () => trackBars(curPattern(), get().selectedTrack);
const curPages = () => stepPages(curPattern(), get().selectedTrack);
const curGrid = () => clipStep(curPattern(), get().selectedTrack);
const barsText = (n: number) => `${n} bar${n === 1 ? "" : "s"}`;
let lastBarsTurn = -Infinity;
/** When an encoder last loaded a sound onto the keys: turns in quick succession share one undo step. */
let lastSoundTurn = -Infinity;
function freshSoundTurn() {
  const now = performance.now(), fresh = now - lastSoundTurn > 2000;
  lastSoundTurn = now;
  return fresh;
}
let lastDoubleTurn = -Infinity;

/** Where a page of step pads starts: "3" (bar 3), or "3.3" (bar 3, beat 3) when a page is half a bar. */
export function stepPageLabel(page = get().stepPage) {
  const step = curGrid();
  const tick = page * pageSteps(step) * step;
  const bar = Math.floor(tick / BAR_TICKS) + 1;
  return pageSteps(step) * step < BAR_TICKS ? `${bar}.${(tick % BAR_TICKS) / PPQN + 1}` : String(bar);
}

/** Double the selected track's loop (right; its notes repeat) or halve it (left). A turn's detents arrive together,
 *  so one turn is one step. */
const DOUBLE: Param = {
  name: "Double",
  value: () => curBars(),
  range: [1, MAX_BARS],
  nudge: (d) => {
    const now = performance.now();
    const first = now - lastDoubleTurn > 400;
    lastDoubleTurn = now;
    if (!first) return;
    if (d > 0) doubleClip(get().currentPattern, get().selectedTrack);
    else if (curBars() > 1) setTrackBars(get().currentPattern, get().selectedTrack, Math.ceil(curBars() / 2));
  },
  format: () => barsText(curBars()),
};

/** Turn right: the selected track's notes onto its step grid (a turn is one go, like Double). */
let lastQuantTurn = -Infinity;
const SNAP: Param = {
  name: "Quant",
  value: () => 0,
  range: [0, 1],
  nudge: (d) => {
    const now = performance.now();
    const first = now - lastQuantTurn > 400;
    lastQuantTurn = now;
    if (first && d > 0) quantizeToGrid();
  },
  format: () => `> ${gridLabel(curGrid())}`,
};

const STEP_VEL: Param = {
  name: "Vel",
  value: () => get().stepVel,
  range: [1, 127],
  nudge: (d, fine) => set({ stepVel: clamp(get().stepVel + d * (fine ? 1 : 2), 1, 127) }),
  format: () => String(get().stepVel),
};

/** What the step pads write: the selected pad (drum track) or the step note (keys track), without playing it first. */
const STEP_SOUND: Param = {
  get name() {
    return selectedTrack().kind === "drum" ? "Pad" : "Note";
  },
  value: () => (selectedTrack().kind === "drum" ? get().selectedPad : keysStepNote(selectedTrack())),
  get range(): [number, number] {
    return selectedTrack().kind === "drum" ? [0, PAD_COUNT - 1] : [0, 127];
  },
  get detents() {
    return selectedTrack().kind === "drum" ? STEPPED : 1;
  },
  nudge: (d) => {
    const t = selectedTrack();
    if (t.kind === "drum") set({ selectedPad: clamp(get().selectedPad + Math.sign(d), 0, PAD_COUNT - 1) });
    else set({ stepNote: clamp(keysStepNote(t) + Math.sign(d), 0, 127) });
  },
  format: () => (selectedTrack().kind === "drum" ? padLabel(get().selectedTrack, get().selectedPad) : noteName(keysStepNote(selectedTrack()))),
};

const GRID: Param = {
  name: "Grid",
  value: () => Math.max(0, GRID_OPTIONS.findIndex((g) => g.ticks === curGrid())),
  range: [0, GRID_OPTIONS.length - 1],
  detents: STEPPED,
  nudge: (d) => {
    const i = clamp(GRID.value() + Math.sign(d), 0, GRID_OPTIONS.length - 1);
    setClipGrid(get().currentPattern, get().selectedTrack, GRID_OPTIONS[i].ticks);
  },
  format: () => gridLabel(curGrid()),
};

/**
 * Step mode's own page: the selected track's length and the page on the pads, swing, quantizing its notes, the step
 * grid, Double, the velocity of new steps and what they write (pad or note).
 */
const STEP_PAGE_DEF: Page = {
  name: "Step",
  tag: "STEP",
  stepOnly: true,
  summary: () => `${curBars()}bar${curBars() === 1 ? "" : "s"} Sw${get().project.swing} V${get().stepVel}${curGrid() === STEP_TICKS ? "" : ` ${gridLabel(curGrid())}`}`,
  params: [
    {
      name: "Bars",
      value: () => curBars(),
      range: [1, MAX_BARS],
      detents: STEPPED,
      nudge: (d) => {
        const bars = clamp(curBars() + Math.sign(d), 1, MAX_BARS);
        if (bars === curBars()) return;
        // Shrinking drops the notes past the end; turns in quick succession share one undo step.
        const now = performance.now();
        setTrackBars(get().currentPattern, get().selectedTrack, bars, now - lastBarsTurn > 2000);
        lastBarsTurn = now;
      },
      format: () => barsText(curBars()),
    },
    {
      name: "Page",
      value: () => get().stepPage + 1,
      get range(): [number, number] {
        return [1, Math.max(2, curPages())];
      },
      detents: STEPPED,
      nudge: (d) => set({ stepPage: clamp(get().stepPage + Math.sign(d), 0, curPages() - 1) }),
      format: () => `${stepPageLabel()}/${curBars()}`,
    },
    SWING,
    SNAP,
    GRID,
    DOUBLE,
    STEP_VEL,
    STEP_SOUND,
  ],
};

/** The Duck page's encoders 1-6, on every track. */
const DUCK_PARAMS: Param[] = [
  {
    name: "Duck",
    value: () => (duckNow().on ? 1 : 0),
    range: [0, 1],
    detents: STEPPED,
    nudge: (d) => setDuck({ on: d > 0 }),
    format: () => (duckNow().on ? "On" : "Off"),
  },
  {
    name: "Input",
    value: () => Math.max(0, duckInputs().indexOf(duckNow().input)),
    get range(): [number, number] {
      return [0, Math.max(1, duckInputs().length - 1)];
    },
    detents: STEPPED,
    nudge: (d) => {
      const list = duckInputs();
      setDuck({ input: list[clamp(list.indexOf(duckNow().input) + Math.sign(d), 0, list.length - 1)] });
    },
    format: () => inputLabel(duckNow().input),
  },
  duckParam("Depth", "depth", 0, 1, 0.02, pct),
  duckParam("Attack", "attack", 0, 0.05, 0.001, ms),
  duckParam("Hold", "hold", 0, 0.5, 0.01, ms),
  duckParam("Release", "release", 0.02, 1, 0.01, ms),
];

/** Drum tracks: whether the selected pad dips (the input pad never does). */
const DUCK_PAD_PARAM: Param = {
  name: "Pad",
  value: () => (padDucks(selectedTrack(), get().selectedPad) ? 1 : 0),
  range: [0, 1],
  detents: STEPPED,
  nudge: (d) => setDuckPad(get().selectedTrack, get().selectedPad, d > 0),
  format: () => {
    const t = selectedTrack(), pad = get().selectedPad;
    if (t.duck.input === inputOf(t.id, pad)) return `P${pad + 1} input`;
    return `P${pad + 1} ${padDucks(t, pad) ? "ducks" : "off"}`;
  },
};

/** One setting of a Perform effect, read and written through `get` / `put` (raw values as in catalog.ts). */
function performParam(p: FxParam, get: () => number, put: (v: number) => void): Param {
  return {
    name: p.name,
    value: get,
    range: [p.min, p.max],
    detents: p.options ? STEPPED : undefined,
    nudge: (d, fine) => {
      const step = p.options ? Math.sign(d) : d * p.step * (fine ? 0.1 : 1);
      const v = clamp(get() + step, p.min, p.max);
      put(p.options ? Math.round(v) : Math.round(v * 10000) / 10000);
    },
    format: () => formatParam(p, get()),
  };
}

const setRow = (rows: number[][], i: number, j: number, v: number) => rows.map((r, k) => (k === i ? r.map((x, m) => (m === j ? v : x)) : r));

/** Perform mode's page: the settings of the Pad FX touched last, or Flex Beat's (the bank on the pads). */
const PERFORM_PAGE_DEF: Page = {
  name: "Perform",
  tag: "PERF",
  performOnly: true,
  summary: () => {
    const s = get();
    if (s.perform.bank === "flex") {
      const f = s.project.perform.flex;
      return `${FLEX_NAMES[s.perform.flex]} ${f.oneShot ? "1shot" : "loop"}${f.quantize ? " Q" : ""}`;
    }
    const fx = s.perform.selected;
    return `${PAD_FX[fx].name}`;
  },
  get params(): Param[] {
    const s = get();
    if (s.perform.bank === "flex") {
      const flex = () => get().project.perform.flex;
      return [
        {
          name: "Mode", value: () => (flex().oneShot ? 0 : 1), range: [0, 1], detents: STEPPED,
          nudge: (d) => updatePerform((p) => ({ ...p, flex: { ...p.flex, oneShot: d < 0 } })),
          format: () => (flex().oneShot ? "One Shot" : "Loop"),
        },
        {
          name: "Quantize", value: () => (flex().quantize ? 1 : 0), range: [0, 1], detents: STEPPED,
          nudge: (d) => updatePerform((p) => ({ ...p, flex: { ...p.flex, quantize: d > 0 } })),
          format: () => (flex().quantize ? "Bar" : "Off"),
        },
        performParam({ name: "Mix", min: 0, max: 1, def: 1, step: 0.02, unit: "%" }, () => flex().mix, (v) => updatePerform((p) => ({ ...p, flex: { ...p.flex, mix: v } }))),
      ];
    }
    const fx = s.perform.selected;
    return PAD_FX[fx].params.map((prm, j) =>
      performParam(prm, () => get().project.perform.pad[fx][j], (v) => updatePerform((p) => ({ ...p, pad: setRow(p.pad, fx, j, v) }))));
  },
};

/** The Knob FX: one effect on the whole mix, on the encoders while the pads go on playing (any mode). */
const KNOB_PAGE_DEF: Page = {
  name: "Knob FX",
  tag: "KNOB",
  summary: () => {
    const k = get().project.perform.knob;
    return `${knobName()} ${k.on ? "on" : "off"}`;
  },
  get params(): Param[] {
    const knob = () => get().project.perform.knob;
    const kind = knob().kind;
    return [
      {
        name: "Effect", value: () => knob().kind, range: [0, KNOB_FX.length - 1], detents: STEPPED,
        nudge: (d) => updatePerform((p) => ({ ...p, knob: { ...p.knob, kind: clamp(p.knob.kind + Math.sign(d), 0, KNOB_FX.length - 1) } })),
        format: () => knobName(),
      },
      {
        name: "On", value: () => (knob().on ? 1 : 0), range: [0, 1], detents: STEPPED,
        nudge: (d) => updatePerform((p) => ({ ...p, knob: { ...p.knob, on: d > 0 } })),
        format: () => (knob().on ? "On" : "Off"),
      },
      performParam({ name: "Mix", min: 0, max: 1, def: 1, step: 0.02, unit: "%" }, () => knob().mix, (v) => updatePerform((p) => ({ ...p, knob: { ...p.knob, mix: v } }))),
      ...KNOB_FX[kind].params.map((prm, j) =>
        performParam(prm, () => get().project.perform.knob.params[kind][j], (v) => updatePerform((p) => ({ ...p, knob: { ...p.knob, params: setRow(p.knob.params, kind, j, v) } })))),
    ];
  },
};

export const PAGES: Page[] = [
  {
    // Like the Keys page's presets: encoder 1 loads the previous / next kit as you turn.
    name: "Kit",
    tag: "KIT",
    kind: "drum",
    summary: () => currentKit() || "No kit",
    params: [
      {
        name: "Kit",
        value: () => kitNames().indexOf(currentKit()),
        get range(): [number, number] {
          return [0, Math.max(1, kitNames().length - 1)];
        },
        nudge: (d) => void stepKit(d),
        format: () => currentKit() || "None",
      },
    ],
  },
  {
    name: "Pad",
    tag: "PAD",
    kind: "drum",
    summary: () => {
      const p = padNow();
      return `S${Math.round(p.start * 100)} E${Math.round(p.end * 100)} ${p.pitch > 0 ? "+" : ""}${Math.round(p.pitch * 10) / 10}st`;
    },
    params: [
      padParam("Start", "start", 0, 1, 0.002, pct),
      padParam("End", "end", 0, 1, 0.002, pct),
      padParam("Pitch", "pitch", -24, 24, 1, (v) => `${v > 0 ? "+" : ""}${v.toFixed(Number.isInteger(v) ? 0 : 1)} st`),
      padParam("Attack", "attack", 0, 1, 0.005, ms),
      padParam("Decay", "decay", 0.02, DECAY_MAX, 0.02, (v) => (v >= DECAY_MAX ? "Full" : ms(v))),
      // HP left of LP, matching the filter curve on screen.
      { ...padParam("HP Filter", "hpCutoff", 0, 1, 0.01, (v) => (v <= 0 ? "Off" : hz(v))), visual: padFilterVisual },
      { ...padParam("LP Filter", "cutoff", 0, 1, 0.01, (v) => (v >= 1 ? "Open" : hz(v))), visual: padFilterVisual },
      padParam("Volume", "volume", 0, 1, 0.01, pct),
    ],
  },
  {
    name: "Pad 2",
    tag: "PAD2",
    kind: "drum",
    summary: () => {
      const p = padNow();
      return `Reso ${Math.round(p.resonance * 100)}% Pan ${panText(p.pan)} ${p.choke ? `Ch${p.choke}` : "NoCh"}`;
    },
    params: [
      { ...padParam("Resonance", "resonance", 0, 1, 0.01, pct), visual: padFilterVisual },
      padParam("Pan", "pan", -1, 1, 0.02, panText),
      CHOKE_PARAM,
    ],
  },
  {
    name: "Keys",
    tag: "KEYS",
    kind: "keys",
    // The encoders follow the keys track's sound source: synth, one sample, a drum pad or a multisample.
    summary: () => {
      const k = keysNow();
      if (k.type === "synth") return `${allPresets().find((p) => p.name === k.preset)?.folder ?? "Synth"}: ${presetLabel()}`;
      if (k.type === "sample") return `Smp: ${keysSampleName()} ${noteName(k.sample.root)}`;
      if (k.type === "chromatic") return `Pad: ${sourcePadLabel()}`;
      return `Multi: ${k.multiName || "none"}`;
    },
    get params(): Param[] {
      const t = keysNow().type;
      return t === "synth" ? SYNTH_PARAMS : t === "sample" ? SAMPLE_PARAMS : t === "chromatic" ? CHROMATIC_PARAMS : [];
    },
  },
  {
    name: "Keys LFO",
    tag: "LFO",
    kind: "keys",
    summary: () => {
      const l = keysNow().lfo;
      return `Vib ${l.vibDepth ? rateHz(l.vibRate) : "off"} Flt ${l.filterDepth ? rateHz(l.filterRate) : "off"}`;
    },
    params: [
      lfoParam("Vib Rate", "vibRate", 0.1, 20, 0.08, rateHz, true),
      // No "±": the screen font is ASCII only.
      lfoParam("Vib Depth", "vibDepth", 0, 1, 0.02, (v) => (v ? `${Math.round(v * 100)} ct` : "Off")),
      lfoParam("Filt Rate", "filterRate", 0.1, 20, 0.08, rateHz, true),
      lfoParam("Filt Depth", "filterDepth", 0, 1, 0.02, (v) => (v ? `${(v * 2).toFixed(1)} oct` : "Off")),
      {
        name: "Volume",
        value: () => keysNow().volume,
        range: [0, 1],
        nudge: (d, fine) => updateKeys({ volume: clamp(keysNow().volume + d * (fine ? 0.001 : 0.01), 0, 1) }),
        format: () => pct(keysNow().volume),
      },
    ],
  },
  FX_PAGE,
  {
    name: "Mix",
    tag: "MIX",
    summary: () => get().project.tracks.map((t) => Math.round(t.level * 9)).join(""),
    // Encoders 1-8 = track levels 1-8.
    params: Array.from({ length: MAX_TRACKS }, (_, i): Param => {
      const t = () => get().project.tracks[i];
      return {
        get name() {
          return t()?.name ?? `Track ${i + 1}`;
        },
        value: () => t()?.level ?? 0,
        range: [0, 1],
        nudge: (d, fine) => {
          const tr = t();
          if (tr) updateTrack(tr.id, { level: clamp(tr.level + d * (fine ? 0.002 : 0.02), 0, 1) });
        },
        format: () => (t() ? pct(t().level) : "-"),
      };
    }),
  },
  {
    name: "Global",
    tag: "GLB",
    summary: () => `${get().project.bpm}BPM Sw${get().project.swing}`,
    params: [
      {
        name: "Tempo",
        value: () => get().project.bpm,
        range: [40, 240],
        nudge: (d, fine) => updateProject((p) => ({ ...p, bpm: clamp(Math.round((p.bpm + d * (fine ? 0.1 : 1)) * 10) / 10, 40, 240) }), false),
        format: () => `${get().project.bpm} BPM`,
      },
      SWING,
      QUANTIZE,
      optionParam("Repeat", REPEAT_OPTIONS, "repeatRate"),
    ],
  },
  {
    name: "Sidechain",
    tag: "SIDE",
    // Drum pads are the sidechain inputs: hit a pad to pick it, encoder 1 makes it an input.
    kind: "drum",
    summary: () => {
      const n = padInput();
      return `P${get().selectedPad + 1} ${n ? `In${n}` : "Off"} (${get().project.sidechain.length} in)`;
    },
    params: [
      {
        name: "Input",
        value: () => (padInput() ? 1 : 0),
        range: [0, 1],
        detents: STEPPED,
        nudge: (d) => {
          if ((d > 0) !== !!padInput()) toggleSidechainInput(get().selectedTrack, get().selectedPad);
        },
        format: () => (padInput() ? `Input ${padInput()}` : "Off"),
      },
    ],
  },
  {
    name: "Duck",
    tag: "DUCK",
    // Every track ducks from one of the drum pads made sidechain inputs: a keys track as a whole, a drum track the
    // pads it ducks (encoder 7 switches the selected pad; hit a pad to pick it).
    summary: () => {
      const d = duckNow();
      const n = d.input === null ? 0 : get().project.sidechain.indexOf(d.input) + 1;
      const pads = selectedTrack().kind === "drum" ? ` ${duckedPads()}p` : "";
      return d.on ? `On ${n ? `In${n}` : "no input"} ${pct(d.depth)}${pads}` : "Off";
    },
    get params(): Param[] {
      return selectedTrack().kind === "drum" ? [...DUCK_PARAMS, DUCK_PAD_PARAM] : DUCK_PARAMS;
    },
  },
  KNOB_PAGE_DEF,
  STEP_PAGE_DEF,
  PERFORM_PAGE_DEF,
  // The effects' own pages (pagesFor puts them after FX, in chain order, while they are on).
  ...FX_PAGES,
];

export const DUCK_PAGE = PAGES.findIndex((p) => p.tag === "DUCK");
export const SIDECHAIN_PAGE = PAGES.findIndex((p) => p.tag === "SIDE");
export const STEP_PAGE = PAGES.findIndex((p) => p.tag === "STEP");
export const PERFORM_PAGE = PAGES.findIndex((p) => p.tag === "PERF");
export const KNOB_PAGE = PAGES.findIndex((p) => p.tag === "KNOB");

/** Indexes of the encoder pages a track of this kind shows, in order; in Step mode the Step page comes first. */
export const FX_PAGE_INDEX = PAGES.indexOf(FX_PAGE);

/**
 * Indexes of the encoder pages a track of this kind shows, in order; in Step mode the Step page comes first. The
 * selected track's effects that are on follow the FX page, in chain order.
 */
export function pagesFor(kind: TrackKind, step = get().hwMode === "step", perform = get().hwMode === "perform") {
  const fits = PAGES.flatMap((p, i) => ((!p.kind || p.kind === kind) && !p.fx ? [i] : []));
  const effects = fxChain(selectedTrack().fx).map((k) => PAGES.findIndex((p) => p.fx === k));
  fits.splice(fits.indexOf(FX_PAGE_INDEX) + 1, 0, ...effects);
  const first = fits.filter((i) => (step && PAGES[i].stepOnly) || (perform && PAGES[i].performOnly));
  return [...first, ...fits.filter((i) => !PAGES[i].stepOnly && !PAGES[i].performOnly)];
}

/** The page `dir` steps from `page` among the selected track's pages (clamped), or `page` when there is none. */
export function stepPage(page: number, dir: 1 | -1, kind = selectedTrack().kind): number {
  const list = pagesFor(kind);
  const i = list.indexOf(page);
  if (i < 0) return list[0];
  return list[Math.max(0, Math.min(list.length - 1, i + dir))];
}

/** Where a page that the other track kind doesn't show goes: a drum track's Sidechain (inputs) to the keys track's Duck. */
const PAGE_PAIRS: Record<string, string> = { SIDE: "DUCK" };

/** Keep the encoder page on one the selected track shows: the paired page (Sidechain -> Duck), else the first (Kit or Keys). */
export function fixPage() {
  const s = get();
  const list = pagesFor(selectedTrack(s).kind);
  if (list.includes(s.encPage)) return;
  // An effect switched off: back to the rack.
  if (PAGES[s.encPage]?.fx) return set({ encPage: FX_PAGE_INDEX });
  const pair = PAGES.findIndex((p) => p.tag === PAGE_PAIRS[PAGES[s.encPage]?.tag]);
  set({ encPage: list.includes(pair) ? pair : list[0] });
}


/** Where each stepped param's turn is: detents towards the next step, its direction and when the last one came. */
const turns = new Map<Param, { acc: number; dir: number; at: number }>();
/** A pause this long (ms) ends a turn. */
const TURN_GAP = 300;

/** Apply an encoder move (the mixer follows the project through the store subscription in boot.ts). `whole`: the delta
 *  counts in steps, not detents (the arrow keys on the on-screen encoders). */
export function turnEncoder(page: number, index: number, delta: number, fine: boolean, whole = false) {
  const p = PAGES[page]?.params[index];
  if (!p) return null;
  const n = p.detents ?? 1;
  if (n === 1 || whole || !delta) {
    p.nudge(delta, fine);
    return p;
  }
  const now = performance.now(), dir = Math.sign(delta);
  const t = turns.get(p);
  // A new turn, or one that changes direction, steps on its first detent; then every n detents.
  const acc = (t && t.dir === dir && now - t.at < TURN_GAP ? t.acc : n - 1) + Math.abs(delta);
  const steps = Math.floor(acc / n);
  turns.set(p, { acc: acc - steps * n, dir, at: now });
  for (let k = 0; k < steps; k++) p.nudge(dir, fine);
  return p;
}
