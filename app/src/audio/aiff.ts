// AIFF and AIFF-C reading: Chromium's decodeAudioData can't decode them, and Ableton Live's library is AIFF. PCM 8, 16,
// 24 and 32-bit (big-endian, or little-endian "sowt"), and 32 / 64-bit float ("fl32", "fl64"). Pure, for the tests.

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
}

const id = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** Whether the bytes are an AIFF or AIFF-C file. */
export function isAiff(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12) return false;
  const v = new DataView(bytes);
  const form = id(v, 8);
  return id(v, 0) === "FORM" && (form === "AIFF" || form === "AIFC");
}

/** The sample rate's 80-bit IEEE 754 extended float. */
function extended(v: DataView, at: number) {
  const exp = v.getUint16(at) & 0x7fff;
  const hi = v.getUint32(at + 2);
  const lo = v.getUint32(at + 6);
  if (!exp && !hi && !lo) return 0;
  const sign = v.getUint16(at) & 0x8000 ? -1 : 1;
  return sign * (hi * 2 ** (exp - 16383 - 31) + lo * 2 ** (exp - 16383 - 63));
}

/** Decode an AIFF / AIFF-C file. Throws on anything else, or a compression it doesn't know. */
export function decodeAiff(bytes: ArrayBuffer): DecodedAudio {
  if (!isAiff(bytes)) throw new Error("Not an AIFF file");
  const v = new DataView(bytes);
  const aifc = id(v, 8) === "AIFC";
  let channels = 0, frames = 0, bits = 0, sampleRate = 0, comp = "NONE";
  let data = -1;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const chunk = id(v, at);
    const size = v.getUint32(at + 4);
    const body = at + 8;
    if (chunk === "COMM") {
      channels = v.getUint16(body);
      frames = v.getUint32(body + 2);
      bits = v.getUint16(body + 6);
      sampleRate = extended(v, body + 8);
      if (aifc && size >= 22) comp = id(v, body + 18);
    } else if (chunk === "SSND") {
      data = body + 8 + v.getUint32(body); // past the offset and block size
    }
    at = body + size + (size & 1); // chunks are padded to an even length
  }
  if (!channels || !sampleRate || data < 0) throw new Error("AIFF without its format or sound data");
  const float = comp === "fl32" || comp === "FL32" || comp === "fl64" || comp === "FL64";
  const little = comp === "sowt";
  if (!float && !little && comp !== "NONE") throw new Error(`AIFF-C compression "${comp}" isn't supported`);
  const bytesPer = float ? (comp.toLowerCase() === "fl64" ? 8 : 4) : Math.ceil(bits / 8);
  frames = Math.min(frames, Math.floor((bytes.byteLength - data) / (bytesPer * channels)));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const scale = 2 ** (bytesPer * 8 - 1);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const at = data + (f * channels + c) * bytesPer;
      let x: number;
      if (float) x = bytesPer === 8 ? v.getFloat64(at) : v.getFloat32(at);
      else if (bytesPer === 1) x = v.getInt8(at) / scale;
      else if (bytesPer === 2) x = v.getInt16(at, little) / scale;
      else if (bytesPer === 3) {
        const b0 = v.getUint8(at), b1 = v.getUint8(at + 1), b2 = v.getUint8(at + 2);
        const n = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        x = (n & 0x800000 ? n - 0x1000000 : n) / scale;
      } else x = v.getInt32(at, little) / scale;
      out[c][f] = x;
    }
  }
  return { sampleRate, channels: out };
}
