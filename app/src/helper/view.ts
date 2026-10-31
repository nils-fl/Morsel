// What the helper screen shows, as plain data. The main area is what the Launchkey's screen shows right now (the
// controller's ScreenModel) at 800x480, with extras the small screen has no room for: the whole clip in Step, every
// track in Track, long lists in Browse and on the Kit and Keys pages. Above it the mode, transport and position; below
// it what the 8 encoders do. draw.ts paints it; nothing here touches the canvas.
import { FLEX_NAMES, PAD_FX } from "../audio/perform/catalog";
import { beatsLabel } from "../audio/chop";
import { engine } from "../audio/engine";
import type { DuckView, ShiftRow } from "../display/screens";
import type { Peaks } from "../display/widgets";
import { bpmText, chopBuffer, chopParams, chopPageInfo, chopPlayhead, chopTempo } from "../modes/chop";
import { currentModel, heldStepList, statusText, trackLabel, type ScreenModel } from "../modes/controller";
import { activeOverlay, type Visual } from "../modes/notify";
import { PAGES, pagesFor, type Param } from "../params";
import { sequencer } from "../seq/sequencer";
import { BAR_TICKS, PPQN, pageSteps } from "../seq/timing";
import { clipOf, clipStep, drumTrack, get, keysStepNote, patternHasNotes, selectedTrack, trackBars, type AppState } from "../state/store";
import type { HwMode } from "../state/types";
import { noteName } from "../ui/notes";
import { helperActiveEncoder } from "./input";
import { OVERVIEW, WAVE } from "./layout";
import { stepOverview, trackRows, type StepOverview, type TrackRow } from "./overview";

export interface EncCell {
  name: string;
  value: string;
  /** How far it's turned, 0..1. */
  t: number;
  /** Fills from the middle (pan, pitch). */
  bipolar: boolean;
  /** Being turned (on the Launchkey or on the helper screen). */
  active: boolean;
}

export interface Header {
  track: string;
  /** PLAY, STEP, TRACK, MUTE, PATTERN, BROWSE or SAMPLE. */
  mode: string;
  /** The encoder page: "ENC 2/8 Pad", "SAMPLE 1/2". */
  page: string;
  /** "P1 PLAY" */
  status: string;
  /** Bar and beat of the selected track while playing ("3.2"), else empty. */
  pos: string;
  bpm: string;
  playing: boolean;
  recording: boolean;
}

export interface ListMain { kind: "list"; heading: string; pos: string; note: string; items: { label: string; folder?: boolean; user?: boolean }[]; index: number }
export interface BigCell { label: string; sub: string; fill: boolean; mark: boolean; dim: boolean }

export type Main =
  | { kind: "boot" }
  | ListMain
  | { kind: "pad"; pad: number; name: string; peaks: Peaks | null; start: number; end: number; info: string }
  | { kind: "duck"; v: DuckView }
  | { kind: "encoders"; heading: string; info: string; cells: (EncCell | null)[] }
  /** Mute and Pattern: 16 cells laid out like the pads (0-7 bottom row, 8-15 top row). */
  | { kind: "grid"; heading: string; info: string; cells: (BigCell | null)[] }
  | { kind: "tracks"; info: string; rows: TrackRow[]; add: string | null }
  | { kind: "steps"; item: string; bar: string; o: StepOverview }
  | {
      kind: "chop"; view: [number, number]; markers: number[]; sel: number | null; playhead: number | null;
      peaks: Peaks; overview: Peaks; info: string;
    }
  | { kind: "shift"; rows: ShiftRow[]; enc: string };

export interface Strip { cells: (EncCell | null)[] }
export interface Popup { name: string; value: string; visual?: Visual }

export interface HelperView {
  header: Header;
  main: Main;
  /** The encoders along the bottom; null when the main area is the encoders, or in Browse (they scroll the list). */
  strip: Strip | null;
  popup: Popup | null;
}

const MODE_NAMES: Record<HwMode, string> = { play: "PLAY", step: "STEP", track: "TRACK", mute: "MUTE", pattern: "PATTERN", perform: "PERFORM", browse: "BROWSE", chop: "SAMPLE" };

function paramCell(p: Param | undefined, i: number, active: number | null): EncCell | null {
  if (!p) return null;
  const [lo, hi] = p.range ?? [0, 1];
  const t = Math.max(0, Math.min(1, (p.value() - lo) / (hi - lo || 1)));
  return { name: p.name, value: p.format(), t, bipolar: lo < 0 && hi > 0, active: active === i };
}
const paramCells = (params: Param[], active: number | null) => Array.from({ length: 8 }, (_, i) => paramCell(params[i], i, active));

/** Min/max per column of `data[from..to)` (sample indexes) across `columns`. */
export function rangePeaks(data: Float32Array, from: number, to: number, columns: number): Peaks {
  const min = new Float32Array(columns), max = new Float32Array(columns);
  const per = (to - from) / columns;
  for (let c = 0; c < columns; c++) {
    let lo = 0, hi = 0;
    const i0 = Math.floor(from + c * per);
    // Zoomed past one sample per column: still read one.
    for (let i = Math.max(0, i0), n = Math.min(data.length, Math.max(i0 + 1, Math.floor(from + (c + 1) * per))); i < n; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

// Peaks only change with the sample and the window: worked out once, not on every frame.
const peakCache = new Map<string, { data: Float32Array; peaks: Peaks }>();
function peaksOf(key: string, data: Float32Array, from: number, to: number, columns: number) {
  const k = `${key}:${from}:${to}:${columns}`;
  const hit = peakCache.get(k);
  if (hit?.data === data) return hit.peaks;
  if (peakCache.size > 16) peakCache.clear();
  const peaks = rangePeaks(data, from, to, columns);
  peakCache.set(k, { data, peaks });
  return peaks;
}

function chopMain(s: AppState, m: ScreenModel | null): Main | null {
  const c = s.chop, buf = chopBuffer();
  if (!c || !buf) return null;
  const data = buf.getChannelData(0);
  const t = chopTempo(c, buf);
  const chops = c.markers.length - 1;
  const v = m?.kind === "chop" ? m.v : null;
  const info = c.page === "sample"
    ? `${beatsLabel(t.beats)} · ${bpmText(t.bpm)} > ${bpmText(c.toBpm)} BPM`
    : `${chops} chop${chops === 1 ? "" : "s"}${v ? ` · ${v.info}` : ""}`;
  return {
    kind: "chop", view: c.view, markers: c.markers, sel: c.sel, playhead: chopPlayhead(), info,
    peaks: peaksOf(`w:${c.sampleId}`, data, c.view[0] * data.length, c.view[1] * data.length, WAVE.w),
    overview: peaksOf(`o:${c.sampleId}`, data, 0, data.length, OVERVIEW.w),
  };
}

function stepsMain(s: AppState): Main {
  const t = selectedTrack(s);
  const pat = s.project.patterns[s.currentPattern];
  const span = clipStep(pat, t.id);
  const pos = sequencer.trackTickAt(t.id);
  const o = stepOverview(clipOf(pat, t.id).events, {
    bars: trackBars(pat, t.id), span, drum: t.kind === "drum", note: s.selectedPad,
    pageFirst: s.stepPage * pageSteps(span), pageLen: pageSteps(span),
    playTick: pos && pos.pattern === s.currentPattern ? pos.tick : null,
    heldTicks: heldStepList().filter((h) => h.track === t.id && h.pattern === s.currentPattern).map((h) => h.tick),
  });
  const item = t.kind === "drum" ? `Pad ${s.selectedPad + 1} · ${t.pads[s.selectedPad].name}` : `Note ${noteName(keysStepNote(t))}`;
  const stepsPerBar = o.perBar;
  const pageBar = Math.floor(o.pageFirst / stepsPerBar) + 1;
  return { kind: "steps", item, bar: `Bar ${pageBar}/${o.bars}`, o };
}

function gridMain(s: AppState, m: Extract<ScreenModel, { kind: "grid" }>): Main {
  const p = s.project;
  if (m.mode === "track") {
    const add = m.v.cells[8 + p.tracks.length];
    return {
      kind: "tracks", info: m.v.info,
      rows: trackRows(p, s.currentPattern, s.selectedTrack, (id) => {
        const pos = s.playing ? sequencer.trackTickAt(id) : null;
        return pos && pos.pattern === s.currentPattern ? pos.tick : null;
      }),
      add: !add ? null : add.label === "+" ? "+ Add a track: tap its pad" : `New ${add.label === "D" ? "Drums" : "Keys"} track: Enc 1 drums/keys, tap to add`,
    };
  }
  if (m.mode === "perform") {
    // The effects' full names under their pad cells; latched ones say so.
    const flex = s.perform.bank === "flex";
    const cells = m.v.cells.map((c, i): BigCell | null => c && {
      label: c.label, sub: `${flex ? FLEX_NAMES[i] : PAD_FX[i].name}${c.mark ? " (latch)" : ""}`, fill: c.fill, mark: !!c.mark, dim: !!c.dim,
    });
    return { kind: "grid", heading: flex ? "Flex Beat" : "Pad FX", info: m.v.info, cells };
  }
  const drum = drumTrack(s);
  const cells = m.v.cells.map((c, i): BigCell | null => {
    if (!c) return null;
    if (m.mode === "mute") return { label: c.label, sub: drum.pads[i]?.name ?? "", fill: c.fill, mark: !!c.mark, dim: !!c.dim };
    const pat = p.patterns[i];
    const bars = pat ? Math.max(pat.bars, ...p.tracks.map((t) => trackBars(pat, t.id))) : 0;
    return {
      label: c.label, sub: pat && patternHasNotes(pat) ? `${bars} bar${bars === 1 ? "" : "s"}` : "empty",
      fill: c.fill, mark: !!c.mark, dim: !!c.dim,
    };
  });
  return { kind: "grid", heading: m.mode === "mute" ? `Pads of ${m.v.title}` : "Patterns", info: m.v.info, cells };
}

function mainOf(s: AppState, m: ScreenModel | null, active: number | null): Main {
  if (m?.kind === "shift") return { kind: "shift", rows: m.v.rows, enc: m.v.enc ?? "enc=fine" };
  if (s.hwMode === "chop") {
    const c = chopMain(s, m);
    if (c) return c;
  }
  if (!m) return { kind: "boot" };
  switch (m.kind) {
    case "browser":
      return {
        kind: "list", heading: m.v.folder || "Top", pos: `${m.v.items.length ? m.v.index + 1 : 0}/${m.v.items.length}`,
        note: `Loads onto ${m.v.track}${m.v.target ? ` ${m.v.target}` : ""}`, items: m.v.items, index: m.v.index,
      };
    case "keys":
      return {
        kind: "list", heading: m.v.folder?.name ?? (m.v.tag === "KIT" ? "Kits" : m.v.title), pos: m.v.folder?.pos ?? `${m.v.index + 1}/${m.v.presets.length}`,
        note: m.v.summary, items: m.v.presets, index: m.v.index,
      };
    case "pad": {
      const t = selectedTrack(s);
      const id = t.kind === "drum" ? t.pads[m.v.pad]?.sampleId : null;
      const buf = id ? engine.buffer(id) : undefined;
      const data = buf?.getChannelData(0);
      return {
        kind: "pad", pad: m.v.pad, name: m.v.name, start: m.v.start, end: m.v.end, info: m.v.pageInfo,
        peaks: data && id ? peaksOf(`p:${id}`, data, 0, data.length, WAVE.w) : null,
      };
    }
    case "duck":
      return { kind: "duck", v: m.v };
    case "encoders":
      // Held steps: the whole clip stays in view, the three edits go to the strip.
      if (s.hwMode === "step") return stepsMain(s);
      return {
        kind: "encoders", heading: m.v.tag, info: m.v.info,
        cells: m.v.cells.map((c, i) => {
          if (!c) return null;
          const p = PAGES[s.encPage]?.params[i];
          const [lo, hi] = p?.range ?? [0, 1];
          return { name: c.name, value: c.value, t: Math.max(0, Math.min(1, c.level)), bipolar: lo < 0 && hi > 0, active: active === i };
        }),
      };
    case "grid":
      return gridMain(s, m);
    case "step":
      return stepsMain(s);
    case "chop":
      return { kind: "boot" }; // the chop's audio isn't there yet
  }
}

function stripOf(s: AppState, m: ScreenModel | null, main: Main, active: number | null): { strip: Strip | null; page: string } {
  if (s.hwMode === "chop") {
    const name = s.chop ? (s.samples[s.chop.sampleId]?.name ?? "Sample") : "";
    return { strip: { cells: paramCells(chopParams(), active) }, page: `ENC ${s.chop?.page === "chop" ? 2 : 1}/2 ${chopPageInfo()} · ${name}` };
  }
  if (main.kind === "encoders" || s.hwMode === "browse") return { strip: null, page: main.kind === "encoders" ? main.heading : "" };
  if (m?.kind === "encoders" && s.hwMode === "step") {
    // Holding steps: velocity, nudge and length of the held notes.
    const cells = m.v.cells.map((c, i): EncCell | null => c && { name: c.name, value: c.value, t: Math.max(0, Math.min(1, c.level)), bipolar: i === 1, active: active === i });
    return { strip: { cells }, page: "HOLD" };
  }
  const pages = pagesFor(selectedTrack(s).kind);
  const at = Math.max(0, pages.indexOf(s.encPage));
  const page = PAGES[pages[at]];
  return { strip: { cells: paramCells(page.params, active) }, page: `ENC ${at + 1}/${pages.length} ${page.name}` };
}

function position(s: AppState) {
  if (!s.playing) return "";
  const pos = sequencer.trackTickAt(s.selectedTrack);
  if (!pos || pos.tick < 0) return "";
  return `${Math.floor(pos.tick / BAR_TICKS) + 1}.${Math.floor((pos.tick % BAR_TICKS) / PPQN) + 1}`;
}

export function buildView(s: AppState = get()): HelperView {
  const m = currentModel();
  const overlay = activeOverlay();
  const active = helperActiveEncoder() ?? overlay?.encoder ?? null;
  const main = mainOf(s, m, active);
  const { strip, page } = stripOf(s, m, main, active);
  const encodersShown = !!strip || main.kind === "encoders";
  // A turned encoder lights up its cell instead of a popup, unless the turn comes with a curve to show.
  const popup = overlay && (overlay.visual || overlay.encoder === undefined || !encodersShown)
    ? { name: overlay.name, value: overlay.value, visual: overlay.visual }
    : null;
  return {
    header: {
      track: trackLabel(s), mode: s.shift ? "SHIFT" : MODE_NAMES[s.hwMode], page, status: statusText(s), pos: position(s),
      bpm: `${bpmText(s.project.bpm)} BPM`, playing: s.playing, recording: s.recording || !!s.countIn,
    },
    main, strip, popup,
  };
}
