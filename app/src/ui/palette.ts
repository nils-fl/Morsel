// Launchkey palette index -> approximate CSS colour (for on-screen pads).
const PALETTE: Record<number, string> = {
  0: "#222", 1: "#555", 2: "#888", 3: "#fff", 5: "#ff3b3b", 7: "#6b1a1a", 9: "#ff8a1f", 13: "#ffe83b", 17: "#9cff3b",
  21: "#2fe05a", 23: "#1a5c2a", 29: "#3bffb0", 37: "#3be7ff", 41: "#3ba4ff", 45: "#3b5bff", 47: "#1a2770",
  49: "#8a3bff", 53: "#ff3bf0", 57: "#ff3b8a",
};
export const paletteCss = (i: number) => PALETTE[i] ?? `hsl(${(i * 37) % 360} 80% 60%)`;
export const PALETTE_CHOICES = [5, 9, 13, 17, 21, 29, 37, 41, 45, 49, 53, 57];
