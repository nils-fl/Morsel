// Launchkey palette index -> approximate CSS colour (for on-screen pads).
// The LED colours are neon; on screen they keep most of that (Neon studio), muted only a little toward grey.

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
const PALETTE: Record<number, string> = Object.fromEntries(Object.entries(LED).map(([k, v]) => [k, mute(v, 0.12)]));
export const paletteCss = (i: number) => PALETTE[i] ?? `hsl(${(i * 37) % 360} 45% 60%)`;
/** Text on a filled `color` (#rrggbb): near-black or white, whichever contrasts more. Blues and violets take white. */
export function inkOn(color: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return INK_DARK;
  const lin = (i: number) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // Contrast against INK_DARK (luminance ~0.005) and white.
  return (l + 0.05) / 0.055 >= 1.05 / (l + 0.05) ? INK_DARK : "#ffffff";
}
const INK_DARK = "#0e1012";

export const PALETTE_CHOICES = [5, 9, 13, 17, 21, 29, 37, 41, 45, 49, 53, 57];
