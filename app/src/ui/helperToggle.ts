// The helper screen above the tabs (ui/HelperScreen.tsx): shown or hidden with the Screen button, remembered per browser.
import { isBoolean, pref } from "../state/prefs";
import { get, set } from "../state/store";

const helperPref = pref("morsel:helper-screen", false, isBoolean);

export const savedHelperScreen = () => helperPref.get();

export function applyHelperScreen(on: boolean) {
  set({ helperScreen: on });
  helperPref.set(on);
}

export const toggleHelperScreen = () => applyHelperScreen(!get().helperScreen);
