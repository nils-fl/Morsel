// Launchkey palette index -> approximate CSS colour (for on-screen pads).
// The LED colours are neon; on screen they are muted toward a neutral grey to suit the UI.

const MUTE_TOWARD = [0x8a, 0x90, 0x97];

/** Mix a #rgb / #rrggbb colour `amount` of the way toward a neutral grey. */
export function mute(hex: string, amount = 0.3) {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const ch = [0, 2, 4].map((i, k) => Math.round(parseInt(full.slice(i, i + 2), 16) * (1 - amount) + MUTE_TOWARD[k] * amount));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const LED: Record<number, string> = {
  0: "#222", 1: "#555", 2: "#888", 3: "#fff", 5: "#ff3b3b", 7: "#6b1a1a", 9: "#ff8a1f", 13: "#ffe83b", 17: "#9cff3b",
  21: "#2fe05a", 23: "#1a5c2a", 29: "#3bffb0", 37: "#3be7ff", 41: "#3ba4ff", 45: "#3b5bff", 47: "#1a2770",
  49: "#8a3bff", 53: "#ff3bf0", 57: "#ff3b8a",
};
const PALETTE: Record<number, string> = Object.fromEntries(Object.entries(LED).map(([k, v]) => [k, mute(v)]));
export const paletteCss = (i: number) => PALETTE[i] ?? `hsl(${(i * 37) % 360} 45% 60%)`;
export const PALETTE_CHOICES = [5, 9, 13, 17, 21, 29, 37, 41, 45, 49, 53, 57];
