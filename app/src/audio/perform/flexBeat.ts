// Flex Beat: time effects on the whole mix (repeats, slow-downs, tape stops, scratches, gates). Each effect is two
// curves over the bar, the way the MPC Sample's Flex Beat (a Gross Beat engine) describes them:
//  - time: how far behind "now" the playback is, in beats (0 = live; rising at 1 beat per beat = frozen; a staircase
//    = repeats),
//  - volume: a gain 0..1 (gates, fades).
// The curves are read at the position in the current bar (not from the press), so an effect always lines up with the
// bar; quantized, a new effect waits for the next bar line. The playback reads the mix's recent history at
// now - time(x), so any curve that never asks for the future works. The curves here are Morsel's own.
import { History, Ramp, Smooth } from "./dsp";

/** A curve: [beat, value] points, linear between them, in order of beat; flat after the last one. */
export type Curve = readonly (readonly [number, number])[];

export interface FlexProgram {
  /** Beats in one pass: the bar (4). */
  beats: number;
  /** Behind-ness in beats at beat x of the bar, or a function for curves easier to write as maths. */
  time: Curve | ((x: number) => number);
  volume?: Curve | ((x: number) => number);
}

const frac = (x: number) => x - Math.floor(x);

/** Repeat the first `d` beats of each `d`-beat block... of the pass: the playback falls back by `d` at each block. */
const repeat = (d: number, beats = 4): FlexProgram => ({ beats, time: (x) => Math.floor(x / d) * d });

/** A gate: `on` of each `d` beats open, the rest closed (with the engine's short ramps). */
const gate = (d: number, on = 0.5): FlexProgram => ({ beats: 4, time: () => 0, volume: (x) => (frac(x / d) < on ? 1 : 0) });

/** Sixteen 16ths, 1 = open. */
const pattern = (steps: string): FlexProgram => ({
  beats: 4, time: () => 0, volume: (x) => (steps[Math.floor(x * 4) % 16] === "1" ? 1 : 0),
});

/** The Flex Beat bank, pad 1 first (pad 1 = Empty: no change). Names are in catalog.ts (FLEX_NAMES). */
export const FLEX_PROGRAMS: (FlexProgram | null)[] = [
  null,
  repeat(1),
  repeat(0.5),
  repeat(0.25),
  repeat(0.125),
  // Slow down: the speed falls from 1 to 0 over 4 beats (behind-ness = x - (x - x^2 / 8)), then silence.
  { beats: 4, time: (x) => (x * x) / 8, volume: (x) => (x < 3.9 ? 1 : 0) },
  // Speed up: from a standstill back up to speed over 2 beats, catching up on the 3rd and 4th beat at double speed.
  { beats: 4, time: (x) => (x <= 2 ? x - (x * x) / 4 : Math.max(0, 1 - (x - 2) * 0.5)) },
  // Half time: each 2 beats play the first of them at half speed.
  { beats: 4, time: (x) => 0.5 * (x % 2) },
  // Reverse: each beat plays the one before it backwards.
  { beats: 4, time: (x) => 2 * frac(x) },
  // Tape stop: the speed falls to 0 over one beat, then silence until the pass ends.
  { beats: 4, time: (x) => (x < 1 ? (x * x) / 2 : 0.5 + (x - 1)), volume: (x) => (x < 1 ? 1 : 0) },
  // Backspin: half a beat backwards at three times the speed, then silence for the rest of the beat.
  { beats: 4, time: (x) => (x < 0.5 ? 4 * x : 2 + (x - 0.5)), volume: (x) => (x < 0.5 ? 1 - x : 0) },
  // Scratch: the record pushed back and forth over an 8th, twice a beat.
  { beats: 4, time: (x) => (x % 0.5) - 0.0625 * (1 - Math.cos(4 * Math.PI * x)) + 0.0625 },
  gate(0.5),
  gate(0.25),
  pattern("1011011010110110"),
  // Stutter roll: a bar of repeats getting shorter, 1/4, 1/8, 1/16, 1/32.
  {
    beats: 4,
    time: (x) => {
      // Each beat repeats its own first 1/4, 1/8, ... : behind by how far into the beat the last repeat started.
      const d = x < 1 ? 1 : x < 2 ? 0.5 : x < 3 ? 0.25 : 0.125;
      const into = x - Math.floor(x);
      return into - (into % d);
    },
  },
];

const evalCurve = (c: Curve | ((x: number) => number) | undefined, x: number, rest: number) => {
  if (!c) return rest;
  if (typeof c === "function") return c(x);
  if (!c.length) return rest;
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i];
    if (x <= x1) {
      const [x0, y0] = c[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
  }
  return c[c.length - 1][1];
};

/** Behind-ness jumps bigger than this many frames crossfade instead of clicking. */
const JUMP = 64;
/** Crossfade length of a jump, seconds. */
const XFADE = 0.004;

/**
 * Plays a Flex Beat program over the mix. A program set with a start in the future (quantized) waits for it while the
 * one before keeps playing. One-shot: the program ends at the next bar line. Between programs the mix passes untouched.
 */
export class FlexBeat {
  private program: FlexProgram | null = null;
  private queued: { program: FlexProgram | null; start: number; oneShot: boolean } | null = null;
  private oneShot = false;
  /** The bar a one-shot program started in. */
  private bar = 0;
  private mix = 1;
  /** Wet level: a 10 ms ramp in and out, so switching programs doesn't click. */
  private wet: Ramp;
  private gain: Smooth;
  private lastDelay = 0;
  /** A jump's crossfade: frames left, and the behind-ness faded out from. */
  private fadeLeft = 0;
  private fadeFrom = 0;
  private fadeLen: number;
  private a: [number, number] = [0, 0];
  private b: [number, number] = [0, 0];
  /** Called when a one-shot pass ends (the app shows Empty again). */
  onEnd: (() => void) | null = null;

  constructor(sampleRate: number) {
    this.wet = new Ramp(0.01, sampleRate);
    this.gain = new Smooth(0.002, sampleRate, 1);
    this.fadeLen = Math.round(XFADE * sampleRate);
  }

  get active() {
    return this.program !== null || this.queued !== null || this.wet.value > 0;
  }

  /** Play `program` (null: back to the plain mix) from absolute frame `start`. */
  set(program: FlexProgram | null, start: number, oneShot: boolean) {
    this.queued = { program, start, oneShot };
  }

  setMix(mix: number) {
    this.mix = mix;
  }

  /** Process one frame at absolute position `frame`, `beat` beats from the grid's bar origin (the history already
   *  holds this frame). */
  tick(frame: number, beat: number, l: number, r: number, beatLen: number, h: History, out: [number, number]) {
    const bar = Math.floor(beat / 4);
    const q = this.queued;
    if (q && frame >= q.start) {
      this.program = q.program;
      this.oneShot = q.oneShot;
      this.bar = bar;
      this.queued = null;
      this.wet.target = q.program ? 1 : 0;
    }
    let delayFrames = 0, vol = 1;
    const p = this.program;
    if (p && this.oneShot && bar !== this.bar) {
      this.program = null;
      this.wet.target = 0;
      this.onEnd?.();
    } else if (p) {
      const x = ((beat % p.beats) + p.beats) % p.beats;
      delayFrames = Math.max(0, evalCurve(p.time, x, 0) * beatLen);
      vol = Math.max(0, Math.min(1, evalCurve(p.volume, x, 1)));
    } else delayFrames = this.lastDelay; // fading out: keep reading where it was
    if (Math.abs(delayFrames - this.lastDelay) > JUMP) {
      this.fadeFrom = this.lastDelay;
      this.fadeLeft = this.fadeLen;
    }
    this.lastDelay = delayFrames;
    const w = this.wet.next() * this.mix;
    const g = this.gain.next(vol);
    if (w <= 0) {
      this.lastDelay = 0;
      out[0] = l;
      out[1] = r;
      return out;
    }
    h.read(frame - delayFrames, this.a);
    if (this.fadeLeft > 0) {
      // The old read head plays on at its own behind-ness while it fades out.
      const t = this.fadeLeft / this.fadeLen;
      h.read(frame - this.fadeFrom, this.b);
      this.a[0] = this.a[0] * (1 - t) + this.b[0] * t;
      this.a[1] = this.a[1] * (1 - t) + this.b[1] * t;
      this.fadeLeft--;
    }
    out[0] = l * (1 - w) + this.a[0] * g * w;
    out[1] = r * (1 - w) + this.a[1] * g * w;
    return out;
  }
}
