// Renders the link preview (public/og-image.png, 1200x630) and the home-screen icon (public/apple-touch-icon.png).
// The preview is the Launchkey screen showing the boot logo (src/display/bootAnim.ts) above a lit 2x8 pad grid.
// Needs rsvg-convert on the PATH (brew install librsvg). Run: npm run og-image
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(appDir, "public");

const OG_W = 1200;
const OG_H = 630;
const DOT = 6; // pixels per screen dot (one of them is the gap between dots)
const BEZEL = 16;
const PAD_GAP = 10;

// Same colours as boot-gif.mjs, the panel tokens in index.css and the pad LEDs in ui/palette.ts.
const BG = "#1c1f23";
const PANEL = "#24282d";
const PANEL_2 = "#2b3036";
const LINE = "#363c43";
const SCREEN = "#15191c";
const DOT_OFF = "#1c2125";
const DOT_ON = "#9cc9d4";
const PADS = [
  ["#ff3b3b", "#ff3b3b", "#ff8a1f", "#ff8a1f", "#ffe83b", "#ffe83b", "#9cff3b", "#2fe05a"],
  ["#3be7ff", "#3be7ff", "#3ba4ff", "#3b5bff", "#8a3bff", "#8a3bff", "#ff3bf0", "#ff3b8a"],
];
// Pads caught mid-hit, so the grid looks played.
const HIT = new Set(["0,0", "0,4", "1,2", "1,5", "0,7"]);

function rsvg(svg, out, width, height) {
  const dir = mkdtempSync(join(tmpdir(), "morsel-og-"));
  const file = join(dir, "in.svg");
  writeFileSync(file, svg);
  const r = spawnSync("rsvg-convert", ["-w", String(width), "-h", String(height), "-o", out, file], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error("rsvg-convert failed (is librsvg installed?)");
  console.log(`Wrote ${out} (${width}x${height})`);
}

const vite = await createServer({ root: appDir, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
try {
  const { bootFrame, BOOT_MS } = await vite.ssrLoadModule("/src/display/bootAnim.ts");
  const { W, H } = await vite.ssrLoadModule("/src/display/frame.ts");
  const logo = bootFrame(BOOT_MS - 1);

  const screenW = W * DOT + BEZEL * 2;
  const screenH = H * DOT + BEZEL * 2;
  const padW = (screenW - PAD_GAP * 7) / 8;
  const padH = padW / 1.6; // same aspect as .pad in index.css
  const gridH = padH * 2 + PAD_GAP;
  const sx = (OG_W - screenW) / 2;
  const sy = (OG_H - (screenH + 24 + gridH)) / 2;
  const gy = sy + screenH + 24;

  const dots = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = logo.get(x, y);
      dots.push(`<rect x="${sx + BEZEL + x * DOT}" y="${sy + BEZEL + y * DOT}" width="${DOT - 1}" height="${DOT - 1}" fill="${on ? DOT_ON : DOT_OFF}"/>`);
    }
  }

  const pads = [];
  PADS.forEach((row, r) => row.forEach((color, c) => {
    const x = sx + c * (padW + PAD_GAP);
    const y = gy + r * (padH + PAD_GAP);
    const hit = HIT.has(`${r},${c}`);
    if (hit) pads.push(`<rect x="${x - 6}" y="${y - 6}" width="${padW + 12}" height="${padH + 12}" rx="9" fill="${color}" opacity=".35" filter="url(#glow)"/>`);
    pads.push(`<rect x="${x + 0.75}" y="${y + 0.75}" width="${padW - 1.5}" height="${padH - 1.5}" rx="4" fill="${hit ? color : PANEL}" fill-opacity="${hit ? 0.85 : 1}" stroke="${color}" stroke-opacity="${hit ? 1 : 0.55}" stroke-width="1.5"/>`);
    if (!hit) pads.push(`<rect x="${x + 0.75}" y="${y + 0.75}" width="${padW - 1.5}" height="${padH - 1.5}" rx="4" fill="url(#tint-${r}-${c})"/>`);
  }));
  const tints = PADS.flatMap((row, r) => row.map((color, c) =>
    `<radialGradient id="tint-${r}-${c}" cx=".5" cy="1.2" r=".9"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`));

  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
    <radialGradient id="vignette" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="${PANEL_2}"/><stop offset="1" stop-color="${BG}"/></radialGradient>
    ${tints.join("\n    ")}
  </defs>
  <rect width="${OG_W}" height="${OG_H}" fill="url(#vignette)"/>
  <rect x="${sx + 0.5}" y="${sy + 0.5}" width="${screenW - 1}" height="${screenH - 1}" rx="6" fill="${PANEL}" stroke="${LINE}"/>
  <rect x="${sx + BEZEL}" y="${sy + BEZEL}" width="${W * DOT}" height="${H * DOT}" fill="${SCREEN}"/>
  ${dots.join("")}
  ${pads.join("\n  ")}
</svg>`;
  rsvg(og, resolve(publicDir, "og-image.png"), OG_W, OG_H);

  // iOS fills transparency with black and rounds the corners itself, so the icon goes on a solid square
  // (a shade lighter than the icon, so the bite still shows) and loses the outline it has for dark tab bars.
  const favicon = readFileSync(resolve(publicDir, "favicon.svg"), "utf8")
    .replace(/^<svg[^>]*>|<\/svg>\s*$/g, "")
    .replace(/ stroke="[^"]*"/g, "");
  const touch = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${PANEL_2}"/><g transform="translate(3 3) scale(.8125)">${favicon}</g></svg>`;
  rsvg(touch, resolve(publicDir, "apple-touch-icon.png"), 180, 180);
} finally {
  await vite.close();
}
