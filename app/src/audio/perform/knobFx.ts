// The Knob FX: one effect at a time on the master, played on the encoders while the pads keep playing.
import { DelayLine, Noise, OnePole, Smooth, Svf } from "./dsp";
import { DELAY_TIMES, RATES } from "./notes";
import { pair, type PerformCtx, type Unit } from "./unit";

const TAU = 2 * Math.PI;

/** One knob from a low-pass (left) through open (centre) to a high-pass (right), as a DJ mixer's filter. */
class DjFilter implements Unit {
  private f = pair(() => new Svf());
  private pos: Smooth;
  private target = 0;
  private q = 0.7;

  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.pos = new Smooth(0.02, sr);
  }

  set([pos, reso]: readonly number[]) {
    this.target = pos;
    this.q = 0.7 + reso * 7;
  }

  start() {}

  tick(io: [number, number]) {
    const p = this.pos.next(this.target);
    // A small dead zone in the middle: the knob at noon passes the mix untouched.
    if (Math.abs(p) < 0.02) return;
    const lp = p < 0;
    const t = (Math.abs(p) - 0.02) / 0.98;
    const hz = lp ? 20000 * Math.pow(60 / 20000, t) : 20 * Math.pow(9000 / 20, t);
    // The resonance comes in as the filter moves away from open, so turning off the centre doesn't jump.
    const q = 0.7 + (this.q - 0.7) * Math.min(1, t * 4);
    for (let c = 0; c < 2; c++) {
      const f = this.f[c];
      f.set(hz, q, this.sr);
      f.tick(io[c]);
      io[c] = lp ? f.lp : f.hp;
    }
  }

  reset() {
    this.f.forEach((f) => f.reset());
  }
}

/** A slowly wandering depth: re-aims every 0.4-1.2 s and glides there, so wobbles never sound like a plain LFO. */
class Walker {
  value = 1;
  private target = 1;
  private left = 0;
  private noise: Noise;
  private sr: number;

  constructor(sr: number, seed: number) {
    this.sr = sr;
    this.noise = new Noise(seed);
  }

  next(vary = 1) {
    if (--this.left <= 0) {
      this.left = Math.round((0.8 + 0.4 * this.noise.next()) * this.sr);
      this.target = 1 - 0.8 * vary * Math.abs(this.noise.next());
    }
    this.value += (this.target - this.value) * (4 / this.sr);
    return this.value;
  }
}

/** Wow (slow) and flutter (fast) pitch wobble: a short delay whose length two LFOs move, their depth wandering. */
class Wobble {
  private d: [DelayLine, DelayLine];
  private ph = 0;
  private ph2 = 0.25;
  private walk: Walker;
  private sr: number;
  private wowHz: number;
  private flutterHz: number;

  constructor(sr: number, wowHz: number, flutterHz: number, seed: number) {
    this.sr = sr;
    this.wowHz = wowHz;
    this.flutterHz = flutterHz;
    this.d = pair(() => new DelayLine(0.03, sr));
    this.walk = new Walker(sr, seed);
  }

  /** depth 0..1: cubed, as the MPC's tape engine scales it (gentle low down, wild at the top). */
  tick(io: [number, number], depth: number) {
    this.ph = (this.ph + this.wowHz / this.sr) % 1;
    this.ph2 = (this.ph2 + this.flutterHz / this.sr) % 1;
    const v = this.walk.next();
    const amt = depth * depth * depth * v * v;
    // Up to 8 ms of slow wow and 1 ms of flutter around a 10 ms centre (about +-15 % speed at the top).
    const ms = 10 + amt * (8 * Math.sin(TAU * this.ph) + Math.sin(TAU * this.ph2));
    const frames = (ms / 1000) * this.sr;
    for (let c = 0; c < 2; c++) {
      this.d[c].write(io[c]);
      io[c] = this.d[c].read(frames + c * amt * 0.0004 * this.sr);
    }
  }

  reset() {
    this.d.forEach((d) => d.clear());
  }
}

/**
 * A cassette, as the MPC Sample's Tape Emulator: Wobble swings the level (fast and slow), Noise is hiss that ducks under
 * loud passages, Wow is the pitch wow and flutter; a little saturation and a soft top end always.
 */
class Tape implements Unit {
  private wobble: Wobble;
  private walk: Walker;
  private tone = pair(() => new OnePole());
  private noise = new Noise(7);
  private hiss = new OnePole();
  private env = new OnePole();
  private v = [0.3, 0.2, 0.4];
  private ph = 0;
  private ph2 = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.wobble = new Wobble(sr, 1.43, 3.58, 11);
    this.walk = new Walker(sr, 13);
    this.hiss.set(6000, sr);
    this.env.set(8, sr);
    this.tone.forEach((t) => t.set(18800, sr));
  }

  set(v: readonly number[]) {
    this.v = [...v];
  }

  start() {}

  tick(io: [number, number]) {
    const [level, noise, wow] = this.v;
    this.wobble.tick(io, wow);
    // Level wobble: a fast (5.85 Hz) and a slow (1.67 Hz) dip, their depth cubed and wandering.
    this.ph = (this.ph + 5.85 / this.sr) % 1;
    this.ph2 = (this.ph2 + 1.67 / this.sr) % 1;
    const a = level * level * level * this.walk.next();
    const gain = (1 - a * 0.5 * (1 - Math.sin(TAU * this.ph))) * (1 - a * 0.5 * (1 - Math.sin(TAU * this.ph2)));
    // Hiss, ducked by up to half under a loud signal.
    const loud = Math.min(1, this.env.tick(Math.abs(io[0]) + Math.abs(io[1])) * 2);
    const h = this.hiss.tick(this.noise.next()) * noise * noise * 0.05 * (1 - 0.5 * loud);
    for (let c = 0; c < 2; c++) io[c] = (Math.tanh(this.tone[c].tick(io[c]) * 1.1) / 1.1) * gain + h;
  }

  reset() {
    this.wobble.reset();
  }
}

/**
 * A record, as the MPC Sample's Vinyl Emulator: Tone is a low-pass left of centre (20 kHz down to 200 Hz) and a
 * high-pass right of it (20 Hz up to 1.2 kHz), flat at noon; Crackle is dust, clicks, rumble and hiss; Wow is the slow
 * wobble of a disc turning at 33 1/3.
 */
class Vinyl implements Unit {
  private wobble: Wobble;
  private f = pair(() => new Svf());
  private noise = new Noise(99);
  private clickF = new Svf();
  private rumble = new OnePole();
  private hiss = new OnePole();
  private dustDelay: DelayLine;
  private v = [0.5, 0.4, 0.3];
  private nextClick = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.wobble = new Wobble(sr, 0.55, 0, 17);
    this.rumble.set(70, sr);
    this.hiss.set(8000, sr);
    this.dustDelay = new DelayLine(0.1, sr);
  }

  set(v: readonly number[]) {
    this.v = [...v];
    const t = v[0];
    for (const f of this.f) {
      if (t < 0.49) f.set(200 * Math.pow(100, t / 0.49), 0.7, this.sr);
      else if (t > 0.51) f.set(20 * Math.pow(60, (t - 0.51) / 0.49), 0.7, this.sr);
    }
  }

  start() {}

  tick(io: [number, number]) {
    const [tone, crackle, wow] = this.v;
    this.wobble.tick(io, wow);
    for (let c = 0; c < 2; c++) {
      if (tone < 0.49 || tone > 0.51) {
        const f = this.f[c];
        f.tick(io[c]);
        io[c] = tone < 0.49 ? f.lp : f.hp;
      }
    }
    if (crackle <= 0) return;
    const sr = this.sr, n = this.noise;
    // Dust: frequent tiny ticks (the right side hears them 90 ms later).
    const p = 0.0005 + 0.004 * crackle;
    const dust = Math.abs(n.next()) < p ? n.next() * 0.25 * crackle : 0;
    // Clicks: a short pulse rung through a resonant band (500-3500 Hz); small ones often, big ones rarely.
    let click = 0;
    if (--this.nextClick <= 0) {
      const u = Math.abs(n.next());
      this.nextClick = Math.max(1, Math.round(Math.exp(1.69 - 4.69 * crackle) * u * u * u * u * sr));
      this.clickF.set(500 + 3000 * Math.abs(n.next()), 2, sr);
      click = u * u * 1.5;
    }
    this.clickF.tick(click);
    const rumble = this.rumble.tick(n.next()) * 0.08;
    const hiss = this.hiss.tick(n.next()) * 0.01;
    const level = crackle * crackle;
    const bed = (this.clickF.bp * 2 + rumble + hiss) * level;
    this.dustDelay.write(dust);
    io[0] += bed + dust * level;
    io[1] += bed + this.dustDelay.read(0.09 * sr) * level;
  }

  reset() {
    this.wobble.reset();
  }
}

/** Truncate to `bits` (two's complement, as converters drop their low bits). */
const truncBits = (x: number, bits: number) => {
  const k = Math.pow(2, bits - 1);
  return Math.floor(Math.max(-1, Math.min(1 - 1 / k, x)) * k) / k;
};

/**
 * The classic samplers, as the MPC Sample's Vintage Emulator models them:
 *  - MPC3000: 16 bits, a steep low-pass near 20 kHz.
 *  - MPC60: 12 bits that drop more low bits as the level rises (pseudo-companded), a little low-end bump at 98 Hz and
 *    an output low-pass at 17 kHz.
 *  - SP1200: a gentle cut below 85 Hz, an asymmetric soft clip, 12 bits, then held at 26.04 kHz between 16 kHz
 *    low-passes (the aliasing is the sound).
 *  - SP1200 Ring: the SP1200 then crushed further (8 bits, held at ~36 kHz), mixed in at 92 %.
 */
class Vintage implements Unit {
  private type = 0;
  private phase = 0;
  private ringPhase = 0;
  private held: [number, number] = [0, 0];
  private ringHeld: [number, number] = [0, 0];
  private pre = pair(() => new Svf());
  private post = pair(() => [new Svf(), new Svf()]);
  private aa = pair(() => [new Svf(), new Svf()]);
  private bump = pair(() => new Svf());
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.pre.forEach((f) => f.set(85, 0.6, sr));
    this.bump.forEach((f) => f.set(98, 0.7, sr));
    this.set([0]);
  }

  set([t]: readonly number[]) {
    this.type = Math.max(0, Math.min(3, Math.round(t)));
    const lp = this.type === 0 ? 20000 : this.type === 1 ? 17000 : 16000;
    const q = this.type === 1 ? 1.414 : 0.707;
    for (const [a, b] of this.post) {
      a.set(lp, q, this.sr);
      b.set(lp, 0.54, this.sr);
    }
    for (const [a, b] of this.aa) {
      a.set(16000, 0.54, this.sr);
      b.set(16000, 1.31, this.sr);
    }
  }

  start() {}

  tick(io: [number, number]) {
    const type = this.type;
    const sp = type >= 2;
    if (sp) {
      // Held at 26.04 kHz: a new sample each time the phase wraps.
      this.phase += 26040 / this.sr;
    }
    const take = !sp || this.phase >= 1;
    if (sp && take) this.phase -= 1;
    // SP1200 Ring: its crusher holds at about 36 kHz.
    let ringTake = false;
    if (type === 3) {
      this.ringPhase += 36000 / this.sr;
      ringTake = this.ringPhase >= 1;
      if (ringTake) this.ringPhase -= 1;
    }
    for (let c = 0; c < 2; c++) {
      let x = io[c];
      if (type === 0) x = truncBits(x, 16);
      else if (type === 1) {
        const a = Math.abs(x);
        x = truncBits(x, a < 0.25 ? 14 : a < 0.5 ? 13 : 12);
        this.bump[c].tick(x);
        x += this.bump[c].bp * 0.41;
      } else {
        // A gentle low cut, then the asymmetric clip (linear from -0.65 to 0.75, rounding off to +-0.95).
        this.pre[c].tick(x);
        x -= this.pre[c].lp * 0.5;
        x = x > 0.75 ? 0.75 + 0.2 * Math.tanh((x - 0.75) / 0.2) : x < -0.65 ? -0.65 - 0.3 * Math.tanh((-x - 0.65) / 0.3) : x;
        const [a1, a2] = this.aa[c];
        a1.tick(x);
        a2.tick(a1.lp);
        if (take) this.held[c] = truncBits(a2.lp, 12);
        x = this.held[c];
      }
      const [p1, p2] = this.post[c];
      p1.tick(x);
      p2.tick(p1.lp);
      x = p2.lp;
      if (type === 3) {
        if (ringTake) this.ringHeld[c] = truncBits(x, 8);
        x = x * 0.08 + this.ringHeld[c] * 0.92;
      }
      io[c] = x;
    }
  }

  reset() {
    this.pre.forEach((f) => f.reset());
  }
}

/**
 * Pumper: a duck on the beat, like a sidechain from a kick that isn't there. Each trigger the level drops quickly
 * (exponentially, 10 ms) and comes back over the rest of the period; Shape keeps it down longer before a late snap
 * back; Depth sets how far down it goes ((1 - depth)^2 at the bottom).
 */
class Pumper implements Unit {
  private v = [3, 0.5, 0.7];
  private g: Smooth;

  constructor(sr: number) {
    this.g = new Smooth(0.001, sr, 1);
  }

  set(v: readonly number[]) {
    this.v = [...v];
  }

  start() {}

  tick(io: [number, number], _a: number, ctx: PerformCtx) {
    const [speed, shape, depth] = this.v;
    const period = (RATES[Math.round(speed)]?.beats ?? 1) * ctx.beatLen;
    const t = ((((ctx.beat * ctx.beatLen) % period) + period) % period) / ctx.sampleRate;
    const attack = 0.01, len = period / ctx.sampleRate;
    let env: number;
    if (t < attack) env = Math.pow(0.01, t / attack);
    else {
      const p = Math.min(1, (t - attack) / Math.max(0.001, len - attack));
      env = Math.pow(0.01, Math.pow(1 - p, Math.pow(100, shape - 0.5)));
    }
    const floor = (1 - depth) * (1 - depth);
    const gain = this.g.next(floor + env * (1 - floor));
    io[0] *= gain;
    io[1] *= gain;
  }

  reset() {}
}

/** The mix swinging left and right on the beat. */
class AutoPan implements Unit {
  private v = [1, 0.8];

  set(v: readonly number[]) {
    this.v = [...v];
  }

  start() {}

  tick(io: [number, number], _a: number, ctx: PerformCtx) {
    const [rate, depth] = this.v;
    const period = RATES[Math.round(rate)]?.beats ?? 2;
    const pan = depth * Math.sin(TAU * (ctx.beat / period));
    // Equal-power pan of the mix, centre = untouched.
    const a = ((pan + 1) * Math.PI) / 4;
    const k = Math.SQRT2;
    io[0] *= Math.cos(a) * k;
    io[1] *= Math.sin(a) * k;
  }

  reset() {}
}

/** A tape echo: tempo-synced, each repeat darker and a little saturated, the tape wobbling. */
class TapeDelay implements Unit {
  readonly tails = true;
  private d: [DelayLine, DelayLine];
  private tone = pair(() => new OnePole());
  private time: Smooth;
  private v = [5, 0.45, 0.3];
  private ph = 0;

  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.d = pair(() => new DelayLine(4.2, sr));
    this.time = new Smooth(0.15, sr);
    this.tone.forEach((t) => t.set(3500, sr));
  }

  set(v: readonly number[]) {
    this.v = [...v];
  }

  start() {}

  tick(io: [number, number], _a: number, ctx: PerformCtx) {
    const [time, fb, wow] = this.v;
    const target = Math.min(4 * this.sr, (DELAY_TIMES[Math.round(time)]?.beats ?? 0.75) * ctx.beatLen);
    this.ph = (this.ph + 0.7 / this.sr) % 1;
    // The delay time glides when the tempo or the setting changes, as a tape machine's motor does.
    if (this.time.value === 0) this.time.value = target;
    const frames = this.time.next(target) * (1 + wow * 0.004 * Math.sin(TAU * this.ph));
    for (let c = 0; c < 2; c++) {
      const echo = this.d[c].read(frames);
      this.d[c].write(io[c] + Math.tanh(this.tone[c].tick(echo) * fb * 1.1));
      io[c] += echo * 0.7;
    }
  }

  reset() {
    this.d.forEach((d) => d.clear());
  }
}

/** Saturation from warm to harsh: three curves, the level kept about where it was. */
class SoftClip implements Unit {
  private drive = 2;
  private shape = 0;

  set([db, shape]: readonly number[]) {
    this.drive = Math.pow(10, db / 20);
    this.shape = Math.round(shape);
  }

  start() {}

  tick(io: [number, number]) {
    const g = this.drive;
    const makeup = 1 / Math.max(1, Math.sqrt(g));
    for (let c = 0; c < 2; c++) {
      const x = io[c] * g;
      let y: number;
      if (this.shape === 1) y = Math.abs(x) < Math.PI / 2 ? Math.sin(x) : Math.sign(x);
      else if (this.shape === 2) y = Math.abs(x) < 2 ? x - (x * Math.abs(x)) / 4 : Math.sign(x);
      else y = Math.tanh(x);
      io[c] = y * makeup;
    }
  }

  reset() {}
}

/** The Knob FX, in catalog order (KNOB_FX). */
export function makeKnobFx(sr: number): Unit[] {
  return [new DjFilter(sr), new Tape(sr), new Vinyl(sr), new Vintage(sr), new Pumper(sr), new AutoPan(), new TapeDelay(sr), new SoftClip()];
}
