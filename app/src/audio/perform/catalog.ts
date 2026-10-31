// What the Perform effects are and what their settings are: names, ranges, defaults and how they read. Shared by
// the app (encoders, screens) and the Perform processor (which turns the values into sound).
import { DELAY_TIMES, DIVISIONS, RATES, SPEEDS, type NoteValue } from "./notes";

export interface FxParam {
  name: string;
  /** Value range; option settings count options (0 .. options.length - 1). */
  min: number;
  max: number;
  def: number;
  /** Steps per encoder detent (Shift: a tenth). Option settings move one option per step. */
  step: number;
  options?: readonly string[];
  /** Units, for the readout: "%" shows 0..1 as a percentage. */
  unit?: "%" | "Hz" | "ms" | "bits";
}

export interface FxDef {
  name: string;
  /** Two letters, for the Launchkey screen's pad cells. */
  short: string;
  family: "time" | "mod" | "filter" | "color" | "space";
  params: FxParam[];
}

const pct = (name: string, def = 0.5): FxParam => ({ name, min: 0, max: 1, def, step: 0.02, unit: "%" });
const notes = (name: string, list: NoteValue[], def: string): FxParam => ({
  name, min: 0, max: list.length - 1, def: list.findIndex((v) => v.label === def), step: 1, options: list.map((v) => v.label),
});
const choice = (name: string, options: readonly string[], def = 0): FxParam => ({ name, min: 0, max: options.length - 1, def, step: 1, options });

export const COLOR_MODES = ["Cassette", "Flutter", "Tube Amp", "Vinyl", "Saturation", "Radio"] as const;
export const DELAY_MODES = ["Normal", "X-Feedback", "Ping-Pong"] as const;

/**
 * The 16 Pad FX, pad 1 first. Pressure on the pad sets how much of each is heard; the settings are the MPC Sample's
 * (its manual, p. 47-49).
 */
export const PAD_FX: FxDef[] = [
  { name: "Half Speed", short: "HS", family: "time", params: [choice("Speed", ["x1.5", "x2", "x4"], 1), pct("Mix", 1)] },
  { name: "Chorus", short: "CH", family: "mod", params: [
    { name: "Rate", min: 0.4, max: 3.2, def: 0.8, step: 0.04, unit: "Hz" }, pct("Depth", 0.6), pct("Feedback", 0.2),
  ] },
  { name: "Flanger", short: "FL", family: "mod", params: [
    { name: "Rate", min: 0.02, max: 10, def: 0.25, step: 0.02, unit: "Hz" }, pct("Depth", 0.7), pct("Feedback", 0.6),
  ] },
  { name: "Phaser", short: "PH", family: "mod", params: [pct("Feedback", 0.5), notes("Speed", SPEEDS, "1 bar"), pct("Range", 0.7)] },
  { name: "Comb Filter", short: "CF", family: "filter", params: [notes("Speed", SPEEDS, "1/2")] },
  { name: "LP Filter", short: "LP", family: "filter", params: [pct("Resonance", 0.5), notes("Speed", SPEEDS, "1 bar"), pct("Range", 0)] },
  { name: "HP Filter", short: "HP", family: "filter", params: [pct("Resonance", 0.5), notes("Speed", SPEEDS, "1 bar"), pct("Range", 0)] },
  { name: "BP Filter", short: "BP", family: "filter", params: [pct("Resonance", 0.5), notes("Speed", SPEEDS, "1/4"), pct("Range", 0.5)] },
  { name: "Ring Mod", short: "RM", family: "mod", params: [{ name: "Max Freq", min: 40, max: 400, def: 40, step: 4, unit: "Hz" }] },
  { name: "LoFi", short: "LF", family: "color", params: [
    { name: "Bitcrush", min: 2, max: 24, def: 8, step: 0.5, unit: "bits" }, pct("Decimator", 0.5),
  ] },
  { name: "Color", short: "CO", family: "color", params: [choice("Mode", COLOR_MODES)] },
  { name: "Granulator", short: "GR", family: "time", params: [
    { name: "Density", min: 1, max: 300, def: 150, step: 2, unit: "Hz" }, pct("Feedback", 0.2),
    { name: "Grain Len", min: 10, max: 200, def: 105, step: 2, unit: "ms" },
  ] },
  { name: "Beat Repeat", short: "BR", family: "time", params: [notes("Division", DIVISIONS, "1/16"), choice("Reverse", ["Off", "On"]), pct("Resonance", 0.5)] },
  { name: "Rev Stepper", short: "RS", family: "time", params: [notes("Delay Time", DIVISIONS, "1/4"), { name: "Repeats", min: 2, max: 8, def: 2, step: 1 }] },
  { name: "Delay", short: "DL", family: "space", params: [notes("Time", DELAY_TIMES, "1/4"), pct("Feedback", 0.5), choice("Range", DELAY_MODES)] },
  { name: "Reverb", short: "RV", family: "space", params: [
    { name: "Pre-Delay", min: 0, max: 250, def: 10, step: 5, unit: "ms" }, pct("Decay", 0.6), pct("Diffusion", 0.7),
  ] },
];

export const PAD_FX_COUNT = PAD_FX.length;
/** Pad FX that sound at once; a fifth bypasses the oldest until it is let go (as on the MPC Sample). */
export const MAX_PAD_FX = 4;

/** The Knob FX: one at a time on the master, played on the encoders while the pads go on playing. */
export const KNOB_FX: FxDef[] = [
  { name: "DJ Filter", short: "DJ", family: "filter", params: [
    { name: "Filter", min: -1, max: 1, def: 0, step: 0.02 }, pct("Resonance", 0.3),
  ] },
  { name: "Tape", short: "TP", family: "color", params: [pct("Wobble", 0.3), pct("Noise", 0.2), pct("Wow", 0.5)] },
  { name: "Vinyl", short: "VN", family: "color", params: [pct("Tone", 0.5), pct("Crackle", 0.5), pct("Wow", 0.4)] },
  { name: "Vintage", short: "VT", family: "color", params: [choice("Type", ["MPC3000", "MPC60", "SP1200", "SP1200Ring"])] },
  { name: "Pumper", short: "PU", family: "mod", params: [notes("Speed", RATES, "1/4"), pct("Shape", 0.5), pct("Depth", 0.7)] },
  { name: "Auto-Pan", short: "AP", family: "mod", params: [notes("Rate", RATES, "1/2"), pct("Depth", 0.8)] },
  { name: "Tape Delay", short: "TD", family: "space", params: [
    notes("Time", DELAY_TIMES, "1/8d"), pct("Feedback", 0.45), pct("Wow/Flut", 0.3),
  ] },
  { name: "Soft Clip", short: "SC", family: "color", params: [
    { name: "Drive", min: 0, max: 36, def: 6, step: 0.5 }, choice("Shape", ["Tanh", "Sine", "Parabolic"]),
  ] },
];

/** The Flex Beat bank: pad 1 is Empty (no change), pads 2-16 warp the mix's time and volume. */
export const FLEX_NAMES = [
  "Empty", "1 Bt Repeat", "1/2 Repeat", "1/4 Repeat", "1/8 Repeat", "Slow Down", "Speed Up", "Half Time",
  "Reverse", "Tape Stop", "Backspin", "Scratch", "1/8 Gate", "1/16 Gate", "Trance Gate", "Stutter Roll",
] as const;
export const FLEX_SHORT = ["--", "R1", "R2", "R4", "R8", "SD", "SU", "HT", "RV", "TS", "BS", "SC", "G8", "G6", "TG", "SR"];

export interface PerformSettings {
  /** The settings of each Pad FX, by pad (raw values: option settings hold the option's index). */
  pad: number[][];
  /** Flex Beat: one-shot (back to Empty when an effect ends) or loop; quantized starts; dry/wet. */
  flex: { oneShot: boolean; quantize: boolean; mix: number };
  /** The Knob FX picked, its settings by effect, its dry/wet, whether it is on and what it plays on. */
  knob: { kind: number; params: number[][]; mix: number; on: boolean; target: KnobTarget };
}

/** What the Knob FX plays on: the whole mix (with the send returns), the selected track (it follows the selection), or
 *  these tracks (by id). */
export type KnobTarget = "mix" | "selected" | string[];

export const defaultParams = (def: FxDef) => def.params.map((p) => p.def);

export function defaultPerform(): PerformSettings {
  return {
    pad: PAD_FX.map(defaultParams),
    flex: { oneShot: false, quantize: true, mix: 1 },
    knob: { kind: 0, params: KNOB_FX.map(defaultParams), mix: 1, on: false, target: "mix" },
  };
}

const clampTo = (p: FxParam, v: unknown) => {
  const x = typeof v === "number" && Number.isFinite(v) ? v : p.def;
  const c = Math.max(p.min, Math.min(p.max, x));
  return p.options ? Math.round(c) : c;
};

/** A saved project's settings, made whole: missing or broken values take the defaults. */
export function normalizePerform(raw: unknown): PerformSettings {
  const d = defaultPerform();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<PerformSettings>;
  const fx = (defs: FxDef[], rows: unknown) =>
    defs.map((def, i) => def.params.map((p, j) => clampTo(p, (Array.isArray(rows) ? rows[i] : undefined)?.[j])));
  const f = (r.flex ?? {}) as Partial<PerformSettings["flex"]>;
  const k = (r.knob ?? {}) as Partial<PerformSettings["knob"]>;
  return {
    pad: fx(PAD_FX, r.pad),
    flex: {
      oneShot: typeof f.oneShot === "boolean" ? f.oneShot : d.flex.oneShot,
      quantize: typeof f.quantize === "boolean" ? f.quantize : d.flex.quantize,
      mix: typeof f.mix === "number" ? Math.max(0, Math.min(1, f.mix)) : d.flex.mix,
    },
    knob: {
      kind: typeof k.kind === "number" ? Math.max(0, Math.min(KNOB_FX.length - 1, Math.round(k.kind))) : 0,
      params: fx(KNOB_FX, k.params),
      mix: typeof k.mix === "number" ? Math.max(0, Math.min(1, k.mix)) : 1,
      on: k.on === true,
      target: k.target === "selected" ? "selected"
        : Array.isArray(k.target) && k.target.length && k.target.every((x) => typeof x === "string") ? [...new Set(k.target)] : "mix",
    },
  };
}

/** A setting as the screens show it. */
export function formatParam(p: FxParam, v: number) {
  if (p.options) return p.options[Math.round(v)] ?? "";
  switch (p.unit) {
    case "%": return `${Math.round(v * 100)}%`;
    case "Hz": return v < 10 ? `${v.toFixed(2)} Hz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`;
    case "ms": return `${Math.round(v)} ms`;
    case "bits": return `${v.toFixed(1)} bit`;
    default: return Math.abs(v - Math.round(v)) < 1e-6 ? `${Math.round(v)}` : v.toFixed(2);
  }
}

/** The tracks the Knob FX plays on, by id ("all": the whole mix). Tracks that are gone are left out; when none is left
 *  it plays on the whole mix. */
export function knobTracks(target: KnobTarget, trackIds: readonly string[], selected: string): "all" | Set<string> {
  if (target === "mix") return "all";
  const ids = target === "selected" ? [selected] : target;
  const there = ids.filter((id) => trackIds.includes(id));
  return there.length ? new Set(there) : "all";
}
