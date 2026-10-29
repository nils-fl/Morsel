import { describe, expect, it } from "vitest";
import { fitsTrack } from "./source";
import type { Entry } from "./tree";

describe("what a track can use", () => {
  const kit: Entry = { kind: "preset", name: "505 Core Kit", path: "disk:Ableton Live/Racks/Drum Racks/505 Core Kit.adg", preset: "kit" };
  const piano: Entry = { kind: "preset", name: "Grand Piano", path: "disk:Ableton Live/Racks/Instrument Racks/Grand Piano.adg", preset: "instrument" };

  it("Live kits on drum tracks, Live instruments on keys tracks", () => {
    expect([fitsTrack(kit, "drum"), fitsTrack(kit, "keys")]).toEqual([true, false]);
    expect([fitsTrack(piano, "drum"), fitsTrack(piano, "keys")]).toEqual([false, true]);
  });

  it("samples, files and ordinary folders on both", () => {
    const entries: Entry[] = [
      { kind: "sample", name: "Kick", id: "1" },
      { kind: "file", name: "Bass_C2", path: "disk:Loops/Bass_C2.wav" },
      { kind: "folder", name: "Loops", path: "disk:Loops" },
    ];
    for (const e of entries) expect([fitsTrack(e, "drum"), fitsTrack(e, "keys")]).toEqual([true, true]);
  });
});
