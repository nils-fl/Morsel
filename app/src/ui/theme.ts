// Light / dark theme: a per-browser preference (not part of the project). Light is the default.
import { get, set } from "../state/store";

export type Theme = "dark" | "light";
const KEY = "morsel:theme";
const OLD_KEY = "launchkit:theme"; // before the rename

/** The saved theme, or light. Storage can be unavailable (private window, blocked site data). */
export function savedTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === "dark" ? "dark" : "light";
  } catch {
    return "light";
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
