// Stock kits synthesized offline, so the app works with no sample files: the Factory kit and genre kits.
// Each sound is a small analog-style drum voice (pitch-swept bodies, shaped noise, 808 metal oscillators)
// rendered once into the library, then treated per kit (drive, tape roll-off, bit crush, a small room).
const SR = 44100;

/** Bumped whenever the sounds change, so kits rendered by an older version are rendered again (actions.ts). */
export const STOCK_REV = 4;

/** A drum voice: builds its nodes into `out` (the sound's bus) at time 0. */
type Gen = (ctx: BaseAudioContext, out: AudioNode) => void;

// ---------- building blocks ----------

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext) {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}

/** Gain envelope: rises over `attack`, holds, then falls exponentially (most of the way within `decay`). */
function envGain(ctx: BaseAudioContext, peak: number, attack: number, decay: number, t = 0, hold = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.setTargetAtTime(0, t + attack + hold, decay / 4);
  return g;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

/** Chain nodes in order; returns the last. */
function chain(...nodes: AudioNode[]) {
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return nodes[nodes.length - 1];
}

function shaper(ctx: BaseAudioContext, drive: number) {
  const s = ctx.createWaveShaper();
  const k = 1 + drive * 6;
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) c[i] = Math.tanh(k * ((i / 1023) * 2 - 1)) / Math.tanh(k);
  s.curve = c;
  s.oversample = "4x";
  return s;
}

/** Oscillator whose pitch falls exponentially from f0 towards f1 (time constant `tau`). */
function sweptOsc(ctx: BaseAudioContext, type: OscillatorType, f0: number, f1: number, tau: number, stop: number, t = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.setTargetAtTime(f1, t, tau);
  o.start(t);
  o.stop(t + stop);
  return o;
}

/** Filtered noise burst into `out`. */
function noiseHit(ctx: BaseAudioContext, out: AudioNode, filters: BiquadFilterNode[], peak: number, attack: number, decay: number, t = 0) {
  const n = noise(ctx);
  n.start(t, Math.random() * 3);
  n.stop(t + attack + decay * 1.5 + 0.05);
  chain(n, ...filters, envGain(ctx, peak, attack, decay, t), out);
}

const TR808_METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** The TR-808 metal: six detuned squares (hats, cymbals, cowbell-ish tones), filtered by the caller. */
function metal(ctx: BaseAudioContext, into: AudioNode, pitch: number, stop: number, t = 0) {
  for (const f of TR808_METAL) {
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = f * pitch;
    o.connect(into);
    o.start(t);
    o.stop(t + stop);
  }
}

const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

// ---------- drum voices, tuned per kit ----------

interface KickOpts { f0?: number; f1?: number; tau?: number; decay?: number; click?: number; knock?: number; drive?: number; punch?: number; grit?: number; body?: number }
/**
 * Sine body with an exponential pitch drop, a noise click, a short tonal knock and a little low-mid grit,
 * lightly saturated. The body falls from its punch (`punch`, time constant) to `body`, then tails off over
 * `decay`. Like Ableton's Core Library kicks: ~0.3 s to -40 dB, about -8 dB at 100 ms, settled near 50 Hz
 * by 20 ms and half the energy below 60 Hz (centroid ~60 Hz); clean enough to keep a ~10 dB crest.
 */
const kick = (o: KickOpts = {}): Gen => (c, out) => {
  const { f0 = 200, f1 = 46, tau = 0.016, decay = 0.32, click = 0.35, knock = 0.3, drive = 0.15, punch = 0.03, grit = 0.12, body = 0.22 } = o;
  const bus = drive ? shaperInto(c, drive, out) : out;
  const g = c.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.001);
  // Low plateau: the saturation after it lifts the tail again.
  g.gain.setTargetAtTime(body, 0.008, punch);
  g.gain.setTargetAtTime(0, 0.008 + punch * 2, decay / 5);
  chain(sweptOsc(c, "sine", f0, f1, tau, decay * 1.5 + 0.1), g, bus);
  if (knock) chain(sweptOsc(c, "sine", f0 * 4, f0 * 2, 0.005, 0.04), envGain(c, knock, 0.0005, 0.018), bus);
  if (click) noiseHit(c, bus, [filter(c, "highpass", 2000), filter(c, "peaking", 4500, 1, 5), filter(c, "lowpass", 9000)], click, 0.0005, 0.01);
  if (grit) noiseHit(c, bus, [filter(c, "bandpass", 400, 0.8)], grit, 0.001, 0.05);
};

/** A shaper feeding `out` (helper so voices can share one saturation stage). */
function shaperInto(ctx: BaseAudioContext, drive: number, out: AudioNode) {
  const s = shaper(ctx, drive);
  s.connect(out);
  return s;
}

interface BassOpts { from: number; to: number; glide?: number; decay?: number; drive?: number }
/** 808 bass drum / sub: a quick thump into a long sine, optionally gliding (drill slides), saturated for presence. */
const bass808 = (o: BassOpts): Gen => (c, out) => {
  const { from, to, glide = 0.04, decay = 1.6, drive = 0.4 } = o;
  const bus = shaperInto(c, drive, out);
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(from * 2.5, 0);
  osc.frequency.setTargetAtTime(from, 0, 0.012);
  osc.frequency.setTargetAtTime(to, 0.03, glide / 3);
  osc.start(0);
  osc.stop(decay * 1.5);
  chain(osc, envGain(c, 1, 0.001, decay, 0, 0.05), bus);
  noiseHit(c, bus, [filter(c, "highpass", 3000)], 0.15, 0.0005, 0.006);
};

interface SnareOpts { tone?: number; ratio?: number; toneDecay?: number; noiseHp?: number; presence?: number; snap?: number; noise?: number; body?: number; drive?: number }
/** Two tuned body modes with a little pitch drop, plus snappy noise with a presence lift. */
const snare = (o: SnareOpts = {}): Gen => (c, out) => {
  const { tone = 200, ratio = 1.7, toneDecay = 0.09, noiseHp = 1000, presence = 3500, snap = 0.13, noise: nAmt = 0.8, body = 0.95, drive = 0.12 } = o;
  const bus = drive ? shaperInto(c, drive, out) : out;
  for (const [f, g] of [[tone, body], [tone * ratio, body * 0.5]] as const) {
    chain(sweptOsc(c, "triangle", f * 1.35, f, 0.012, toneDecay * 1.5), envGain(c, g, 0.0005, toneDecay), bus);
  }
  // Lowpassed at 5.5 kHz: sampled snares keep only ~20 % of their energy above 2 kHz, the body carries them.
  noiseHit(c, bus, [filter(c, "highpass", noiseHp), filter(c, "peaking", Math.min(presence, 4500), 0.8, 3), filter(c, "lowpass", 5500)], nAmt, 0.0008, snap);
};

/** Brushed / ghost snare: soft band-limited noise with a slower attack. */
const brush = (band = 3000, decay = 0.25): Gen => (c, out) =>
  noiseHit(c, out, [filter(c, "bandpass", band, 0.6), filter(c, "lowpass", 9000)], 0.8, 0.012, decay);

interface ClapOpts { band?: number; tail?: number; bursts?: number; spread?: number }
/** Hand clap: a flurry of uneven noise bursts (several hands), then a short tail, through one band-pass. */
const clap = (o: ClapOpts = {}): Gen => (c, out) => {
  const { band = 1200, tail = 0.09, bursts = 7, spread = 0.0065 } = o;
  const n = noise(c);
  const g = c.createGain();
  g.gain.setValueAtTime(0, 0);
  let t = 0;
  for (let i = 0; i < bursts; i++) {
    // Loudest first, like sampled claps (they peak within ~3 ms); the tail starts a little lower.
    g.gain.setValueAtTime(i === 0 ? 1 : i === bursts - 1 ? 0.7 : 0.5 + Math.random() * 0.3, t);
    if (i < bursts - 1) g.gain.setTargetAtTime(0.03, t + 0.0004, 0.0018);
    else g.gain.setTargetAtTime(0, t + 0.002, tail / 4);
    if (i < bursts - 1) t += spread * (0.6 + Math.random() * 0.8);
  }
  n.start(0, Math.random() * 3);
  n.stop(t + tail * 1.5 + 0.05);
  chain(n, filter(c, "highpass", 600), filter(c, "bandpass", band, 0.9), filter(c, "peaking", band * 3, 0.8, 5), filter(c, "lowpass", 10000), g, out);
};

/** Finger snap: a tight band of noise with a tiny tonal tick. */
const snap = (band = 2400): Gen => (c, out) => {
  noiseHit(c, out, [filter(c, "bandpass", band, 3)], 1, 0.0005, 0.045);
  chain(sweptOsc(c, "sine", 2200, 1600, 0.004, 0.02), envGain(c, 0.25, 0.0003, 0.008), out);
};

/** A struck mode of a rim: frequency, level and decay (s). */
type Mode = [freq: number, amp: number, decay: number];

// Modes measured from sampled rims (Ableton's Core Library). In all of them the high partials are gone within
// ~10 ms, or ring on as a dense, noisy shell; one clean high tone that rings reads as a beep.
/** TR-808: two bridged-T tones, the high one leading, gone within ~15 ms. */
const RIM_808: Mode[] = [[480, 0.45, 0.012], [1800, 1, 0.008]];
/** TR-909: three resonators over a 226 Hz body that outlasts them (a dark sound: centroid ~300 Hz). */
const RIM_909: Mode[] = [[226, 0.5, 0.05], [484, 0.55, 0.035], [742, 0.4, 0.02], [1010, 1, 0.016], [1300, 0.3, 0.01]];
/** Side stick: a short thump of the drum's body under the stick's crack and the brighter, longer ring of the shell. */
const SIDESTICK: Mode[] = [[215, 0.7, 0.035], [473, 0.35, 0.03], [1108, 0.5, 0.07], [1819, 0.45, 0.08], [2304, 0.35, 0.06], [3150, 0.2, 0.04]];

interface RimOpts { tune?: number; drive?: number; click?: number; grain?: number }
/**
 * Rimshot / side stick: struck modes (each with a slight pitch drop), a noise click for the stick, and optionally
 * `grain`, noise rung through the upper modes so they sound wooden rather than like sine tones.
 */
const rim = (modes: Mode[], o: RimOpts = {}): Gen => (c, out) => {
  const { tune = 1, drive = 0, click = 0.3, grain = 0 } = o;
  const hp = chain(filter(c, "highpass", modes[0][0] * tune * 0.6), out);
  const bus = drive ? shaperInto(c, drive, hp) : hp;
  for (const [f0, amp, d] of modes) {
    const f = f0 * tune;
    chain(sweptOsc(c, "sine", f * 1.04, f, 0.003, d * 1.5 + 0.01), envGain(c, amp, 0.0002, d), bus);
    if (grain && f > 400) noiseHit(c, bus, [filter(c, "bandpass", f, 8)], amp * grain, 0.0003, d * 0.7);
  }
  if (click) noiseHit(c, bus, [filter(c, "highpass", 1750), filter(c, "bandpass", 3500, 0.8)], click, 0.0002, 0.006);
};

/** 808-style hat: the six metal squares through a band-pass at 10 kHz and a high-pass, plus a little noise sizzle. */
const hat = (decay: number, o: { hp?: number; pitch?: number; amt?: number; sizzle?: number; bp?: number } = {}): Gen => (c, out) => {
  // Sampled hats measure a ~7.7 kHz centroid with two thirds of their energy above 6 kHz.
  const { hp = 6000, pitch = 1, amt = 0.6, sizzle = 0.3, bp: band = 9000 } = o;
  const g = envGain(c, amt, 0.0005, decay);
  const bp = filter(c, "bandpass", band, 0.7);
  chain(bp, filter(c, "highpass", hp * 0.85), filter(c, "lowpass", 14000), g, out);
  metal(c, bp, pitch, decay * 1.5 + 0.02);
  if (sizzle) noiseHit(c, out, [filter(c, "highpass", hp), filter(c, "lowpass", 14000)], amt * sizzle, 0.0005, decay * 0.8);
};

/** Noise hat for the dustier kits: brighter top, no metallic ring. */
const noiseHat = (decay: number, hp = 6000, amt = 0.6): Gen => (c, out) =>
  noiseHit(c, out, [filter(c, "highpass", hp * 0.85), filter(c, "peaking", 7000, 1, 4), filter(c, "lowpass", 9500)], amt, 0.0006, decay);

/** Shaker: band of noise with a soft attack (two grains, like a shake back and forth). */
const shaker = (band = 6000, decay = 0.08): Gen => (c, out) => {
  noiseHit(c, out, [filter(c, "bandpass", band, 1.4)], 0.5, 0.02, decay);
  noiseHit(c, out, [filter(c, "bandpass", band * 1.15, 1.4)], 0.35, 0.015, decay * 0.7, decay * 0.4);
};

/** Tambourine: metal jingles plus noise, with a couple of follow-up jingles. */
const tamb = (decay = 0.2): Gen => (c, out) => {
  for (const [t, a] of [[0, 1], [0.025, 0.5], [0.05, 0.3]] as const) {
    const g = envGain(c, 0.25 * a, 0.001, decay, t);
    const bp = filter(c, "bandpass", 9000, 1.2);
    chain(bp, g, out);
    metal(c, bp, 1.35, t + decay * 1.5, t);
    noiseHit(c, out, [filter(c, "bandpass", 7500, 1.5)], 0.35 * a, 0.001, decay * 0.8, t);
  }
};

/** Two-stage envelope: from `peak` down to `peak * floor` over `fall` (the hit), then out over `decay` (the wash). */
function hitWash(ctx: BaseAudioContext, peak: number, attack: number, fall: number, floor: number, decay: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(peak, attack);
  g.gain.setTargetAtTime(peak * floor, attack, fall / 3);
  g.gain.setTargetAtTime(0, attack + fall, decay / 4);
  return g;
}

/** Ride: metal with a lower band, a bell "ping" and a long wash; the stick hit falls about 10 dB within 100 ms, like sampled rides. */
const ride = (decay = 1.4, o: { pitch?: number; bell?: number } = {}): Gen => (c, out) => {
  const { pitch = 1.25, bell = 0.15 } = o;
  const bp = filter(c, "bandpass", 9500, 0.7);
  chain(bp, filter(c, "highpass", 3000), filter(c, "lowpass", 14000), hitWash(c, 0.35, 0.001, 0.08, 0.3, decay), out);
  metal(c, bp, pitch, decay * 1.5);
  const n = noise(c);
  n.start(0, Math.random() * 3);
  n.stop(decay * 1.5 + 0.05);
  chain(n, filter(c, "highpass", 7000), filter(c, "lowpass", 14000), hitWash(c, 0.3, 0.001, 0.08, 0.3, decay * 0.7), out);
  for (const f of [3100, 4600]) chain(sweptOsc(c, "sine", f, f, 1, decay), envGain(c, bell, 0.001, decay * 0.5), out);
};

/** Crash: noise and metal, a fast bloom and a long wash. */
const crash = (decay = 1.8, hp = 3500): Gen => (c, out) => {
  const bp = filter(c, "bandpass", 5500, 0.5);
  chain(bp, filter(c, "highpass", hp * 0.8), filter(c, "lowpass", 13000), hitWash(c, 0.25, 0.003, 0.15, 0.6, decay), out);
  metal(c, bp, 1.6, decay * 1.5);
  const n = noise(c);
  n.start(0, Math.random() * 3);
  n.stop(decay * 1.5 + 0.05);
  chain(n, filter(c, "highpass", hp * 0.8), filter(c, "peaking", 5000, 0.8, 3), filter(c, "lowpass", 13000), hitWash(c, 0.6, 0.004, 0.15, 0.6, decay), out);
};

/** Tom: a pitched sine dropping a fourth, a soft attack noise and a little drive. */
const tom = (f: number, decay = 0.22): Gen => (c, out) => {
  const bus = shaperInto(c, 0.15, out);
  chain(sweptOsc(c, "sine", f * 1.8, f, 0.03, decay * 1.5), envGain(c, 1, 0.001, decay), bus);
  chain(sweptOsc(c, "triangle", f * 3, f * 2.2, 0.02, decay), envGain(c, 0.4, 0.001, decay * 0.4), bus);
  noiseHit(c, bus, [filter(c, "bandpass", Math.max(900, f * 7), 0.8)], 0.45, 0.001, 0.05);
};

/** Conga / bongo: a quick pitch blip and a slap. */
const conga = (f: number, decay = 0.25): Gen => (c, out) => {
  chain(sweptOsc(c, "sine", f * 1.3, f, 0.01, decay * 1.5), envGain(c, 1, 0.0008, decay), out);
  noiseHit(c, out, [filter(c, "bandpass", 2200, 1.5)], 0.2, 0.0005, 0.015);
};

/** 808 cowbell: two squares through a band-pass, a fast first drop then a slower ring. */
const cowbell = (a = 540, b = 800): Gen => (c, out) => {
  const g = c.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.001);
  g.gain.setTargetAtTime(0.15, 0.001, 0.008);
  g.gain.setTargetAtTime(0, 0.03, 0.045);
  // Sampled 808 cowbells sit near their two tones (~800 Hz centroid), not up in the square waves' harmonics.
  const bp = filter(c, "bandpass", 900, 1);
  chain(bp, g, out);
  for (const f of [a, b]) {
    const o = c.createOscillator();
    o.type = "square";
    o.frequency.value = f;
    o.connect(bp);
    o.start(0);
    o.stop(0.6);
  }
};

const clave = (f = 2500): Gen => (c, out) => {
  chain(sweptOsc(c, "sine", f, f, 1, 0.1), envGain(c, 0.8, 0.0003, 0.04), out);
};

/** Woodblock / perc: a hollow triangle knock with a higher partial. */
const wood = (f = 900): Gen => (c, out) => {
  chain(sweptOsc(c, "triangle", f * 1.1, f, 0.005, 0.2), envGain(c, 0.8, 0.0005, 0.1), out);
  chain(sweptOsc(c, "sine", f * 2.7, f * 2.6, 0.005, 0.08), envGain(c, 0.25, 0.0005, 0.04), out);
};

/** Pitch-sweep effect. */
const zap = (from = 2400, to = 60, time = 0.2, type: OscillatorType = "sawtooth"): Gen => (c, out) => {
  chain(sweptOsc(c, type, from, to, time / 3, time * 1.5), filter(c, "lowpass", 8000), envGain(c, 0.5, 0.001, time), out);
};

/** Noise riser: a band-pass sweeping up while it swells. */
const riser = (time = 0.5): Gen => (c, out) => {
  const n = noise(c);
  const bp = filter(c, "bandpass", 300, 2);
  bp.frequency.exponentialRampToValueAtTime(6000, time);
  const g = c.createGain();
  g.gain.setValueAtTime(0.001, 0);
  g.gain.exponentialRampToValueAtTime(1, time);
  g.gain.linearRampToValueAtTime(0, time + 0.05);
  n.start(0);
  n.stop(time + 0.1);
  chain(n, bp, g, out);
};

/** Record scratch: a band-limited saw pushed up and pulled back. */
const scratch: Gen = (c, out) => {
  const bus = chain(filter(c, "bandpass", 1500, 0.8), out);
  const o = c.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(220, 0);
  o.frequency.exponentialRampToValueAtTime(1300, 0.07);
  o.frequency.exponentialRampToValueAtTime(260, 0.18);
  o.start(0);
  o.stop(0.22);
  const g = c.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.6, 0.01);
  g.gain.setValueAtTime(0.6, 0.06);
  g.gain.linearRampToValueAtTime(0.1, 0.085);
  g.gain.linearRampToValueAtTime(0.6, 0.1);
  g.gain.linearRampToValueAtTime(0, 0.2);
  chain(o, g, bus);
};

/** Chord stab: detuned pairs of `wave` per note through a lowpass with its own envelope. */
const chord = (notes: number[], wave: OscillatorType, decay: number, o: { cutoff?: number; env?: number } = {}): Gen => (c, out) => {
  const { cutoff = 1200, env = 4 } = o;
  const lp = filter(c, "lowpass", cutoff, 2);
  lp.frequency.setValueAtTime(cutoff * env, 0);
  lp.frequency.setTargetAtTime(cutoff, 0.002, decay / 4);
  chain(lp, envGain(c, 0.5, 0.002, decay, 0, 0.02), out);
  for (const n of notes) {
    for (const cents of [-8, 8]) {
      const osc = c.createOscillator();
      osc.type = wave;
      osc.frequency.value = hz(n);
      osc.detune.value = cents;
      const g = c.createGain();
      g.gain.value = 0.5 / notes.length;
      chain(osc, g, lp);
      osc.start(0);
      osc.stop(decay * 1.5 + 0.05);
    }
  }
};

/** Bell: inharmonic sine partials, the higher ones dying sooner. */
const bell = (f: number, decay = 1.2): Gen => (c, out) => {
  for (const [r, a, d] of [[1, 0.6, 1], [2.76, 0.3, 0.5], [5.4, 0.15, 0.25], [8.93, 0.08, 0.12]] as const) {
    chain(sweptOsc(c, "sine", f * r, f * r, 1, decay * d * 1.5), envGain(c, a, 0.001, decay * d), out);
  }
};

/** A dusty hit: band-passed noise thump with a low body, like a hit lifted off vinyl. */
const vinylHit: Gen = (c, out) => {
  noiseHit(c, out, [filter(c, "bandpass", 1500, 0.8)], 0.5, 0.002, 0.35);
  chain(sweptOsc(c, "sine", 120, 55, 0.03, 0.4), envGain(c, 0.6, 0.001, 0.25), out);
};

// ---------- treatment ----------

/** Offline "sampler" treatment after rendering: drive (tanh), fewer bits, a lower sample rate, then a lowpass. */
interface Fx { drive?: number; lp?: number; bits?: number; hold?: number; room?: number }

function applyFx(data: Float32Array, fx: Fx) {
  const { drive, lp, bits, hold } = fx;
  const a = lp ? 1 - Math.exp((-2 * Math.PI * lp) / SR) : 1;
  const q = bits ? 2 ** (bits - 1) : 0;
  const norm = drive ? Math.tanh(drive) : 1;
  // Like a sampler: saturate, crush (bits, rate), then the output filter (two one-poles, 12 dB) smooths the grit.
  let y1 = 0, y2 = 0, held = 0;
  for (let i = 0; i < data.length; i++) {
    let x = data[i];
    if (drive) x = Math.tanh(x * drive) / norm;
    if (q) x = Math.round(x * q) / q;
    if (hold && hold > 1) x = i % hold === 0 ? (held = x) : held;
    y1 += a * (x - y1);
    y2 += a * (y1 - y2);
    data[i] = lp ? y2 : x;
  }
}

/** A small room: exponentially decaying, darkening noise as the impulse response. */
function roomIR(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / ctx.sampleRate;
    const a = 0.25 + 0.6 * (t / seconds); // darker as it decays
    y += (1 - a) * (Math.random() * 2 - 1 - y);
    d[i] = y * Math.exp((-6 * t) / seconds);
  }
  return b;
}

const ROOM_SECONDS = 0.35;

const PEAK = 0.9;

function normalize(data: Float32Array, peak: number) {
  let max = 0;
  for (const x of data) max = Math.max(max, Math.abs(x));
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
}

/** Below this (dB under the peak) a sound counts as faded out; the render is cut there. */
const TRIM_DB = -54;

/** The buffer cut where it has faded out (plus a short fade, so it never clicks). */
function trimmed(buffer: AudioBuffer, fadeMs = 10) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  const floor = peak * 10 ** (TRIM_DB / 20);
  let last = d.length - 1;
  while (last > 0 && Math.abs(d[last]) < floor) last--;
  const fade = Math.round((fadeMs / 1000) * SR);
  const len = Math.min(d.length, last + fade);
  const out = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: SR });
  const o = out.getChannelData(0);
  o.set(d.subarray(0, len));
  for (let i = 0; i < Math.min(fade, len); i++) o[len - 1 - i] *= i / fade;
  return out;
}

/** One pad: name, length in seconds, generator, and its own Fx on top of the kit's (room: wet level 0..1). */
type Sound = [name: string, len: number, gen: Gen, fx?: Fx];

interface StockKit { sounds: Sound[]; fx?: Fx }

// 16 sounds each, pads 1-16 (pad 1 = bottom left): the groove on the bottom row, variations, toms, cymbals and colour on top.
// "Hat Cl" / "Hat Op" choke each other. Lengths are upper bounds: each render is trimmed where it fades out.
// Tuned against Ableton Live's Core Library one-shots, per kit the drum machines or sampled kits it's modelled on
// (npm run measure; lengths to -40 dB): kicks ~0.3 s settling near 50 Hz, snares ~0.2 s with the body carrying
// most of the energy, claps ~0.2 s, closed hats ~0.12 s and open ~0.45 s around 7.5 kHz, toms ~0.4 s, rides
// ~1.2 s and crashes ~1.5-2 s around 6 kHz.
const KITS: Record<string, StockKit> = {
  // All-rounder: punchy, clean, a touch of room on the snare and clap.
  Factory: { fx: { drive: 1.1 }, sounds: [
    ["Kick", 0.6, kick({ f0: 190, f1: 48 })],
    ["Snare", 0.5, snare({ tone: 200, snap: 0.125 }), { room: 0.15 }],
    ["Clap", 0.5, clap(), { room: 0.2 }],
    ["Rim", 0.25, rim(RIM_808)],
    ["Hat Cl", 0.3, hat(0.1)],
    ["Hat Op", 0.8, hat(0.396, { amt: 0.5 })],
    ["Shaker", 0.3, shaker()],
    ["Ride", 2, ride(1.3)],
    ["Tom Lo", 0.84, tom(95, 0.294)],
    ["Tom Mid", 0.7, tom(135, 0.252)],
    ["Tom Hi", 0.7, tom(190, 0.21)],
    ["Cowbell", 0.5, cowbell()],
    ["808", 2, bass808({ from: 55, to: 50, decay: 1.4 })],
    ["Crash", 2.4, crash(1.8)],
    ["Zap", 0.4, zap()],
    ["Stab", 0.8, chord([60, 63, 67, 70], "sawtooth", 0.5)],
  ] },
  // Dusty and soft: short rounded kicks, brushy snares, rolled off and crushed like a sampled record.
  // Darker than the others (measured: lo-fi packs' snares sit near 4 kHz, kicks near 150 Hz).
  "Lo-Fi": { fx: { drive: 1.4, lp: 4500, bits: 12, hold: 2, room: 0.1 }, sounds: [
    ["Kick", 0.6, kick({ f0: 120, f1: 48, tau: 0.025, decay: 0.22, click: 0.05, knock: 0.08, drive: 0.3, grit: 0.04, body: 0.25 })],
    ["Snare", 0.5, snare({ tone: 190, snap: 0.115, noise: 0.6, presence: 3500, body: 0.6 })],
    ["Rim", 0.25, rim(SIDESTICK, { tune: 0.95, click: 1.4, grain: 4 })],
    ["Snap", 0.2, snap(2100)],
    ["Hat Cl", 0.3, noiseHat(0.1, 5500, 0.5)],
    ["Hat Op", 0.7, noiseHat(0.385, 5000, 0.45)],
    ["Shaker", 0.3, shaker(5500, 0.1)],
    ["Brush", 0.5, brush(2800, 0.22)],
    ["Kick 2", 0.6, kick({ f0: 105, f1: 44, tau: 0.03, decay: 0.25, click: 0.03, knock: 0.05, drive: 0.35, grit: 0.05, body: 0.25 })],
    ["Snare 2", 0.4, snare({ tone: 170, snap: 0.096, noise: 0.5, body: 0.45, presence: 3000 })],
    ["Conga Lo", 0.5, conga(220, 0.26)],
    ["Conga Hi", 0.4, conga(320, 0.2)],
    ["Wood", 0.2, wood(800)],
    ["Ride", 1.8, ride(1.2, { bell: 0.08 })],
    ["Keys", 1.4, chord([57, 60, 64, 67, 71], "triangle", 1, { cutoff: 1800, env: 2 })],
    ["Vinyl Hit", 0.6, vinylHit],
  ] },
  // Hard-hitting 90s: punchy mid-heavy kick, cracking snare, gritty like an SP-1200.
  "Boom Bap": { fx: { drive: 1.8, lp: 10000, bits: 12, room: 0.08 }, sounds: [
    ["Kick", 0.6, kick({ f0: 170, f1: 50, tau: 0.018, decay: 0.22, click: 0.45, knock: 0.45, drive: 0.45, grit: 0.25, body: 0.2 })],
    ["Snare", 0.5, snare({ tone: 200, snap: 0.144, noise: 0.95, presence: 4000, drive: 0.6 }), { room: 0.18 }],
    ["Clap", 0.5, clap({ band: 1300, tail: 0.096 })],
    ["Rim", 0.25, rim(SIDESTICK, { click: 2, grain: 4 })],
    ["Hat Cl", 0.3, noiseHat(0.1, 6500, 0.55)],
    ["Hat Op", 0.7, noiseHat(0.352, 6000, 0.5)],
    ["Shaker", 0.3, shaker(6000, 0.08)],
    ["Tamb", 0.5, tamb(0.22)],
    ["Kick 2", 0.5, kick({ f0: 200, f1: 55, tau: 0.015, decay: 0.17, click: 0.5, knock: 0.5, drive: 0.5, grit: 0.3, body: 0.18 })],
    ["Snare 2", 0.4, snare({ tone: 240, snap: 0.106, noise: 0.85, presence: 5000, drive: 0.6 })],
    ["Snap", 0.2, snap(2600)],
    ["Tom Lo", 0.7, tom(110, 0.28)],
    ["Tom Hi", 0.56, tom(180, 0.21)],
    ["Crash", 2.2, crash(1.6)],
    ["Scratch", 0.3, scratch],
    ["Horns", 0.7, chord([58, 62, 65], "sawtooth", 0.45, { cutoff: 1600, env: 3 })],
  ] },
  // Modern and clean: tight kick, 808s to play bass lines with pitch.
  "Hip Hop": { fx: { drive: 1.2 }, sounds: [
    ["Kick", 0.6, kick({ f0: 185, f1: 50, decay: 0.24 })],
    ["808", 2.2, bass808({ from: 55, to: 55, decay: 1.6 })],
    ["Snare", 0.5, snare({ tone: 220, snap: 0.125, presence: 5000 }), { room: 0.12 }],
    ["Clap", 0.5, clap({ band: 1250, tail: 0.104 }), { room: 0.15 }],
    ["Hat Cl", 0.3, hat(0.088, { hp: 7000 })],
    ["Hat Op", 0.8, hat(0.396, { hp: 6500, amt: 0.5 })],
    ["Rim", 0.25, rim(SIDESTICK, { tune: 1.05, click: 2, grain: 3 })],
    ["Snap", 0.2, snap(2800)],
    ["Kick 2", 0.7, kick({ f0: 155, f1: 45, tau: 0.022, decay: 0.3, click: 0.2, knock: 0.2 })],
    ["808 Hi", 2, bass808({ from: 73, to: 73, decay: 1.4 })],
    ["Snare 2", 0.4, snare({ tone: 260, snap: 0.096, noise: 0.75, presence: 5500 })],
    ["Perc", 0.25, wood(1100)],
    ["Shaker", 0.3, shaker(6500, 0.09)],
    ["Crash", 2.2, crash(1.7, 4000)],
    ["Zap", 0.4, zap(1800, 80, 0.18)],
    ["Bell", 1.6, bell(880, 1.1)],
  ] },
  // Long 808s, tight snares and claps, crisp hats for rolls.
  Trap: { fx: { drive: 1.3 }, sounds: [
    ["Kick", 0.5, kick({ f0: 210, f1: 52, tau: 0.014, decay: 0.2, click: 0.45, knock: 0.35, drive: 0.3 })],
    ["808", 2.6, bass808({ from: 49, to: 49, decay: 2, drive: 0.6 })],
    ["Snare", 0.4, snare({ tone: 280, snap: 0.106, noise: 0.85, presence: 5500, body: 0.55 })],
    ["Clap", 0.5, clap({ band: 1400, tail: 0.112, bursts: 8, spread: 0.006 }), { room: 0.15 }],
    ["Hat Cl", 0.2, hat(0.062, { hp: 7500 })],
    ["Hat Op", 0.7, hat(0.352, { hp: 7000, amt: 0.5 })],
    ["Hat Tick", 0.12, hat(0.025, { hp: 8000, sizzle: 0.4 })],
    ["Rim", 0.2, rim(RIM_808, { tune: 1.05 })],
    ["Kick 2", 0.4, kick({ f0: 240, f1: 56, tau: 0.012, decay: 0.16, click: 0.5, knock: 0.4, drive: 0.35 })],
    ["808 Hi", 2.4, bass808({ from: 65, to: 65, decay: 1.8, drive: 0.6 })],
    ["Snap", 0.2, snap(3000)],
    ["Perc", 0.25, wood(1300)],
    ["Cowbell", 0.5, cowbell()],
    ["Crash", 2.4, crash(1.9, 4500)],
    ["Riser", 0.7, riser(0.5)],
    ["Bell", 1.8, bell(1046, 1.3)],
  ] },
  // UK drill: sliding 808s, short punchy kicks, crisp snares and sharp percs.
  Drill: { fx: { drive: 1.4 }, sounds: [
    ["Kick", 0.4, kick({ f0: 220, f1: 54, tau: 0.012, decay: 0.17, click: 0.5, knock: 0.4, drive: 0.3 })],
    ["808 Slide", 2.4, bass808({ from: 98, to: 46, glide: 0.35, decay: 1.8, drive: 0.7 })],
    ["Snare", 0.35, snare({ tone: 320, snap: 0.096, noise: 0.9, presence: 6000, body: 0.5 })],
    ["Clap", 0.4, clap({ band: 1500, tail: 0.08, spread: 0.006 })],
    ["Hat Cl", 0.2, hat(0.056, { hp: 8000 })],
    ["Hat Op", 0.6, hat(0.308, { hp: 7500, amt: 0.5 })],
    ["Rim", 0.2, rim(RIM_808, { tune: 1.1 })],
    ["Perc", 0.2, wood(1400)],
    ["Kick 2", 0.35, kick({ f0: 260, f1: 60, tau: 0.01, decay: 0.14, click: 0.5, knock: 0.45, drive: 0.4 })],
    ["808 Up", 2.4, bass808({ from: 41, to: 62, glide: 0.3, decay: 1.8, drive: 0.7 })],
    ["Snare 2", 0.35, snare({ tone: 350, snap: 0.086, noise: 0.8, presence: 6500, body: 0.45 })],
    ["Snap", 0.2, snap(3200)],
    ["Shaker", 0.2, shaker(7500, 0.08)],
    ["Crash", 2.2, crash(1.6, 4500)],
    ["Dark Bell", 1.8, bell(622, 1.3)],
    ["Zap", 0.4, zap(2000, 100, 0.2)],
  ] },
  // 909-style: driven four-on-the-floor kick, metallic hats, roomy claps, organ and chord stabs.
  House: { fx: { drive: 1.2 }, sounds: [
    ["Kick", 0.7, kick({ f0: 210, f1: 50, tau: 0.018, decay: 0.3, click: 0.45, knock: 0.3, drive: 0.35, punch: 0.04 })],
    ["Clap", 0.6, clap({ band: 1100, tail: 0.12 }), { room: 0.25 }],
    ["Snare", 0.5, snare({ tone: 200, snap: 0.134, presence: 4500 }), { room: 0.15 }],
    ["Rim", 0.2, rim(RIM_909)],
    ["Hat Cl", 0.3, hat(0.088, { pitch: 1.1 })],
    ["Hat Op", 0.7, hat(0.374, { pitch: 1.1, amt: 0.5 })],
    ["Shaker", 0.3, shaker(6500, 0.09)],
    ["Ride", 1.8, ride(1.2, { pitch: 1.4 })],
    ["Kick 2", 0.8, kick({ f0: 165, f1: 44, tau: 0.024, decay: 0.34, click: 0.25, knock: 0.15, punch: 0.045 })],
    ["Clap 2", 0.7, clap({ band: 1300, tail: 0.176, bursts: 9, spread: 0.008 }), { room: 0.3 }],
    ["Tamb", 0.5, tamb(0.22)],
    ["Conga", 0.4, conga(220)],
    ["Cowbell", 0.5, cowbell()],
    ["Crash", 2.4, crash(1.5)],
    ["Organ", 0.7, chord([57, 60, 64, 67], "square", 0.4, { cutoff: 2500, env: 1.5 })],
    ["Chord", 0.9, chord([57, 60, 64, 67, 71], "sawtooth", 0.6, { cutoff: 1500, env: 3 }), { room: 0.2 }],
  ] },
  // Hard and dark: long distorted kick, rumble, metallic percussion, a minor stab.
  Techno: { fx: { drive: 1.3 }, sounds: [
    ["Kick", 0.7, kick({ f0: 240, f1: 46, tau: 0.02, decay: 0.272, click: 0.6, knock: 0.45, drive: 1.2, punch: 0.04, grit: 0.25, body: 0.09 })],
    ["Clap", 0.6, clap({ band: 1200, tail: 0.128, spread: 0.007 }), { room: 0.3 }],
    ["Snare", 0.5, snare({ tone: 210, snap: 0.144, noise: 0.95, body: 0.7, presence: 4000, drive: 0.7 })],
    ["Rim", 0.2, rim(RIM_909, { tune: 1.05, drive: 0.4 })],
    ["Hat Cl", 0.25, hat(0.075, { hp: 7000, pitch: 1.15 })],
    ["Hat Op", 0.6, hat(0.33, { hp: 6500, pitch: 1.15, amt: 0.5 })],
    ["Ride", 1.8, ride(1.2, { pitch: 1.5, bell: 0.1 })],
    ["Perc", 0.35, bell(300, 0.25), { drive: 2.5 }],
    ["Rumble", 1.4, bass808({ from: 50, to: 45, decay: 1.1, drive: 1 }), { lp: 500, room: 0.3 }],
    ["Kick 2", 0.5, kick({ f0: 280, f1: 55, tau: 0.012, decay: 0.22, click: 0.6, knock: 0.5, drive: 1.2, grit: 0.25, punch: 0.02, body: 0.15 })],
    ["Clave", 0.15, clave(2200)],
    ["Tom", 0.56, tom(140, 0.238)],
    ["Shaker", 0.25, shaker(7500, 0.085)],
    ["Crash", 2.4, crash(1.5, 4500)],
    ["Stab", 0.6, chord([57, 60, 64], "sawtooth", 0.35, { cutoff: 900, env: 5 }), { room: 0.25 }],
    ["Zap", 0.4, zap(3000, 50, 0.25)],
  ] },
  // Drum & bass: tight kick, cracking bright snare, ghost snare for rolling breaks, a deep sub.
  DnB: { fx: { drive: 1.4 }, sounds: [
    ["Kick", 0.5, kick({ f0: 200, f1: 54, tau: 0.014, decay: 0.2, click: 0.5, knock: 0.4 })],
    ["Snare", 0.5, snare({ tone: 230, snap: 0.144, noise: 1, body: 0.8, presence: 4500, drive: 0.7 }), { room: 0.15 }],
    ["Ghost", 0.3, snare({ tone: 250, snap: 0.077, noise: 0.5, body: 0.35, presence: 6000 })],
    ["Rim", 0.2, rim(SIDESTICK, { tune: 1.1, click: 2.2, grain: 3 })],
    ["Hat Cl", 0.2, hat(0.062, { hp: 7500 })],
    ["Hat Op", 0.6, hat(0.33, { hp: 7000, amt: 0.5 })],
    ["Shaker", 0.2, shaker(7500, 0.08)],
    ["Ride", 1.6, ride(1.2, { pitch: 1.35 })],
    ["Kick 2", 0.6, kick({ f0: 170, f1: 48, tau: 0.018, decay: 0.24, click: 0.35, knock: 0.3 })],
    ["Snare 2", 0.4, snare({ tone: 270, snap: 0.106, noise: 0.9, presence: 6000, drive: 0.6 })],
    ["Clap", 0.5, clap({ band: 1400, tail: 0.088 })],
    ["Tom", 0.56, tom(150, 0.238)],
    ["Tamb", 0.5, tamb(0.22)],
    ["Crash", 2.4, crash(1.6, 4000)],
    ["Sub", 1.6, bass808({ from: 41, to: 41, decay: 1.2, drive: 0.3 })],
    ["Zap", 0.4, zap(2600, 70, 0.2)],
  ] },
  // Classic drum machine: booming 808 kick, metallic hats, cowbell, claves and toms.
  Electro: { sounds: [
    ["Kick", 1.2, bass808({ from: 52, to: 47, decay: 0.8, drive: 0.3 })],
    ["Snare", 0.4, snare({ tone: 238, ratio: 2, toneDecay: 0.09, snap: 0.115, noise: 0.7, presence: 5000, drive: 0 })],
    ["Clap", 0.5, clap({ band: 1100, tail: 0.112 })],
    ["Rim", 0.2, rim(RIM_808)],
    ["Hat Cl", 0.3, hat(0.088)],
    ["Hat Op", 0.8, hat(0.462, { amt: 0.5 })],
    ["Cowbell", 0.5, cowbell()],
    ["Clave", 0.15, clave()],
    ["Tom Lo", 0.84, tom(80, 0.336)],
    ["Tom Mid", 0.7, tom(120, 0.28)],
    ["Tom Hi", 0.7, tom(170, 0.238)],
    ["Conga", 0.4, conga(300, 0.22)],
    ["Maraca", 0.2, shaker(9000, 0.035)],
    ["Cymbal", 2.6, crash(2.1, 5000)],
    ["Zap", 0.4, zap()],
    ["Laser", 0.3, zap(4000, 400, 0.15, "square")],
  ] },
};

/** Pad names of a stock kit, pads 1-16. */
export const stockSounds = (kit: string) => KITS[kit]?.sounds.map(([name]) => name) ?? [];

/** Sound lengths of a stock kit, so the pads can ring as long as the sound. */
export const stockLengths = (kit: string) => KITS[kit]?.sounds.map(([, len]) => len) ?? [];

/** Render a stock kit's 16 sounds. */
export async function renderStockKit(kit: string): Promise<{ name: string; buffer: AudioBuffer }[]> {
  const def = KITS[kit];
  if (!def) throw new Error(`No stock kit ${kit}`);
  return Promise.all(
    def.sounds.map(async ([name, len, gen, fx]) => {
      // Rendered with room to spare; trimmed() then cuts it where it has actually faded out.
      const ctx = new OfflineAudioContext(1, Math.ceil((len * 1.5 + 0.3) * SR), SR);
      const all: Fx = { ...def.fx, ...fx };
      // The voice plays into a bus; a room (when asked for) is mixed in from it.
      const bus = ctx.createGain();
      bus.connect(ctx.destination);
      if (all.room) {
        const conv = ctx.createConvolver();
        conv.buffer = roomIR(ctx, ROOM_SECONDS);
        const wet = ctx.createGain();
        wet.gain.value = all.room;
        chain(bus, conv, wet, ctx.destination);
      }
      gen(ctx, bus);
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      applyFx(data, all);
      normalize(data, PEAK);
      return { name, buffer: trimmed(buffer) };
    }),
  );
}
