# Port of the parts of app/src/display/widgets.ts that Live can fill (no waveform, filter or duck curves yet).
from .frame import H, W, text_width

ROW_H = 9
HEADER_H = 9


def header(f, left, right=""):
    """Inverted bar: left text, right-aligned text. Returns the left text as drawn (cut with "~" when it didn't fit)."""
    f.fill_rect(0, 0, W, HEADER_H)
    rw = text_width(right) if right else 0
    if right:
        f.text(W - 2 - rw, 1, right, 0)
    return f.text_fit(2, 1, left, W - 4 - (rw + 6 if right else 0), 0)


def scroll_top(cursor, rows):
    """Index shown on the first row: the cursor always sits on the middle row. Without a cursor (-1), from the top."""
    return 0 if cursor < 0 else cursor - rows // 2


def item_list(f, y0, rows, items, cursor):
    """Rows of labels with the cursor row inverted; items are (label, is_folder) pairs."""
    top = scroll_top(cursor, rows)
    scroll = len(items) > rows
    width = W - (4 if scroll else 0)
    for r in range(rows):
        i = top + r
        if i >= len(items):
            break
        if i < 0:
            continue
        label, folder = items[i]
        y = y0 + r * ROW_H
        sel = i == cursor
        if sel:
            f.fill_rect(0, y, width, ROW_H)
        on = 0 if sel else 1
        x = 2
        if folder:
            f.hline(x, x + 2, y + 1, on)
            f.rect(x, y + 2, 7, 5, on)
            x += 10
        f.text_fit(x, y + 1, label, width - x - 1, on)
    if scroll:
        h = rows * ROW_H
        thumb = max(4, int(round(float(h * rows) / len(items))))
        pos = int(round(float((h - thumb) * max(0, cursor)) / (len(items) - 1)))
        f.vline(W - 2, y0, y0 + h - 1)
        f.fill_rect(W - 3, y0 + pos, 3, thumb)
    if not items:
        f.text(2, y0 + 1, "(empty)")


def meter(f, x, y, w, h, value):
    f.rect(x, y, w, h)
    f.fill_rect(x + 1, y + 1, int(round((w - 2) * max(0.0, min(1.0, value)))), h - 2)


def step_row(f, x, y, size, gap, steps, playhead, offset=0):
    """A row of step boxes: filled = on, inverted outline = playhead."""
    for i, on in enumerate(steps):
        bx = x + i * (size + gap)
        if on:
            f.fill_rect(bx, y, size, size)
        else:
            f.rect(bx, y, size, size)
        if offset + i == playhead:
            f.rect(bx - 1, y - 1, size + 2, size + 2)
            f.invert(bx + 2, y + 2, size - 4, size - 4)


def footer(f, tag, text):
    """Bottom line: inverted tag box (e.g. the encoder page), then text. Returns the text as drawn."""
    y = H - 9
    tw = text_width(tag) + 4
    f.fill_rect(0, y, tw, 9)
    f.text(2, y + 1, tag, 0)
    return f.text_fit(tw + 3, y + 1, text, W - tw - 3)


def overlay_bar(f, name, value):
    """
    Inverted message bar along the bottom: name on the left, value right-aligned. When the two don't fit one line,
    the bar grows to two lines (name, then value) so instructions are never cut. Returns the two strings as drawn.
    """
    if not value or text_width(name) + 6 + text_width(value) <= W - 4:
        y = H - 10
        f.fill_rect(0, y, W, 10)
        vw = text_width(value) if value else 0
        if value:
            f.text(W - 2 - vw, y + 2, value, 0)
        return f.text_fit(2, y + 2, name, W - 4 - (vw + 6 if value else 0), 0), value
    y = H - 19
    f.fill_rect(0, y, W, 19)
    return f.text_fit(2, y + 2, name, W - 4, 0), f.text_fit(2, y + 11, value, W - 4, 0)
