// Light / dark theme: a per-browser preference (not part of the project). Light is the default.
import { oneOf, pref } from "../state/prefs";
import { get, set } from "../state/store";

export type Theme = "dark" | "light";
const themePref = pref<Theme>("morsel:theme", "light", oneOf(["dark", "light"]), "launchkit:theme"); // before the rename

/** The saved theme, or light. */
export const savedTheme = () => themePref.get();

/** Apply a theme to the page and the store (canvases redraw on the store change) and remember it. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  set({ theme });
  themePref.set(theme);
}

export const toggleTheme = () => applyTheme(get().theme === "light" ? "dark" : "light");
