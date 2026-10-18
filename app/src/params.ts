// Encoder pages: what each of the 8 encoders edits, with formatting.
import { DECAY_MAX, cutoffHz, padQDb, synthQDb } from "./audio/dsp";
import type { Visual } from "./modes/notify";
import { QUANTIZE_OPTIONS, REPEAT_OPTIONS } from "./seq/timing";
import { drumPads, get, keysTrack, setPatternBars, parseDuckTarget, selectedTrack, set, trackById, updateKeys, updatePad, updateProject, updateTrack } from "./state/store";
import { DUCK_ALL, MAX_TRACKS, PAD_COUNT, type DuckSettings, type DuckTarget, type KeysLfo, type Pad, type SynthParams, type TrackFx, type TrackKind, type Wave } from "./state/types";
import { allPresets, applyPreset, currentKit, kitNames, stepKit } from "./actions";
import { presetEdited } from "./audio/synthPresets";
import { noteName } from "./ui/notes";

export interface Param {
  name: string;
  value(): number;
  /** Apply one encoder detent (sign = direction, fine = shift held). */
  nudge(delta: number, fine: boolean): void;
  format(): string;
  /** Value range, for drawing the knob on screen. */
  range?: [number, number];
  /** Optional graphic shown on the Launchkey screen while turning. */
  visual?(): Visual;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  return `${withTrack && t ? `${t.name} ` : ""}P${pad + 1} ${t?.pads[pad]?.name ?? ""}`.trim();
}

/** "All", a track name, or "Drums P1 Kick" for a duck target. */
export function duckTargetLabel(target: DuckTarget) {
  const parsed = parseDuckTarget(target);
  if (!parsed) return "All";
  if (parsed.pad !== null) return padLabel(parsed.track, parsed.pad, get().project.tracks.filter((t) => t.kind === "drum").length > 1);
  return trackById(get().project, parsed.track)?.name ?? "?";
}

/** Short form for the screen footer: "All", "T2" or "T1P3". */
function duckTargetShort(target: DuckTarget) {
  const parsed = parseDuckTarget(target);
  if (!parsed) return "All";
  const n = get().project.tracks.findIndex((t) => t.id === parsed.track) + 1;
  return parsed.pad === null ? `T${n}` : `T${n}P${parsed.pad + 1}`;
}

export const duckSourceLabel = () => padLabel(duckNow().sourceTrack, duckNow().sourcePad, get().project.tracks.filter((t) => t.kind === "drum").length > 1);

/** Targets in encoder order: all others, each whole track, then each pad of each drum track. */
export function duckTargets(): DuckTarget[] {
  const tracks = get().project.tracks;
  return [DUCK_ALL, ...tracks.map((t) => t.id), ...tracks.filter((t) => t.kind === "drum").flatMap((t) => Array.from({ length: PAD_COUNT }, (_, i) => `${t.id}:${i}`))];
}

/** Duck sources in encoder order: each pad of each drum track. */
function duckSources() {
  return get().project.tracks.filter((t) => t.kind === "drum").flatMap((t) => Array.from({ length: PAD_COUNT }, (_, pad) => ({ track: t.id, pad })));
}

const duckNow = () => get().project.duck;
export const setDuck = (patch: Partial<DuckSettings>) => updateProject((p) => ({ ...p, duck: { ...p.duck, ...patch } }), false);
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

const sourceIndex = () => Math.max(0, duckSources().findIndex((x) => x.track === duckNow().sourceTrack && x.pad === duckNow().sourcePad));

// ---------- track FX (selected track) ----------

const FX_FILTERS: TrackFx["filter"][] = ["off", "lp", "hp", "bp"];
export const FX_FILTER_NAMES: Record<TrackFx["filter"], string> = { off: "Off", lp: "Lowpass", hp: "Highpass", bp: "Bandpass" };
const fxNow = () => selectedTrack().fx;
export const setFx = (patch: Partial<TrackFx>, trackId = selectedTrack().id) => updateTrack(trackId, (t) => ({ ...t, fx: { ...t.fx, ...patch } }));
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

type FxNumKey = Exclude<keyof TrackFx, "filter">;
function fxParam(name: string, key: FxNumKey, lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => fxNow()[key];
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => setFx({ [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) }),
    format: () => fmt(cur()),
  };
}

// ---------- keys page, per sound source ----------

const SYNTH_PARAMS: Param[] = [
  {
    name: "Preset",
    value: presetIndex,
    // A getter: the list grows when you save presets.
    get range(): [number, number] {
      return [0, Math.max(1, allPresets().length - 1)];
    },
    nudge: (d) => {
      const list = allPresets();
      applyPreset(list[clamp(presetIndex() + Math.sign(d), 0, list.length - 1)]);
    },
    format: presetLabel,
  },
  {
    name: "Waves",
    value: () => WAVES.indexOf(keysNow().synth.wave) * 4 + WAVES.indexOf(keysNow().synth.wave2),
    range: [0, 15],
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

/** Library samples in the order the Keys sample picker steps through them. */
export const keysSampleList = () =>
  Object.values(get().samples).sort((a, b) => `${a.folder ?? ""}/${a.name}`.localeCompare(`${b.folder ?? ""}/${b.name}`, undefined, { numeric: true }));
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
      updateKeys({ sample: { ...keysNow().sample, sampleId: list[clamp(i + Math.sign(d), 0, list.length - 1)].id } });
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
    nudge: (d) => {
      const list = sourcePads();
      const next = list[clamp(sourcePadIndex() + Math.sign(d), 0, list.length - 1)];
      if (next) updateKeys({ sourceTrack: next.track, sourcePad: next.pad });
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

const curPattern = () => get().project.patterns[get().currentPattern];
const barsText = (n: number) => `${n} bar${n === 1 ? "" : "s"}`;
let lastBarsTurn = -Infinity;

/** Step mode's own page: the pattern's length and the bar on the pads, plus swing and quantize. */
const STEP_PAGE_DEF: Page = {
  name: "Step",
  tag: "STEP",
  stepOnly: true,
  summary: () => `${curPattern().bars}bar${curPattern().bars === 1 ? "" : "s"} Sw${get().project.swing} Q${QUANTIZE.format()}`,
  params: [
    {
      name: "Bars",
      value: () => curPattern().bars,
      range: [1, 4],
      nudge: (d) => {
        const bars = clamp(curPattern().bars + Math.sign(d), 1, 4);
        if (bars === curPattern().bars) return;
        // Shrinking drops the notes past the end; turns in quick succession share one undo step.
        const now = performance.now();
        setPatternBars(get().currentPattern, bars, now - lastBarsTurn > 2000);
        lastBarsTurn = now;
      },
      format: () => barsText(curPattern().bars),
    },
    {
      name: "Bar",
      value: () => get().stepPage + 1,
      get range(): [number, number] {
        return [1, Math.max(2, curPattern().bars)];
      },
      nudge: (d) => set({ stepPage: clamp(get().stepPage + Math.sign(d), 0, curPattern().bars - 1) }),
      format: () => `${get().stepPage + 1}/${curPattern().bars}`,
    },
    SWING,
    QUANTIZE,
  ],
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
      return `Reso ${Math.round(p.resonance * 100)}% Pan ${panText(p.pan)}`;
    },
    params: [
      { ...padParam("Resonance", "resonance", 0, 1, 0.01, pct), visual: padFilterVisual },
      padParam("Pan", "pan", -1, 1, 0.02, panText),
    ],
  },
  {
    name: "Keys",
    tag: "KEYS",
    kind: "keys",
    // The encoders follow the keys track's sound source: synth, one sample, a drum pad or a multisample.
    summary: () => {
      const k = keysNow();
      if (k.type === "synth") return `Synth: ${presetLabel()}`;
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
  {
    name: "Track FX",
    tag: "FX",
    summary: () => {
      const t = selectedTrack();
      return `${t.name} ${t.fx.filter === "off" ? "" : t.fx.filter.toUpperCase() + " "}Dr${pct(t.fx.drive)}`;
    },
    params: [
      {
        name: "Filter",
        value: () => FX_FILTERS.indexOf(fxNow().filter),
        range: [0, FX_FILTERS.length - 1],
        nudge: (d) => setFx({ filter: FX_FILTERS[clamp(FX_FILTERS.indexOf(fxNow().filter) + Math.sign(d), 0, FX_FILTERS.length - 1)] }),
        format: () => FX_FILTER_NAMES[fxNow().filter],
      },
      fxParam("Cutoff", "cutoff", 0, 1, 0.01, hz),
      fxParam("Reso", "resonance", 0, 1, 0.01, pct),
      fxParam("Low", "eqLow", -15, 15, 0.5, db),
      fxParam("Mid", "eqMid", -15, 15, 0.5, db),
      fxParam("High", "eqHigh", -15, 15, 0.5, db),
      fxParam("Drive", "drive", 0, 1, 0.01, pct),
      fxParam("Comp", "comp", 0, 1, 0.01, (v) => (v <= 0 ? "Off" : pct(v))),
    ],
  },
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
    name: "Duck",
    tag: "DUCK",
    // The sidechain input is a drum pad, so it is set from drum tracks.
    kind: "drum",
    summary: () => {
      const d = duckNow();
      const n = get().project.tracks.findIndex((t) => t.id === d.sourceTrack) + 1;
      return d.on ? `On T${n}P${d.sourcePad + 1}>${duckTargetShort(d.target)} ${pct(d.depth)}` : "Off";
    },
    params: [
      {
        name: "Duck",
        value: () => (duckNow().on ? 1 : 0),
        range: [0, 1],
        nudge: (d) => setDuck({ on: d > 0 }),
        format: () => (duckNow().on ? "On" : "Off"),
      },
      {
        name: "Input",
        value: sourceIndex,
        get range(): [number, number] {
          return [0, duckSources().length - 1];
        },
        nudge: (d) => {
          const list = duckSources();
          const next = list[clamp(sourceIndex() + Math.sign(d), 0, list.length - 1)];
          setDuck({ sourceTrack: next.track, sourcePad: next.pad });
        },
        format: duckSourceLabel,
      },
      {
        name: "Target",
        value: () => duckTargets().indexOf(duckNow().target),
        get range(): [number, number] {
          return [0, duckTargets().length - 1];
        },
        nudge: (d) => {
          const list = duckTargets();
          setDuck({ target: list[clamp(list.indexOf(duckNow().target) + Math.sign(d), 0, list.length - 1)] });
        },
        format: () => duckTargetLabel(duckNow().target),
      },
      duckParam("Depth", "depth", 0, 1, 0.02, pct),
      duckParam("Attack", "attack", 0, 0.05, 0.001, ms),
      duckParam("Hold", "hold", 0, 0.5, 0.01, ms),
      duckParam("Release", "release", 0.02, 1, 0.01, ms),
    ],
  },
  STEP_PAGE_DEF,
];
export const DUCK_PAGE = PAGES.findIndex((p) => p.tag === "DUCK");
export const STEP_PAGE = PAGES.findIndex((p) => p.tag === "STEP");

/** Indexes of the encoder pages a track of this kind shows, in order; in Step mode the Step page comes first. */
export function pagesFor(kind: TrackKind, step = get().hwMode === "step") {
  const fits = PAGES.flatMap((p, i) => (!p.kind || p.kind === kind ? [i] : []));
  return [...fits.filter((i) => step && PAGES[i].stepOnly), ...fits.filter((i) => !PAGES[i].stepOnly)];
}

/** The page `dir` steps from `page` among the selected track's pages (clamped), or `page` when there is none. */
export function stepPage(page: number, dir: 1 | -1, kind = selectedTrack().kind): number {
  const list = pagesFor(kind);
  const i = list.indexOf(page);
  if (i < 0) return list[0];
  return list[Math.max(0, Math.min(list.length - 1, i + dir))];
}

/** Keep the encoder page on one the selected track shows (Pad or Keys after switching kind). */
export function fixPage() {
  const s = get();
  if (!pagesFor(selectedTrack(s).kind).includes(s.encPage)) set({ encPage: pagesFor(selectedTrack(s).kind)[0] });
}


/** Apply an encoder move (the mixer follows the project through the store subscription in boot.ts). */
export function turnEncoder(page: number, index: number, delta: number, fine: boolean) {
  const p = PAGES[page]?.params[index];
  if (!p) return null;
  p.nudge(delta, fine);
  return p;
}
