// The 16 Pad FX, pad 1 first (catalog.ts PAD_FX has their names and settings). Each takes the pad's pressure as its
// amount (0..1) and is transparent at 0, so a pad let go fades out without a click.
import { COLOR_MODES } from "./catalog";
import { DelayLine, Noise, OnePole, Smooth, Svf } from "./dsp";
import { DELAY_TIMES, DIVISIONS, SPEEDS } from "./notes";
import { pair, type PerformCtx, type Unit } from "./unit";

const TAU = 2 * Math.PI;
const wrap = (x: number) => x - Math.floor(x);
const mix = (dry: number, wet: number, w: number) => dry + (wet - dry) * w;

/** A tempo-synced LFO phase for a note-value speed, locked to the grid so it sweeps on the beat. */
const lfoPhase = (ctx: PerformCtx, speed: number) => wrap(ctx.beat / (SPEEDS[Math.round(speed)]?.beats ?? 4));

/** The sweeping Pad FX's LFO: a unipolar parabolic sine, 0..1, from a phase 0..1 (as the MPC Sample's). */
const lfoShape = (ph: number) => {
  const p = ph * 2 - 1;
  return 0.5 + 2 * p * (1 - Math.abs(p));
};

/** Where pressure `p` puts a sweep (0..1), with the LFO pulling it back by up to `depth` of itself. */
const sweep = (p: number, lfo: number, depth: number) => {
  const x = Math.max(0, Math.min(1, (1 + (lfo - 1) * depth) * p));
  return x * x;
};

/** Damping of the resonant filters for Resonance 0..1: Q from 1.4 (0) to 5.7 (1). */
const resoQ = (reso: number) => 1 / (Math.SQRT1_2 * (1 - 0.75 * reso * reso));

// ---------- time ----------

/**
 * Half Speed: a playback tap whose delay grows as it plays, so it runs slower than the mix (x2 = half speed, an octave
 * down). On every bar line it starts again from the live mix, crossfading from the old tap, so it stays in time. Like
 * the MPC Sample's, it doesn't use pressure: holding the pad is enough.
 */
class HalfSpeed implements Unit {
  private rate = 0.5;
  private wet = 1;
  /** Frame where the current tap started (it read the live mix then), and the previous tap's start. */
  private t0 = 0;
  private prev = -1;
  /** Frame the current tap's crossfade began. */
  private fadeAt = 0;
  private bar = 0;
  private a: [number, number] = [0, 0];
  private b: [number, number] = [0, 0];

  set([s, wet]: readonly number[]) {
    this.rate = 1 / ([1.5, 2, 4][Math.round(s)] ?? 2);
    this.wet = wet;
  }

  start(ctx: PerformCtx) {
    this.t0 = this.fadeAt = ctx.frame;
    this.prev = -1;
    this.bar = Math.floor(ctx.beat / 4);
  }

  tick(io: [number, number], _amount: number, ctx: PerformCtx) {
    const bar = Math.floor(ctx.beat / 4);
    // A new bar restarts the tap, unless the current one began less than a beat ago.
    if (bar !== this.bar) {
      this.bar = bar;
      if (ctx.frame - this.t0 >= ctx.beatLen) {
        this.prev = this.t0;
        this.t0 = this.fadeAt = ctx.frame;
      }
    }
    ctx.history.read(this.t0 + (ctx.frame - this.t0) * this.rate, this.a);
    const fadeLen = Math.min(0.06 * ctx.sampleRate, ctx.beatLen);
    const into = ctx.frame - this.fadeAt;
    if (this.prev >= 0 && into < fadeLen) {
      ctx.history.read(this.prev + (ctx.frame - this.prev) * this.rate, this.b);
      const f = into / fadeLen;
      this.a[0] = this.b[0] + (this.a[0] - this.b[0]) * f;
      this.a[1] = this.b[1] + (this.a[1] - this.b[1]) * f;
    }
    // Dry/wet that keeps the level up in the middle.
    const m = this.wet, wet = 2 * m - m * m, dry = 1 - m * m;
    io[0] = io[0] * dry + this.a[0] * wet;
    io[1] = io[1] * dry + this.a[1] * wet;
  }

  reset() {}
}

/**
 * Beat Repeat: the last division before the pad went down loops (backwards with Reverse) for as long as it is held.
 * Pressure closes a resonant low-pass over the repeats: from 10 kHz with a light touch to 40 Hz pressed hard.
 */
class BeatRepeat implements Unit {
  private division = 4;
  private reverse = false;
  private reso = 0.5;
  private t0 = 0;
  private a: [number, number] = [0, 0];
  private b: [number, number] = [0, 0];
  private f = pair(() => new Svf());
  private hz: Smooth;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.hz = new Smooth(1 / (2 * Math.PI * 10), sr, 10000);
  }

  set([d, rev, reso]: readonly number[]) {
    this.division = Math.round(d);
    this.reverse = Math.round(rev) === 1;
    this.reso = reso;
  }

  start(ctx: PerformCtx) {
    this.t0 = ctx.frame;
    this.hz.value = 10000;
  }

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const len = Math.max(64, Math.round((DIVISIONS[this.division]?.beats ?? 0.25) * ctx.beatLen));
    const ph = (ctx.frame - this.t0) % len;
    // The slice is the division just before the press: [t0 - len, t0).
    const from = this.t0 - len;
    const pos = (p: number) => (this.reverse ? from + len - 1 - p : from + p);
    ctx.history.read(pos(ph), this.a);
    // A 2 ms crossfade across the loop seam (the MPC's loop is a hard cut).
    const seam = Math.min(96, len >> 2);
    if (ph < seam) {
      ctx.history.read(pos(len + ph), this.b);
      const t = ph / seam;
      this.a[0] = this.b[0] + (this.a[0] - this.b[0]) * t;
      this.a[1] = this.b[1] + (this.a[1] - this.b[1]) * t;
    }
    const hz = this.hz.next(10000 - 9960 * amount * amount);
    const q = resoQ(this.reso);
    for (let c = 0; c < 2; c++) {
      const f = this.f[c];
      f.set(hz, q, this.sr);
      f.tick(this.a[c]);
      io[c] = f.lp;
    }
  }

  reset() {
    this.f.forEach((f) => f.reset());
  }
}

/**
 * Rev Stepper: records a slice of the delay time (the mix passes meanwhile), then plays it backwards, forwards,
 * backwards... Repeats times in all, then records the next one.
 */
class RevStepper implements Unit {
  private time = 0;
  private repeats = 2;
  private t0 = 0;
  private a: [number, number] = [0, 0];

  set([t, rep]: readonly number[]) {
    this.time = Math.round(t);
    this.repeats = Math.max(2, Math.round(rep));
  }

  start(ctx: PerformCtx) {
    this.t0 = ctx.frame;
  }

  tick(io: [number, number], _amount: number, ctx: PerformCtx) {
    const len = Math.max(64, Math.round((DIVISIONS[this.time]?.beats ?? 1) * ctx.beatLen));
    const cycle = len * (1 + this.repeats);
    const t = (ctx.frame - this.t0) % cycle;
    // Recording: the mix as it is.
    if (t < len) return;
    const slice = ctx.frame - t;
    const play = t - len;
    const pass = Math.floor(play / len);
    const ph = play - pass * len;
    ctx.history.read(pass % 2 === 0 ? slice + len - 1 - ph : slice + ph, this.a);
    // 2 ms fades at each pass's ends (the MPC cuts hard).
    const edge = Math.min(1, ph / 96, (len - ph) / 96);
    io[0] = this.a[0] * edge;
    io[1] = this.a[1] * edge;
  }

  reset() {}
}

/**
 * Granulator: grains of the last moments, on a steady clock (Density), each ending just behind now, windowed and
 * summed. Feedback writes the grains back into the grain buffer (inverted, through a DC blocker and a soft clip),
 * smearing them into a cloud. Pressure is the dry/wet.
 */
class Granulator implements Unit {
  private density = 150;
  private feedback = 0.2;
  private grainLen = 0.105;
  private grains: { pos: number; age: number; len: number }[] = [];
  private clock = 0;
  private noise = new Noise(5);
  private buf: [Float32Array, Float32Array];
  private mask: number;
  private w = 0;
  private dc = pair(() => ({ x: 0, y: 0 }));
  private dcCoef: number;
  private last: [number, number] = [0, 0];

  constructor(sr: number) {
    let size = 1;
    while (size < 2.1 * sr) size *= 2;
    this.buf = pair(() => new Float32Array(size));
    this.mask = size - 1;
    this.dcCoef = 1 - (2 * Math.PI * 10) / sr;
  }

  set([d, fb, len]: readonly number[]) {
    this.density = d;
    this.feedback = fb;
    this.grainLen = len / 1000;
  }

  start() {
    this.grains = [];
    this.clock = 0;
    this.buf.forEach((b) => b.fill(0));
  }

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const sr = ctx.sampleRate;
    // Write the input plus the fed-back grains into the grain buffer.
    for (let c = 0; c < 2; c++) {
      let x = io[c] - 0.99 * this.feedback * this.last[c];
      const d = this.dc[c];
      const y = x - d.x + this.dcCoef * d.y;
      d.x = x;
      d.y = y;
      x = Math.max(-1.5, Math.min(1.5, y));
      this.buf[c][this.w] = x - (4 / 27) * x * x * x;
    }
    this.w = (this.w + 1) & this.mask;
    if (--this.clock <= 0 && this.grains.length < 64) {
      this.clock = Math.max(1, Math.round(sr / this.density));
      const len = Math.max(16, Math.round(this.grainLen * sr));
      // Each grain ends just behind now, scattered over the last 20 ms.
      const back = len + 1 + Math.abs(this.noise.next()) * 0.02 * sr;
      this.grains.push({ pos: this.w - back, age: 0, len });
    }
    let l = 0, r = 0;
    for (let i = this.grains.length - 1; i >= 0; i--) {
      const g = this.grains[i];
      const x = g.age / g.len;
      const win = 16 * x * x * (1 - x) * (1 - x) * 0.6875;
      const k = (g.pos + g.age) & this.mask;
      l += this.buf[0][k] * win;
      r += this.buf[1][k] * win;
      if (++g.age >= g.len) this.grains.splice(i, 1);
    }
    this.last[0] = l;
    this.last[1] = r;
    io[0] += (l - io[0]) * amount;
    io[1] += (r - io[1]) * amount;
  }

  reset() {
    this.grains = [];
  }
}

// ---------- modulation ----------

/** A short modulated delay mixed back in: chorus (slower, longer, two voices) or flanger (short, with feedback). */
class ModDelay implements Unit {
  private rate = 1;
  private depth = 0.5;
  private feedback = 0;
  private ph = 0;
  private d: [DelayLine, DelayLine];
  private z: [number, number] = [0, 0];
  private baseMs: number;
  private depthMs: number;
  private fbMax: number;

  constructor(sr: number, baseMs: number, depthMs: number, fbMax: number) {
    this.d = pair(() => new DelayLine(0.05, sr));
    this.baseMs = baseMs;
    this.depthMs = depthMs;
    this.fbMax = fbMax;
  }

  set([rate, depth, fb]: readonly number[]) {
    this.rate = rate;
    this.depth = depth;
    this.feedback = fb;
  }

  start() {}

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const sr = ctx.sampleRate;
    this.ph = wrap(this.ph + this.rate / sr);
    for (let c = 0; c < 2; c++) {
      // The right side a quarter cycle later: the sound moves across the stereo field.
      const lfo = 0.5 + 0.5 * Math.sin(TAU * (this.ph + c * 0.25));
      const ms = this.baseMs + this.depthMs * this.depth * lfo;
      const y = this.d[c].read((ms / 1000) * sr);
      this.d[c].write(io[c] + y * this.feedback * this.fbMax);
      this.z[c] = y;
    }
    const w = amount * 0.5;
    io[0] = mix(io[0], this.z[0], w);
    io[1] = mix(io[1], this.z[1], w);
  }

  reset() {
    this.d.forEach((d) => d.clear());
  }
}

/** Phaser: six all-pass stages per side; pressure sweeps them from 40 Hz up to 8 kHz, the LFO (Speed, Range) pulls
 *  them back on the beat, Feedback sharpens the notches. */
class Phaser implements Unit {
  private feedback = 0.5;
  private speed = 1;
  private range = 0.7;
  private z = [new Float64Array(6), new Float64Array(6)];
  private fbz: [number, number] = [0, 0];

  set([fb, speed, range]: readonly number[]) {
    this.feedback = fb;
    this.speed = speed;
    this.range = range;
  }

  start() {}

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const lfo = lfoShape(lfoPhase(ctx, this.speed));
    const hz = 40 + 7960 * sweep(amount, lfo, this.range / 2);
    const t = Math.tan((Math.PI * Math.min(hz, ctx.sampleRate * 0.45)) / ctx.sampleRate);
    const a = (t - 1) / (t + 1);
    const fb = this.feedback * 0.98;
    for (let c = 0; c < 2; c++) {
      let x = io[c] + this.fbz[c] * fb;
      const z = this.z[c];
      for (let s = 0; s < 6; s++) {
        const y = a * x + z[s];
        z[s] = x - a * y;
        x = y;
      }
      this.fbz[c] = x;
      io[c] = (io[c] + x) * 0.5 * (1 - 0.75 * this.feedback);
    }
  }

  reset() {
    this.z.forEach((z) => z.fill(0));
    this.fbz = [0, 0];
  }
}

/** Comb filter: a delay swept between 2.5 and 10 ms on the beat; pressure turns up its (inverted) feedback, ringing
 *  at 100-400 Hz; the result is softly clipped. */
class Comb implements Unit {
  private speed = 2;
  private d: [DelayLine, DelayLine];
  private y: [number, number] = [0, 0];

  constructor(sr: number) {
    this.d = pair(() => new DelayLine(0.02, sr));
  }

  set([speed]: readonly number[]) {
    this.speed = speed;
  }

  start() {}

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const ms = 2.5 + 7.5 * lfoShape(lfoPhase(ctx, this.speed));
    for (let c = 0; c < 2; c++) {
      this.d[c].write(io[c] - 0.95 * amount * this.y[c]);
      const y = (this.y[c] = this.d[c].read((ms / 1000) * ctx.sampleRate));
      const u = Math.max(-1.5, Math.min(1.5, y / 4));
      io[c] = 4 * (u - (4 / 27) * u * u * u);
    }
  }

  reset() {
    this.d.forEach((d) => d.clear());
    this.y = [0, 0];
  }
}

/**
 * The three LFO filters: pressure moves the cutoff (LP closes from 8 kHz to 40 Hz, HP opens from 0 to 8 kHz, BP rises
 * from 40 Hz to 10 kHz), the LFO pulls it back on the beat by up to half (Range), Resonance sets the peak.
 */
class LfoFilter implements Unit {
  private reso = 0.5;
  private speed = 1;
  private range = 0;
  private f = pair(() => new Svf());
  private kind: "lp" | "hp" | "bp";
  private sr: number;
  private hz: Smooth;
  /** The cutoff smoother starts where the filter is, not at 0 Hz. */
  private fresh = true;

  constructor(sr: number, kind: "lp" | "hp" | "bp") {
    this.sr = sr;
    this.kind = kind;
    this.hz = new Smooth(1 / (2 * Math.PI * 10), sr, 0);
  }

  set([reso, speed, range]: readonly number[]) {
    this.reso = reso;
    this.speed = speed;
    this.range = range;
  }

  start() {
    this.fresh = true;
  }

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const t = sweep(amount, lfoShape(lfoPhase(ctx, this.speed)), this.range / 2);
    const target = this.kind === "lp" ? 8000 + t * (40 - 8000) : this.kind === "hp" ? 20 + t * (8000 - 20) : 40 + t * (10000 - 40);
    if (this.fresh) {
      this.hz.value = target;
      this.fresh = false;
    }
    const hz = this.hz.next(target);
    const q = resoQ(this.reso);
    for (let c = 0; c < 2; c++) {
      const f = this.f[c];
      f.set(hz, q, this.sr);
      f.tick(io[c]);
      io[c] = this.kind === "lp" ? f.lp : this.kind === "hp" ? f.hp : f.bp / q;
    }
  }

  reset() {
    this.f.forEach((f) => f.reset());
  }
}

/** Ring Mod: the mix's level swung by a sine (0..1); pressure speeds it up from 10 Hz (a ducking pulse) towards Max
 *  Freq (a metallic ring), reaching about half way at full pressure, as the MPC Sample's does. */
class RingMod implements Unit {
  private max = 40;
  private ph = 0;

  set([max]: readonly number[]) {
    this.max = max;
  }

  start() {
    this.ph = 0;
  }

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const k = 0.7 * amount;
    const hz = 10 + k * k * (this.max - 10);
    this.ph = wrap(this.ph + hz / ctx.sampleRate);
    const m = 0.5 + 0.5 * Math.sin(TAU * this.ph);
    io[0] *= m;
    io[1] *= m;
  }

  reset() {}
}

// ---------- colour ----------

/** LoFi: fewer bits and a lower sample rate (held samples); pressure takes it from clean to the settings, quickly at
 *  first (1 - (1 - p)^3). */
class LoFi implements Unit {
  private bits = 8;
  private decim = 0.5;
  private phase = 0;
  private held: [number, number] = [0, 0];

  set([bits, decim]: readonly number[]) {
    this.bits = bits;
    this.decim = decim;
  }

  start() {}

  tick(io: [number, number], amount: number) {
    const a = 1 - (1 - amount) ** 3;
    const steps = Math.pow(2, 24 + (this.bits - 24) * a - 1);
    const hold = 1 + this.decim * 31 * a;
    this.phase += 1 / hold;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      this.held[0] = Math.trunc(io[0] * steps) / steps;
      this.held[1] = Math.trunc(io[1] * steps) / steps;
    }
    io[0] = this.held[0];
    io[1] = this.held[1];
  }

  reset() {}
}

const DRIVE: Partial<Record<(typeof COLOR_MODES)[number], number>> = { "Tube Amp": 6, Saturation: 10, Radio: 4, Cassette: 1.5 };

/** Color: old gear's sound. Each mode is a filter, some drive, noise and wobble in different measures. */
class Color implements Unit {
  private mode = 0;
  private lp = pair(() => new OnePole());
  private hp = pair(() => new OnePole());
  private bp = pair(() => new Svf());
  private d: [DelayLine, DelayLine];
  private noise = new Noise(31);
  private hiss = new OnePole();
  private ph = 0;
  private ph2 = 0;
  private pop = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.d = pair(() => new DelayLine(0.03, sr));
    this.hiss.set(5000, sr);
  }

  set([mode]: readonly number[]) {
    this.mode = Math.round(mode);
    const name = COLOR_MODES[this.mode];
    const lpHz = { Cassette: 9000, Flutter: 12000, "Tube Amp": 7000, Vinyl: 8000, Saturation: 16000, Radio: 3200 }[name] ?? 12000;
    const hpHz = { Cassette: 40, Flutter: 30, "Tube Amp": 60, Vinyl: 50, Saturation: 20, Radio: 450 }[name] ?? 20;
    this.lp.forEach((f) => f.set(lpHz, this.sr));
    this.hp.forEach((f) => f.set(hpHz, this.sr));
    this.bp.forEach((f) => f.set(1200, 0.9, this.sr));
  }

  start() {}

  tick(io: [number, number], amount: number) {
    const name = COLOR_MODES[this.mode];
    const sr = this.sr;
    // Wobble: wow for cassette and vinyl, a fast flutter for Flutter.
    const wowHz = name === "Flutter" ? 9 : name === "Vinyl" ? 0.55 : 0.8;
    const wowMs = name === "Flutter" ? 0.5 : name === "Cassette" ? 1.2 : name === "Vinyl" ? 0.8 : 0;
    this.ph = wrap(this.ph + wowHz / sr);
    this.ph2 = wrap(this.ph2 + 6.3 / sr);
    const delayMs = 3 + (wowMs * Math.sin(TAU * this.ph) + (name === "Cassette" ? 0.15 * Math.sin(TAU * this.ph2) : 0));
    const drive = 1 + (DRIVE[name] ?? 0.5);
    const n = this.noise.next();
    const hiss = name === "Cassette" || name === "Radio" ? this.hiss.tick(n) * 0.02 : 0;
    if (name === "Vinyl" && Math.abs(n) > 0.9993) this.pop = n * 0.3;
    this.pop *= 0.55;
    for (let c = 0; c < 2; c++) {
      const dry = io[c];
      let x = dry;
      if (wowMs) {
        this.d[c].write(x);
        x = this.d[c].read((delayMs / 1000) * sr);
      }
      x = this.lp[c].tick(x);
      x -= this.hp[c].tick(x);
      // Tube: asymmetric, so it adds even harmonics; the others are symmetric.
      x = name === "Tube Amp" ? Math.tanh(x * drive + 0.1) - Math.tanh(0.1) : Math.tanh(x * drive) / Math.sqrt(drive);
      if (name === "Radio") {
        this.bp[c].tick(x);
        x = this.bp[c].bp * 1.6;
      }
      x += hiss + (name === "Vinyl" ? this.pop : 0);
      io[c] = mix(dry, x, amount);
    }
  }

  reset() {
    this.d.forEach((d) => d.clear());
  }
}

// ---------- space ----------

/**
 * Delay: pressure sends the mix into a tempo-synced echo; the echoes ring on after the pad is let go. Normal = each
 * side echoes itself, X-Feedback = the sides feed each other, Ping-Pong = the echoes bounce left and right.
 */
class Delay implements Unit {
  readonly tails = true;
  private time = 5;
  private feedback = 0.5;
  private mode = 0;
  private d: [DelayLine, DelayLine];
  private tone = pair(() => new OnePole());
  private len: Smooth;

  constructor(sr: number) {
    this.d = pair(() => new DelayLine(4.2, sr));
    this.tone.forEach((t) => t.set(6000, sr));
    this.len = new Smooth(0.08, sr);
  }

  set([time, fb, mode]: readonly number[]) {
    this.time = Math.round(time);
    this.feedback = fb;
    this.mode = Math.round(mode);
  }

  start() {}

  tick(io: [number, number], amount: number, ctx: PerformCtx) {
    const target = Math.min(4 * ctx.sampleRate, (DELAY_TIMES[this.time]?.beats ?? 0.75) * ctx.beatLen);
    // The delay time glides when the tempo or the setting changes; it starts where it should be.
    if (this.len.value === 0) this.len.value = target;
    const frames = this.len.next(target);
    const el = this.d[0].read(frames), er = this.d[1].read(frames);
    const fb = Math.min(0.95, this.feedback);
    const sl = io[0] * amount, sr = io[1] * amount;
    const tl = this.tone[0].tick(el) * fb, tr = this.tone[1].tick(er) * fb;
    if (this.mode === 2) {
      // Ping-pong: the input goes in on the left only (mono), and each echo crosses over.
      this.d[0].write((sl + sr) * 0.5 + tr);
      this.d[1].write(tl);
    } else if (this.mode === 1) {
      this.d[0].write(sl + tr);
      this.d[1].write(sr + tl);
    } else {
      this.d[0].write(sl + tl);
      this.d[1].write(sr + tr);
    }
    io[0] += el * 0.8;
    io[1] += er * 0.8;
  }

  reset() {
    this.d.forEach((d) => d.clear());
  }
}

/** Reverb: pressure sends the mix into a room (a small feedback-delay network); its tail rings on after the release. */
class Reverb implements Unit {
  readonly tails = true;
  private pre: [DelayLine, DelayLine];
  private lines: DelayLine[];
  private lens: number[];
  private damp: OnePole[];
  private ap: DelayLine[];
  private apLens: number[];
  private decay = 0.6;
  private diffusion = 0.7;
  private preMs = 10;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.pre = pair(() => new DelayLine(0.3, sr));
    const ms = [29.7, 37.1, 41.1, 43.7, 47.3, 53.9, 59.3, 67.1];
    this.lens = ms.map((m) => Math.round((m / 1000) * sr));
    this.lines = ms.map(() => new DelayLine(0.1, sr));
    this.damp = ms.map(() => {
      const f = new OnePole();
      f.set(7000, sr);
      return f;
    });
    const apMs = [4.7, 3.6, 12.7, 9.3];
    this.apLens = apMs.map((m) => Math.round((m / 1000) * sr));
    this.ap = apMs.map(() => new DelayLine(0.02, sr));
  }

  set([pre, decay, diffusion]: readonly number[]) {
    this.preMs = pre;
    this.decay = decay;
    this.diffusion = diffusion;
  }

  start() {}

  tick(io: [number, number], amount: number) {
    const preFrames = Math.max(1, (this.preMs / 1000) * this.sr);
    this.pre[0].write(io[0] * amount);
    this.pre[1].write(io[1] * amount);
    let xl = this.pre[0].read(preFrames), xr = this.pre[1].read(preFrames);
    // Input diffusion: two all-passes a side.
    const g = 0.4 + 0.35 * this.diffusion;
    for (let k = 0; k < 2; k++) {
      const dl = this.ap[k], dr = this.ap[k + 2];
      const yl = dl.read(this.apLens[k]) - g * xl;
      dl.write(xl + g * yl);
      xl = yl;
      const yr = dr.read(this.apLens[k + 2]) - g * xr;
      dr.write(xr + g * yr);
      xr = yr;
    }
    // Eight lines mixed by a Householder matrix; the feedback gain sets the decay (0.3 s .. 12 s RT60).
    const rt = 0.3 * Math.pow(40, this.decay);
    let sum = 0;
    const out = this.tmp;
    for (let i = 0; i < 8; i++) {
      out[i] = this.damp[i].tick(this.lines[i].read(this.lens[i]));
      sum += out[i];
    }
    const h = (2 / 8) * sum;
    let l = 0, r = 0;
    for (let i = 0; i < 8; i++) {
      const gain = Math.pow(10, (-3 * this.lens[i]) / (rt * this.sr));
      this.lines[i].write((out[i] - h) * gain + (i % 2 ? xr : xl));
      if (i % 2) r += out[i];
      else l += out[i];
    }
    io[0] += l * 0.35;
    io[1] += r * 0.35;
  }

  private tmp = new Float64Array(8);

  reset() {
    this.lines.forEach((d) => d.clear());
    this.pre.forEach((d) => d.clear());
    this.ap.forEach((d) => d.clear());
  }
}

/** The 16 Pad FX, in pad order (catalog.ts PAD_FX). */
export function makePadFx(sr: number): Unit[] {
  return [
    new HalfSpeed(),
    new ModDelay(sr, 12, 8, 0.7),
    new ModDelay(sr, 0.6, 5, 0.92),
    new Phaser(),
    new Comb(sr),
    new LfoFilter(sr, "lp"),
    new LfoFilter(sr, "hp"),
    new LfoFilter(sr, "bp"),
    new RingMod(),
    new LoFi(),
    new Color(sr),
    new Granulator(sr),
    new BeatRepeat(sr),
    new RevStepper(),
    new Delay(sr),
    new Reverb(sr),
  ];
}
