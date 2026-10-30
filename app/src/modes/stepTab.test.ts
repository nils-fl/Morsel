import { describe, expect, it } from "vitest";
import { get, set } from "../state/store";
import { enterStepTab, leaveStepTab } from "./stepTab";

describe("the Sequencer tab follows Step mode", () => {
  it("opens on entering Step and goes back to the tab before on leaving", () => {
    set({ tab: "Mixer" });
    enterStepTab();
    expect(get().tab).toBe("Sequencer");
    leaveStepTab();
    expect(get().tab).toBe("Mixer");
  });

  it("keeps a tab picked while in Step", () => {
    set({ tab: "Mixer" });
    enterStepTab();
    set({ tab: "Song" });
    leaveStepTab();
    expect(get().tab).toBe("Song");
    enterStepTab();
    leaveStepTab();
    expect(get().tab).toBe("Song"); // nothing stale from before
  });

  it("remembers the tab across a trip into Chop and back", () => {
    set({ tab: "Mixer" });
    enterStepTab();
    set({ tab: "Chop" }); // Step → Chop (Chop opens its own tab; the controller doesn't call leaveStepTab)
    enterStepTab(); // Chop → Step
    expect(get().tab).toBe("Sequencer");
    leaveStepTab();
    expect(get().tab).toBe("Mixer");
  });
});
