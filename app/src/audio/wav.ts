// WAV files: written as 16-bit PCM (how the library stores samples, audio/pcm.ts), read as 16/24/32-bit PCM or
// 32-bit float, so a sample swapped in by hand in an exported project or kit still loads.

/** A 16-bit PCM WAV of `channels` (one per channel, all the same length). */
export function writeWav(channels: Int16Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const ch = channels.length;
  const n = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const data = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      data.setInt16(o, channels[c][i], true);
      o += 2;
    }
  }
  return bytes;
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** A WAV file's audio as float, one array per channel. 16-bit audio comes back exactly as audio/pcm.ts toFloat does. */
export function readWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array<ArrayBuffer>[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || str(0) !== "RIFF" || str(8) !== "WAVE") throw new Error("Not a WAV file");
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = str(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && size >= 16) {
      let format = view.getUint16(body, true);
      if (format === EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true); // the sub-format GUID starts with it
      fmt = { format, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before its format");
      return { sampleRate: fmt.sampleRate, channels: decode(view, body, Math.min(size, bytes.length - body), fmt) };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV file has no audio");
}

function decode(view: DataView, start: number, size: number, fmt: { format: number; channels: number; bits: number }) {
  const { format, channels: ch, bits } = fmt;
  const width = bits / 8;
  const read =
    format === PCM && bits === 16 ? (o: number) => view.getInt16(o, true) / 0x7fff :
    format === PCM && bits === 24 ? (o: number) => ((view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)) / 0x7fffff) :
    format === PCM && bits === 32 ? (o: number) => view.getInt32(o, true) / 0x7fffffff :
    format === FLOAT && bits === 32 ? (o: number) => view.getFloat32(o, true) :
    null;
  if (!read || ch < 1) throw new Error(`Unsupported WAV format (${bits}-bit${format === FLOAT ? " float" : ""})`);
  const n = Math.floor(size / (width * ch));
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0, o = start; i < n; i++) {
    for (let c = 0; c < ch; c++, o += width) out[c][i] = read(o);
  }
  return out;
}
