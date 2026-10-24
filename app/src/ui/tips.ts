// Tips: the explanatory paragraphs in the panels (class "tip"), hidden unless switched on. A per-browser preference.
import { isBoolean, pref } from "../state/prefs";
import { get, set } from "../state/store";

const tipsPref = pref("morsel:tips", false, isBoolean);

/** Whether tips were switched on. */
export const savedTips = () => tipsPref.get();

/** Show or hide the tips on the page (index.css keys off data-tips) and remember it. */
export function applyTips(tips: boolean) {
  if (tips) document.documentElement.dataset.tips = "";
  else delete document.documentElement.dataset.tips;
  set({ tips });
  tipsPref.set(tips);
}

export const toggleTips = () => applyTips(!get().tips);
