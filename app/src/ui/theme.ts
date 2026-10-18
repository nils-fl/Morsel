// Light / dark theme: a per-browser preference (not part of the project). Dark is the default.
import { get, set } from "../state/store";

export type Theme = "dark" | "light";
const KEY = "launchkit:theme";

/** The saved theme, or dark. Storage can be unavailable (private window, blocked site data). */
export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Apply a theme to the page and the store (canvases redraw on the store change) and remember it. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  set({ theme });
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

export const toggleTheme = () => applyTheme(get().theme === "light" ? "dark" : "light");
