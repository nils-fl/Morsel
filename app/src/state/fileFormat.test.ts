import { describe, expect, it } from "vitest";
import { KIT_FORMAT, PROJECT_FORMAT, isKitFormat, isProjectFormat } from "./fileFormat";

describe("file formats", () => {
  it("exports as Morsel", () => {
    expect(PROJECT_FORMAT).toBe("morsel");
    expect(KIT_FORMAT).toBe("morsel-kit");
  });
  it("still imports LaunchKit files", () => {
    expect(isProjectFormat("morsel")).toBe(true);
    expect(isProjectFormat("launchkit")).toBe(true);
    expect(isKitFormat("morsel-kit")).toBe(true);
    expect(isKitFormat("launchkit-kit")).toBe(true);
  });
  it("rejects other files", () => {
    expect(isProjectFormat("morsel-kit")).toBe(false);
    expect(isKitFormat("morsel")).toBe(false);
    expect(isProjectFormat(undefined)).toBe(false);
  });
});
