// Building pad sets: slices of one sample, or a folder of samples (pure, no audio).
import { slicesFromMarkers } from "../audio/chop";
import { DECAY_MAX } from "../audio/dsp";
import { DRUM_NOTES } from "../midi/protocol";
import { defaultPad } from "./store";
import { DEFAULT_SLICE, PAD_COUNT, type Pad, type SliceOpts } from "./types";

/** Chop k of `chops` as pad `i` (colour `color`): its region, pitch and choke (`group` when it chokes), the rest a fresh pad. */
export function chopAsPad(chops: { sampleId: string; markers: number[]; slices: SliceOpts[] }, k: number, i: number, color: number, group: number): Pad {
  const [start, end] = slicesFromMarkers(chops.markers)[k];
  const o = chops.slices[k] ?? DEFAULT_SLICE;
  return { ...defaultPad(i), color, sampleId: chops.sampleId, name: `Chop ${k + 1}`, start, end, pitch: o.pitch, choke: o.choke ? group : 0, decay: DECAY_MAX, mode: "oneshot" };
}

/**
 * Slices between `markers` on consecutive pads from `firstPad`, keeping each pad's colour. Slices past pad 16 are dropped.
 * With `opts` (a chop session's), each pad gets its slice's pitch, and choke group `group` when the slice chokes.
 */
export function slicePads(pads: Pad[], sampleId: string, markers: number[], firstPad: number, baseName: string, opts?: SliceOpts[], group = 1): Pad[] {
  const slices = slicesFromMarkers(markers).slice(0, PAD_COUNT - firstPad);
  const base = baseName.slice(0, 9);
  return pads.map((pad, i) => {
    const k = i - firstPad;
    if (k < 0 || k >= slices.length) return pad;
    const [start, end] = slices[k];
    const o = opts?.[k];
    const sound = o ? { pitch: o.pitch, choke: o.choke ? group : 0 } : {};
    return { ...pad, sampleId, name: `${base} ${k + 1}`, start, end, decay: DECAY_MAX, mode: "oneshot", reverse: false, ...sound };
  });
}

const HAT = /hat|\bhh\b|\b[co]h\b/i;
const OPEN = /open|\boh\b|\bop\b/i;

/** Up to 16 samples on pads 1-16 in the given order. Closed and open hats share choke group 1 when both are there. */
export function padsFromSamples(samples: { id: string; name: string }[]): Pad[] {
  const list = samples.slice(0, PAD_COUNT);
  const pads = Array.from({ length: PAD_COUNT }, (_, i) => {
    const s = list[i];
    return s ? { ...defaultPad(i), sampleId: s.id, name: s.name.slice(0, 12) } : defaultPad(i);
  });
  chokeHats(pads, list.map((s) => s.name));
  return pads;
}

/** Closed and open hats share choke group 1 when both are there (`names` by pad, undefined for an empty one). */
function chokeHats(pads: Pad[], names: (string | undefined)[]) {
  const open = names.findIndex((n) => n !== undefined && HAT.test(n) && OPEN.test(n));
  const closed = names.findIndex((n) => n !== undefined && HAT.test(n) && !OPEN.test(n));
  if (open >= 0 && closed >= 0) pads[open].choke = pads[closed].choke = 1;
}

/**
 * Sounds by MIDI note on the pads that play those notes (a Drum Rack's layout: note 36 on pad 1, as the Launchkey's
 * drum pads send them), hats choked. Notes the 16 pads don't play are left out.
 */
export function padsFromNotes(sounds: { note: number; id: string; name: string }[]): Pad[] {
  const pads = Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i));
  const names: (string | undefined)[] = Array(PAD_COUNT).fill(undefined);
  for (const s of sounds) {
    const i = DRUM_NOTES.indexOf(s.note);
    if (i < 0) continue;
    pads[i] = { ...defaultPad(i), sampleId: s.id, name: s.name.slice(0, 12) };
    names[i] = s.name;
  }
  chokeHats(pads, names);
  return pads;
}

/** The first choke group (1-4) no pad uses, else 1. */
export function freeChokeGroup(pads: Pad[]): number {
  for (let g = 1; g <= 4; g++) if (!pads.some((p) => p.choke === g)) return g;
  return 1;
}
