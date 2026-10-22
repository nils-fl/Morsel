// The reverb return's room: an impulse response generated from the reverb knobs. Pure, so it can be tested.
import type { Returns } from "../state/types";

/** Reverb length in seconds for a `size` of 0..1 (the mixer shows it). */
export const reverbSeconds = (size: number) => 0.3 + size * 3.7;
/** Most pre-delay, seconds. */
export const MAX_PREDELAY = 0.08;

/** Small, fast, repeatable random numbers (mulberry32), so the same settings always give the same room. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Energy of every impulse per channel, at 44.1 kHz: about as loud as the default room was before. */
const IR_ENERGY = 0.15;

/**
 * A room as two channels of samples: silence for the pre-delay, a few early reflections, then a decaying noise
 * tail that gets darker as it fades (`tone` sets how bright it starts and ends). Left and right use different noise,
 * so the tail is wide. Every room has the same energy, so changing the size doesn't jump the level.
 */
export function reverbImpulseData(sampleRate: number, r: Returns["reverb"]): Float32Array<ArrayBuffer>[] {
  const seconds = reverbSeconds(r.size);
  const pre = Math.round(r.predelay * MAX_PREDELAY * sampleRate);
  const len = pre + Math.floor(seconds * sampleRate);
  const rt60 = seconds * (0.3 + 0.7 * r.decay);
  const fromHz = 3000 + r.tone * 15000;
  const toHz = 300 + r.tone * 2700;
  const fade = Math.round(0.006 * sampleRate);
  const chans = [0, 1].map((c) => {
    const rand = rng(1 + c * 7919 + Math.round(r.size * 1000) * 31 + Math.round(r.decay * 1000));
    const d = new Float32Array(len);
    // Early reflections: sparse taps over the first ~50 ms, a bit later on bigger rooms.
    const spread = 0.6 + r.size * 0.8;
    [7, 11, 17, 23, 31, 41].forEach((ms, k) => {
      const at = pre + Math.round((ms + c * 1.7) * spread * 0.001 * sampleRate);
      if (at < len) d[at] += (rand() < 0.5 ? -1 : 1) * (0.5 - k * 0.05);
    });
    let lp = 0;
    const n = len - pre;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const hz = fromHz * Math.pow(toHz / fromHz, i / n);
      const a = Math.exp((-2 * Math.PI * hz) / sampleRate);
      lp = (1 - a) * (rand() * 2 - 1) + a * lp;
      // Exponential decay, faded in over a few ms and out over the last tenth so the tail never stops short.
      const env = Math.exp((-6.9 * t) / rt60) * Math.min(1, i / fade) * Math.min(1, (n - i) / (n * 0.1));
      d[pre + i] += lp * env * 2;
    }
    return d;
  });
  let energy = 0;
  for (const d of chans) for (const v of d) energy += v * v;
  const scale = Math.sqrt((IR_ENERGY * 2 * (44100 / sampleRate)) / Math.max(energy, 1e-12));
  for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= scale;
  return chans;
}
