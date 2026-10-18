// Chop session shared by the Chop tab and the Launchkey: view, marker selection, audition,
// and the hardware side (encoders scroll / zoom / pick / move markers, pads play slices).
import { clampView, slicesFromMarkers, zeroCrossing } from "../audio/chop";
import { engine } from "../audio/engine";
import { computePeaks, type Peaks } from "../display/widgets";
import { COLOR } from "../midi/protocol";
import { drumPads, get, set } from "../state/store";
import { PAD_COUNT, type ChopSession } from "../state/types";
import { showTemp } from "./notify";

/** Narrowest view: 512 samples across the screen. */
export const minSpan = (buf: AudioBuffer) => Math.min(1, 512 / buf.length);

export function newChop(sampleId: string, markers: number[] = [0, 1]): ChopSession {
  return { sampleId, markers, view: [0, 1], sel: null, firstPad: get().selectedPad };
}

/** Patch the open session (no-op without one). A patch function sees the latest state. */
export function updateChop(patch: Partial<ChopSession> | ((c: ChopSession) => Partial<ChopSession>)) {
  const c = get().chop;
  if (!c) return;
  const next = { ...c, ...(typeof patch === "function" ? patch(c) : patch) };
  if (next.sel !== null && (next.sel < 0 || next.sel >= next.markers.length)) next.sel = null;
  set({ chop: next });
}

export const chopBuffer = () => {
  const c = get().chop;
  return c ? engine.buffer(c.sampleId) : undefined;
};

/** Centre the view on `f` when it is off screen. */
function reveal(c: ChopSession, f: number, min: number): [number, number] {
  const [v0, v1] = c.view;
  if (f >= v0 && f <= v1) return c.view;
  return clampView(f - (v1 - v0) / 2, v1 - v0, min);
}

// ---------- audition ----------

let playing: { t0: number; offset: number; dur: number } | null = null;

/** Play a region (fractions) of the session's sample through the preview voice. */
export function chopPlay(a: number, b: number, gain?: number) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const offset = a * buf.duration, dur = (b - a) * buf.duration;
  const t0 = engine.preview(c.sampleId, offset, dur, gain);
  playing = t0 === undefined ? null : { t0, offset, dur };
}

export function chopStop() {
  engine.stopPreview();
  playing = null;
}

export const chopPlaying = () => playing !== null;

/** Playhead as a fraction of the sample, or null when nothing plays. */
export function chopPlayhead(): number | null {
  const buf = chopBuffer();
  if (!playing || !buf) return null;
  const t = engine.ctx.currentTime - playing.t0;
  if (t > playing.dur) {
    playing = null;
    return null;
  }
  return (playing.offset + Math.max(0, t)) / buf.duration;
}

export function chopPlaySlice(k: number, gain?: number) {
  const c = get().chop;
  const s = c && slicesFromMarkers(c.markers)[k];
  if (s) chopPlay(s[0], s[1], gain);
}

// ---------- Launchkey ----------

const time = (f: number, buf: AudioBuffer) => `${(f * buf.duration).toFixed(f * buf.duration < 10 ? 3 : 2)}s`;

/** Encoders: 1 scroll, 2 zoom, 3 pick marker, 4 move marker. Shift = fine. */
export function chopEncoder(index: number, delta: number, fine: boolean) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
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
    case 2: {
      const n = c.markers.length;
      const sel = c.sel === null ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, c.sel + Math.sign(delta)));
      updateChop({ sel, view: reveal(c, c.markers[sel], min) });
      showTemp("Marker", `${sel + 1}/${n} ${time(c.markers[sel], buf)}`);
      break;
    }
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
      const gap = 0.01 / buf.duration;
      const lo = i > 0 ? c.markers[i - 1] + gap : 0;
      const hi = i < c.markers.length - 1 ? c.markers[i + 1] - gap : 1;
      m = Math.max(lo, Math.min(hi, m));
      const markers = c.markers.slice();
      markers[i] = m;
      updateChop({ markers, view: reveal(c, m, min) });
      showTemp(`Marker ${i + 1}`, time(m, buf));
      break;
    }
  }
}

/** Pad i plays slice i (pad 1 = slice 1) and selects its start marker for encoder 4. */
export function chopPad(pad: number, velocity: number) {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf) return;
  const slices = slicesFromMarkers(c.markers);
  if (pad >= slices.length) return showTemp("Chop", `No slice ${pad + 1}`);
  chopPlay(slices[pad][0], slices[pad][1], 0.2 + 0.8 * (velocity / 127));
  updateChop({ sel: pad, view: reveal(c, c.markers[pad], minSpan(buf)) });
  showTemp(`Slice ${pad + 1}`, time(slices[pad][1] - slices[pad][0], buf));
}

/** Slice pads lit in the colour of the pad they will be sent to; the selected slice pulses, held pads are white. */
export function chopPadLeds(held: Set<number>) {
  const s = get(), c = s.chop;
  const count = c ? c.markers.length - 1 : 0;
  return Array.from({ length: PAD_COUNT }, (_, i) => {
    if (!c || i >= count) return { color: COLOR.off as number };
    if (held.has(i)) return { color: COLOR.white as number };
    const target = c.firstPad + i;
    const color = target < PAD_COUNT ? drumPads(s)[target].color : COLOR.dimWhite;
    return { color, mode: i === c.sel ? ("pulse" as const) : ("static" as const) };
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
  return {
    name: s.samples[c.sampleId]?.name ?? "Sample",
    peaks: peakCache,
    // Positions within the visible window (may fall outside 0..1).
    markers: c.markers.map((m) => (m - v0) / (v1 - v0)),
    sel: c.sel,
    playhead: head === null ? null : (head - v0) / (v1 - v0),
    slices: c.markers.length - 1,
    zoom: 1 / (v1 - v0),
    at: time(c.sel !== null ? c.markers[c.sel] : v0, buf),
  };
}
