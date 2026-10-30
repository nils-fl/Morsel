// Drums / No drums: harmonic-percussive source separation (Fitzgerald 2010). In a spectrogram hits are vertical lines
// (short, every frequency) and tones horizontal ones (held): a median across frequency keeps the hits, one across time
// the tones, and soft masks from the two split every bin between them, so drums + the rest add up to the original.
// The STFT is torch.stft's (periodic Hann window, centred with reflect padding, normalized). Pure, for the worker.

/** In-place radix-2 complex FFT of one size (a power of two). */
export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    this.n = n;
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error(`FFT size ${n} is not a power of two`);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** Forward (e^-i) or inverse (e^+i, without the 1/n). */
  run(re: Float64Array, im: Float64Array, inverse = false) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const r = re[i], m = im[i];
        re[i] = re[j];
        im[i] = im[j];
        re[j] = r;
        im[j] = m;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sign * sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

const ffts = new Map<number, FFT>();
const fftOf = (n: number) => {
  let f = ffts.get(n);
  if (!f) ffts.set(n, (f = new FFT(n)));
  return f;
};

/** torch.hann_window(n): periodic. */
export function hann(n: number) {
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

/** `x` with `left` / `right` samples mirrored on (torch's "reflect": the edge sample isn't repeated). */
export function reflectPad(x: Float32Array, left: number, right: number): Float32Array {
  const n = x.length;
  if (left >= n || right >= n) throw new Error("Reflect padding longer than the signal");
  const out = new Float32Array(left + n + right);
  out.set(x, left);
  for (let i = 1; i <= left; i++) out[left - i] = x[i];
  for (let i = 1; i <= right; i++) out[left + n - 1 + i] = x[n - 1 - i];
  return out;
}

/** A complex spectrogram, bins × frames, row-major (bin f, frame t at f * frames + t). */
export interface Spec {
  re: Float32Array;
  im: Float32Array;
  bins: number;
  frames: number;
}

/** torch.stft(x, nfft, hop, hann, center=True, pad_mode="reflect", normalized=True): nfft / 2 + 1 bins. */
export function stft(x: Float32Array, nfft: number, hop: number): Spec {
  const padded = reflectPad(x, nfft / 2, nfft / 2);
  const frames = 1 + Math.floor(x.length / hop);
  const bins = nfft / 2 + 1;
  const win = hann(nfft), fft = fftOf(nfft), scale = 1 / Math.sqrt(nfft);
  const re = new Float32Array(bins * frames), im = new Float32Array(bins * frames);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    const at = t * hop;
    for (let i = 0; i < nfft; i++) {
      fr[i] = padded[at + i] * win[i];
      fi[i] = 0;
    }
    fft.run(fr, fi);
    for (let f = 0; f < bins; f++) {
      re[f * frames + t] = fr[f] * scale;
      im[f * frames + t] = fi[f] * scale;
    }
  }
  return { re, im, bins, frames };
}

/** torch.istft(z, nfft, hop, hann, center=True, normalized=True, length): z has nfft / 2 + 1 bins. */
export function istft(z: Spec, nfft: number, hop: number, length: number): Float32Array {
  const { re, im, bins, frames } = z;
  if (bins !== nfft / 2 + 1) throw new Error(`istft wants ${nfft / 2 + 1} bins, got ${bins}`);
  const win = hann(nfft), fft = fftOf(nfft), scale = Math.sqrt(nfft) / nfft;
  const total = nfft + hop * (frames - 1);
  const out = new Float64Array(total), env = new Float64Array(total);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    // The full spectrum of a real frame: the upper half mirrors the lower one, conjugated.
    for (let f = 0; f < bins; f++) {
      fr[f] = re[f * frames + t];
      fi[f] = im[f * frames + t];
    }
    fi[0] = 0;
    fi[bins - 1] = 0;
    for (let f = 1; f < nfft / 2; f++) {
      fr[nfft - f] = fr[f];
      fi[nfft - f] = -fi[f];
    }
    fft.run(fr, fi, true);
    const at = t * hop;
    for (let i = 0; i < nfft; i++) {
      out[at + i] += fr[i] * scale * win[i];
      env[at + i] += win[i] * win[i];
    }
  }
  const y = new Float32Array(length), start = nfft / 2;
  for (let i = 0; i < length && start + i < total; i++) {
    const e = env[start + i];
    y[i] = e > 1e-11 ? out[start + i] / e : 0;
  }
  return y;
}

/** Median of `n` values in `a` (reordered), by quickselect. */
function median(a: Float32Array, n: number): number {
  const k = n >> 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/** Median filter of a bins × frames grid along time (each bin's row) or frequency (each frame's column), `kernel`
 *  wide, cut short at the edges. */
export function medianFilter(grid: Float32Array, bins: number, frames: number, kernel: number, along: "time" | "freq"): Float32Array {
  const out = new Float32Array(grid.length), scratch = new Float32Array(kernel), half = kernel >> 1;
  const [rows, len, stride, step] = along === "time" ? [bins, frames, frames, 1] : [frames, bins, 1, frames];
  for (let r = 0; r < rows; r++) {
    const base = r * stride;
    for (let i = 0; i < len; i++) {
      const a = Math.max(0, i - half), b = Math.min(len - 1, i + half);
      let n = 0;
      for (let j = a; j <= b; j++) scratch[n++] = grid[base + j * step];
      out[base + i * step] = median(scratch, n);
    }
  }
  return out;
}

export interface HpssOptions {
  /** FFT size and hop: about 46 ms and 12 ms at 44.1 kHz. */
  nfft?: number;
  hop?: number;
  /** Median lengths in frames (time) and bins (frequency). */
  kernel?: number;
}

/**
 * Split `channels` into the hits (drums) and the rest. The masks come from every channel's magnitude summed, so the
 * channels share them and the stereo picture stays where it was. Drums + harmonic = the input.
 */
export function hpss(channels: Float32Array[], { nfft = 2048, hop = 512, kernel = 17 }: HpssOptions = {}): { drums: Float32Array[]; harmonic: Float32Array[] } {
  const length = channels[0].length;
  // Reflect padding needs more than half a window of signal: very short samples are zero-padded first.
  const padded = length > nfft ? channels : channels.map((c) => {
    const p = new Float32Array(nfft + 1);
    p.set(c);
    return p;
  });
  // First pass: the summed magnitude, without keeping the spectrograms (a long take's are big).
  let mag: Float32Array | null = null, bins = 0, frames = 0;
  for (const ch of padded) {
    const z = stft(ch, nfft, hop);
    mag ??= new Float32Array(z.re.length);
    ({ bins, frames } = z);
    for (let i = 0; i < mag.length; i++) mag[i] += Math.hypot(z.re[i], z.im[i]);
  }
  const h = medianFilter(mag!, bins, frames, kernel, "time");
  const p = medianFilter(mag!, bins, frames, kernel, "freq");
  // The percussive share of each bin: P² / (H² + P²), a Wiener-like soft mask (silence goes to the rest).
  const mask = mag!;
  for (let i = 0; i < mask.length; i++) {
    const pp = p[i] * p[i], hh = h[i] * h[i];
    mask[i] = pp + hh > 1e-20 ? pp / (pp + hh) : 0;
  }
  const drums: Float32Array[] = [], harmonic: Float32Array[] = [];
  for (const ch of padded) {
    const z = stft(ch, nfft, hop);
    const d = { ...z, re: z.re.map((v, i) => v * mask[i]), im: z.im.map((v, i) => v * mask[i]) };
    const r = { ...z, re: z.re.map((v, i) => v * (1 - mask[i])), im: z.im.map((v, i) => v * (1 - mask[i])) };
    drums.push(istft(d, nfft, hop, ch.length).slice(0, length));
    harmonic.push(istft(r, nfft, hop, ch.length).slice(0, length));
  }
  return { drums, harmonic };
}

/** hpss() in a worker, so the Launchkey screen and the page keep going; on the main thread if a worker can't start. */
export function hpssAsync(channels: Float32Array[]): Promise<{ drums: Float32Array[]; harmonic: Float32Array[] }> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./hpssWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(hpss(channels));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ drums: Float32Array[]; harmonic: Float32Array[] }>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Separation failed"));
    };
    worker.postMessage(channels);
  });
}
