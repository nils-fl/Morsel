import { describe, expect, it } from "vitest";
import { STOCK_KITS } from "../state/types";
import { Cursor, KITS, ROOT, SAMPLES, fitLine, fitName, fitPath, jumpLetter, listDir, type Entry } from "./tree";

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
