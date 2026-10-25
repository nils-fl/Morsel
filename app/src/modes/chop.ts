// Chop session shared by the Chop tab and the Launchkey: view, marker selection, audition, and the hardware side.
// The keys play the chops (C3 = chop 1); hold a key and tap a pad to put that chop on the pad of the session's rack.
// Two encoder pages. Sample, where a chop opens: scroll, zoom, the region's start and end (Func keeps only it), its length
// in beats and the tempo to stretch it to (Scene). Chop: scroll, zoom, pick and move markers, the number of steps, how
// they're placed (equal steps, or at the hits), and the selected chop's pitch and choke.
import { MAX_CHOPS, addMarker, beatsLabel, clampView, detectOnsets, equalSlices, guessBeats, remapSliceOpts, removeMarker, slicesFromMarkers, sourceBpm, trimRegion, zeroCrossing } from "../audio/chop";
import { DECAY_MAX } from "../audio/dsp";
import { engine } from "../audio/engine";
import { computePeaks, type Peaks } from "../display/widgets";
import { COLOR } from "../midi/protocol";
import { freeChokeGroup } from "../state/pads";
import { addTrack, defaultPad, drumTrack, get, set, updateTrack } from "../state/store";
import { DEFAULT_SLICE, PAD_COUNT, type ChopSession, type Pad, type SliceOpts, type Track } from "../state/types";
import { noteName } from "../ui/notes";
import type { Param } from "../params";
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
    sampleId, markers, slices: defaultSlices(markers), view: [0, 1], sel: null, firstPad: get().selectedPad, detect: "equal", count: 16, sens: 0.5,
    rack: null, page: "sample", beats: null, toBpm: get().project.bpm,
  };
}

/** Slice boundaries inside `range` (N + 1 markers for N slices). */
export function autoMarkers(buf: AudioBuffer, range: [number, number], mode: "equal" | "transient", count: number, sensitivity = 0.5): number[] {
  const [a, b] = range;
  if (mode === "equal") return [...equalSlices(count).map(([s0]) => a + (b - a) * s0), b];
  return [...detectOnsets(buf.getChannelData(0), buf.sampleRate, count, sensitivity, range), b];
}

/**
 * Re-place the markers inside the region: `mode` (else the session's own way, equal steps or hits) with its count and
 * sensitivity. Inner markers snap to zero crossings. Returns the slice count.
 */
export function autoChop(mode?: "equal" | "transient") {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return 0;
  const data = buf.getChannelData(0);
  const region: [number, number] = [c.markers[0], c.markers[c.markers.length - 1]];
  const how = mode ?? (c.detect === "equal" ? "equal" : "transient");
  const markers = autoMarkers(buf, region, how, c.count, c.sens).map((m, i, a) => (i === 0 || i === a.length - 1 ? m : zeroCrossing(data, m)));
  updateChop({ markers, sel: null, ...(mode && { detect: mode === "equal" ? "equal" as const : "hits" as const }) });
  return markers.length - 1;
}

/** How chops are placed, for the screen: "Equal" or "Hits 50%". */
export const detectText = (c: ChopSession) => (c.detect === "equal" ? "Equal" : `Hits ${Math.round(c.sens * 100)}%`);

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

/** Loop the region (the Sample page's Play, the Tab's Loop), or stop. */
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

/** The pads of the rack holding chop k (same sample and region). */
export function chopPadsOf(s = get(), k: number): number[] {
  const c = s.chop, rack = chopRack(s);
  const slice = c && slicesFromMarkers(c.markers)[k];
  if (!rack || !slice) return [];
  const on = (p: Pad) => p.sampleId === c.sampleId && Math.abs(p.start - slice[0]) < 1e-9 && Math.abs(p.end - slice[1]) < 1e-9;
  return rack.pads.flatMap((p, i) => (on(p) ? [i] : []));
}

/** The first pad of the rack holding chop k, or -1. */
export const chopPadOf = (s = get(), k: number) => chopPadsOf(s, k)[0] ?? -1;

/** Set chops' pitch and choke (by index), and the same on the rack's pads already holding them, so a change after key + pad reaches the pads too. */
export function setChopOpts(ks: number[], patch: Partial<SliceOpts>) {
  updateChop((c) => ({ slices: c.slices.map((o, j) => (ks.includes(j) ? { ...o, ...patch } : o)) }));
  const s = get(), c = s.chop, rack = chopRack(s);
  if (!c?.rack || !rack) return;
  const group = c.rack.group;
  const onPads = new Map(ks.flatMap((k) => chopPadsOf(s, k).map((i) => [i, k] as const)));
  if (!onPads.size) return;
  updateTrack(rack.id, (t) => ({
    ...t,
    pads: t.pads.map((p, i) => {
      const k = onPads.get(i);
      if (k === undefined) return p;
      const o = c.slices[k] ?? DEFAULT_SLICE;
      return { ...p, pitch: o.pitch, choke: o.choke ? group : 0 };
    }),
  }));
}

// ---------- Launchkey ----------

const time = (f: number, buf: AudioBuffer) => `${(f * buf.duration).toFixed(f * buf.duration < 10 ? 3 : 2)}s`;

/** Play button: on the Chop page play from the selected marker (or the region start) to the region end; on the Sample page loop the region. Or stop. */
export function chopTogglePlay() {
  const c = get().chop;
  if (!c) return;
  if (c.page === "sample") return chopToggleLoop();
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

/**
 * Encoder page ⌃ / ⌄: the Sample page (where a chop opens) or the Chop page. Going to the Chop page the first time (no
 * chops yet) places the steps in the region, equal ones unless hits were picked.
 */
export function chopSetPage(page: ChopSession["page"]) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  if (c.page !== page) updateChop({ page });
  if (page === "sample") return showTemp("Sample", "Fn=keep Scn=stretch");
  if (c.markers.length === 2) {
    const n = autoChop();
    return showTemp("Chop", `${n} ${c.detect === "equal" ? "steps" : "hits"}, keys play them`);
  }
  showTemp("Chop", "Keys play chops");
}

/** Encoders 1 and 2 on both pages: scroll and zoom (around the selected marker when it's on screen). */
function viewEncoder(c: ChopSession, buf: AudioBuffer, index: number, delta: number, fine: boolean) {
  const min = minSpan(buf);
  const [v0, v1] = c.view;
  const span = v1 - v0;
  if (index === 0) {
    updateChop({ view: clampView(v0 + delta * span * (fine ? 0.005 : 0.04), span, min) });
    return showTemp("Scroll", time(get().chop!.view[0], buf));
  }
  // Clockwise zooms in.
  const anchor = c.sel !== null && c.markers[c.sel] >= v0 && c.markers[c.sel] <= v1 ? c.markers[c.sel] : (v0 + v1) / 2;
  const next = span * Math.exp(-delta * (fine ? 0.03 : 0.15));
  updateChop({ view: clampView(anchor - ((anchor - v0) / span) * next, next, min) });
  const v = get().chop!.view;
  showTemp("Zoom", `${(1 / (v[1] - v[0])).toFixed(1)}x`);
}

/** Encoders. Both pages: 1 scroll, 2 zoom (Shift = fine). Sample page: 3 start, 4 end (Shift = fine), 5 length in beats
 *  (Shift = bars), 6 the tempo to stretch to (Shift = 0.1). Chop page: 3 pick marker, 4 move it (Shift = fine), 5 steps,
 *  6 how they're placed (Equal, or Hits at a sensitivity), 7 pitch of the selected chop, 8 its choke (Shift: every chop). */
export function chopEncoder(index: number, delta: number, fine: boolean) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  if (index < 2) return viewEncoder(c, buf, index, delta, fine);
  if (c.page === "sample") return sampleEncoder(c, buf, index, delta, fine);
  const min = minSpan(buf);
  const span = c.view[1] - c.view[0];
  switch (index) {
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
    case 4: {
      // Steps: the number of equal chops (with hits: the most of them). The chops are placed again.
      updateChop({ count: Math.max(1, Math.min(MAX_CHOPS, c.count + Math.sign(delta))) });
      const n = autoChop();
      const now = get().chop!;
      showTemp(now.detect === "equal" ? "Steps" : "Max hits", now.detect === "equal" ? `${n}` : `${now.count} (${n} found)`, { encoder: index });
      break;
    }
    case 5: {
      // How chops are placed: Equal at the left end, then at the hits, more sensitive the further right.
      const at = c.detect === "equal" ? 0 : Math.round(c.sens * 10);
      const next = Math.max(0, Math.min(10, at + Math.sign(delta)));
      updateChop(next === 0 ? { detect: "equal" } : { detect: "hits", sens: next / 10 });
      const n = autoChop();
      showTemp("Chop by", `${detectText(get().chop!)}: ${n}`, { encoder: index });
      break;
    }
    case 6:
    case 7: {
      const k = selectedChop(c);
      if (index === 7 && fine) {
        // Shift: every chop at once.
        const choke = delta > 0;
        setChopOpts(c.slices.map((_, j) => j), { choke });
        showTemp("All chops", choke ? "Choke" : "No choke", { encoder: index });
        break;
      }
      if (k === null) {
        showTemp(index === 6 ? "Pitch" : "Choke", "Play a key first");
        break;
      }
      const o = c.slices[k] ?? DEFAULT_SLICE;
      const next = index === 6 ? { ...o, pitch: Math.max(-24, Math.min(24, o.pitch + Math.sign(delta))) } : { ...o, choke: delta > 0 };
      setChopOpts([k], next);
      showTemp(`Chop ${k + 1}`, sliceText(next), { encoder: index });
      break;
    }
  }
}

/** The Sample page's encoders 3-6: start, end, length in beats, the tempo to stretch to. */
function sampleEncoder(c: ChopSession, buf: AudioBuffer, index: number, delta: number, fine: boolean) {
  const min = minSpan(buf);
  switch (index) {
    case 2:
    case 3: {
      const i = index === 2 ? 0 : c.markers.length - 1;
      const span = c.view[1] - c.view[0];
      // A screen pixel per detent (Shift: an eighth of one), snapped to a zero crossing.
      const step = Math.max(1, Math.round((span * buf.length) / (fine ? 1024 : 128)));
      const at = zeroCrossing(buf.getChannelData(0), c.markers[i] + (delta * step) / buf.length, Math.floor(step / 2));
      const markers = trimRegion(c.markers, index === 2 ? "start" : "end", at, MIN_GAP_S / buf.duration);
      updateChop({ markers, sel: i === 0 ? 0 : markers.length - 1, view: centerOn(c, markers[i === 0 ? 0 : markers.length - 1], min) });
      const next = get().chop!;
      followLoop(next);
      const t = chopTempo(next, buf);
      showTemp(index === 2 ? "Start" : "End", `${t.seconds.toFixed(2)}s ${bpmText(t.bpm)} BPM`, { encoder: index });
      break;
    }
    case 4: {
      const beats = Math.max(1, Math.min(256, chopTempo(c, buf).beats + Math.sign(delta) * (fine ? 4 : 1)));
      updateChop({ beats });
      showTemp(beatsLabel(beats), `${bpmText(chopTempo(get().chop!, buf).bpm)} BPM`, { encoder: index });
      break;
    }
    case 5: {
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

/** The encoders of the Sample or Chop page as params, for the on-screen encoder strip: names, values, and turning them
 *  as the Launchkey's encoders do (chopEncoder, popups included). Empty without an open chop. */
export function chopParams(): Param[] {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return [];
  const turn = (i: number) => (d: number, fine: boolean) => chopEncoder(i, d, fine);
  // The strip's cells are narrow: short names, seconds to two places.
  const secs = (f: number) => `${(f * buf.duration).toFixed(f * buf.duration < 100 ? 2 : 1)}s`;
  const n = c.markers.length;
  const [v0, v1] = c.view;
  const view: Param[] = [
    { name: "Scroll", value: () => v0, range: [0, Math.max(1e-9, 1 - (v1 - v0))], nudge: turn(0), format: () => secs(v0) },
    { name: "Zoom", value: () => Math.log(1 / (v1 - v0)), range: [0, Math.log(1 / minSpan(buf))], nudge: turn(1), format: () => `${(1 / (v1 - v0)).toFixed(1)}x` },
  ];
  if (c.page === "sample") {
    const t = chopTempo(c, buf);
    return [
      ...view,
      { name: "Start", value: () => c.markers[0], range: [0, 1], nudge: turn(2), format: () => secs(c.markers[0]) },
      { name: "End", value: () => c.markers[n - 1], range: [0, 1], nudge: turn(3), format: () => secs(c.markers[n - 1]) },
      { name: "Length", value: () => t.beats, range: [1, 64], nudge: turn(4), format: () => beatsLabel(t.beats) },
      { name: "To BPM", value: () => c.toBpm, range: [40, 240], nudge: turn(5), format: () => bpmText(c.toBpm) },
    ];
  }
  const k = selectedChop(c);
  const o = k !== null ? (c.slices[k] ?? DEFAULT_SLICE) : null;
  return [
    ...view,
    { name: "Marker", value: () => c.sel ?? 0, range: [0, n - 1], nudge: turn(2), format: () => (c.sel === null ? "–" : `${c.sel + 1}/${n}`) },
    { name: "Move", value: () => (c.sel === null ? 0 : c.markers[c.sel]), range: [0, 1], nudge: turn(3), format: () => (c.sel === null ? "–" : secs(c.markers[c.sel])) },
    { name: c.detect === "equal" ? "Steps" : "Max", value: () => c.count, range: [1, MAX_CHOPS], nudge: turn(4), format: () => `${c.count}` },
    { name: c.detect === "equal" ? "Mode" : "Hits", value: () => (c.detect === "equal" ? 0 : c.sens), range: [0, 1], nudge: turn(5), format: () => (c.detect === "equal" ? "Equal" : `${Math.round(c.sens * 100)}%`) },
    { name: "Pitch", value: () => o?.pitch ?? 0, range: [-24, 24], nudge: turn(6), format: () => (o ? `${o.pitch > 0 ? "+" : ""}${o.pitch} st` : "–") },
    { name: "Choke", value: () => (o?.choke ? 1 : 0), range: [0, 1], nudge: turn(7), format: () => (o ? (o.choke ? "On" : "Off") : "–") },
  ];
}

/** The encoder strip's page label in Chop, short like the other pages' names: the page, and the chop selected. */
export function chopPageInfo(): string {
  const c = get().chop;
  if (!c) return "";
  if (c.page === "sample") return "Sample";
  const k = selectedChop(c);
  return k === null ? "Chop" : `Chop ${k + 1}`;
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
