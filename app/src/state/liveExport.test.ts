import { describe, expect, it } from "vitest";
import { answer } from "./confirm";
import { isLiveSample, okToExport } from "./liveExport";
import { get, set } from "./store";

describe("exporting Ableton Live sounds", () => {
  it("knows a sample from Live's library by where it came from", () => {
    expect(isLiveSample("disk:Ableton Live/Samples/One Shots/Drums/Kick/Kick 505.aif")).toBe(true);
    expect(isLiveSample("disk:My Samples/Kick.wav")).toBe(false);
    expect(isLiveSample(undefined)).toBe(false);
  });

  it("asks before a file with Live's sounds in it, and not otherwise", async () => {
    set({
      samples: {
        own: { id: "own", name: "Kick", src: "disk:My Samples/Kick.wav" },
        live: { id: "live", name: "Kick 505", src: "disk:Ableton Live/Samples/One Shots/Drums/Kick/Kick 505.aif" },
      },
    });
    expect(await okToExport(["own"], "kit")).toBe(true);
    const asked = okToExport(["own", "live"], "kit");
    expect(get().confirm?.message).toMatch(/1 of the samples in this kit come from Ableton Live/);
    answer(false);
    expect(await asked).toBe(false);
  });
});
