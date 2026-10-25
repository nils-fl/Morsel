// Chop session shared by the Chop tab and the Launchkey: view, marker selection, audition, and the hardware side.
// The keys play the chops (C3 = chop 1); hold a key and tap a pad to put that chop on the pad of the session's rack.
// Two encoder pages: Chop (scroll / zoom / pick / move markers, chop count, sensitivity, pitch, choke) and Tempo
// (trim the region, its length in beats, the tempo to stretch it to).
import { MAX_CHOPS, addMarker, beatsLabel, clampView, detectOnsets, equalSlices, guessBeats, remapSliceOpts, removeMarker, slicesFromMarkers, sourceBpm, trimRegion, zeroCrossing } from "../audio/chop";
import { DECAY_MAX } from "../audio/dsp";
import { engine } from "../audio/engine";
import { computePeaks, type Peaks } from "../display/widgets";
import { COLOR } from "../midi/protocol";
import { freeChokeGroup } from "../state/pads";
import { addTrack, defaultPad, drumTrack, get, set, updateTrack } from "../state/store";
import { DEFAULT_SLICE, PAD_COUNT, type ChopSession, type Pad, type SliceOpts, type Track } from "../state/types";
import { noteName } from "../ui/notes";
import { showTemp } from "./notify";

/** Narrowest view: 512 samples across the screen. */
export const minSpan = (buf: AudioBuffer) => Math.min(1, 512 / buf.length);

/** The key that plays chop 1 (C3, the lowest key at the default octave); the next keys play the next chops. */
export const CHOP_KEY0 = 48;

/** Markers stay at least this far apart (seconds). */
const MIN_GAP_S = 0.01;

const defaultSlices = (markers: number[]) => Array.from({ length: Math.max(0, markers.length - 1) }, () => DEFAULT_SLICE);

export function newChop(sampleId: string, markers: number[] = [0, 1]): ChopSession {
  return {
    sampleId, markers, slices: defaultSlices(markers), view: [0, 1], sel: null, firstPad: get().selectedPad, count: 16, sens: 0.5,
    rack: null, page: "chop", beats: null, toBpm: get().project.bpm,
  };
}

/** Slice boundaries inside `range` (N + 1 markers for N slices). */
export function autoMarkers(buf: AudioBuffer, range: [number, number], mode: "equal" | "transient", count: number, sensitivity = 0.5): number[] {
  const [a, b] = range;
  if (mode === "equal") return [...equalSlices(count).map(([s0]) => a + (b - a) * s0), b];
  return [...detectOnsets(buf.getChannelData(0), buf.sampleRate, count, sensitivity, range), b];
}

/** Markers for a fresh take: transients across the whole sample, or 8 equal slices when there are none. Inner markers snap to zero crossings. */
export function takeMarkers(buf: AudioBuffer): number[] {
  let markers = autoMarkers(buf, [0, 1], "transient", 16);
  if (markers.length < 3) markers = autoMarkers(buf, [0, 1], "equal", 8);
  const data = buf.getChannelData(0);
  return markers.map((m, i, a) => (i === 0 || i === a.length - 1 ? m : zeroCrossing(data, m)));
}

/** Re-place the markers inside the region with the session's count and sensitivity. Returns the slice count. */
export function autoChop(mode: "equal" | "transient") {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return 0;
  const data = buf.getChannelData(0);
  const region: [number, number] = [c.markers[0], c.markers[c.markers.length - 1]];
  const markers = autoMarkers(buf, region, mode, c.count, c.sens).map((m, i, a) => (i === 0 || i === a.length - 1 ? m : zeroCrossing(data, m)));
  updateChop({ markers, sel: null });
  return markers.length - 1;
}

/**
 * Patch the open session (no-op without one). A patch function sees the latest state. When the markers change, the
 * chops' pitch and choke follow them (a split chop keeps its settings in both halves).
 */
export function updateChop(patch: Partial<ChopSession> | ((c: ChopSession) => Partial<ChopSession>)) {
  const c = get().chop;
  if (!c) return;
  const p = typeof patch === "function" ? patch(c) : patch;
  const next = { ...c, ...p };
  if (next.markers !== c.markers && !p.slices) next.slices = remapSliceOpts(c.markers, c.slices, next.markers, DEFAULT_SLICE);
  if (next.sel !== null && (next.sel < 0 || next.sel >= next.markers.length)) next.sel = null;
  set({ chop: next });
}

export const chopBuffer = () => {
  const c = get().chop;
  return c ? engine.buffer(c.sampleId) : undefined;
};

/** The view, same zoom, with `f` in the middle: the waveform scrolls under a selected or moving marker. At the sample's
 *  start and end it stops at the edge, and the marker moves off centre. */
function centerOn(c: ChopSession, f: number, min: number): [number, number] {
  const span = c.view[1] - c.view[0];
  return clampView(f - span / 2, span, min);
}

/** The chop with marker `sel` as its start, or null when the selection is the region's end (or nothing). */
const selectedChop = (c: ChopSession) => (c.sel !== null && c.sel < c.markers.length - 1 ? c.sel : null);

// ---------- tempo ----------

/** The region's length in beats (as set, or guessed), its length in seconds and its tempo. */
export function chopTempo(c: ChopSession, buf: AudioBuffer) {
  const seconds = (c.markers[c.markers.length - 1] - c.markers[0]) * buf.duration;
  const beats = c.beats ?? guessBeats(seconds, get().project.bpm);
  return { beats, seconds, bpm: sourceBpm(beats, seconds) };
}

export const bpmText = (bpm: number) => bpm.toFixed(1).replace(/\.0$/, "");

// ---------- audition ----------

let playing: { t0: number; offset: number; dur: number; rate: number; loop: boolean } | null = null;

/** Play a region (fractions) of the session's sample: at `pitch` semitones, choking the other choking chops, or looped. */
export function chopPlay(a: number, b: number, gain?: number, opts: { pitch?: number; choke?: boolean; loop?: boolean } = {}) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const offset = a * buf.duration, dur = (b - a) * buf.duration;
  const rate = Math.pow(2, (opts.pitch ?? 0) / 12);
  const t0 = engine.chopVoice(c.sampleId, offset, dur, { rate, gain, choke: opts.choke ?? true, loop: opts.loop });
  playing = t0 === undefined ? null : { t0, offset, dur, rate, loop: !!opts.loop };
}

export function chopStop() {
  engine.stopPreview();
  playing = null;
}

export const chopPlaying = () => playing !== null;
export const chopLooping = () => !!playing?.loop;

/** Playhead as a fraction of the sample, or null when nothing plays. */
export function chopPlayhead(): number | null {
  const buf = chopBuffer();
  if (!playing || !buf) return null;
  let t = Math.max(0, engine.ctx.currentTime - playing.t0) * playing.rate;
  if (playing.loop) t %= playing.dur;
  else if (t > playing.dur) {
    playing = null;
    return null;
  }
  return (playing.offset + t) / buf.duration;
}

/** Play chop k with its own pitch and choke. */
export function chopPlaySlice(k: number, gain?: number) {
  const c = get().chop;
  const s = c && slicesFromMarkers(c.markers)[k];
  if (s) chopPlay(s[0], s[1], gain, c.slices[k] ?? DEFAULT_SLICE);
}

/** Loop the region (the Tempo page's Play, the Tab's Loop), or stop. */
export function chopToggleLoop() {
  const c = get().chop;
  if (!c) return;
  if (chopPlaying()) return chopStop();
  chopPlay(c.markers[0], c.markers[c.markers.length - 1], undefined, { loop: true });
}

/** The region changed while it loops: loop the new one. */
function followLoop(c: ChopSession) {
  const buf = chopBuffer();
  if (!playing?.loop || !buf) return;
  const a = c.markers[0] * buf.duration, dur = (c.markers[c.markers.length - 1] - c.markers[0]) * buf.duration;
  engine.setChopLoop(a, dur);
  playing = { ...playing, offset: a, dur };
}

// ---------- chops on pads ----------

/** Name for the next drum track made from a chop: "Chop 1", "Chop 2"… */
export function nextChopName() {
  const names = new Set(get().project.tracks.map((t) => t.name));
  let n = 1;
  while (names.has(`Chop ${n}`)) n++;
  return `Chop ${n}`;
}

/** The drum track key + pad has been putting chops on (null before the first one, or once it is deleted). */
export function chopRack(s = get()): Track | null {
  const id = s.chop?.rack?.id;
  return (id && s.project.tracks.find((t) => t.id === id && t.kind === "drum")) || null;
}

/** "+3st Choke", "No choke". */
export const sliceText = (o: SliceOpts) => `${o.pitch ? `${o.pitch > 0 ? "+" : ""}${o.pitch}st ` : ""}${o.choke ? "Choke" : "No choke"}`;

/** Pad `i` playing chop k: its region, pitch and choke (`group` when it chokes), the rest a fresh pad. */
function chopOnPad(c: ChopSession, k: number, i: number, color: number, group: number): Pad {
  const [start, end] = slicesFromMarkers(c.markers)[k];
  const o = c.slices[k] ?? DEFAULT_SLICE;
  return { ...defaultPad(i), color, sampleId: c.sampleId, name: `Chop ${k + 1}`, start, end, pitch: o.pitch, choke: o.choke ? group : 0, decay: DECAY_MAX, mode: "oneshot" };
}

/**
 * Put chop k on pad `pad` of the session's rack, one undo step. The first one makes the rack: a new drum track, or with
 * 8 tracks already the pads' drum track (its chops choke in a group of their own).
 */
export function assignChop(k: number, pad: number) {
  const c = get().chop;
  if (!c || k >= c.markers.length - 1) return;
  const rack = chopRack();
  if (rack && c.rack) {
    updateTrack(rack.id, (t) => ({ ...t, kit: "", pads: t.pads.map((p, i) => (i === pad ? chopOnPad(c, k, i, p.color, c.rack!.group) : p)) }), true);
    return showTemp(`Chop ${k + 1} > Pad ${pad + 1}`, rack.name);
  }
  const empty = Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i));
  const name = nextChopName();
  const id = addTrack("drum", { name, pads: empty.map((p, i) => (i === pad ? chopOnPad(c, k, i, p.color, 1) : p)) });
  if (id) {
    updateChop({ rack: { id, group: 1 } });
    set({ status: `${name}: a new drum rack for your chops. Hold a key and tap a pad to add more.` });
    return showTemp(`Chop ${k + 1} > Pad ${pad + 1}`, `New rack ${name}`);
  }
  const t = drumTrack();
  const group = freeChokeGroup(t.pads);
  updateChop({ rack: { id: t.id, group } });
  updateTrack(t.id, (x) => ({ ...x, kit: "", pads: x.pads.map((p, i) => (i === pad ? chopOnPad(c, k, i, p.color, group) : p)) }), true);
  showTemp(`Chop ${k + 1} > Pad ${pad + 1}`, `8 tracks: ${t.name}`);
}

/** The pad of the rack holding chop k (same sample and region), or -1. */
export function chopPadOf(s = get(), k: number): number {
  const c = s.chop, rack = chopRack(s);
  const slice = c && slicesFromMarkers(c.markers)[k];
  if (!rack || !slice) return -1;
  return rack.pads.findIndex((p) => p.sampleId === c.sampleId && Math.abs(p.start - slice[0]) < 1e-9 && Math.abs(p.end - slice[1]) < 1e-9);
}

// ---------- Launchkey ----------

const time = (f: number, buf: AudioBuffer) => `${(f * buf.duration).toFixed(f * buf.duration < 10 ? 3 : 2)}s`;

/** Play button: on the Chop page play from the selected marker (or the region start) to the region end; on the Tempo page loop the region. Or stop. */
export function chopTogglePlay() {
  const c = get().chop;
  if (!c) return;
  if (c.page === "tempo") return chopToggleLoop();
  if (chopPlaying()) return chopStop();
  const end = c.markers[c.markers.length - 1];
  chopPlay(c.sel !== null && c.sel < c.markers.length - 1 ? c.markers[c.sel] : c.markers[0], end);
}

/** Scene button: drop a marker at the playhead (tap-chop while playing), or at the view centre when stopped. */
export function chopAddMarker() {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const at = zeroCrossing(buf.getChannelData(0), chopPlayhead() ?? (c.view[0] + c.view[1]) / 2);
  const markers = addMarker(c.markers, at, MIN_GAP_S / buf.duration);
  if (markers === c.markers) return showTemp("Marker", "Too close");
  updateChop({ markers, sel: markers.indexOf(at) });
  showTemp("Marker added", `${markers.length - 1} chops`);
}

/** Shift + Scene: remove the selected marker (the region bounds stay). */
export function chopRemoveMarker() {
  const c = get().chop;
  if (!c) return;
  const markers = c.sel === null ? c.markers : removeMarker(c.markers, c.sel);
  if (markers === c.markers) return showTemp("Marker", "Pick an inner one");
  updateChop({ markers, sel: null });
  showTemp("Marker removed", `${markers.length - 1} chops`);
}

/** Select the previous / next marker (encoder 3, or Pad ⌃ / ⌄), scrolling it into view. None selected: the first / last. */
export function chopStepMarker(dir: 1 | -1) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const n = c.markers.length;
  const sel = c.sel === null ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, c.sel + dir));
  updateChop({ sel, view: centerOn(c, c.markers[sel], minSpan(buf)) });
  showTemp("Marker", `${sel + 1}/${n} ${time(c.markers[sel], buf)}`);
}

/** Pad ⌃ / ⌄ LEDs in Chop: lit when there is a marker that way. */
export function chopMarkerArrows() {
  const c = get().chop;
  if (!c || !c.markers.length) return { up: false, down: false };
  return c.sel === null ? { up: true, down: true } : { up: c.sel > 0, down: c.sel < c.markers.length - 1 };
}

/** Encoder page ⌃ / ⌄: the Chop page or the Tempo page. The Tempo page shows the whole region. */
export function chopSetPage(page: ChopSession["page"]) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  if (c.page !== page) {
    const [a, b] = [c.markers[0], c.markers[c.markers.length - 1]];
    updateChop(page === "tempo" ? { page, view: clampView(a - (b - a) * 0.05, (b - a) * 1.1, minSpan(buf)) } : { page });
  }
  if (page === "tempo") {
    const t = chopTempo(get().chop!, buf);
    showTemp("Tempo", `${beatsLabel(t.beats)} = ${bpmText(t.bpm)} BPM`);
  } else showTemp("Chop", "Keys play chops");
}

/** Encoders. Chop page: 1 scroll, 2 zoom, 3 pick marker, 4 move marker (Shift = fine), 5 most chops, 6 sensitivity,
 *  7 pitch of the selected chop, 8 its choke (Shift: every chop). Tempo page: 1 region start, 2 region end (Shift =
 *  fine), 3 length in beats (Shift = bars), 4 the tempo to stretch to (Shift = 0.1). */
export function chopEncoder(index: number, delta: number, fine: boolean) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  if (c.page === "tempo") return tempoEncoder(c, buf, index, delta, fine);
  const min = minSpan(buf);
  const [v0, v1] = c.view;
  const span = v1 - v0;
  switch (index) {
    case 0: {
      updateChop({ view: clampView(v0 + delta * span * (fine ? 0.005 : 0.04), span, min) });
      const v = get().chop!.view;
      showTemp("Scroll", time(v[0], buf));
      break;
    }
    case 1: {
      // Clockwise zooms in, around the selected marker when it is on screen.
      const anchor = c.sel !== null && c.markers[c.sel] >= v0 && c.markers[c.sel] <= v1 ? c.markers[c.sel] : (v0 + v1) / 2;
      const next = span * Math.exp(-delta * (fine ? 0.03 : 0.15));
      updateChop({ view: clampView(anchor - ((anchor - v0) / span) * next, next, min) });
      const v = get().chop!.view;
      showTemp("Zoom", `${(1 / (v[1] - v[0])).toFixed(1)}x`);
      break;
    }
    case 2:
      chopStepMarker(delta > 0 ? 1 : -1);
      break;
    case 3: {
      if (c.sel === null) {
        showTemp("Marker", "Pick one (enc 3)");
        break;
      }
      const i = c.sel;
      const data = buf.getChannelData(0);
      // Coarse: a screen pixel per detent, snapped to a zero crossing no further than half a step away
      // (so the snap can't pull it back). Fine: single samples, unsnapped.
      const stepSamples = fine ? 1 : Math.max(1, Math.round((span * buf.length) / 128));
      let m = c.markers[i] + (delta * stepSamples) / buf.length;
      if (!fine) m = zeroCrossing(data, m, Math.floor(stepSamples / 2));
      const gap = MIN_GAP_S / buf.duration;
      const lo = i > 0 ? c.markers[i - 1] + gap : 0;
      const hi = i < c.markers.length - 1 ? c.markers[i + 1] - gap : 1;
      m = Math.max(lo, Math.min(hi, m));
      const markers = c.markers.slice();
      markers[i] = m;
      updateChop({ markers, view: centerOn(c, m, min) });
      showTemp(`Marker ${i + 1}`, time(m, buf));
      break;
    }
    case 4:
    case 5: {
      // Re-detect transients with the new count or sensitivity.
      const patch = index === 4
        ? { count: Math.max(2, Math.min(MAX_CHOPS, c.count + Math.sign(delta))) }
        : { sens: Math.round(Math.max(0, Math.min(1, c.sens + Math.sign(delta) * 0.05)) * 20) / 20 };
      updateChop(patch);
      const n = autoChop("transient");
      showTemp(index === 4 ? `Max ${get().chop!.count}` : `Sens ${Math.round(get().chop!.sens * 100)}%`, `${n} chops`);
      break;
    }
    case 6:
    case 7: {
      const k = selectedChop(c);
      if (index === 7 && fine) {
        // Shift: every chop at once.
        const choke = delta > 0;
        updateChop({ slices: c.slices.map((o) => ({ ...o, choke })) });
        showTemp("All chops", choke ? "Choke" : "No choke", { encoder: index });
        break;
      }
      if (k === null) {
        showTemp(index === 6 ? "Pitch" : "Choke", "Play a key first");
        break;
      }
      const o = c.slices[k] ?? DEFAULT_SLICE;
      const next = index === 6 ? { ...o, pitch: Math.max(-24, Math.min(24, o.pitch + Math.sign(delta))) } : { ...o, choke: delta > 0 };
      updateChop({ slices: c.slices.map((x, j) => (j === k ? next : x)) });
      showTemp(`Chop ${k + 1}`, sliceText(next), { encoder: index });
      break;
    }
  }
}

function tempoEncoder(c: ChopSession, buf: AudioBuffer, index: number, delta: number, fine: boolean) {
  const min = minSpan(buf);
  switch (index) {
    case 0:
    case 1: {
      const i = index === 0 ? 0 : c.markers.length - 1;
      const span = c.view[1] - c.view[0];
      // A screen pixel per detent (Shift: an eighth of one), snapped to a zero crossing.
      const step = Math.max(1, Math.round((span * buf.length) / (fine ? 1024 : 128)));
      const at = zeroCrossing(buf.getChannelData(0), c.markers[i] + (delta * step) / buf.length, Math.floor(step / 2));
      const markers = trimRegion(c.markers, index === 0 ? "start" : "end", at, MIN_GAP_S / buf.duration);
      updateChop({ markers, sel: i === 0 ? 0 : markers.length - 1, view: centerOn(c, markers[i === 0 ? 0 : markers.length - 1], min) });
      const next = get().chop!;
      followLoop(next);
      const t = chopTempo(next, buf);
      showTemp(index === 0 ? "Start" : "End", `${t.seconds.toFixed(2)}s ${bpmText(t.bpm)} BPM`, { encoder: index });
      break;
    }
    case 2: {
      const beats = Math.max(1, Math.min(256, chopTempo(c, buf).beats + Math.sign(delta) * (fine ? 4 : 1)));
      updateChop({ beats });
      showTemp(beatsLabel(beats), `${bpmText(chopTempo(get().chop!, buf).bpm)} BPM`, { encoder: index });
      break;
    }
    case 3: {
      const toBpm = Math.round(Math.max(40, Math.min(240, c.toBpm + Math.sign(delta) * (fine ? 0.1 : 1))) * 10) / 10;
      updateChop({ toBpm });
      showTemp("Stretch to", `${bpmText(chopTempo(c, buf).bpm)} > ${bpmText(toBpm)} BPM`, { encoder: index });
      break;
    }
  }
}

/** Held keys (chop indices), the last pressed last: a pad tapped meanwhile gets the last one. */
let heldChops: { note: number; k: number }[] = [];

/** The chop a key is holding, or null. */
export const heldChop = () => heldChops.at(-1)?.k ?? null;

/** A key in Chop: play its chop (C3 = chop 1) and select its marker; held, the next pad tapped gets it. */
export function chopKeyDown(note: number, vel: number) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const k = note - CHOP_KEY0, n = c.markers.length - 1;
  if (k < 0 || k >= n) return showTemp(noteName(note), k < 0 ? `Chop 1 is ${noteName(CHOP_KEY0)}` : `Only ${n} chops`);
  heldChops = [...heldChops.filter((h) => h.note !== note), { note, k }];
  chopPlaySlice(k, 0.2 + 0.8 * (vel / 127));
  updateChop({ sel: k, view: centerOn(c, c.markers[k], minSpan(buf)) });
  const pad = chopPadOf(get(), k);
  showTemp(`Chop ${k + 1} ${noteName(note)}`, pad >= 0 ? `On pad ${pad + 1}` : `${sliceText(c.slices[k] ?? DEFAULT_SLICE)} ${time(c.markers[k + 1] - c.markers[k], buf)}`);
}

export function chopKeyUp(note: number) {
  heldChops = heldChops.filter((h) => h.note !== note);
}

export function chopKeysReleased() {
  heldChops = [];
}

/** A pad in Chop: with a key held, put that chop on it; else play the rack's pad. */
export function chopPad(pad: number, velocity: number, when = engine.ctx.currentTime) {
  const c = get().chop;
  if (!c) return;
  const k = heldChop();
  if (k !== null) return assignChop(k, pad);
  const rack = chopRack();
  if (!rack?.pads[pad].sampleId) return showTemp(`Pad ${pad + 1}`, "Hold a key + pad");
  engine.voices.pad(rack.id, pad, velocity, when);
  showTemp(`Pad ${pad + 1}`, rack.pads[pad].name);
}

/** The rack's pads in their colours (empty ones dark), held pads white; while a key is held they all pulse to take it. */
export function chopPadLeds(held: Set<number>) {
  const rack = chopRack();
  const taking = heldChop() !== null;
  return Array.from({ length: PAD_COUNT }, (_, i) => {
    if (held.has(i)) return { color: COLOR.white as number };
    const pad = rack?.pads[i];
    const color: number = pad?.sampleId ? pad.color : taking ? COLOR.dimWhite : COLOR.off;
    return { color, mode: taking ? ("pulse" as const) : ("static" as const) };
  });
}

// Peaks of the visible window, recomputed only when the view changes.
let peakKey = "";
let peakCache: Peaks | null = null;

/** What the Launchkey screen shows in Chop mode. */
export function chopView(columns: number) {
  const s = get(), c = s.chop, buf = chopBuffer();
  if (!c || !buf) return null;
  const [v0, v1] = c.view;
  const key = `${c.sampleId}:${v0}:${v1}:${columns}`;
  if (key !== peakKey) {
    const d = buf.getChannelData(0);
    peakCache = computePeaks(d.subarray(Math.floor(v0 * d.length), Math.ceil(v1 * d.length)), columns);
    peakKey = key;
  }
  const head = chopPlayhead();
  const k = selectedChop(c);
  const o = k !== null ? (c.slices[k] ?? DEFAULT_SLICE) : null;
  const t = chopTempo(c, buf);
  const zoom = 1 / (v1 - v0);
  return {
    name: s.samples[c.sampleId]?.name ?? "Sample",
    peaks: peakCache,
    // Positions within the visible window (may fall outside 0..1).
    markers: c.markers.map((m) => (m - v0) / (v1 - v0)),
    sel: c.sel,
    playhead: head === null ? null : (head - v0) / (v1 - v0),
    slices: c.markers.length - 1,
    page: c.page,
    // Chop page footer: the selected chop (number, key, pitch, choke), else zoom and position.
    info: k !== null && o
      ? `${k + 1} ${noteName(CHOP_KEY0 + k)}${o.pitch ? ` ${o.pitch > 0 ? "+" : ""}${o.pitch}st` : ""}${o.choke ? " CH" : ""}`
      : `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}x ${time(c.sel !== null ? c.markers[c.sel] : v0, buf)}`,
    tempo: { length: beatsLabel(t.beats), from: bpmText(t.bpm), to: bpmText(c.toBpm), seconds: `${t.seconds.toFixed(2)}s` },
  };
}
