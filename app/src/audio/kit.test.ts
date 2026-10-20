import { describe, expect, it } from "vitest";
import { stockLengths, stockSounds } from "./kit";
import { FACTORY_KIT, PAD_COUNT, STOCK_KITS, stockFolder } from "../state/types";

describe("stock kits", () => {
  it("each have 16 uniquely named sounds that fit a pad name", () => {
    for (const kit of STOCK_KITS) {
      const names = stockSounds(kit);
      expect(names, kit).toHaveLength(PAD_COUNT);
      expect(new Set(names).size, kit).toBe(PAD_COUNT);
      for (const n of names) expect(n.length, `${kit} ${n}`).toBeLessThanOrEqual(12);
      for (const len of stockLengths(kit)) expect(len, kit).toBeGreaterThan(0);
    }
  });
  it("keep the Factory kit's sounds where projects expect them", () => {
    expect(stockSounds(FACTORY_KIT).slice(0, 6)).toEqual(["Kick", "Snare", "Clap", "Rim", "Hat Cl", "Hat Op"]);
    expect(stockFolder(FACTORY_KIT)).toBe("Factory");
    expect(stockFolder("House")).toBe("Factory/House");
  });
  it("give the hats a choke pair in every kit", () => {
    for (const kit of STOCK_KITS) expect(stockSounds(kit), kit).toEqual(expect.arrayContaining(["Hat Cl", "Hat Op"]));
  });
});
