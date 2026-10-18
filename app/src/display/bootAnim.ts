// Start-up animation for the Launchkey screen: a blob chomps a waveform, burps, and the logo bounces in.
// Plain time in, Frame out, like the other screens.
import { Frame, H, W, textWidth } from "./frame";

export const BOOT_EAT_MS = 1800;
export const BOOT_BURP_MS = 2300;
/** Logo bounces in for 0.5 s after the burp, then stays up long enough to read. */
export const BOOT_MS = BOOT_BURP_MS + 2000;

const MID = 32;
const R = 7;

/** Blob centre x: walks in from the left edge and stops mid-screen when the eating is done. */
export function blobX(ms: number) {
  return Math.round(-R + Math.min(1, ms / BOOT_EAT_MS) * (W / 2 + R));
}

/** The waveform it eats: a sine with a slow swell, so it looks like audio. */
const waveAt = (x: number) => Math.sin(x / 3.1) * (0.35 + 0.65 * Math.abs(Math.sin(x / 19))) * 12;

function drawWave(f: Frame, from: number, to: number, dx: number) {
  for (let x = Math.max(0, from); x < Math.min(W, to); x++) {
    const y = Math.round(MID - waveAt(x));
    f.vline(x + dx, Math.min(y, MID), Math.max(y, MID));
  }
}

/** Filled circle with a mouth wedge facing right and one eye. */
function drawBlob(f: Frame, cx: number, r: number, mouth: number, dx: number) {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      if (x > 0 && Math.abs(Math.atan2(y, x)) < mouth) continue;
      f.set(cx + x + dx, MID + y);
    }
  }
  f.set(cx + dx, MID - Math.ceil(r / 2), 0);
  f.set(cx + dx + 1, MID - Math.ceil(r / 2), 0);
}

function easeOutBounce(t: number) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** Text drawn at twice the size. */
function bigText(f: Frame, x: number, y: number, str: string) {
  const tmp = new Frame();
  tmp.text(0, 0, str);
  const w = textWidth(str);
  for (let j = 0; j < 7; j++) for (let i = 0; i < w; i++) if (tmp.get(i, j)) f.fillRect(x + i * 2, y + j * 2, 2, 2);
}

/** The frame `ms` into the animation, or null once it's over. */
export function bootFrame(ms: number): Frame | null {
  if (ms < 0 || ms >= BOOT_MS) return null;
  const f = new Frame();
  if (ms < BOOT_EAT_MS) {
    const bx = blobX(ms);
    drawWave(f, bx + R + 1, W, 0);
    // Crumbs tumbling out behind it.
    for (let k = 1; k <= 3; k++) {
      const cx = bx - R - k * 5 - ((ms / 40) % 5);
      f.set(Math.round(cx), MID + ((k * 7 + Math.floor(ms / 60)) % 9) - 4);
    }
    const open = Math.floor(ms / 120) % 2 === 0;
    drawBlob(f, bx, R, open ? 0.75 : 0.12, 0);
    return f;
  }
  if (ms < BOOT_BURP_MS) {
    const t = (ms - BOOT_EAT_MS) / (BOOT_BURP_MS - BOOT_EAT_MS);
    const shake = Math.floor(ms / 50) % 2 ? 1 : -1;
    const cx = W / 2;
    // The burp blows the rest of the waveform away.
    drawWave(f, cx + R + 2 + Math.round(t * W), W, shake);
    drawBlob(f, cx, R + Math.round(t * 3), 0.9, shake);
    const bub = "BURP!";
    const bw = textWidth(bub) + 6;
    const bxl = cx + 8 + shake, byt = 6;
    f.fillRect(bxl, byt, bw, 11, 0);
    f.rect(bxl, byt, bw, 11);
    f.set(bxl - 1, byt + 11);
    f.set(bxl - 2, byt + 12);
    f.text(bxl + 3, byt + 2, bub);
    return f;
  }
  const t = Math.min(1, (ms - BOOT_BURP_MS) / 500);
  const logo = "MORSEL";
  const lw = textWidth(logo) * 2;
  const y = Math.round(-16 + easeOutBounce(t) * (18 + 16));
  bigText(f, Math.floor((W - lw) / 2), y, logo);
  if (ms > BOOT_BURP_MS + 450) {
    const sub = "ready to chop";
    f.text(Math.floor((W - textWidth(sub)) / 2), H - 16, sub);
  }
  return f;
}
