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
