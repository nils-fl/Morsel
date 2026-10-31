// Small building blocks of the Perform effects, sample by sample (they run in the audio thread).

/** A zero-delay-feedback state-variable filter (Simper's "SVF", trapezoidal): low-, band- and high-pass from one
 *  core, stable while its cutoff sweeps every sample. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  lp = 0;
  bp = 0;
  hp = 0;

  /** `hz` cutoff, `q` resonance (0.5 = flat, higher rings). */
  set(hz: number, q: number, sampleRate: number) {
    const g = Math.tan((Math.PI * Math.min(hz, sampleRate * 0.49)) / sampleRate);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Filter one sample; the three outputs are left in lp / bp / hp. */
  tick(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }

  reset() {
    this.ic1 = this.ic2 = this.lp = this.bp = this.hp = 0;
  }
}

/** One-pole smoother towards a target, `seconds` to get about 63% of the way. */
export class Smooth {
  value: number;
  private coef: number;

  constructor(seconds: number, sampleRate: number, start = 0) {
    this.coef = 1 - Math.exp(-1 / Math.max(1, seconds * sampleRate));
    this.value = start;
  }

  next(target: number) {
    this.value += (target - this.value) * this.coef;
    return this.value;
  }
}

/** A linear ramp towards a target over a fixed time (the MPC Sample's parameter and on/off ramps). */
export class Ramp {
  value: number;
  target: number;
  private step: number;

  constructor(seconds: number, sampleRate: number, start = 0) {
    this.step = 1 / Math.max(1, seconds * sampleRate);
    this.value = this.target = start;
  }

  next() {
    const d = this.target - this.value;
    this.value = Math.abs(d) <= this.step ? this.target : this.value + Math.sign(d) * this.step;
    return this.value;
  }

  get moving() {
    return this.value !== this.target;
  }
}

/** A one-pole low-pass (tone controls, damping). */
export class OnePole {
  private z = 0;
  private a = 1;

  set(hz: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * Math.min(hz, sampleRate * 0.49)) / sampleRate);
  }

  tick(x: number) {
    this.z += (x - this.z) * this.a;
    return this.z;
  }

  reset() {
    this.z = 0;
  }
}

/** A stereo history: every frame the Perform engine hears is written here, so time effects can play it back. Read
 *  positions are absolute frame counts (they keep rising), so they stay valid while the buffer wraps. */
export class History {
  readonly size: number;
  readonly l: Float32Array;
  readonly r: Float32Array;
  /** Frames written so far. */
  written = 0;
  private mask: number;

  constructor(seconds: number, sampleRate: number) {
    let size = 1;
    while (size < seconds * sampleRate) size *= 2;
    this.size = size;
    this.mask = size - 1;
    this.l = new Float32Array(size);
    this.r = new Float32Array(size);
  }

  write(l: number, r: number) {
    const i = this.written & this.mask;
    this.l[i] = l;
    this.r[i] = r;
    this.written++;
  }

  /** The frame at absolute position `pos` (fractional: linear interpolation). Positions not written yet, or already
   *  overwritten, read as silence. */
  read(pos: number, out: [number, number]) {
    if (pos < this.written - this.size + 2 || pos > this.written - 1) {
      out[0] = out[1] = 0;
      return out;
    }
    const i = Math.floor(pos);
    const f = pos - i;
    const a = i & this.mask, b = (i + 1) & this.mask;
    out[0] = this.l[a] + (this.l[b] - this.l[a]) * f;
    out[1] = this.r[a] + (this.r[b] - this.r[a]) * f;
    return out;
  }
}

/** A mono delay line with a fractional read (chorus, flanger, comb, delays). */
export class DelayLine {
  private buf: Float32Array;
  private mask: number;
  private w = 0;

  constructor(maxSeconds: number, sampleRate: number) {
    let size = 1;
    while (size < maxSeconds * sampleRate + 4) size *= 2;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /** The sample written `frames` ago (1 = the last one written); fractional reads interpolate linearly. */
  read(frames: number) {
    const d = Math.max(1, Math.min(this.mask - 2, frames));
    const p = this.w - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[i & this.mask], b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }

  clear() {
    this.buf.fill(0);
  }
}

/** Equal-power crossfade gains for a position 0..1 (0 = all a, 1 = all b). */
export function xfade(t: number): [number, number] {
  const x = Math.max(0, Math.min(1, t)) * (Math.PI / 2);
  return [Math.cos(x), Math.sin(x)];
}

/** Gentle saturation that stays close to unity for small signals. */
export const sat = (x: number) => Math.tanh(x);

/** A raised-cosine window, 0..1 over `t` in 0..1. */
export const hann = (t: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * t);

/** Deterministic noise: the same seed gives the same stream (live and in tests). */
export class Noise {
  private s: number;

  constructor(seed = 22222) {
    this.s = seed >>> 0 || 1;
  }

  /** -1..1 */
  next() {
    // xorshift32
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s >>> 0;
    return (this.s / 4294967296) * 2 - 1;
  }
}
