# Live colours (0xRRGGBB) to the Novation palette indices Morsel uses (RGB from app/src/ui/palette.ts).
from .protocol import COLOR

PALETTE_RGB = {
    COLOR["red"]: 0xFF3B3B, COLOR["orange"]: 0xFF8A1F, COLOR["yellow"]: 0xFFE83B, COLOR["lime"]: 0x9CFF3B,
    COLOR["green"]: 0x2FE05A, COLOR["mint"]: 0x3BFFB0, COLOR["cyan"]: 0x3BE7FF, COLOR["sky"]: 0x3BA4FF,
    COLOR["blue"]: 0x3B5BFF, COLOR["purple"]: 0x8A3BFF, COLOR["magenta"]: 0xFF3BF0, COLOR["pink"]: 0xFF3B8A,
    COLOR["white"]: 0xFFFFFF,
}


def _rgb(c):
    return (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF


def _hsv(c):
    r, g, b = [v / 255.0 for v in _rgb(c)]
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d == 0:
        h = 0.0
    elif mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60, (d / mx if mx else 0.0), mx


_cache = {}


def nearest_color(rgb):
    """The palette colour closest in hue; greys and near-whites go to white. Pads are bright, so value is ignored."""
    if rgb in _cache:
        return _cache[rgb]
    h, s, v = _hsv(rgb)
    if s < 0.25:
        best = COLOR["white"]
    else:
        best, dist = None, None
        for idx, prgb in PALETTE_RGB.items():
            ph, ps, _ = _hsv(prgb)
            if ps < 0.25:
                continue
            d = min(abs(h - ph), 360 - abs(h - ph))
            if dist is None or d < dist:
                best, dist = idx, d
    _cache[rgb] = best
    return best
