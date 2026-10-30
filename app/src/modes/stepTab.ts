// The Sequencer tab follows the Launchkey's Step mode: entering Step opens it, leaving Step goes back to the tab
// before (unless another tab was picked meanwhile). A trip from Step into Chop or Browse and back keeps the tab to go
// back to.
import { get, set } from "../state/store";
import type { Tab } from "../state/types";

let tabBeforeStep: Tab | null = null;

export function enterStepTab() {
  const tab = get().tab;
  if (tabBeforeStep === null && tab !== "Sequencer") tabBeforeStep = tab;
  set({ tab: "Sequencer" });
}

/** Leaving Step for a mode of the Func cycle (not Chop or Browse). */
export function leaveStepTab() {
  if (tabBeforeStep !== null && get().tab === "Sequencer") set({ tab: tabBeforeStep });
  tabBeforeStep = null;
}
