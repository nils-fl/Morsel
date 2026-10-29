# The Launchkey's own Scale mode and Live 12's song scale, kept in step (as Live's Launchkey_MK4 script does,
# scale.py there; disassembled 2026-10-26). The device knows a scale by its position in its firmware's list of 30
# scales, counted from 1 (0 is no scale: SCALE_NAMES = [None] + ... there); Live by name. Matched by intervals.

FIRMWARE_SCALES = (
    (0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10), (0, 2, 3, 5, 7, 9, 10), (0, 2, 4, 5, 7, 9, 10),
    (0, 2, 4, 6, 7, 9, 11), (0, 1, 3, 5, 7, 8, 10), (0, 1, 3, 5, 6, 8, 10), (0, 2, 4, 6, 8, 10),
    (0, 1, 3, 4, 6, 7, 9, 10), (0, 2, 3, 5, 6, 8, 9, 11), (0, 3, 5, 6, 7, 10), (0, 3, 5, 7, 10), (0, 2, 4, 7, 9),
    (0, 2, 3, 5, 7, 8, 11), (0, 2, 4, 5, 7, 8, 11), (0, 2, 3, 6, 7, 9, 10), (0, 1, 4, 5, 7, 8, 10),
    (0, 2, 3, 5, 7, 9, 11), (0, 2, 4, 6, 8, 9, 11), (0, 2, 4, 6, 7, 9, 10), (0, 1, 3, 4, 6, 8, 10),
    (0, 1, 3, 4, 5, 6, 8, 10), (0, 1, 4, 5, 7, 8, 11), (0, 2, 3, 6, 7, 8, 11), (0, 2, 3, 7, 8), (0, 1, 5, 7, 10),
    (0, 1, 5, 6, 10), (0, 2, 3, 7, 9), (0, 1, 3, 7, 8), (0, 1, 5, 7, 8),
)

# Device CCs on ch7. The stock script sends each value on both numbers and reads either.
CC_ROOT = (61, 81)
CC_SCALE = (62, 80)

ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def scale_names(all_scales):
    """Live's name for each device scale value (None for 0, and where Live has none). `all_scales`: Live's
    (name, intervals) list."""
    by_intervals = {tuple(intervals): name for name, intervals in all_scales}
    return [None] + [by_intervals.get(intervals) for intervals in FIRMWARE_SCALES]


def device_index(names, scale_name):
    """The device's index for a Live scale name, or None when the device doesn't have it."""
    return names.index(scale_name) if scale_name in names else None


def label(root, scale_name):
    return "%s %s" % (ROOT_NAMES[root % 12], scale_name)
