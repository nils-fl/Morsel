import { describe, expect, it } from "vitest";
import { FACTORY_PRESETS, jumpFolder, presetEdited, presetFolders } from "./synthPresets";
import { defaultKeys } from "../state/store";

describe("synth presets", () => {
  it("have unique names and stay inside the knob ranges", () => {
    expect(new Set(FACTORY_PRESETS.map((p) => p.name)).size).toBe(FACTORY_PRESETS.length);
    // Same limits as the Keys tab sliders and the Keys encoder page.
    const inRange = (name: string, v: number, lo: number, hi: number) => {
      expect(v, name).toBeGreaterThanOrEqual(lo);
      expect(v, name).toBeLessThanOrEqual(hi);
    };
    for (const { name, params: s } of FACTORY_PRESETS) {
      inRange(name, s.detune, -2400, 2400);
      for (const v of [s.osc2Level, s.cutoff, s.resonance, s.envAmount, s.sustain, s.volume]) inRange(name, v, 0, 1);
      inRange(name, s.attack, 0.001, 2);
      inRange(name, s.decay, 0.01, 2);
      inRange(name, s.release, 0.01, 3);
      for (const v of [s.sub, s.noise, s.drive, s.keyTrack, s.velFilter]) inRange(name, v, 0, 1);
      inRange(name, s.filterDecay, 0, 2);
      expect([12, 24], name).toContain(s.slope);
    }
  });
  it("Init matches the default synth, so a fresh project isn't marked edited", () => {
    expect(presetEdited(defaultKeys().synth, FACTORY_PRESETS.find((p) => p.name === defaultKeys().preset))).toBe(false);
  });
  it("notices edits and unknown presets", () => {
    const p = FACTORY_PRESETS[3];
    expect(presetEdited({ ...p.params }, p)).toBe(false);
    expect(presetEdited({ ...p.params, cutoff: p.params.cutoff + 0.01 }, p)).toBe(true);
    expect(presetEdited({ ...p.params, wave: "sine" }, p)).toBe(p.params.wave !== "sine");
    expect(presetEdited(p.params, undefined)).toBe(true);
  });
  it("keep each folder together, so stepping walks one folder at a time", () => {
    const folders = presetFolders(FACTORY_PRESETS);
    const runs = FACTORY_PRESETS.map((p) => p.folder).filter((f, i, a) => f !== a[i - 1]);
    expect(runs).toEqual(folders);
    expect(folders).toContain("Bass");
  });
  it("jump to the next or previous folder", () => {
    const list = ["A", "B", "B", "B", "C"].map((folder, i) => ({ name: `${i}`, folder, params: FACTORY_PRESETS[0].params }));
    expect(jumpFolder(list, 0, 1)).toBe(1);
    expect(jumpFolder(list, 2, 1)).toBe(4);
    expect(jumpFolder(list, 4, 1)).toBe(4);
    expect(jumpFolder(list, 3, -1)).toBe(1); // back to this folder's start first
    expect(jumpFolder(list, 1, -1)).toBe(0);
    expect(jumpFolder(list, 4, -1)).toBe(1);
    expect(jumpFolder([], 0, 1)).toBe(0);
  });
});
