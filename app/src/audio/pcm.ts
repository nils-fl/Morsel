// How sample audio is stored: 16-bit, half the size of the 32-bit float the browser decodes to and plenty for samples
// (96 dB of range). Stereo whose two sides are the same is stored once.

export function toInt16(data: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, data[i])) * 0x7fff);
  return out;
}

/** Stored audio (16-bit, or 32-bit float from before) back to float. */
export function toFloat(data: Int16Array | Float32Array): Float32Array<ArrayBuffer> {
  if (data instanceof Float32Array) return new Float32Array(data);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / 0x7fff;
  return out;
}

const same = (a: Int16Array, b: Int16Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Channels as stored: 16-bit, and a single channel when every channel is identical. */
export function encodeChannels(channels: Float32Array[]): Int16Array<ArrayBuffer>[] {
  const pcm = channels.map(toInt16);
  return pcm.length > 1 && pcm.every((c) => same(c, pcm[0])) ? [pcm[0]] : pcm;
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
