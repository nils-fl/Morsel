// Building pad sets: slices of one sample, or a folder of samples (pure, no audio).
import { slicesFromMarkers } from "../audio/chop";
import { DECAY_MAX } from "../audio/dsp";
import { defaultPad } from "./store";
import { PAD_COUNT, type Pad } from "./types";

/** Slices between `markers` on consecutive pads from `firstPad`, keeping each pad's colour. Slices past pad 16 are dropped. */
export function slicePads(pads: Pad[], sampleId: string, markers: number[], firstPad: number, baseName: string): Pad[] {
  const slices = slicesFromMarkers(markers).slice(0, PAD_COUNT - firstPad);
  const base = baseName.slice(0, 9);
  return pads.map((pad, i) => {
    const k = i - firstPad;
    if (k < 0 || k >= slices.length) return pad;
    const [start, end] = slices[k];
    return { ...pad, sampleId, name: `${base} ${k + 1}`, start, end, decay: DECAY_MAX, mode: "oneshot", reverse: false };
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
  const open = list.findIndex((s) => HAT.test(s.name) && OPEN.test(s.name));
  const closed = list.findIndex((s) => HAT.test(s.name) && !OPEN.test(s.name));
  if (open >= 0 && closed >= 0) pads[open].choke = pads[closed].choke = 1;
  return pads;
}
