// Voice DSP of the worklet engine: plain TypeScript without Web Audio types, so it runs in the audio thread and in
// tests. Where the node engine (dsp.ts) relies on Web Audio, this follows the spec and Chrome: the automation
// timeline, the biquad formulas, the built-in oscillators' band-limited tables and the stereo panner law. Each voice
// makes the same automation calls as its dsp.ts builder, so both engines play the same envelopes.
import type { KeysLfo, Pad, SynthParams, Wave } from "../../state/types";
import { DECAY_MAX, FILTER_LFO_CENTS, RELEASE_TAIL, minAttack, MOD_VIB_CENTS, REGION_FADE, KEY_TRACK_PIVOT, VIB_CENTS, cutoffHz, driveCurve, padQDb, synthQDb, velGain } from "../dsp";

// ---------- messages between the main thread and the processor ----------

export interface SampleVoiceSpec {
  kind: "sample";
  sample: string;
  pad: Pad;
  vel: number;
  pitchOffset: number;
  gate: boolean;
  lfo?: KeysLfo;
}

export interface SynthVoiceSpec {
  kind: "synth";
  synth: SynthParams;
  note: number;
  vel: number;
  lfo?: KeysLfo;
}

export type VoiceSpec = SampleVoiceSpec | SynthVoiceSpec;

export type ToProcessor =
  | { type: "sample"; id: string; sampleRate: number; channels: Float32Array[] }
  | { type: "drop"; ids: string[] }
  | { type: "voice"; id: number; out: number; when: number; spec: VoiceSpec }
  | { type: "stop"; id: number; t: number; fast: boolean }
  /** The Launchkey's strips on a keys track: pitch bend in cents, mod wheel 0..1 (Expression). */
  | { type: "expression"; t: number; bend: number; mod: number }
  | { type: "sync"; id: number }
  | { type: "close" };

export type FromProcessor = { type: "ended"; ids: number[] } | { type: "synced"; id: number };

export const PROCESSOR_NAME = "morsel-voices";

export interface SampleData {
  sampleRate: number;
  channels: Float32Array[];
}

// ---------- AudioParam automation ----------

const SET = 0;
const LINEAR = 1;
const TARGET = 2;

interface AutomationEvent {
  kind: typeof SET | typeof LINEAR | typeof TARGET;
  t: number;
  v: number;
  tau: number;
}

/** The AudioParam timeline for the event kinds the voices use (setValue, linearRamp, setTarget, cancelAndHold). */
export class Param {
  private ev: AutomationEvent[] = [];
  private def: number;

  constructor(def: number) {
    this.def = def;
  }

  set(v: number, t: number) {
    this.insert({ kind: SET, t, v, tau: 0 });
  }

  linear(v: number, t: number) {
    this.insert({ kind: LINEAR, t, v, tau: 0 });
  }

  target(v: number, t: number, tau: number) {
    this.insert({ kind: TARGET, t, v, tau });
  }

  /** cancelAndHoldAtTime: keep the value the automation has at t from then on. */
  hold(t: number) {
    const v = this.at(t);
    const keep = this.ev.filter((e) => e.t < t);
    const cut = this.ev[keep.length];
    // A ramp running across t now ends at t, so the values before t stay as they were.
    keep.push({ kind: cut?.kind === LINEAR && keep.length ? LINEAR : SET, t, v, tau: 0 });
    this.ev = keep;
  }

  /** Events at the same time keep the order they were added in. */
  private insert(e: AutomationEvent) {
    let i = this.ev.length;
    while (i > 0 && this.ev[i - 1].t > e.t) i--;
    this.ev.splice(i, 0, e);
  }

  at(t: number): number {
    const ev = this.ev;
    let j = 0;
    while (j < ev.length && ev[j].t <= t) j++;
    if (j < ev.length && ev[j].kind === LINEAR && j > 0) {
      const t0 = ev[j - 1].t;
      const v0 = this.after(j - 1, t0);
      return v0 + ((ev[j].v - v0) * (t - t0)) / (ev[j].t - t0);
    }
    return j === 0 ? this.def : this.after(j - 1, t);
  }

  /** The value at t of the automation up to event i, which is the last event at or before t. */
  private after(i: number, t: number): number {
    const e = this.ev[i];
    if (e.kind !== TARGET) return e.v;
    const v0 = i === 0 ? this.def : this.after(i - 1, e.t);
    return e.v + (v0 - e.v) * Math.exp(-(t - e.t) / e.tau);
  }
}

// ---------- biquad filter ----------

/** Chrome's BiquadFilterNode lowpass and highpass: the RBJ formulas with Q in dB. */
export function biquadCoefficients(type: "lowpass" | "highpass", hz: number, qDb: number, sampleRate: number): number[] {
  const cutoff = Math.max(0, Math.min(1, hz / (sampleRate / 2)));
  if (cutoff === 1) return type === "lowpass" ? [1, 0, 0, 0, 0] : [0, 0, 0, 0, 0];
  if (cutoff === 0) return type === "lowpass" ? [0, 0, 0, 0, 0] : [1, 0, 0, 0, 0];
  const theta = Math.PI * cutoff;
  const alpha = Math.sin(theta) / (2 * Math.pow(10, qDb / 20));
  const cosw = Math.cos(theta);
  const beta = type === "lowpass" ? (1 - cosw) / 2 : (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const b1 = type === "lowpass" ? 2 * beta : -2 * beta;
  return [beta / a0, b1 / a0, beta / a0, (-2 * cosw) / a0, (1 - alpha) / a0];
}

/** [b0, b1, b2, a1, a2], normalized. One state per channel. */
export class Biquad {
  private c = [1, 0, 0, 0, 0];
  private z1 = [0, 0];
  private z2 = [0, 0];
  private hz = NaN;
  private q = NaN;
  private type: "lowpass" | "highpass";

  constructor(type: "lowpass" | "highpass") {
    this.type = type;
  }

  set(hz: number, qDb: number, sampleRate: number) {
    if (hz === this.hz && qDb === this.q) return;
    this.hz = hz;
    this.q = qDb;
    this.c = biquadCoefficients(this.type, hz, qDb, sampleRate);
  }

  run(x: number, ch: number) {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + this.z1[ch];
    this.z1[ch] = b1 * x - a1 * y + this.z2[ch];
    this.z2[ch] = b2 * x - a2 * y;
    return y;
  }
}

/** The frequency a biquad uses: frequency × 2^(detune / 1200), up to Nyquist. */
const detuned = (hz: number, cents: number, sampleRate: number) => Math.min(sampleRate / 2, Math.max(0, hz * Math.pow(2, cents / 1200)));

// ---------- oscillators ----------

/** Chrome's built-in oscillator: band-limited tables, three per octave, crossfaded by pitch, normalized to peak 1. */
interface WaveTables {
  size: number;
  tables: Float32Array[];
  lowest: number;
}

const waveTables = new Map<string, WaveTables>();

/** Fourier sine coefficient of partial n for the built-in waves (the spec's formulas). */
function partial(wave: Wave, n: number) {
  const pi = 2 / (n * Math.PI);
  switch (wave) {
    case "sine":
      return n === 1 ? 1 : 0;
    case "sawtooth":
      return n & 1 ? pi : -pi;
    case "square":
      return n & 1 ? 2 * pi : 0;
    case "triangle":
      return n & 1 ? (8 / (Math.PI * n) ** 2) * ((n - 1) >> 1 & 1 ? -1 : 1) : 0;
  }
}

export function tablesFor(wave: Wave, sampleRate: number): WaveTables {
  const key = `${wave}:${sampleRate}`;
  let w = waveTables.get(key);
  if (w) return w;
  const size = sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384;
  const ranges = Math.round(3 * Math.log2(size));
  const maxPartials = size / 2;
  // Range r keeps the partials up to a third of an octave lower for each range (the top ones keep none).
  const counts = Array.from({ length: ranges }, (_, r) => Math.min(maxPartials - 1, Math.floor(Math.pow(2, -r / 3) * maxPartials)));
  const tables = counts.map(() => new Float32Array(size));
  const coef = Array.from({ length: counts[0] + 1 }, (_, n) => (n ? partial(wave, n) : 0));
  for (let x = 0; x < size; x++) {
    // sin(kθ) by the recurrence s(k+1) = 2cosθ·s(k) − s(k−1); the ranges take the running sum at their counts.
    const theta = (2 * Math.PI * x) / size;
    const twoCos = 2 * Math.cos(theta);
    let prev = 0;
    let cur = Math.sin(theta);
    let sum = 0;
    let r = ranges - 1;
    while (r >= 0 && counts[r] === 0) r--;
    for (let n = 1; r >= 0; n++) {
      sum += coef[n] * cur;
      while (r >= 0 && counts[r] === n) tables[r--][x] = sum;
      const next = twoCos * cur - prev;
      prev = cur;
      cur = next;
    }
  }
  let peak = 0;
  for (const v of tables[0]) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (const t of tables) for (let i = 0; i < size; i++) t[i] /= peak;
  w = { size, tables, lowest: sampleRate / size };
  waveTables.set(key, w);
  return w;
}

export class Oscillator {
  private w: WaveTables;
  private phase = 0;
  private sampleRate: number;

  constructor(wave: Wave, sampleRate: number) {
    this.w = tablesFor(wave, sampleRate);
    this.sampleRate = sampleRate;
  }

  /** Move on by `frames` (a fraction: a start between two frames) at `hz`. */
  skip(hz: number, frames: number) {
    this.phase += (hz * this.w.size * frames) / this.sampleRate;
  }

  /** Next sample at `hz`. */
  next(hz: number) {
    const { size, tables, lowest } = this.w;
    const cents = hz > 0 ? 1200 * Math.log2(hz / lowest) : -1200;
    // One range up, so partials are dropped just before they would alias.
    const range = Math.max(0, Math.min(tables.length - 1, 1 + cents / 400));
    const r1 = Math.floor(range);
    const r2 = Math.min(r1 + 1, tables.length - 1);
    const f = range - r1;
    const i = Math.floor(this.phase);
    const frac = this.phase - i;
    const j = i + 1 === size ? 0 : i + 1;
    const hi = tables[r1];
    const lo = tables[r2];
    const a = hi[i] + (hi[j] - hi[i]) * frac;
    const b = lo[i] + (lo[j] - lo[i]) * frac;
    this.phase += (hz * size) / this.sampleRate;
    this.phase -= Math.floor(this.phase / size) * size;
    return (1 - f) * a + f * b;
  }
}

/** A sine LFO from `when` (phase 0 there), `depth` cents. */
function lfoAt(rate: number, depth: number, when: number, t: number) {
  return depth > 0 ? depth * Math.sin(2 * Math.PI * rate * (t - when)) : 0;
}

/** WaveShaperNode: the curve over -1..1, linearly interpolated, clamped at the ends. */
function shape(curve: Float32Array, x: number) {
  const v = ((curve.length - 1) / 2) * (x + 1);
  if (v <= 0) return curve[0];
  if (v >= curve.length - 1) return curve[curve.length - 1];
  const k = Math.floor(v);
  return curve[k] + (curve[k + 1] - curve[k]) * (v - k);
}

/** Half-band low-pass taps (windowed sinc, cut-off at a quarter of the 2x rate), for Oversampler2x. */
const HALF_BAND = (() => {
  const n = 15;
  const m = (n - 1) / 2;
  const taps = Array.from({ length: n }, (_, i) => {
    const k = i - m;
    const sinc = k === 0 ? 0.5 : Math.sin((Math.PI * k) / 2) / (Math.PI * k);
    return sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)));
  });
  const sum = taps.reduce((a, b) => a + b, 0);
  return Float32Array.from(taps, (t) => t / sum);
})();

/**
 * A waveshaper at twice the sample rate: up (zero-stuffed, half-band filtered), shaped, then half-band filtered and
 * back down. The harmonics the curve adds above the original Nyquist are filtered out instead of folding back as
 * aliasing (a plain shaper, or averaging with a shaped midpoint, leaves most of it). About 7 frames of delay.
 */
export class Oversampler2x {
  private up = new Float32Array(HALF_BAND.length);
  private down = new Float32Array(HALF_BAND.length);
  private ui = 0;
  private di = 0;

  private static fir(buf: Float32Array, pos: number) {
    let y = 0;
    const n = buf.length;
    for (let k = 0; k < n; k++) y += HALF_BAND[k] * buf[(pos - k + n) % n];
    return y;
  }

  private push(buf: Float32Array, which: "up" | "down", x: number) {
    const i = which === "up" ? (this.ui = (this.ui + 1) % buf.length) : (this.di = (this.di + 1) % buf.length);
    buf[i] = x;
    return Oversampler2x.fir(buf, i);
  }

  run(curve: Float32Array, x: number) {
    // Zero-stuffing halves the level; the 2 brings it back.
    const a = shape(curve, this.push(this.up, "up", 2 * x));
    const b = shape(curve, this.push(this.up, "up", 0));
    this.push(this.down, "down", a);
    return this.push(this.down, "down", b);
  }
}

// ---------- expression (the Launchkey's pitch and mod strips) ----------

/** How fast bend and mod follow the strips: smooth enough not to step, quick enough to feel direct. */
const EXPRESSION_TAU = 0.01;

/**
 * A strip's live pitch bend (cents) and mod wheel (0..1), shared by every voice it plays, so held notes follow too.
 * The processor fills a block's worth before its voices render (fill), easing towards each new value.
 */
export class Expression {
  bend = new Float32Array(128);
  mod = new Float32Array(128);
  private now = { bend: 0, mod: 0 };
  private target = { bend: 0, mod: 0 };
  private queue: { t: number; bend: number; mod: number }[] = [];
  /** Nothing to add: the block is all zeros and stays so (voices then render exactly as without it). */
  idle = true;

  set(t: number, bend: number, mod: number) {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].t > t) i--;
    this.queue.splice(i, 0, { t, bend, mod });
  }

  fill(frame: number, n: number, sampleRate: number) {
    if (this.bend.length < n) {
      this.bend = new Float32Array(n);
      this.mod = new Float32Array(n);
    }
    const settled = (x: number, y: number) => Math.abs(x - y) < 1e-4;
    const { now, target, queue } = this;
    if (!queue.length && settled(now.bend, target.bend) && settled(now.mod, target.mod) && !target.bend && !target.mod) {
      if (!this.idle) {
        this.bend.fill(0);
        this.mod.fill(0);
        now.bend = now.mod = 0;
        this.idle = true;
      }
      return;
    }
    this.idle = false;
    const k = 1 - Math.exp(-1 / (EXPRESSION_TAU * sampleRate));
    for (let i = 0; i < n; i++) {
      const t = (frame + i) / sampleRate;
      while (queue.length && queue[0].t <= t) {
        const q = queue.shift()!;
        target.bend = q.bend;
        target.mod = q.mod;
      }
      now.bend += (target.bend - now.bend) * k;
      now.mod += (target.mod - now.mod) * k;
      this.bend[i] = now.bend;
      this.mod[i] = now.mod;
    }
  }

  /** Extra cents for frame i of the block: the bend, plus the mod wheel's vibrato at `rate` Hz (a shared phase). */
  cents(i: number, t: number, rate: number) {
    const m = this.mod[i];
    return this.bend[i] + (m ? m * MOD_VIB_CENTS * Math.sin(2 * Math.PI * rate * t) : 0);
  }
}

/** Without a vibrato rate of their own, notes wobble at this one (the Keys LFO's default). */
const DEFAULT_VIB_RATE = 5;

// ---------- voices ----------

export interface Voice {
  /** Release (gate) or cut (choke). `fast` = 5 ms fade for chokes. The earliest stop wins. */
  stop(t: number, fast: boolean): void;
  /** Add frames [frame, frame + n) to `out` (1 or 2 channels), bent by `expr` if given. Returns false once the voice has ended. */
  render(out: Float32Array[], frame: number, n: number, expr?: Expression): boolean;
}

/** StereoPannerNode gains: [left, right] for mono input; for stereo, how much of each side crosses over. */
function panGains(pan: number, stereo: boolean) {
  const x = stereo ? (pan <= 0 ? pan + 1 : pan) : (pan + 1) / 2;
  return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
}

/**
 * 4-point, 3rd-order Hermite interpolation between b (f = 0) and c (f = 1), with a and d the frames around them.
 * Smoother than a straight line between b and c: less of the hiss and dulling that pitching a sample adds.
 */
export function hermite(a: number, b: number, c: number, d: number, f: number) {
  const c1 = 0.5 * (c - a);
  const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
  const c3 = 0.5 * (d - a) + 1.5 * (b - c);
  return ((c3 * f + c2) * f + c1) * f + b;
}

export class SampleVoice implements Voice {
  private amp = new Param(0);
  private hp: Biquad | null = null;
  private lp: Biquad | null = null;
  private hpHz: number;
  private lpHz: number;
  private q: number;
  private startFrame: number;
  private stopTime: number;
  private stopAt = Infinity;
  /** Read position in buffer frames, and where the region ends. */
  private pos: number;
  private endPos: number;
  private rate: number;
  private pan: number[];
  private when: number;
  private spec: SampleVoiceSpec;
  private data: SampleData;
  private sampleRate: number;

  constructor(spec: SampleVoiceSpec, data: SampleData, when: number, sampleRate: number) {
    this.spec = spec;
    this.data = data;
    this.when = when;
    this.sampleRate = sampleRate;
    const { pad, vel, pitchOffset, gate, lfo } = spec;
    const duration = data.channels[0].length / data.sampleRate;
    this.rate = Math.pow(2, (pad.pitch + pitchOffset) / 12);
    const a = Math.min(pad.start, pad.end);
    const b = Math.max(pad.start, pad.end);
    this.pos = a * data.channels[0].length;
    this.endPos = b * data.channels[0].length;
    const regionDur = Math.max(0.001, (b - a) * duration) / this.rate;

    this.q = padQDb(pad.resonance);
    const filterLfo = !!lfo && lfo.filterDepth > 0;
    if (pad.hpCutoff > 0) this.hp = new Biquad("highpass");
    if (pad.cutoff < 1 || filterLfo) this.lp = new Biquad("lowpass");
    this.hpHz = cutoffHz(pad.hpCutoff);
    this.lpHz = cutoffHz(pad.cutoff);
    this.pan = panGains(pad.pan, data.channels.length > 1);

    const peak = velGain(vel) * pad.volume;
    const attack = Math.max(minAttack(pad), pad.attack);
    this.amp.set(0, when);
    this.amp.linear(peak, when + attack);
    let end = when + regionDur;
    if (!gate && pad.decay < DECAY_MAX) {
      const fadeEnd = Math.min(end, when + attack + Math.max(0.01, pad.decay));
      this.amp.set(peak, when + attack);
      this.amp.linear(0, fadeEnd);
      end = fadeEnd;
    } else if (end - REGION_FADE > when + attack) {
      // No fade (gate, or full decay): the region's end would cut the sound off mid-wave.
      this.amp.set(peak, end - REGION_FADE);
      this.amp.linear(0, end);
    }
    // Sources start between frames, as in Chrome: from the next frame on, as far along as they would be by then.
    this.startFrame = Math.ceil(when * sampleRate);
    this.pos += (this.startFrame - when * sampleRate) * (data.sampleRate / sampleRate) * this.rate;
    this.stopTime = end + 0.01;
  }

  stop(t: number, fast: boolean) {
    if (t >= this.stopAt) return;
    this.stopAt = t;
    const rel = fast ? 0.005 : Math.max(0.01, Math.min(this.spec.pad.decay, DECAY_MAX));
    this.amp.hold(t);
    this.amp.linear(0, t + rel);
    this.stopTime = t + rel + 0.01;
  }

  /** Buffer channel c at fractional frame p, read backwards when reversed. Frames outside the buffer are silence. */
  private read(c: number, p: number) {
    const d = this.data.channels[c];
    const i = Math.floor(p);
    if (this.spec.pad.reverse) {
      const j = d.length - 1 - i;
      return hermite(d[j + 1] ?? 0, d[j] ?? 0, d[j - 1] ?? 0, d[j - 2] ?? 0, p - i);
    }
    return hermite(d[i - 1] ?? 0, d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, p - i);
  }

  render(out: Float32Array[], frame: number, n: number, expr?: Expression) {
    const sr = this.sampleRate;
    const stereoIn = this.data.channels.length > 1;
    const { lfo } = this.spec;
    const bent = expr && !expr.idle ? expr : null;
    const vibRate = lfo?.vibRate ?? DEFAULT_VIB_RATE;
    const step = (this.data.sampleRate / sr) * this.rate;
    const [gl, gr] = this.pan;
    const pan = this.spec.pad.pan;
    for (let i = Math.max(0, this.startFrame - frame); i < n; i++) {
      const t = (frame + i) / sr;
      if (t >= this.stopTime || this.pos >= this.endPos) return false;
      let vib = lfo ? lfoAt(lfo.vibRate, lfo.vibDepth * VIB_CENTS, this.when, t) : 0;
      if (bent) vib += bent.cents(i, t, vibRate);
      const filt = lfo ? lfoAt(lfo.filterRate, lfo.filterDepth * FILTER_LFO_CENTS, this.when, t) : 0;
      this.hp?.set(this.hpHz, this.q, sr);
      this.lp?.set(detuned(this.lpHz, filt, sr), this.q, sr);
      const g = this.amp.at(t);
      let l = this.read(0, this.pos);
      let r = stereoIn ? this.read(1, this.pos) : 0;
      if (this.hp) {
        l = this.hp.run(l, 0);
        if (stereoIn) r = this.hp.run(r, 1);
      }
      if (this.lp) {
        l = this.lp.run(l, 0);
        if (stereoIn) r = this.lp.run(r, 1);
      }
      l *= g;
      r *= g;
      if (!stereoIn) {
        out[0][i] += l * gl;
        out[1][i] += l * gr;
      } else if (pan <= 0) {
        out[0][i] += l + r * gl;
        out[1][i] += r * gr;
      } else {
        out[0][i] += l * gl;
        out[1][i] += r + l * gr;
      }
      this.pos += vib ? step * Math.pow(2, vib / 1200) : step;
    }
    return true;
  }
}

/** Seeded per voice, so voices don't all play the same noise. */
function noiseSource(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2147483648 - 1;
  };
}

let noiseSeed = 0x9e3779b9;

export class SynthVoice implements Voice {
  private amp = new Param(0);
  private cutoff: Param;
  private o1: Oscillator;
  private o2: Oscillator;
  private sub: Oscillator | null;
  private noise: (() => number) | null;
  private f1 = new Biquad("lowpass");
  private f2: Biquad | null;
  private curve: Float32Array | null;
  private over = new Oversampler2x();
  private freq: number;
  private q: number;
  private startFrame: number;
  /** Fraction of a frame between the start time and the first frame (see SampleVoice). */
  private lead: number;
  private stopTime = Infinity;
  private stopAt = Infinity;
  private when: number;
  private spec: SynthVoiceSpec;
  private sampleRate: number;

  constructor(spec: SynthVoiceSpec, when: number, sampleRate: number) {
    this.spec = spec;
    this.when = when;
    this.sampleRate = sampleRate;
    const { synth: s, note, vel } = spec;
    this.freq = 440 * Math.pow(2, (note - 69) / 12);
    this.o1 = new Oscillator(s.wave, sampleRate);
    this.o2 = new Oscillator(s.wave2, sampleRate);
    this.sub = s.sub > 0 ? new Oscillator("sine", sampleRate) : null;
    this.noise = s.noise > 0 ? noiseSource((noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0)) : null;
    this.f2 = s.slope === 24 ? new Biquad("lowpass") : null;
    this.curve = s.drive > 0 ? driveCurve(s.drive) : null;
    this.q = synthQDb(s.resonance);

    const track = s.keyTrack > 0 ? Math.pow(this.freq / KEY_TRACK_PIVOT, s.keyTrack) : 1;
    const base = Math.max(20, Math.min(18000, cutoffHz(s.cutoff) * track));
    const env = s.envAmount * (1 - s.velFilter + (s.velFilter * vel) / 127);
    const top = Math.min(18000, base * Math.pow(2, env * 6));
    const a = Math.max(0.002, s.attack);
    this.cutoff = new Param(base);
    this.cutoff.set(base, when);
    this.cutoff.linear(top, when + a);
    if (s.filterDecay > 0) this.cutoff.target(base, when + a, s.filterDecay / 3);
    else this.cutoff.target(base + (top - base) * s.sustain, when + a, Math.max(0.01, s.decay) / 3);

    const peak = velGain(vel) * s.volume * 0.5;
    this.amp.set(0, when);
    this.amp.linear(peak, when + a);
    this.amp.target(peak * s.sustain, when + a, Math.max(0.01, s.decay) / 3);
    this.startFrame = Math.ceil(when * sampleRate);
    this.lead = this.startFrame - when * sampleRate;
  }

  stop(t: number, fast: boolean) {
    if (t >= this.stopAt) return;
    this.stopAt = t;
    const rel = fast ? 0.005 : Math.max(0.01, this.spec.synth.release);
    this.amp.hold(t);
    this.amp.target(0, t, rel / 4);
    this.cutoff.hold(t);
    this.stopTime = t + rel * RELEASE_TAIL + 0.01;
  }

  render(out: Float32Array[], frame: number, n: number, expr?: Expression) {
    const sr = this.sampleRate;
    const { synth: s, lfo } = this.spec;
    const bent = expr && !expr.idle ? expr : null;
    const vibRate = lfo?.vibRate ?? DEFAULT_VIB_RATE;
    for (let i = Math.max(0, this.startFrame - frame); i < n; i++) {
      const t = (frame + i) / sr;
      if (t >= this.stopTime) return false;
      let vib = lfo ? lfoAt(lfo.vibRate, lfo.vibDepth * VIB_CENTS, this.when, t) : 0;
      if (bent) vib += bent.cents(i, t, vibRate);
      const filt = lfo ? lfoAt(lfo.filterRate, lfo.filterDepth * FILTER_LFO_CENTS, this.when, t) : 0;
      const bend = vib ? Math.pow(2, vib / 1200) : 1;
      if (this.lead) {
        this.o1.skip(this.freq * bend, this.lead);
        this.o2.skip(this.freq * bend * Math.pow(2, s.detune / 1200), this.lead);
        this.sub?.skip((this.freq / 2) * bend, this.lead);
        this.lead = 0;
      }
      let x = this.o1.next(this.freq * bend) + this.o2.next(this.freq * bend * Math.pow(2, s.detune / 1200)) * s.osc2Level;
      if (this.sub) x += this.sub.next((this.freq / 2) * bend) * s.sub * 0.8;
      if (this.noise) x += this.noise() * s.noise * 0.5;
      const hz = detuned(this.cutoff.at(t), filt, sr);
      this.f1.set(hz, this.q, sr);
      x = this.f1.run(x, 0);
      if (this.f2) {
        this.f2.set(hz, 0, sr);
        x = this.f2.run(x, 0);
      }
      if (this.curve) x = this.over.run(this.curve, x);
      out[0][i] += x * this.amp.at(t);
    }
    return true;
  }
}
