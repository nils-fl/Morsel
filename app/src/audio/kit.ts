// A factory kit synthesized offline, so the app works with no sample files.
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

const KIT: { name: string; len: number; gen: Gen }[] = [
  { name: "Kick", len: 0.6, gen: (c) => { tone(c, "sine", 150, 42, 0.12, 1, 0.5); tone(c, "triangle", 900, 100, 0.01, 0.3, 0.02); } },
  { name: "Snare", len: 0.4, gen: (c) => { tone(c, "triangle", 240, 170, 0.05, 0.6, 0.12); filteredNoise(c, "highpass", 1800, 0.7, 0.7, 0.22); } },
  { name: "Clap", len: 0.5, gen: (c) => { [0, 0.012, 0.024].forEach((t) => filteredNoise(c, "bandpass", 1200, 1.2, 0.8, 0.02, t)); filteredNoise(c, "bandpass", 1200, 1.2, 0.8, 0.25, 0.034); } },
  { name: "Rim", len: 0.15, gen: (c) => { tone(c, "square", 1700, 1600, 0.01, 0.4, 0.03); tone(c, "triangle", 500, 480, 0.01, 0.4, 0.05); } },
  { name: "Hat Cl", len: 0.15, gen: (c) => filteredNoise(c, "highpass", 7500, 0.8, 0.6, 0.06) },
  { name: "Hat Op", len: 0.7, gen: (c) => filteredNoise(c, "highpass", 7000, 0.8, 0.5, 0.5) },
  { name: "Shaker", len: 0.2, gen: (c) => filteredNoise(c, "bandpass", 6000, 2, 0.5, 0.09) },
  { name: "Ride", len: 1.2, gen: (c) => { filteredNoise(c, "highpass", 5000, 2, 0.3, 1.0); [3200, 4700, 6100].forEach((f) => tone(c, "square", f, f, 0.01, 0.03, 0.9)); } },
  { name: "Tom Lo", len: 0.6, gen: (c) => tone(c, "sine", 140, 80, 0.2, 0.9, 0.45) },
  { name: "Tom Mid", len: 0.5, gen: (c) => tone(c, "sine", 200, 120, 0.2, 0.9, 0.38) },
  { name: "Tom Hi", len: 0.45, gen: (c) => tone(c, "sine", 280, 170, 0.18, 0.9, 0.32) },
  { name: "Cowbell", len: 0.5, gen: (c) => { tone(c, "square", 560, 560, 0.01, 0.25, 0.35); tone(c, "square", 845, 845, 0.01, 0.25, 0.35); } },
  { name: "808", len: 1.6, gen: (c) => tone(c, "sine", 120, 55, 0.08, 1, 1.4) },
  { name: "Crash", len: 2, gen: (c) => filteredNoise(c, "highpass", 4000, 0.5, 0.5, 1.8) },
  { name: "Zap", len: 0.3, gen: (c) => tone(c, "sawtooth", 2400, 60, 0.2, 0.4, 0.25) },
  { name: "Stab", len: 0.8, gen: (c) => [60, 63, 67, 70].forEach((n) => tone(c, "sawtooth", 440 * 2 ** ((n - 69) / 12), 440 * 2 ** ((n - 69) / 12), 0.01, 0.12, 0.6)) },
];

/** Names of the factory sounds, pads 1-16. */
export const FACTORY_SOUNDS = KIT.map((k) => k.name);

export async function renderFactoryKit(): Promise<{ name: string; buffer: AudioBuffer }[]> {
  return Promise.all(
    KIT.map(async ({ name, len, gen }) => {
      const ctx = new OfflineAudioContext(1, Math.ceil(len * SR), SR);
      gen(ctx);
      return { name, buffer: await ctx.startRendering() };
    }),
  );
}
