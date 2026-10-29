// How sample audio is stored: 16-bit, half the size of the 32-bit float the browser decodes to and plenty for samples
// (96 dB of range), with its channels as they are: stereo stays stereo, even with two identical sides (stored once,
// it came back as mono, which a centred pan plays 3 dB quieter than the stereo it was).

export function toInt16(data: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, data[i])) * 0x7fff);
  return out;
}

/**
 * 16-bit with TPDF dither: a triangular noise of ±1 step added before rounding, so quiet tails fade into a soft hiss
 * instead of the gritty steps plain rounding leaves. For bounces; samples are stored without it.
 */
export function toInt16Dithered(data: Float32Array, rand = Math.random): Int16Array<ArrayBuffer> {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, data[i])) * 0x7fff + rand() - rand());
    out[i] = Math.max(-0x7fff, Math.min(0x7fff, v));
  }
  return out;
}

/** Stored audio (16-bit, or 32-bit float from before) back to float. */
export function toFloat(data: Int16Array | Float32Array): Float32Array<ArrayBuffer> {
  if (data instanceof Float32Array) return new Float32Array(data);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / 0x7fff;
  return out;
}

/** Channels as stored: 16-bit, every channel kept. */
export function encodeChannels(channels: Float32Array[]): Int16Array<ArrayBuffer>[] {
  return channels.map(toInt16);
}

/**
 * Whether two samples' channels hold the same audio as stored: within one 16-bit step (a sample added this session is
 * still the float the browser decoded), and a single channel matches stereo with two identical sides.
 */
export function sameAudio(a: Float32Array[], b: Float32Array[]) {
  if (!a.length || !b.length || a[0].length !== b[0].length) return false;
  if (a.length !== b.length && Math.min(a.length, b.length) !== 1) return false;
  const clip = (v: number) => Math.max(-1, Math.min(1, v));
  for (let c = 0; c < Math.max(a.length, b.length); c++) {
    const x = a[Math.min(c, a.length - 1)], y = b[Math.min(c, b.length - 1)];
    for (let i = 0; i < x.length; i++) if (Math.abs(clip(x[i]) - clip(y[i])) > 1 / 0x7fff) return false;
  }
  return true;
}
