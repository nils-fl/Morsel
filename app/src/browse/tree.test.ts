import { describe, expect, it } from "vitest";
import { STOCK_KITS } from "../state/types";
import { Cursor, KITS, ROOT, SAMPLES, entryKey, favoriteEntries, fitLine, fitName, fitPath, jumpLetter, listDir, searchPaths, type Entry } from "./tree";

const samples = [
  { id: "1", name: "kick 2", folder: "Drums/Kicks" },
  { id: "2", name: "Kick 10", folder: "Drums/Kicks" },
  { id: "3", name: "Snare", folder: "Drums/Snares" },
  { id: "4", name: "Loose", folder: undefined },
  { id: "5", name: "amen", folder: "" },
  { id: "6", name: "Clap", folder: "Drums" },
];

describe("listDir", () => {
  it("has Samples and Kits at the root", () => {
    expect(listDir(ROOT, samples, []).map((e) => e.name)).toEqual([SAMPLES, KITS]);
  });
  it("lists folders first, then items, case-insensitively sorted", () => {
    expect(listDir(SAMPLES, samples, []).map((e) => `${e.kind}:${e.name}`)).toEqual(["folder:Drums", "sample:amen", "sample:Loose"]);
    expect(listDir("Samples/Drums", samples, []).map((e) => `${e.kind}:${e.name}`)).toEqual(["folder:Kicks", "folder:Snares", "sample:Clap"]);
    expect(listDir("Samples/Drums/Kicks", samples, []).map((e) => e.name)).toEqual(["kick 2", "Kick 10"]);
  });
  it("lists kits", () => {
    expect(listDir(KITS, samples, ["b", "A"]).map((e) => e.name)).toEqual([...STOCK_KITS, "A", "b"]);
    expect(listDir(KITS, samples, ["Factory", "House"]).map((e) => e.name)).toEqual(STOCK_KITS);
  });
});

describe("fitting text into 16 chars", () => {
  it("trims paths from the left and names from the right", () => {
    expect(fitPath("Samples/Drums/Kicks")).toBe("..es/Drums/Kicks");
    expect(fitPath("Samples/Drums/Kicks").length).toBe(16);
    expect(fitName("A very long sample name")).toBe("A very long sam~");
  });
  it("right-aligns the position", () => {
    const l = fitLine("Samples/Drums/Kicks", "3/42");
    expect(l.length).toBe(16);
    expect(l.endsWith(" 3/42")).toBe(true);
    expect(fitLine("Kits", "1/2")).toBe("Kits         1/2");
  });
});

describe("jumpLetter", () => {
  const e = ["Apple", "avocado", "Bass", "Bell", "Clap"].map((name): Entry => ({ kind: "kit", name }));
  it("jumps forward to the next initial", () => {
    expect(jumpLetter(e, 0, 1)).toBe(2);
    expect(jumpLetter(e, 2, 1)).toBe(4);
    expect(jumpLetter(e, 4, 1)).toBe(4);
  });
  it("jumps back to the group start, then the previous group", () => {
    expect(jumpLetter(e, 3, -1)).toBe(2);
    expect(jumpLetter(e, 2, -1)).toBe(0);
    expect(jumpLetter(e, 0, -1)).toBe(0);
  });
});

describe("Cursor", () => {
  it("restores the cursor when going up", () => {
    const c = new Cursor();
    c.move(1, 2);
    c.enter("Kits");
    c.move(5, 3);
    expect(c.index).toBe(2);
    expect(c.up()).toBe(true);
    expect(c.path).toBe(ROOT);
    expect(c.index).toBe(1);
    expect(c.up()).toBe(false);
  });
});

describe("searchPaths", () => {
  const paths = ["Packs/Drums/Kick 10.wav", "Packs/Drums/kick 2.wav", "Packs/Kick Loops/Groove.wav", "Packs/Snare.wav"];
  it("needs every word, in any case", () => {
    expect(searchPaths(paths, "KICK groove")).toEqual(["Packs/Kick Loops/Groove.wav"]);
    expect(searchPaths(paths, "snare kick")).toEqual([]);
    expect(searchPaths(paths, "  ")).toEqual([]);
  });
  it("puts name matches first, each part sorted by name", () => {
    expect(searchPaths(paths, "kick")).toEqual(["Packs/Drums/kick 2.wav", "Packs/Drums/Kick 10.wav", "Packs/Kick Loops/Groove.wav"]);
  });
  it("stops at the limit", () => {
    expect(searchPaths(paths, "packs", 2)).toHaveLength(2);
  });
});

describe("favoriteEntries", () => {
  const lib = { a: { name: "Amen" }, b: { name: "Break" } };
  it("resolves samples, folders and files, folders first", () => {
    const keys = ["sample:b", "file:disk:Packs/Drums/Kick.wav", "folder:disk:Packs/Drums", "folder:Samples/Loops", "sample:a"];
    expect(favoriteEntries(keys, lib, ["Packs"]).map((e) => `${e.kind}:${e.name}`)).toEqual(["folder:Drums", "folder:Loops", "sample:Amen", "sample:Break", "file:Kick"]);
  });
  it("names a starred connected folder by its own name", () => {
    expect(favoriteEntries(["folder:disk:Packs"], lib, ["Packs"])).toEqual([{ kind: "folder", name: "Packs", path: "disk:Packs" }]);
  });
  it("hides what's gone: deleted samples, disconnected folders", () => {
    expect(favoriteEntries(["sample:x", "file:disk:Gone/Kick.wav", "folder:disk:Gone"], lib, ["Packs"])).toEqual([]);
  });
  it("round-trips entry keys", () => {
    const entries: Entry[] = [{ kind: "sample", id: "a", name: "Amen" }, { kind: "file", name: "Kick", path: "disk:Packs/Kick.wav" }];
    expect(favoriteEntries(entries.map(entryKey), lib, ["Packs"])).toEqual(entries);
  });
});
