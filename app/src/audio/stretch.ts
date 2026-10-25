// Time stretch that keeps the pitch (WSOLA), anchored on chop markers: each slice is stretched on its own, so
// every hit starts exactly at its scaled position with its attack intact (no smeared or doubled transients).

const FRAME_S = 0.04; // frame length; frames overlap by half
const SEEK_S = 0.012; // how far a frame may move to line up with the one before it
const FADE_S = 0.003; // a slice's end fades out before the next one's attack
const DECIMATE = 4; // the coarse search runs on every 4th sample of a smoothed mono mix

/**
 * Stretch `channels` to `outLength` samples, keeping the pitch. `anchors` are sample positions (inner chop markers):
 * each lands at `round(anchor * outLength / inLength)` and starts there unfaded.
 */
export function stretch(channels: Float32Array[], sampleRate: number, outLength: number, anchors: number[] = []): Float32Array<ArrayBuffer>[] {
  const inLength = channels[0]?.length ?? 0;
  const out = channels.map(() => new Float32Array(outLength));
  if (!inLength || !outLength) return out;
  const scale = outLength / inLength;
  const inner = [...new Set(anchors.map(Math.round))].filter((a) => a > 0 && a < inLength).sort((a, b) => a - b);
  const bounds = [0, ...inner, inLength];
  const mono = monoMix(channels);
  const coarse = decimate(mono);
  const fade = Math.round(FADE_S * sampleRate);
  for (let i = 0; i < bounds.length - 1; i++) {
    const last = i === bounds.length - 2;
    const o0 = Math.round(bounds[i] * scale);
    const o1 = last ? outLength : Math.round(bounds[i + 1] * scale);
    if (o1 <= o0) continue;
    const seg = segment(channels, mono, coarse, bounds[i], bounds[i + 1], o1 - o0, sampleRate);
    const f = last ? 0 : Math.min(fade, Math.floor((o1 - o0) / 2));
    seg.forEach((src, c) => {
      const dst = out[c];
      for (let j = 0; j < src.length; j++) dst[o0 + j] = j >= src.length - f ? (src[j] * (src.length - j)) / f : src[j];
    });
  }
  return out;
}

function monoMix(channels: Float32Array[]) {
  const n = channels[0].length, m = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) m[i] += ch[i] / channels.length;
  return m;
}

/** Every DECIMATE-th sample, averaged over its neighbours (so the coarse search doesn't alias). */
function decimate(x: Float32Array) {
  const out = new Float32Array(Math.ceil(x.length / DECIMATE));
  for (let i = 0; i < out.length; i++) {
    let sum = 0, n = 0;
    for (let j = i * DECIMATE; j < Math.min(x.length, (i + 1) * DECIMATE); j++, n++) sum += x[j];
    out[i] = sum / n;
  }
  return out;
}

const hann = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

/** Input [a, b) stretched to `len` samples: overlap-added frames, each placed where it best continues the last. */
function segment(channels: Float32Array[], mono: Float32Array, coarse: Float32Array, a: number, b: number, len: number, sampleRate: number): Float32Array[] {
  const inLen = b - a;
  const out = channels.map(() => new Float32Array(len));
  let n = Math.min(Math.round(FRAME_S * sampleRate), inLen, len) & ~1;
  if (n < 4 * DECIMATE) {
    // Too short to stretch: copy what fits.
    channels.forEach((ch, c) => out[c].set(ch.subarray(a, a + Math.min(inLen, len))));
    return out;
  }
  const hs = n / 2;
  const seek = Math.round(SEEK_S * sampleRate);
  const win = hann(n);
  let prev = a;
  for (let k = 0; ; k++) {
    const pos = k * hs;
    const nominal = a + Math.round((pos * inLen) / len);
    const start = k === 0 ? a : bestStart(mono, coarse, prev + hs, nominal, seek, hs, a, b - n);
    // The first frame starts unfaded (the attack); the last one ends unfaded. Elsewhere the Hann halves sum to 1.
    const end = pos + n >= len;
    channels.forEach((ch, c) => {
      const o = out[c];
      for (let j = 0; j < n && pos + j < len; j++) {
        const w = (k === 0 && j < hs) || (end && j >= hs) ? 1 : win[j];
        o[pos + j] += ch[start + j] * w;
      }
    });
    if (end) break;
    prev = start;
  }
  return out;
}

/**
 * The frame start in [lo, hi] near `nominal` whose first `overlap` samples best match the natural continuation of the
 * last frame (the input from `natural`): coarse on the decimated mix, then to the sample.
 */
function bestStart(mono: Float32Array, coarse: Float32Array, natural: number, nominal: number, seek: number, overlap: number, lo: number, hi: number): number {
  const from = Math.max(lo, nominal - seek), to = Math.min(hi, nominal + seek);
  if (to <= from) return Math.max(lo, Math.min(hi, nominal));
  natural = Math.min(natural, mono.length - overlap);
  const score = (x: Float32Array, nat: number, cand: number, count: number) => {
    let xy = 0, yy = 1e-9;
    for (let j = 0; j < count; j++) {
      const y = x[cand + j];
      xy += x[nat + j] * y;
      yy += y * y;
    }
    return xy / Math.sqrt(yy);
  };
  let best = from, top = -Infinity;
  const cn = Math.floor(overlap / DECIMATE), nat = Math.floor(natural / DECIMATE);
  for (let c = Math.ceil(from / DECIMATE); c * DECIMATE <= to; c++) {
    const v = score(coarse, nat, c, Math.min(cn, coarse.length - c, coarse.length - nat));
    if (v > top) [top, best] = [v, c * DECIMATE];
  }
  const coarseBest = best;
  top = -Infinity;
  for (let s = Math.max(from, coarseBest - DECIMATE); s <= Math.min(to, coarseBest + DECIMATE); s++) {
    const v = score(mono, natural, s, overlap);
    if (v > top) [top, best] = [v, s];
  }
  return best;
}

/** stretch() in a worker, so the Launchkey screen and the page keep going; on the main thread if a worker can't start. */
export function stretchAsync(channels: Float32Array[], sampleRate: number, outLength: number, anchors: number[]): Promise<Float32Array<ArrayBuffer>[]> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./stretchWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(stretch(channels, sampleRate, outLength, anchors));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>[]>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Stretch failed"));
    };
    worker.postMessage({ channels, sampleRate, outLength, anchors });
  });
}
