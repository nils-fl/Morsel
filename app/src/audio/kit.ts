// Stock kits synthesized offline, so the app works with no sample files: the Factory kit and genre kits.
const SR = 44100;

type Gen = (ctx: OfflineAudioContext) => void;

function noise(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}

function env(ctx: BaseAudioContext, peak: number, attack: number, decay: number, t = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function tone(ctx: BaseAudioContext, type: OscillatorType, f0: number, f1: number, sweep: number, peak: number, decay: number, t = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const g = env(ctx, peak, 0.002, decay, t);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + decay + 0.05);
}

const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** Six detuned squares through a highpass: the metallic 808 / 909 hat and cymbal sound. */
function metal(ctx: BaseAudioContext, base: number, hp: number, peak: number, decay: number, t = 0) {
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = hp;
  const g = env(ctx, peak, 0.001, decay, t);
  f.connect(g).connect(ctx.destination);
  for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = base * r;
    o.connect(f);
    o.start(t);
    o.stop(t + decay + 0.05);
  }
}

function filteredNoise(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number, t = 0) {
  const n = noise(ctx, decay + 0.1);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(ctx, peak, 0.001, decay, t);
  n.connect(f).connect(g).connect(ctx.destination);
  n.start(t);
}

// ---------- drum voices, tuned per kit ----------

/** Pitch-swept body plus a click; `wave` "triangle" or a short sweep gives a harder kick. */
const kick = (f0: number, f1: number, sweep: number, decay: number, click = 0.3, wave: OscillatorType = "sine"): Gen => (c) => {
  tone(c, wave, f0, f1, sweep, 1, decay);
  if (click) tone(c, "triangle", 1200, 120, 0.01, click, 0.015);
};
/** A long sine bass drum; `from` above `to` with a long `glide` slides like a drill 808. */
const bass808 = (from: number, to: number, glide: number, decay: number): Gen => (c) => tone(c, "sine", from, to, glide, 1, decay);
const snare = (body: number, noiseHz: number, decay: number, noiseAmt = 0.7, bodyAmt = 0.6): Gen => (c) => {
  tone(c, "triangle", body, body * 0.7, 0.05, bodyAmt, decay * 0.55);
  filteredNoise(c, "highpass", noiseHz, 0.7, noiseAmt, decay);
};
/** Brushed / ghost snare: band-limited noise, little body. */
const brush = (noiseHz: number, decay: number): Gen => (c) => filteredNoise(c, "bandpass", noiseHz, 0.6, 0.6, decay);
const clap = (band: number, tail: number, spread = 0.012): Gen => (c) => {
  [0, spread, spread * 2].forEach((t) => filteredNoise(c, "bandpass", band, 1.2, 0.8, 0.02, t));
  filteredNoise(c, "bandpass", band, 1.2, 0.8, tail, spread * 3 + 0.01);
};
const snap = (band: number): Gen => (c) => { filteredNoise(c, "bandpass", band, 3, 0.9, 0.05); tone(c, "sine", 2000, 1500, 0.01, 0.2, 0.01); };
const rim = (hi = 1700, lo = 500): Gen => (c) => { tone(c, "square", hi, hi * 0.94, 0.01, 0.4, 0.03); tone(c, "triangle", lo, lo * 0.96, 0.01, 0.4, 0.05); };
const hat = (hp: number, decay: number, amt = 0.6): Gen => (c) => filteredNoise(c, "highpass", hp, 0.8, amt, decay);
const metalHat = (decay: number, base = 100, hp = 7000, amt = 0.35): Gen => (c) => metal(c, base, hp, amt, decay);
const shaker = (band: number, decay: number): Gen => (c) => filteredNoise(c, "bandpass", band, 2, 0.5, decay);
const tamb = (decay: number): Gen => (c) => { metal(c, 130, 8000, 0.15, decay); filteredNoise(c, "bandpass", 7000, 1.5, 0.4, decay); };
const ride = (decay: number, hp = 5000): Gen => (c) => { filteredNoise(c, "highpass", hp, 2, 0.3, decay); [3200, 4700, 6100].forEach((f) => tone(c, "square", f, f, 0.01, 0.03, decay * 0.9)); };
const crash = (decay: number, hp = 4000): Gen => (c) => filteredNoise(c, "highpass", hp, 0.5, 0.5, decay);
const tom = (f0: number, decay: number): Gen => (c) => tone(c, "sine", f0, f0 * 0.58, 0.2, 0.9, decay);
const conga = (f: number): Gen => (c) => { tone(c, "sine", f * 1.4, f, 0.03, 0.9, 0.25); filteredNoise(c, "bandpass", f * 4, 2, 0.15, 0.02); };
const cowbell = (a = 560, b = 845): Gen => (c) => { tone(c, "square", a, a, 0.01, 0.25, 0.35); tone(c, "square", b, b, 0.01, 0.25, 0.35); };
const clave = (f = 2500): Gen => (c) => tone(c, "sine", f, f, 0.01, 0.7, 0.05);
const wood = (f = 900): Gen => (c) => { tone(c, "triangle", f, f * 0.9, 0.02, 0.7, 0.08); tone(c, "sine", f * 2.7, f * 2.6, 0.01, 0.2, 0.03); };
const zap = (from = 2400, to = 60, time = 0.2): Gen => (c) => tone(c, "sawtooth", from, to, time, 0.4, time + 0.05);
/** Two quick opposite sweeps, like a record pushed and pulled. */
const scratch: Gen = (c) => { tone(c, "sawtooth", 250, 1400, 0.08, 0.35, 0.08); tone(c, "sawtooth", 1400, 300, 0.1, 0.35, 0.1, 0.09); };
const chord = (notes: number[], wave: OscillatorType, decay: number, peak = 0.12): Gen => (c) => notes.forEach((n) => tone(c, wave, hz(n), hz(n), 0.01, peak, decay));
const bell = (f: number, decay: number): Gen => (c) => { tone(c, "sine", f, f, 0.01, 0.5, decay); tone(c, "sine", f * 2.76, f * 2.76, 0.01, 0.2, decay * 0.5); };

/** Offline "tape" treatment after rendering: drive (tanh), a gentle lowpass, fewer bits and a lower sample rate. */
interface Fx { drive?: number; lp?: number; bits?: number; hold?: number }

function applyFx(data: Float32Array, fx: Fx) {
  const { drive, lp, bits, hold } = fx;
  const a = lp ? 1 - Math.exp((-2 * Math.PI * lp) / SR) : 1;
  const q = bits ? 2 ** (bits - 1) : 0;
  const norm = drive ? Math.tanh(drive) : 1;
  let y = 0, held = 0;
  for (let i = 0; i < data.length; i++) {
    let x = data[i];
    if (drive) x = Math.tanh(x * drive) / norm;
    y += a * (x - y);
    x = y;
    if (q) x = Math.round(x * q) / q;
    if (hold && hold > 1) x = i % hold === 0 ? (held = x) : held;
    data[i] = x;
  }
}

const PEAK = 0.9;

function normalize(data: Float32Array, peak: number) {
  let max = 0;
  for (const x of data) max = Math.max(max, Math.abs(x));
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
}

/** One pad: name, length in seconds, generator, and its own Fx on top of the kit's. */
type Sound = [name: string, len: number, gen: Gen, fx?: Fx];

interface StockKit { sounds: Sound[]; fx?: Fx }

// 16 sounds each, pads 1-16 (pad 1 = bottom left): the groove on the bottom row, variations, toms, cymbals and colour on top.
// "Hat Cl" / "Hat Op" choke each other; sounds longer than a pad's default tail get a longer decay (see stockKitPads).
const KITS: Record<string, StockKit> = {
  Factory: { sounds: [
    ["Kick", 0.6, (c) => { tone(c, "sine", 150, 42, 0.12, 1, 0.5); tone(c, "triangle", 900, 100, 0.01, 0.3, 0.02); }],
    ["Snare", 0.4, (c) => { tone(c, "triangle", 240, 170, 0.05, 0.6, 0.12); filteredNoise(c, "highpass", 1800, 0.7, 0.7, 0.22); }],
    ["Clap", 0.5, (c) => { [0, 0.012, 0.024].forEach((t) => filteredNoise(c, "bandpass", 1200, 1.2, 0.8, 0.02, t)); filteredNoise(c, "bandpass", 1200, 1.2, 0.8, 0.25, 0.034); }],
    ["Rim", 0.15, (c) => { tone(c, "square", 1700, 1600, 0.01, 0.4, 0.03); tone(c, "triangle", 500, 480, 0.01, 0.4, 0.05); }],
    ["Hat Cl", 0.15, (c) => filteredNoise(c, "highpass", 7500, 0.8, 0.6, 0.06)],
    ["Hat Op", 0.7, (c) => filteredNoise(c, "highpass", 7000, 0.8, 0.5, 0.5)],
    ["Shaker", 0.2, (c) => filteredNoise(c, "bandpass", 6000, 2, 0.5, 0.09)],
    ["Ride", 1.2, (c) => { filteredNoise(c, "highpass", 5000, 2, 0.3, 1.0); [3200, 4700, 6100].forEach((f) => tone(c, "square", f, f, 0.01, 0.03, 0.9)); }],
    ["Tom Lo", 0.6, (c) => tone(c, "sine", 140, 80, 0.2, 0.9, 0.45)],
    ["Tom Mid", 0.5, (c) => tone(c, "sine", 200, 120, 0.2, 0.9, 0.38)],
    ["Tom Hi", 0.45, (c) => tone(c, "sine", 280, 170, 0.18, 0.9, 0.32)],
    ["Cowbell", 0.5, (c) => { tone(c, "square", 560, 560, 0.01, 0.25, 0.35); tone(c, "square", 845, 845, 0.01, 0.25, 0.35); }],
    ["808", 1.6, (c) => tone(c, "sine", 120, 55, 0.08, 1, 1.4)],
    ["Crash", 2, (c) => filteredNoise(c, "highpass", 4000, 0.5, 0.5, 1.8)],
    ["Zap", 0.3, (c) => tone(c, "sawtooth", 2400, 60, 0.2, 0.4, 0.25)],
    ["Stab", 0.8, (c) => [60, 63, 67, 70].forEach((n) => tone(c, "sawtooth", 440 * 2 ** ((n - 69) / 12), 440 * 2 ** ((n - 69) / 12), 0.01, 0.12, 0.6))],
  ] },
  // Dusty and soft: rounded kicks, brushy snares, bit-crushed and rolled off like a sampled record.
  "Lo-Fi": { fx: { drive: 1.3, lp: 5000, bits: 10, hold: 2 }, sounds: [
    ["Kick", 0.5, kick(110, 45, 0.1, 0.38, 0.1)],
    ["Snare", 0.35, snare(200, 2200, 0.2, 0.5, 0.5)],
    ["Rim", 0.15, rim(1500, 450)],
    ["Snap", 0.15, snap(2200)],
    ["Hat Cl", 0.12, hat(6000, 0.05, 0.4)],
    ["Hat Op", 0.5, hat(5500, 0.35, 0.35)],
    ["Shaker", 0.2, shaker(5000, 0.1)],
    ["Brush", 0.35, brush(3000, 0.25)],
    ["Kick 2", 0.55, kick(90, 40, 0.12, 0.45, 0.05)],
    ["Snare 2", 0.3, snare(180, 1800, 0.15, 0.45, 0.4)],
    ["Conga Lo", 0.35, conga(180)],
    ["Conga Hi", 0.3, conga(260)],
    ["Wood", 0.15, wood(800)],
    ["Ride", 1.2, ride(1, 4000)],
    ["Keys", 1.2, chord([57, 60, 64, 67, 71], "triangle", 1, 0.1)],
    ["Vinyl Hit", 0.6, (c) => { filteredNoise(c, "bandpass", 1500, 0.8, 0.5, 0.4); tone(c, "sine", 80, 50, 0.1, 0.5, 0.3); }],
  ] },
  // Hard-hitting 90s: punchy kick, cracking snare, gritty from the sampler.
  "Boom Bap": { fx: { drive: 2, lp: 9000, bits: 12 }, sounds: [
    ["Kick", 0.45, kick(130, 48, 0.08, 0.32, 0.4)],
    ["Snare", 0.4, snare(210, 1900, 0.26, 0.9, 0.6)],
    ["Clap", 0.4, clap(1300, 0.2)],
    ["Rim", 0.15, rim()],
    ["Hat Cl", 0.12, hat(7000, 0.05, 0.5)],
    ["Hat Op", 0.5, hat(6500, 0.35, 0.45)],
    ["Shaker", 0.2, shaker(6000, 0.08)],
    ["Tamb", 0.3, tamb(0.2)],
    ["Kick 2", 0.3, kick(160, 55, 0.05, 0.18, 0.5)],
    ["Snare 2", 0.3, snare(260, 2500, 0.15, 0.8, 0.5)],
    ["Snap", 0.15, snap(2600)],
    ["Tom Lo", 0.5, tom(130, 0.4)],
    ["Tom Hi", 0.4, tom(220, 0.3)],
    ["Crash", 1.8, crash(1.6)],
    ["Scratch", 0.25, scratch],
    ["Horns", 0.6, chord([58, 62, 65], "sawtooth", 0.45, 0.14)],
  ] },
  // Modern and clean: tight kick, 808s to play bass lines with pitch.
  "Hip Hop": { fx: { drive: 1.2 }, sounds: [
    ["Kick", 0.45, kick(140, 50, 0.07, 0.35, 0.35)],
    ["808", 1.8, bass808(110, 55, 0.06, 1.6)],
    ["Snare", 0.35, snare(230, 2400, 0.2, 0.8, 0.5)],
    ["Clap", 0.45, clap(1250, 0.25)],
    ["Hat Cl", 0.1, hat(8500, 0.04, 0.5)],
    ["Hat Op", 0.6, hat(8000, 0.4, 0.4)],
    ["Rim", 0.15, rim(1800, 520)],
    ["Snap", 0.15, snap(2800)],
    ["Kick 2", 0.5, kick(120, 45, 0.1, 0.4, 0.2)],
    ["808 Hi", 1.6, bass808(146, 73, 0.06, 1.4)],
    ["Snare 2", 0.3, snare(280, 3000, 0.14, 0.7, 0.4)],
    ["Perc", 0.2, wood(1100)],
    ["Shaker", 0.2, shaker(6500, 0.08)],
    ["Crash", 1.8, crash(1.6, 4500)],
    ["Zap", 0.3, zap(1800, 80, 0.18)],
    ["Bell", 1.2, bell(880, 1)],
  ] },
  // Long 808s, tight snares, crisp hats for rolls.
  Trap: { fx: { drive: 1.3 }, sounds: [
    ["Kick", 0.4, kick(160, 50, 0.06, 0.25, 0.45)],
    ["808", 2.2, bass808(98, 49, 0.05, 2), { drive: 1.8 }],
    ["Snare", 0.3, snare(300, 3000, 0.16, 0.8, 0.5)],
    ["Clap", 0.45, clap(1400, 0.26, 0.01)],
    ["Hat Cl", 0.08, hat(9500, 0.03, 0.5)],
    ["Hat Op", 0.5, hat(9000, 0.35, 0.4)],
    ["Hat Tick", 0.05, hat(10000, 0.018, 0.45)],
    ["Rim", 0.12, rim(1900, 600)],
    ["Kick 2", 0.35, kick(180, 55, 0.04, 0.2, 0.5, "triangle")],
    ["808 Hi", 2, bass808(130, 65, 0.05, 1.8), { drive: 1.8 }],
    ["Snap", 0.15, snap(3000)],
    ["Perc", 0.2, wood(1300)],
    ["Cowbell", 0.4, cowbell(540, 800)],
    ["Crash", 2, crash(1.8, 5000)],
    ["Riser", 0.5, zap(200, 3000, 0.45)],
    ["Bell", 1.4, bell(1046, 1.2)],
  ] },
  // UK drill: sliding 808s, short punchy kicks, crisp snares and sharp percs.
  Drill: { fx: { drive: 1.4 }, sounds: [
    ["Kick", 0.3, kick(170, 52, 0.04, 0.2, 0.5)],
    ["808 Slide", 2, bass808(98, 46, 0.35, 1.8), { drive: 2.2 }],
    ["Snare", 0.3, snare(330, 3500, 0.13, 0.85, 0.45)],
    ["Clap", 0.35, clap(1500, 0.2, 0.009)],
    ["Hat Cl", 0.07, hat(9500, 0.028, 0.5)],
    ["Hat Op", 0.4, hat(9000, 0.28, 0.4)],
    ["Rim", 0.12, rim(2000, 650)],
    ["Perc", 0.15, wood(1400)],
    ["Kick 2", 0.3, kick(190, 60, 0.03, 0.16, 0.5, "triangle")],
    ["808 Up", 2, bass808(41, 62, 0.3, 1.8), { drive: 2.2 }],
    ["Snare 2", 0.3, snare(360, 4000, 0.12, 0.75, 0.4)],
    ["Snap", 0.12, snap(3200)],
    ["Shaker", 0.15, shaker(7000, 0.06)],
    ["Crash", 1.8, crash(1.6, 5000)],
    ["Dark Bell", 1.4, bell(622, 1.2)],
    ["Zap", 0.3, zap(2000, 100, 0.2)],
  ] },
  // 909-style: driven four-on-the-floor kick, metallic hats, claps, an organ chord.
  House: { sounds: [
    ["Kick", 0.5, kick(160, 50, 0.05, 0.42, 0.5), { drive: 1.6 }],
    ["Clap", 0.5, clap(1100, 0.32)],
    ["Snare", 0.35, snare(220, 2200, 0.2, 0.75, 0.55)],
    ["Rim", 0.12, rim(1700, 500)],
    ["Hat Cl", 0.1, metalHat(0.05)],
    ["Hat Op", 0.5, metalHat(0.35, 100, 6500, 0.3)],
    ["Shaker", 0.2, shaker(6000, 0.08)],
    ["Ride", 1.4, (c) => metal(c, 120, 5000, 0.2, 1.2)],
    ["Kick 2", 0.6, kick(120, 45, 0.08, 0.5, 0.25)],
    ["Clap 2", 0.6, clap(1300, 0.45, 0.015)],
    ["Tamb", 0.3, tamb(0.2)],
    ["Conga", 0.3, conga(220)],
    ["Cowbell", 0.4, cowbell()],
    ["Crash", 2, crash(1.8)],
    ["Organ", 0.6, chord([57, 60, 64, 67], "square", 0.4, 0.08)],
    ["Chord", 0.8, chord([57, 60, 64, 67, 71], "sawtooth", 0.6, 0.08), { lp: 3000 }],
  ] },
  // Hard and dark: distorted kick, rumble, metallic percussion, a minor stab.
  Techno: { sounds: [
    ["Kick", 0.6, kick(180, 45, 0.04, 0.5, 0.5), { drive: 3 }],
    ["Clap", 0.5, clap(1200, 0.3, 0.01)],
    ["Snare", 0.35, snare(240, 2000, 0.22, 0.9, 0.4)],
    ["Rim", 0.12, rim(1900, 550)],
    ["Hat Cl", 0.08, metalHat(0.04, 110, 8000)],
    ["Hat Op", 0.5, metalHat(0.3, 110, 7500, 0.3)],
    ["Ride", 1.4, (c) => metal(c, 140, 6000, 0.2, 1.2)],
    ["Perc", 0.3, bell(300, 0.2), { drive: 2 }],
    ["Rumble", 1.2, bass808(60, 45, 0.1, 1), { drive: 3, lp: 400 }],
    ["Kick 2", 0.35, kick(200, 55, 0.03, 0.25, 0.6, "triangle"), { drive: 4 }],
    ["Clave", 0.1, clave(2200)],
    ["Tom", 0.4, tom(160, 0.3)],
    ["Shaker", 0.2, shaker(7000, 0.07)],
    ["Crash", 2, crash(1.8, 5000)],
    ["Stab", 0.5, chord([57, 60, 64], "sawtooth", 0.35, 0.12), { lp: 2500 }],
    ["Zap", 0.3, zap(3000, 50, 0.25)],
  ] },
  // Drum & bass: tight kick, cracking snare, ghost snare for rolling breaks, a deep sub.
  DnB: { fx: { drive: 1.4 }, sounds: [
    ["Kick", 0.35, kick(150, 55, 0.05, 0.22, 0.5)],
    ["Snare", 0.35, snare(230, 2200, 0.2, 0.95, 0.65), { drive: 2 }],
    ["Ghost", 0.2, snare(260, 2600, 0.1, 0.4, 0.25)],
    ["Rim", 0.12, rim(1800, 520)],
    ["Hat Cl", 0.08, hat(9000, 0.035, 0.5)],
    ["Hat Op", 0.4, hat(8500, 0.28, 0.4)],
    ["Shaker", 0.15, shaker(7000, 0.06)],
    ["Ride", 1.2, ride(1, 5500)],
    ["Kick 2", 0.4, kick(120, 48, 0.07, 0.3, 0.3)],
    ["Snare 2", 0.3, snare(290, 3000, 0.15, 0.85, 0.5)],
    ["Clap", 0.4, clap(1400, 0.22)],
    ["Tom", 0.4, tom(180, 0.3)],
    ["Tamb", 0.3, tamb(0.2)],
    ["Crash", 2, crash(1.8, 4500)],
    ["Sub", 1.4, bass808(41, 41, 0.01, 1.2)],
    ["Zap", 0.3, zap(2600, 70, 0.2)],
  ] },
  // Classic drum machine: booming 808 kick, metallic hats, cowbell, claves and toms.
  Electro: { sounds: [
    ["Kick", 1, bass808(80, 48, 0.08, 0.8)],
    ["Snare", 0.35, (c) => { tone(c, "triangle", 180, 175, 0.01, 0.4, 0.15); tone(c, "triangle", 330, 325, 0.01, 0.3, 0.1); filteredNoise(c, "highpass", 3000, 0.7, 0.6, 0.2); }],
    ["Clap", 0.5, clap(1100, 0.3)],
    ["Rim", 0.12, rim(1700, 500)],
    ["Hat Cl", 0.1, metalHat(0.05)],
    ["Hat Op", 0.6, metalHat(0.45, 100, 6500, 0.3)],
    ["Cowbell", 0.5, cowbell(540, 800)],
    ["Clave", 0.1, clave()],
    ["Tom Lo", 0.6, tom(100, 0.5)],
    ["Tom Mid", 0.5, tom(150, 0.42)],
    ["Tom Hi", 0.45, tom(220, 0.36)],
    ["Conga", 0.3, conga(300)],
    ["Maraca", 0.12, shaker(8000, 0.04)],
    ["Cymbal", 2, (c) => metal(c, 90, 5000, 0.25, 1.8)],
    ["Zap", 0.3, zap()],
    ["Laser", 0.25, zap(4000, 400, 0.15)],
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
      const ctx = new OfflineAudioContext(1, Math.ceil(len * SR), SR);
      gen(ctx);
      const buffer = await ctx.startRendering();
      const all = { ...def.fx, ...fx };
      const data = buffer.getChannelData(0);
      if (Object.keys(all).length) applyFx(data, all);
      // Genre kits are peak-normalized like sample-pack one-shots (the pads balance them); Factory stays as it always sounded.
      if (kit !== "Factory") normalize(data, PEAK);
      return { name, buffer };
    }),
  );
}
