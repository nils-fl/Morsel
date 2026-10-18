// Encoder pages: what each of the 8 encoders edits, with formatting.
import { DECAY_MAX, cutoffHz, padQDb, synthQDb } from "./audio/dsp";
import type { Visual } from "./modes/notify";
import { engine } from "./audio/engine";
import { QUANTIZE_OPTIONS, REPEAT_OPTIONS } from "./seq/timing";
import { get, set, updateKeys, updatePad, updateProject } from "./state/store";
import { DUCK_ALL, KEYS_TRACK, PAD_COUNT, type DuckSettings, type Pad, type SynthParams, type Wave } from "./state/types";
import { allPresets, applyPreset } from "./actions";
import { presetEdited } from "./audio/synthPresets";

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
  const cur = () => get().project.pads[get().selectedPad][key] as number;
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => updatePad(get().selectedPad, { [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) }),
    format: () => fmt(cur()),
  };
}

type SynthNumKey = { [K in keyof SynthParams]: SynthParams[K] extends number ? K : never }[keyof SynthParams];

function synthParam(name: string, key: SynthNumKey, lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
  const cur = () => get().project.keys.synth[key] as number;
  return {
    name,
    value: cur,
    range: [lo, hi],
    nudge: (d, fine) => updateKeys({ synth: { ...get().project.keys.synth, [key]: clamp(cur() + d * step * (fine ? 0.1 : 1), lo, hi) } }),
    format: () => fmt(cur()),
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
export const hz = (c: number) => {
  const f = cutoffHz(c);
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
};
const padFilterVisual = (): Visual => {
  const pad = get().project.pads[get().selectedPad];
  return {
    kind: "filter",
    lpHz: pad.cutoff >= 1 ? null : cutoffHz(pad.cutoff),
    hpHz: pad.hpCutoff <= 0 ? null : cutoffHz(pad.hpCutoff),
    qDb: padQDb(pad.resonance),
  };
};
const synthFilterVisual = (): Visual => {
  const s = get().project.keys.synth;
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
}

const panText = (v: number) => (Math.abs(v) < 0.01 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
const padNow = () => get().project.pads[get().selectedPad];

// ---------- keys synth ----------

const WAVES: Wave[] = ["sawtooth", "square", "triangle", "sine"];
const WAVE_SHORT: Record<Wave, string> = { sawtooth: "Saw", square: "Sqr", triangle: "Tri", sine: "Sin" };
const keysNow = () => get().project.keys;
const presetIndex = () => Math.max(0, allPresets().findIndex((p) => p.name === keysNow().preset));

/** "Warm Pad", with a * once edited (or "Pad sample" / "Multisample" when Keys isn't the synth). */
export function presetLabel() {
  const k = keysNow();
  if (k.type !== "synth") return k.type === "chromatic" ? "Pad sample" : "Multisample";
  const p = allPresets().find((x) => x.name === k.preset);
  return `${k.preset}${presetEdited(k.synth, p) ? "*" : ""}`;
}

const cents = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)} ct`;

// ---------- sidechain ducker ----------

/** "P1 Kick", "Keys" or "All" for a duck source / target. */
export function trackLabel(t: number) {
  if (t === DUCK_ALL) return "All";
  if (t === KEYS_TRACK) return "Keys";
  return `P${t + 1} ${get().project.pads[t]?.name ?? ""}`.trim();
}

/** Targets in encoder order: all others, pads 1-16, Keys. */
export const DUCK_TARGETS = [DUCK_ALL, ...Array.from({ length: PAD_COUNT }, (_, i) => i), KEYS_TRACK];

const duckNow = () => get().project.duck;
export const setDuck = (patch: Partial<DuckSettings>) => updateProject((p) => ({ ...p, duck: { ...p.duck, ...patch } }), false);
export const duckVisual = (): Visual => {
  const d = duckNow();
  return { kind: "duck", depth: d.depth, attack: d.attack, release: d.release };
};

function duckParam(name: string, key: "depth" | "attack" | "release", lo: number, hi: number, step: number, fmt: (v: number) => string): Param {
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

export const PAGES: Page[] = [
  {
    name: "Pad",
    tag: "PAD",
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
    summary: presetLabel,
    params: [
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
    ],
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
      {
        name: "Swing",
        value: () => get().project.swing,
        range: [50, 75],
        nudge: (d) => updateProject((p) => ({ ...p, swing: clamp(p.swing + d, 50, 75) }), false),
        format: () => `${get().project.swing}%`,
      },
      optionParam("Quantize", QUANTIZE_OPTIONS, "quantize"),
      optionParam("Repeat", REPEAT_OPTIONS, "repeatRate"),
      { ...synthParam("Keys Cutoff", "cutoff", 0, 1, 0.01, hz), visual: synthFilterVisual },
      { ...synthParam("Keys Reso", "resonance", 0, 1, 0.01, pct), visual: synthFilterVisual },
      synthParam("Keys Env", "envAmount", 0, 1, 0.01, pct),
      {
        name: "Keys Vol",
        value: () => get().project.keys.volume,
        range: [0, 1],
        nudge: (d, fine) => updateKeys({ volume: clamp(get().project.keys.volume + d * (fine ? 0.001 : 0.01), 0, 1) }),
        format: () => pct(get().project.keys.volume),
      },
    ],
  },
  {
    name: "Duck",
    tag: "DUCK",
    summary: () => {
      const d = duckNow();
      return d.on ? `P${d.source + 1}>${d.target === DUCK_ALL ? "All" : d.target === KEYS_TRACK ? "Keys" : `P${d.target + 1}`} ${pct(d.depth)}` : "Off";
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
        value: () => duckNow().source,
        range: [0, PAD_COUNT - 1],
        nudge: (d) => setDuck({ source: clamp(duckNow().source + Math.sign(d), 0, PAD_COUNT - 1) }),
        format: () => trackLabel(duckNow().source),
      },
      {
        name: "Target",
        value: () => DUCK_TARGETS.indexOf(duckNow().target),
        range: [0, DUCK_TARGETS.length - 1],
        nudge: (d) => setDuck({ target: DUCK_TARGETS[clamp(DUCK_TARGETS.indexOf(duckNow().target) + Math.sign(d), 0, DUCK_TARGETS.length - 1)] }),
        format: () => trackLabel(duckNow().target),
      },
      duckParam("Depth", "depth", 0, 1, 0.02, pct),
      duckParam("Attack", "attack", 0, 0.05, 0.001, ms),
      duckParam("Release", "release", 0.02, 1, 0.01, ms),
    ],
  },
];
export const DUCK_PAGE = PAGES.findIndex((p) => p.tag === "DUCK");
export const KEYS_PAGE = PAGES.findIndex((p) => p.tag === "KEYS");


/** Apply an encoder move and refresh the mixer (levels may change). */
export function turnEncoder(page: number, index: number, delta: number, fine: boolean) {
  const p = PAGES[page]?.params[index];
  if (!p) return null;
  p.nudge(delta, fine);
  engine.voices.updateMix();
  return p;
}
