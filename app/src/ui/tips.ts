// Tips: the explanatory paragraphs in the panels (class "tip"), hidden unless switched on. A per-browser preference.
import { get, set } from "../state/store";

const KEY = "morsel:tips";

/** Whether tips were switched on. Storage can be unavailable (private window, blocked site data). */
export function savedTips(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

/** Show or hide the tips on the page (index.css keys off data-tips) and remember it. */
export function applyTips(tips: boolean) {
  if (tips) document.documentElement.dataset.tips = "";
  else delete document.documentElement.dataset.tips;
  set({ tips });
  try {
    localStorage.setItem(KEY, tips ? "on" : "off");
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

export const toggleTips = () => applyTips(!get().tips);
