import { describe, expect, it } from "vitest";
import { encodeChannels, toFloat, toInt16 } from "./pcm";

describe("16-bit sample storage", () => {
  it("round-trips within one 16-bit step and clips out-of-range values", () => {
    const src = Float32Array.from([0, 0.5, -0.25, 1, -1, 1.5, -2]);
    const back = toFloat(toInt16(src));
    src.forEach((v, i) => expect(back[i]).toBeCloseTo(Math.max(-1, Math.min(1, v)), 4));
  });
  it("reads old 32-bit float records unchanged", () => {
    expect([...toFloat(Float32Array.from([0.1, -0.3]))]).toEqual([...Float32Array.from([0.1, -0.3])]);
  });
  it("stores identical stereo sides once and keeps real stereo", () => {
    const l = Float32Array.from([0.1, 0.2, 0.3]);
    expect(encodeChannels([l, l.slice()])).toHaveLength(1);
    expect(encodeChannels([l, Float32Array.from([0.1, 0.2, -0.3])])).toHaveLength(2);
  });
});
