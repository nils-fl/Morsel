# Port of app/src/display/frame.ts.
# 128x64 1-bit frame for the Launchkey MK4 screen, packed as 64 rows x 19 bytes,
# 7 pixels per byte, bit 6 = leftmost pixel.
from .fonts import font5x7

W = 128
H = 64
ROW_BYTES = 19
PACKED_SIZE = ROW_BYTES * H  # 1216


class Frame(object):
    def __init__(self):
        self.px = bytearray(W * H)

    def clear(self):
        self.px = bytearray(W * H)
        return self

    def set(self, x, y, on=1):
        if 0 <= x < W and 0 <= y < H:
            self.px[y * W + x] = on

    def get(self, x, y):
        return self.px[y * W + x] if 0 <= x < W and 0 <= y < H else 0

    def hline(self, x0, x1, y, on=1):
        for x in range(x0, x1 + 1):
            self.set(x, y, on)

    def vline(self, x, y0, y1, on=1):
        for y in range(y0, y1 + 1):
            self.set(x, y, on)

    def rect(self, x, y, w, h, on=1):
        self.hline(x, x + w - 1, y, on)
        self.hline(x, x + w - 1, y + h - 1, on)
        self.vline(x, y, y + h - 1, on)
        self.vline(x + w - 1, y, y + h - 1, on)

    def fill_rect(self, x, y, w, h, on=1):
        for j in range(y, y + h):
            self.hline(x, x + w - 1, j, on)

    def invert(self, x, y, w, h):
        for j in range(y, y + h):
            for i in range(x, x + w):
                self.set(i, j, 0 if self.get(i, j) else 1)

    def text(self, x, y, s, on=1, font=font5x7):
        """Draw text with its top-left at (x, y). Returns the x after the last char."""
        for ch in s:
            for c, bits in enumerate(font.glyph(ord(ch))):
                for r in range(font.height):
                    if bits & (1 << r):
                        self.set(x + c, y + r, on)
            x += font.advance
        return x

    def text_fit(self, x, y, s, max_width, on=1, font=font5x7):
        """Text clipped to max_width pixels, with a trailing "~" when truncated. Returns the drawn string."""
        s = fit_text(s, max_width, font)
        self.text(x, y, s, on, font)
        return s

    def pack(self):
        out = bytearray(PACKED_SIZE)
        px = self.px
        for y in range(H):
            row = y * W
            for b in range(ROW_BYTES):
                byte = 0
                for bit in range(7):
                    x = b * 7 + bit
                    if x < W and px[row + x]:
                        byte |= 1 << (6 - bit)
                out[y * ROW_BYTES + b] = byte
        return out


def text_width(s, font=font5x7):
    return len(s) * font.advance - ((font.advance - font.width) if s else 0)


def fit_text(s, max_width, font=font5x7):
    mx = (max_width + (font.advance - font.width)) // font.advance
    return s if len(s) <= mx else s[: max(0, mx - 1)] + "~"
