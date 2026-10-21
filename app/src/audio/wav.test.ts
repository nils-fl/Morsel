import { describe, expect, it } from "vitest";
import { toFloat, toInt16 } from "./pcm";
import { readWav, writeWav } from "./wav";

/** A WAV with one fmt chunk (`format`, `bits`) and the given data bytes. */
function wav(format: number, ch: number, bits: number, data: number[], extensible = false) {
  const fmtSize = extensible ? 40 : 16;
  const bytes = new Uint8Array(12 + 8 + fmtSize + 8 + data.length);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, fmtSize, true);
  v.setUint16(20, extensible ? 0xfffe : format, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, 48000, true);
  v.setUint16(34, bits, true);
  if (extensible) v.setUint16(20 + 24, format, true);
  str(20 + fmtSize, "data");
  v.setUint32(24 + fmtSize, data.length, true);
  bytes.set(data, 28 + fmtSize);
  return bytes;
}

describe("WAV files", () => {
  it("round-trips 16-bit audio exactly as the library stores it", () => {
    const l = toInt16(Float32Array.from([0, 0.5, -0.25, 1, -1]));
    const r = toInt16(Float32Array.from([0.1, -0.1, 0.2, -0.2, 0]));
    const { sampleRate, channels } = readWav(writeWav([l, r], 44100));
    expect(sampleRate).toBe(44100);
    expect(channels.map((c) => [...c])).toEqual([[...toFloat(l)], [...toFloat(r)]]);
  });
  it("reads 24-bit, 32-bit and float audio", () => {
    expect([...readWav(wav(1, 1, 24, [0xff, 0xff, 0x7f, 0x00, 0x00, 0x80])).channels[0]]).toEqual([1, Math.fround(-0x800000 / 0x7fffff)]);
    expect(readWav(wav(1, 1, 32, [0xff, 0xff, 0xff, 0x7f])).channels[0][0]).toBe(1);
    const f = new Uint8Array(Float32Array.from([0.25, -0.5]).buffer);
    expect([...readWav(wav(3, 2, 32, [...f], true)).channels.map((c) => c[0])]).toEqual([0.25, -0.5]);
  });
  it("skips other chunks and rejects what it can't read", () => {
    const plain = writeWav([Int16Array.from([100])], 22050);
    const withList = new Uint8Array(plain.length + 10);
    withList.set(plain.subarray(0, 12));
    withList.set([0x4c, 0x49, 0x53, 0x54, 1, 0, 0, 0, 0, 0], 12); // "LIST", 1 byte + pad byte
    withList.set(plain.subarray(12), 22);
    expect(readWav(withList).channels[0][0]).toBe(Math.fround(100 / 0x7fff));
    expect(() => readWav(new Uint8Array(20))).toThrow("Not a WAV file");
    expect(() => readWav(wav(1, 1, 8, [0x80]))).toThrow("Unsupported");
    expect(() => readWav(plain.subarray(0, 36))).toThrow("no audio");
  });
});
