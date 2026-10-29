import { describe, expect, it } from "vitest";
import { defaultFx } from "../state/store";
import { crushCurve, delaySeconds, fxChain } from "./fxUnits";
import { CrushCore, crushHold } from "./worklet/crushCore";

describe("FX rack audio", () => {
  it("chains the effects switched on, in the track's order", () => {
    const fx = defaultFx();
    fx.order = ["reverb", "filter", "eq", "drive", "comp", "chorus", "delay", "crush"];
    fx.on = { ...fx.on, delay: true, reverb: true, filter: true };
    expect(fxChain(fx)).toEqual(["reverb", "filter", "delay"]);
  });

  it("delays by 16ths of the tempo, at most 8 s", () => {
    expect(delaySeconds(3, 120)).toBeCloseTo(0.375);
    expect(delaySeconds(16, 20)).toBe(8);
  });

  it("crushes to fewer bits as a staircase", () => {
    const c = crushCurve(2); // two steps a side
    expect(new Set(c)).toEqual(new Set([-1, -0.5, 0, 0.5, 1]));
    expect(crushCurve(16).length).toBe(4097);
  });

  it("holds samples for a lower rate, evenly across blocks", () => {
    expect([crushHold(1), crushHold(0), crushHold(0.5)]).toEqual([1, 32, 6]);
    const core = new CrushCore();
    const out = [new Float32Array(3)], out2 = [new Float32Array(3)];
    core.process([Float32Array.from([1, 2, 3])], out, 3, 2);
    core.process([Float32Array.from([4, 5, 6])], out2, 3, 2);
    expect([...out[0], ...out2[0]]).toEqual([1, 1, 3, 3, 5, 5]);
  });
});
