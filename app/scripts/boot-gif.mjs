// Renders the Launchkey start-up animation (src/display/bootAnim.ts) to docs/boot-animation.gif for the README.
// The frames come from the same code the device screen uses, drawn as the on-screen dot-matrix preview.
// Needs ffmpeg on the PATH. Run: npm run boot-gif
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(appDir, "../docs/boot-animation.gif");

const FPS = 25;
const HOLD_LAST_MS = 1200; // pause on the logo before the GIF loops
const SCALE = 4; // pixels per screen dot (one of them is the gap between dots)
const PAD = 14; // bezel around the screen

// Same colours as ui/ScreenPreview.tsx and the panel tokens in index.css.
const BEZEL = [0x24, 0x28, 0x2d];
const BEZEL_LINE = [0x36, 0x3c, 0x43];
const SCREEN = [0x15, 0x19, 0x1c];
const DOT_OFF = [0x1c, 0x21, 0x25];
const DOT_ON = [0x9c, 0xc9, 0xd4];

const vite = await createServer({ root: appDir, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
try {
  const { bootFrame, BOOT_MS } = await vite.ssrLoadModule("/src/display/bootAnim.ts");
  const { W, H } = await vite.ssrLoadModule("/src/display/frame.ts");

  const width = W * SCALE + PAD * 2;
  const height = H * SCALE + PAD * 2;
  const dir = mkdtempSync(join(tmpdir(), "morsel-boot-"));

  /** One frame as a binary PPM image. */
  function ppm(frame) {
    const px = Buffer.alloc(width * height * 3);
    const put = (x, y, [r, g, b]) => px.set([r, g, b], (y * width + x) * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        put(x, y, edge ? BEZEL_LINE : BEZEL);
      }
    }
    for (let y = 0; y < H * SCALE; y++) for (let x = 0; x < W * SCALE; x++) put(PAD + x, PAD + y, SCREEN);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const color = frame?.get(x, y) ? DOT_ON : DOT_OFF;
        for (let j = 0; j < SCALE - 1; j++) for (let i = 0; i < SCALE - 1; i++) put(PAD + x * SCALE + i, PAD + y * SCALE + j, color);
      }
    }
    return Buffer.concat([Buffer.from(`P6 ${width} ${height} 255\n`), px]);
  }

  const frames = Math.ceil(BOOT_MS / (1000 / FPS));
  let last = null;
  for (let n = 0; n < frames; n++) {
    const f = bootFrame((n * 1000) / FPS) ?? last;
    last = f;
    writeFileSync(join(dir, `f${String(n).padStart(4, "0")}.ppm`), ppm(f));
  }
  // Hold on the final (logo) frame.
  for (let k = 0; k < Math.round((HOLD_LAST_MS / 1000) * FPS); k++) {
    writeFileSync(join(dir, `f${String(frames + k).padStart(4, "0")}.ppm`), ppm(bootFrame(BOOT_MS - 1)));
  }

  const ff = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "f%04d.ppm"),
    "-vf", "split[a][b];[a]palettegen=max_colors=8:stats_mode=full[p];[b][p]paletteuse=dither=none",
    "-loop", "0", out,
  ], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  if (ff.status !== 0) throw new Error("ffmpeg failed (is it installed?)");
  console.log(`Wrote ${out} (${width}x${height}, ${frames} frames + ${HOLD_LAST_MS} ms hold)`);
} finally {
  await vite.close();
}
