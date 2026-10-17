// 128x64 1-bit frame for the Launchkey MK4 screen, packed as 64 rows x 19 bytes,
// 7 pixels per byte, bit 6 = leftmost pixel.
import { font5x7, type Font } from "./fonts";

export const W = 128;
export const H = 64;
export const ROW_BYTES = 19;
export const PACKED_SIZE = ROW_BYTES * H; // 1216

export class Frame {
  readonly px = new Uint8Array(W * H);

  clear() {
    this.px.fill(0);
    return this;
  }

  set(x: number, y: number, on = 1) {
    if (x >= 0 && x < W && y >= 0 && y < H) this.px[y * W + x] = on;
  }

  get(x: number, y: number) {
    return x >= 0 && x < W && y >= 0 && y < H ? this.px[y * W + x] : 0;
  }

  hline(x0: number, x1: number, y: number, on = 1) {
    for (let x = x0; x <= x1; x++) this.set(x, y, on);
  }

  vline(x: number, y0: number, y1: number, on = 1) {
    for (let y = y0; y <= y1; y++) this.set(x, y, on);
  }

  rect(x: number, y: number, w: number, h: number, on = 1) {
    this.hline(x, x + w - 1, y, on);
    this.hline(x, x + w - 1, y + h - 1, on);
    this.vline(x, y, y + h - 1, on);
    this.vline(x + w - 1, y, y + h - 1, on);
  }

  fillRect(x: number, y: number, w: number, h: number, on = 1) {
    for (let j = y; j < y + h; j++) this.hline(x, x + w - 1, j, on);
  }

  invert(x: number, y: number, w: number, h: number) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, this.get(i, j) ? 0 : 1);
  }

  /** Draw text with its top-left at (x, y). Returns the x after the last char. */
  text(x: number, y: number, str: string, on = 1, font: Font = font5x7) {
    for (const ch of str) {
      const cols = font.glyph(ch.charCodeAt(0));
      cols.forEach((bits, c) => {
        for (let r = 0; r < font.height; r++) if (bits & (1 << r)) this.set(x + c, y + r, on);
      });
      x += font.advance;
    }
    return x;
  }

  /** Text clipped to maxWidth pixels, with a trailing "~" when truncated. Returns the drawn string. */
  textFit(x: number, y: number, str: string, maxWidth: number, on = 1, font: Font = font5x7) {
    const s = fitText(str, maxWidth, font);
    this.text(x, y, s, on, font);
    return s;
  }

  pack(): Uint8Array {
    const out = new Uint8Array(PACKED_SIZE);
    for (let y = 0; y < H; y++) {
      for (let b = 0; b < ROW_BYTES; b++) {
        let byte = 0;
        for (let bit = 0; bit < 7; bit++) {
          const x = b * 7 + bit;
          if (x < W && this.px[y * W + x]) byte |= 1 << (6 - bit);
        }
        out[y * ROW_BYTES + b] = byte;
      }
    }
    return out;
  }
}

export const textWidth = (str: string, font: Font = font5x7) => str.length * font.advance - (str.length ? font.advance - font.width : 0);

export function fitText(str: string, maxWidth: number, font: Font = font5x7) {
  const max = Math.floor((maxWidth + (font.advance - font.width)) / font.advance);
  return str.length <= max ? str : str.slice(0, Math.max(0, max - 1)) + "~";
}
