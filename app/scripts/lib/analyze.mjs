// Sound measurements for tuning the stock kits and synth presets against reference one-shots.
// Mono Float32Array in, plain numbers out, so Morsel's renders and decoded samples compare like for like.

/** In-place radix-2 FFT (re, im of a power-of-two length). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k);
        const xr = re[i + k + len / 2], xi = im[i + k + len / 2];
        const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

/** Power spectrum of `x[from, from + n)` (Hann window, zero-padded to `size`). */
export function spectrum(x, from, n, size) {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < n && from + i < x.length; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const p = new Float64Array(size / 2);
  for (let k = 0; k < p.length; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);

/** RMS in windows of `win` seconds. */
function rmsEnvelope(x, sr, win) {
  const w = Math.max(1, Math.round(win * sr));
  const out = new Float64Array(Math.ceil(x.length / w));
  for (let b = 0; b < out.length; b++) {
    let s = 0, n = 0;
    for (let i = b * w; i < Math.min(x.length, (b + 1) * w); i++, n++) s += x[i] * x[i];
    out[b] = Math.sqrt(s / Math.max(1, n));
  }
  return { env: out, win: w / sr };
}

/** Energy-weighted spectral centroid (Hz) and band shares between sample `from` and `to`. */
function spectralShape(x, sr, from, to) {
  const N = 2048, hop = 512;
  const acc = new Float64Array(N / 2);
  for (let f = from; f + 256 < to; f += hop) {
    const p = spectrum(x, f, Math.min(N, to - f), N);
    for (let k = 0; k < p.length; k++) acc[k] += p[k];
  }
  let sum = 0, wsum = 0;
  const edges = [60, 250, 2000, 6000];
  const bands = [0, 0, 0, 0, 0];
  for (let k = 1; k < acc.length; k++) {
    const hz = (k * sr) / N;
    sum += acc[k];
    wsum += acc[k] * hz;
    let b = 0;
    while (b < edges.length && hz >= edges[b]) b++;
    bands[b] += acc[k];
  }
  return { centroid: sum ? wsum / sum : 0, bands: bands.map((b) => (sum ? b / sum : 0)) };
}

/** Strongest frequency below `maxHz` between `from` and `to` (zero-padded, parabolic peak). */
function peakFrequency(x, sr, from, to, minHz = 25, maxHz = 1200) {
  const n = Math.max(256, to - from);
  const size = 2 ** Math.ceil(Math.log2(Math.max(16384, n * 2)));
  const p = spectrum(x, from, n, size);
  const lo = Math.ceil((minHz * size) / sr), hi = Math.floor((maxHz * size) / sr);
  let best = lo;
  for (let k = lo; k <= hi; k++) if (p[k] > p[best]) best = k;
  const [a, b, c] = [p[best - 1] ?? 0, p[best], p[best + 1] ?? 0].map((v) => Math.log(v + 1e-30));
  const d = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return ((best + d) * sr) / size;
}

const ENV_MS = [5, 20, 50, 100, 200, 500];

/**
 * A one-shot's measurements: length to -40 / -60 dB (s), attack 10→90 % (ms), RMS level at ENV_MS (dB re
 * its loudest 5 ms), spectral centroid overall / first 30 ms / after (Hz), band shares (<60, 60-250,
 * 250-2k, 2k-6k, >6k Hz), body pitch over 20-80 ms (Hz) and crest factor (dB).
 */
export function analyzeHit(x, sr) {
  const { env, win } = rmsEnvelope(x, sr, 0.005);
  let max = 0, maxAt = 0;
  env.forEach((v, i) => v > max && ((max = v), (maxAt = i)));
  const lastAbove = (dB) => {
    const floor = max * 10 ** (dB / 20);
    let i = env.length - 1;
    while (i > 0 && env[i] < floor) i--;
    return (i + 1) * win;
  };
  const len40 = lastAbove(-40);
  // Attack on a 1 ms peak envelope: 5 ms RMS windows are too coarse for drum transients.
  const { env: fine, win: fw } = rmsEnvelope(x, sr, 0.001);
  let fmax = 0, fAt = 0;
  fine.forEach((v, i) => v > fmax && ((fmax = v), (fAt = i)));
  let a10 = 0;
  while (a10 < fAt && fine[a10] < fmax * 0.1) a10++;
  let a90 = a10;
  while (a90 < fAt && fine[a90] < fmax * 0.9) a90++;
  const envDb = Object.fromEntries(ENV_MS.map((ms) => [ms, Math.max(-90, db((env[Math.floor(ms / 1000 / win)] ?? 0) / max))]));
  const end = Math.min(x.length, Math.round(len40 * sr));
  const start = Math.max(0, Math.round((maxAt - 1) * win * sr));
  const split = Math.min(end, start + Math.round(0.03 * sr));
  const all = spectralShape(x, sr, start, end);
  const early = spectralShape(x, sr, start, split);
  const late = end - split > 512 ? spectralShape(x, sr, split, end) : early;
  const pitch = peakFrequency(x, sr, start + Math.round(0.02 * sr), Math.min(end, start + Math.round(0.08 * sr)));
  let peak = 0, ss = 0;
  for (let i = 0; i < end; i++) {
    peak = Math.max(peak, Math.abs(x[i]));
    ss += x[i] * x[i];
  }
  return {
    len40,
    len60: lastAbove(-60),
    attackMs: (a90 - a10) * fw * 1000,
    env: envDb,
    centroid: all.centroid,
    centroidEarly: early.centroid,
    centroidLate: late.centroid,
    bands: all.bands,
    pitch,
    crest: db(peak / Math.sqrt(ss / Math.max(1, end))),
  };
}

/**
 * A held synth note's measurements (pitch-independent where possible): length of the release tail, RMS level
 * over time (dB re its loudest), brightness over time as centroid / f0 (harmonics), and attack time.
 */
export function analyzeNote(x, sr, f0, holdSec) {
  const { env, win } = rmsEnvelope(x, sr, 0.01);
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  const at = (t) => env[Math.min(env.length - 1, Math.floor(t / win))] ?? 0;
  let a = 0;
  while (a < env.length && env[a] < max * 0.9) a++;
  const floor = max * 10 ** (-40 / 20);
  let last = env.length - 1;
  while (last > 0 && env[last] < floor) last--;
  const times = [0.02, 0.1, 0.3, 0.6, holdSec - 0.05];
  const bright = times.map((t) => {
    const from = Math.round(t * sr);
    if (from + 2048 > x.length) return 0;
    const p = spectrum(x, from, 2048, 4096);
    let s = 0, w = 0;
    for (let k = 1; k < p.length; k++) {
      s += p[k];
      w += p[k] * ((k * sr) / 4096);
    }
    return s ? w / s / f0 : 0;
  });
  return {
    attack: a * win,
    release: Math.max(0, (last + 1) * win - holdSec),
    level: times.map((t) => Math.max(-90, db(at(t) / max))),
    bright,
  };
}

/** Median and quartiles of a list of numbers. */
export function quartiles(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return v[lo] + (v[Math.min(v.length - 1, lo + 1)] - v[lo]) * (i - lo);
  };
  return { n: v.length, q1: q(0.25), median: q(0.5), q3: q(0.75) };
}
