# Full-screen layouts, ported from app/src/display/screens.ts. Plain data in, Frame out: no Live, no MIDI.
# Every mode screen has the same header: the selected track on the left, "S<n> <STATE>" (scene and transport) on the
# right, so Play / Record always show. The footer names the mode or encoder page.
import re

from .frame import W, Frame, text_width
from .frame import H
from .widgets import HEADER_H, ROW_H, footer, header, item_list, step_row


class GridCell(object):
    def __init__(self, label, fill=False, mark=False, dim=False):
        self.label = label  # 1-2 characters
        self.fill = fill  # drawn solid (selected / on)
        self.mark = mark  # a bar under the label (e.g. a scene with clips)
        self.dim = dim  # dotted outline (empty / off / queued)


def grid_screen(title, status, cells, tag, info, note=None):
    """Track, Mute and Pattern modes: the 16 pads as two rows of cells, laid out like the hardware.
    `cells` by pad index: 0-7 bottom row, 8-15 top row; None = nothing drawn."""
    f = Frame()
    header(f, title, status)
    if note:
        f.text_fit(2, HEADER_H + 16, note, W - 4)
    else:
        cw, gap, ch, x0 = 14, 2, 19, 1
        rows = (HEADER_H + 3, HEADER_H + 3 + ch + 3)
        for i in range(16):
            c = cells[i] if i < len(cells) else None
            if c is None:
                continue
            x = x0 + (i % 8) * (cw + gap)
            y = rows[0 if i >= 8 else 1]
            if c.fill:
                f.fill_rect(x, y, cw, ch)
            elif c.dim:
                for k in range(0, cw, 2):
                    f.set(x + k, y)
                    f.set(x + k, y + ch - 1)
            else:
                f.rect(x, y, cw, ch)
            if c.dim and not c.fill:
                for k in range(0, ch, 2):
                    f.set(x, y + k)
                    f.set(x + cw - 1, y + k)
            tw = len(c.label) * 6 - 1
            f.text(x + (cw - tw) // 2, y + 4, c.label, 0 if c.fill else 1)
            if c.mark:
                f.hline(x + 3, x + cw - 4, y + ch - 4, 0 if c.fill else 1)
    footer(f, tag, info)
    return f


def browser_screen(track, target, folder, index, items):
    """Header: the track (and pad) things load onto, and the position in the folder. Footer: the folder.
    `items`: (label, is_folder) pairs."""
    f = Frame()
    pos = "%d/%d" % (index + 1, len(items)) if items else "0/0"
    header(f, track, "%s %s" % (target, pos) if target else pos)
    item_list(f, HEADER_H + 1, (H - HEADER_H - 1 - 9) // ROW_H, items, index)
    footer(f, "BROWSE", folder or "Top")
    return f


class EncoderCell(object):
    def __init__(self, name, value, level):
        self.name = name
        self.value = value
        self.level = level  # 0..1 position in the parameter's range


SHORT = {
    "Volume": "Vol", "Quantize": "Quant", "Repeat": "Rept", "Release": "Rel", "Attack": "Atk", "Cutoff": "Cut",
    "Resonance": "Reso", "Sample": "Smpl", "Preset": "Prst", "Detune": "Detn", "Filter": "Filt",
    "Track Volume": "Vol", "Track Panning": "Pan", "Song Tempo": "Tempo",
}


def short_name(name):
    """At most 5 characters: a known short form, or the name without spaces, cut."""
    return SHORT.get(name, re.sub(r"\s+", "", name))[:5]


SHORT_VALUES = {"Lowpass": "LP", "Highpass": "HP", "Bandpass": "BP"}


def short_value(v):
    """"2.51 kHz" -> "2.51k", "-6.0 dB" -> "-6.0", "Lowpass" -> "LP": values squeezed into 5 characters,
    a unit after a number dropped when it doesn't fit."""
    if v in SHORT_VALUES:
        return SHORT_VALUES[v]
    s = re.sub(r"\s+", "", v.replace(u"±", ""))
    s = re.sub(r"kHz$", "k", s)
    if len(s) > 5:
        s = re.sub(r"(?<=\d)[a-zA-Z%]+$", "", s)
    return s[:5]


def encoder_screen(title, status, tag, info, cells, active=None):
    """An encoder page as the 8 encoders: two rows of four, each with name, value and a level bar.
    `active`: the encoder being turned, drawn inverted."""
    f = Frame()
    header(f, title, status)
    row_y = (HEADER_H + 1, HEADER_H + 24)
    for i, c in enumerate(cells[:8]):
        if c is None:
            continue
        x = (i % 4) * 32 + 1
        y = row_y[0 if i < 4 else 1]
        f.text(x, y, short_name(c.name))
        f.text(x, y + 8, short_value(c.value))
        f.rect(x, y + 17, 29, 4)
        w = int(round(27 * max(0.0, min(1.0, c.level))))
        if w:
            f.fill_rect(x + 1, y + 18, w, 2)
        if i == active:
            f.invert(x - 1, y - 1, 31, 22)
    footer(f, tag, info)
    return f


def step_screen(track, status, item, bar, bars, steps, playhead, page_tag, page_info, per_row=8):
    """Step mode: top row = steps 1-8, bottom row = 9-16, like the pads (rows of 6 on a triplet grid)."""
    f = Frame()
    header(f, track, status)
    size, gap = 13, 3
    x0 = (W - (8 * size + 7 * gap)) // 2
    step_row(f, x0, 14, size, gap, steps[:per_row], playhead, 0)
    step_row(f, x0, 14 + size + 4, size, gap, steps[per_row: 2 * per_row], playhead, per_row)
    b = "B%s/%s" % (bar, bars)
    bw = text_width(b)
    f.text(W - 2 - bw, 46, b)
    f.text_fit(2, 46, item, W - 4 - bw - 6)
    footer(f, page_tag, page_info)
    return f


def shift_screen(rows, hint=""):
    """The shift map: six rows of "button: action" (button at most 6 characters, action at most 13)."""
    f = Frame()
    header(f, "SHIFT", hint)
    for r, (key, action) in enumerate(rows[:6]):
        y = HEADER_H + 1 + r * ROW_H
        f.text_fit(2, y, key, 40)
        f.text_fit(44, y, action, W - 44 - 2)
    return f
