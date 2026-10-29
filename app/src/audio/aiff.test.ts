import { describe, expect, it } from "vitest";
import { decodeAiff, isAiff } from "./aiff";

/** An 80-bit IEEE 754 extended float, as AIFF stores its sample rate. */
function extended(x: number) {
  const out = new Uint8Array(10);
  const exp = Math.floor(Math.log2(x));
  const mant = x / 2 ** exp; // 1 <= mant < 2
  const v = new DataView(out.buffer);
  v.setUint16(0, exp + 16383);
  const hi = Math.floor(mant * 2 ** 31);
  v.setUint32(2, hi);
  v.setUint32(6, Math.round((mant * 2 ** 31 - hi) * 2 ** 32));
  return out;
}

/** An AIFF (or AIFF-C with `comp`) file of interleaved frames `data` (per channel arrays, -1..1). */
function aiff(data: number[][], bits: number, rate: number, comp?: "NONE" | "sowt" | "fl32") {
  const channels = data.length, frames = data[0].length;
  const bytesPer = comp === "fl32" ? 4 : bits / 8;
  const sound = new DataView(new ArrayBuffer(frames * channels * bytesPer));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const at = (f * channels + c) * bytesPer, x = data[c][f];
      if (comp === "fl32") sound.setFloat32(at, x);
      else {
        const n = Math.round(x * (2 ** (bits - 1) - 1));
        if (bits === 16) sound.setInt16(at, n, comp === "sowt");
        else {
          const u = n < 0 ? n + 0x1000000 : n;
          const b = [(u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff];
          (comp === "sowt" ? b.reverse() : b).forEach((byte, i) => sound.setUint8(at + i, byte));
        }
      }
    }
  }
  const aifc = comp !== undefined;
  const commSize = aifc ? 24 : 18;
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, n); return new Uint8Array(b.buffer); };
  const u16 = (n: number) => { const b = new DataView(new ArrayBuffer(2)); b.setUint16(0, n); return new Uint8Array(b.buffer); };
  const str = (s: string) => new TextEncoder().encode(s);
  parts.push(str("COMM"), u32(commSize), u16(channels), u32(frames), u16(comp === "fl32" ? 32 : bits), extended(rate));
  if (aifc) parts.push(str(comp!), u16(0)); // compression id, then an empty name (padded to even)
  parts.push(str("SSND"), u32(8 + sound.byteLength), u32(0), u32(0), new Uint8Array(sound.buffer));
  const body = parts.reduce((n, p) => n + p.length, 0);
  const all = [str("FORM"), u32(4 + body), str(aifc ? "AIFC" : "AIFF"), ...parts];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

const ramp = [0, 0.5, -0.5, 0.25, -1, 0.99];

describe("decodeAiff", () => {
  it("knows an AIFF from a WAV", () => {
    expect(isAiff(aiff([ramp], 16, 44100))).toBe(true);
    expect(isAiff(new TextEncoder().encode("RIFF....WAVE").buffer)).toBe(false);
  });

  for (const [label, bits, comp] of [["16-bit AIFF", 16, undefined], ["24-bit AIFF", 24, undefined],
    ["16-bit AIFF-C sowt", 16, "sowt"], ["24-bit AIFF-C sowt", 24, "sowt"], ["float AIFF-C fl32", 32, "fl32"]] as const) {
    it(`reads ${label}, stereo, with its sample rate`, () => {
      const right = ramp.map((x) => -x * 0.5);
      for (const rate of [44100, 48000]) {
        const d = decodeAiff(aiff([ramp, right], bits, rate, comp));
        expect(d.sampleRate).toBe(rate);
        expect(d.channels).toHaveLength(2);
        const tol = bits === 16 ? 1e-4 : 1e-6;
        d.channels[0].forEach((x, i) => expect(Math.abs(x - ramp[i])).toBeLessThan(tol));
        d.channels[1].forEach((x, i) => expect(Math.abs(x - right[i])).toBeLessThan(tol));
      }
    });
  }

  it("rejects a compression it can't read", () => {
    const bytes = new Uint8Array(aiff([ramp], 16, 44100, "sowt"));
    bytes.set(new TextEncoder().encode("ulaw"), 38); // the compression id in COMM
    expect(() => decodeAiff(bytes.buffer)).toThrow(/ulaw/);
  });
});
