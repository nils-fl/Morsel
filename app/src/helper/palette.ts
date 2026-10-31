// The helper screen's 16 colours. Everything on it is drawn from these, so the picture can later go to the screen box
// as 4-bit pixels without changing. Always dark, like the Launchkey's screen.
export const P = {
  bg: "#0d1013",
  panel: "#161b1f",
  sliceAlt: "#1b2126",
  grid: "#262e35",
  knobTrack: "#323b43",
  dim: "#6f7a84",
  text: "#e6e9ec",
  wave: "#4cc8f0",
  waveDim: "#24566a",
  shade: "#090b0d",
  marker: "#c9d0d6",
  accent: "#e0a956",
  playhead: "#ff6a5c",
  rec: "#e5484d",
  play: "#4cc26e",
  fill: "#8fd3a5",
} as const;

export type PaletteKey = keyof typeof P;
export const PALETTE: readonly string[] = Object.values(P);
