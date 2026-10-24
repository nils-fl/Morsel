// Encoder pages: what each of the 8 encoders edits, with formatting.
import { DECAY_MAX, cutoffHz, padQDb, synthQDb } from "./audio/dsp";
import type { Visual } from "./modes/notify";
import { BAR_TICKS, GRID_OPTIONS, MAX_BARS, PPQN, QUANTIZE_OPTIONS, REPEAT_OPTIONS, STEP_TICKS, gridLabel, pageSteps } from "./seq/timing";
import { clipStep, defaultDuck, doubleClip, drumPads, get, setClipGrid, stepPages, inputOf, keysTrack, padDucks, parseInput, setDuckPad, setTrackBars, setTrackDuck, toggleSidechainInput, trackBars, selectedTrack, set, trackById, updateKeys, updatePad, updateProject, updateTrack } from "./state/store";
import { MAX_TRACKS, type KeysLfo, type Pad, type SampleInfo, type SidechainInput, type SynthParams, type TrackDuck, type TrackFx, type TrackKind, type Wave } from "./state/types";
import { allPresets, applyPreset, currentKit, kitNames, stepKit } from "./actions";
import { jumpFolder, presetEdited } from "./audio/synthPresets";
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
    // Shift jumps to the next / previous folder (Bass, Lead, Keys…).
    nudge: (d, fine) => {
      const list = allPresets();
      applyPreset(list[fine ? jumpFolder(list, presetIndex(), d > 0 ? 1 : -1) : clamp(presetIndex() + Math.sign(d), 0, list.length - 1)]);
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

/** The selected track's loop length in the current pattern. */
const curPattern = () => get().project.patterns[get().currentPattern];
const curBars = () => trackBars(curPattern(), get().selectedTrack);
const curPages = () => stepPages(curPattern(), get().selectedTrack);
const curGrid = () => clipStep(curPattern(), get().selectedTrack);
const barsText = (n: number) => `${n} bar${n === 1 ? "" : "s"}`;
let lastBarsTurn = -Infinity;
let lastShiftBarsTurn = -Infinity;

/** Where a page of step pads starts: "3" (bar 3), or "3.3" (bar 3, beat 3) when a page is half a bar. */
export function stepPageLabel(page = get().stepPage) {
  const step = curGrid();
  const tick = page * pageSteps(step) * step;
  const bar = Math.floor(tick / BAR_TICKS) + 1;
  return pageSteps(step) * step < BAR_TICKS ? `${bar}.${(tick % BAR_TICKS) / PPQN + 1}` : String(bar);
}

const GRID: Param = {
  name: "Grid",
  value: () => Math.max(0, GRID_OPTIONS.findIndex((g) => g.ticks === curGrid())),
  range: [0, GRID_OPTIONS.length - 1],
  nudge: (d) => {
    const i = clamp(GRID.value() + Math.sign(d), 0, GRID_OPTIONS.length - 1);
    setClipGrid(get().currentPattern, get().selectedTrack, GRID_OPTIONS[i].ticks);
  },
  format: () => gridLabel(curGrid()),
};

/** Step mode's own page: the selected track's length and the page on the pads, swing, quantize and the step grid. */
const STEP_PAGE_DEF: Page = {
  name: "Step",
  tag: "STEP",
  stepOnly: true,
  summary: () => `${curBars()}bar${curBars() === 1 ? "" : "s"} Sw${get().project.swing} Q${QUANTIZE.format()}${curGrid() === STEP_TICKS ? "" : ` ${gridLabel(curGrid())}`}`,
  params: [
    {
      name: "Bars",
      value: () => curBars(),
      range: [1, MAX_BARS],
      nudge: (d, fine) => {
        if (fine) {
          // Shift: double the loop (its notes repeat) or halve it. A turn's detents arrive together, so one turn is one step.
          const now = performance.now();
          const first = now - lastShiftBarsTurn > 400;
          lastShiftBarsTurn = now;
          if (!first) return;
          if (d > 0) doubleClip(get().currentPattern, get().selectedTrack);
          else if (curBars() > 1) setTrackBars(get().currentPattern, get().selectedTrack, Math.ceil(curBars() / 2));
          return;
        }
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
      nudge: (d) => set({ stepPage: clamp(get().stepPage + Math.sign(d), 0, curPages() - 1) }),
      format: () => `${stepPageLabel()}/${curBars()}`,
    },
    SWING,
    QUANTIZE,
    GRID,
  ],
};

/** The Duck page's encoders 1-6, on every track. */
const DUCK_PARAMS: Param[] = [
  {
    name: "Duck",
    value: () => (duckNow().on ? 1 : 0),
    range: [0, 1],
    nudge: (d) => setDuck({ on: d > 0 }),
    format: () => (duckNow().on ? "On" : "Off"),
  },
  {
    name: "Input",
    value: () => Math.max(0, duckInputs().indexOf(duckNow().input)),
    get range(): [number, number] {
      return [0, Math.max(1, duckInputs().length - 1)];
    },
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
  nudge: (d) => setDuckPad(get().selectedTrack, get().selectedPad, d > 0),
  format: () => {
    const t = selectedTrack(), pad = get().selectedPad;
    if (t.duck.input === inputOf(t.id, pad)) return `P${pad + 1} input`;
    return `P${pad + 1} ${padDucks(t, pad) ? "ducks" : "off"}`;
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
  STEP_PAGE_DEF,
];

export const DUCK_PAGE = PAGES.findIndex((p) => p.tag === "DUCK");
export const SIDECHAIN_PAGE = PAGES.findIndex((p) => p.tag === "SIDE");
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

/** Where a page that the other track kind doesn't show goes: a drum track's Sidechain (inputs) to the keys track's Duck. */
const PAGE_PAIRS: Record<string, string> = { SIDE: "DUCK" };

/** Keep the encoder page on one the selected track shows: the paired page (Sidechain -> Duck), else the first (Kit or Keys). */
export function fixPage() {
  const s = get();
  const list = pagesFor(selectedTrack(s).kind);
  if (list.includes(s.encPage)) return;
  const pair = PAGES.findIndex((p) => p.tag === PAGE_PAIRS[PAGES[s.encPage]?.tag]);
  set({ encPage: list.includes(pair) ? pair : list[0] });
}


/** Apply an encoder move (the mixer follows the project through the store subscription in boot.ts). */
export function turnEncoder(page: number, index: number, delta: number, fine: boolean) {
  const p = PAGES[page]?.params[index];
  if (!p) return null;
  p.nudge(delta, fine);
  return p;
}
