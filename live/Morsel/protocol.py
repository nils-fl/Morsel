# Launchkey Mini MK4 DAW-mode protocol (Novation MK4 Programmer's Reference v2).
# Port of app/src/midi/protocol.ts: pure data + byte builders only, so it can be tested without Live.
# Channels in this file are 0-based (ch1 = 0). Messages are tuples, as Live's send_midi wants them.

SYSEX_HEADER = (0xF0, 0x00, 0x20, 0x29, 0x02, 0x13)

CH_DAW_PADS = 0  # ch1
CH_FEATURE = 6  # ch7
CH_DRUM = 9  # ch10
CH_BUTTON = 15  # ch16
CH_DAW = 15  # ch16 (note 12 = DAW mode)

CC_PAD_LAYOUT = 29  # ch7
CC_ENCODER_MODE = 30  # ch7
CC_ENCODER_RELATIVE = 69  # ch7
CC_DRUM_TO_DAW = 84  # ch7
CC_SHIFT = 63
CC_PLAY = 115
CC_RECORD = 117
CC_ENC_PAGE_UP = 51
CC_ENC_PAGE_DOWN = 52
CC_PAD_UP = 106
CC_PAD_DOWN = 107
CC_TRACK_PREV = 102  # measured: what Pad up sends while Shift is held ("< Track" on the device), ch1
CC_TRACK_NEXT = 103  # assumed: Shift + Pad down ("Track >"), not measured yet
CC_SCENE = 104
CC_FUNC = 105
CC_ENC_ABS_FIRST = 21  # 21..28 on ch16
CC_ENC_REL_FIRST = 85  # 85..92 on ch16

PAD_LAYOUT = {"drum": 1, "daw": 2}

BUTTON_BY_CC = {
    CC_SHIFT: "shift",
    CC_PLAY: "play",
    CC_RECORD: "record",
    CC_ENC_PAGE_UP: "encPageUp",
    CC_ENC_PAGE_DOWN: "encPageDown",
    CC_PAD_UP: "padUp",
    CC_PAD_DOWN: "padDown",
    CC_TRACK_PREV: "trackPrev",
    CC_TRACK_NEXT: "trackNext",
    CC_SCENE: "scene",
    CC_FUNC: "func",
}

# Pad index 0..15, MPC style: 0..7 = bottom row left->right, 8..15 = top row.
DRUM_NOTES = (36, 37, 38, 39, 44, 45, 46, 47, 40, 41, 42, 43, 48, 49, 50, 51)
DAW_NOTES = tuple(range(112, 120)) + tuple(range(96, 104))


def _notes(layout):
    return DRUM_NOTES if layout == "drum" else DAW_NOTES


def pad_from_note(layout, note):
    notes = _notes(layout)
    return notes.index(note) if note in notes else -1


def note_for_pad(layout, pad):
    return _notes(layout)[pad]


LED_CH_OFFSET = {"static": 0, "flash": 1, "pulse": 2}


def pad_led_message(layout, pad, color, mode="static"):
    base = CH_DRUM if layout == "drum" else CH_DAW_PADS
    return (0x90 | (base + LED_CH_OFFSET[mode]), note_for_pad(layout, pad), color & 0x7F)


def button_led_message(cc, brightness):
    """Monochrome button LEDs: CC on ch4, value = brightness."""
    return (0xB3, cc, brightness & 0x7F)


def pad_rgb_sysex(layout, pad, r, g, b):
    return SYSEX_HEADER + (0x01, 0x43, note_for_pad(layout, pad), r & 0x7F, g & 0x7F, b & 0x7F, 0xF7)


DAW_MODE_ON = (0x9F, 0x0C, 0x7F)
DAW_MODE_OFF = (0x9F, 0x0C, 0x00)


def cc7(cc, v):
    return (0xB0 | CH_FEATURE, cc, v & 0x7F)


# Display. Targets: 0x15..0x1C encoders, 0x20 stationary, 0x21 global temporary.
DISPLAY_STATIONARY = 0x20
DISPLAY_TEMPORARY = 0x21


def display_encoder(i):
    return 0x15 + i


def display_config_sysex(target, config):
    return SYSEX_HEADER + (0x04, target, config & 0x7F, 0xF7)


ARRANGEMENT_NAME_VALUE = 1
ARRANGEMENT_TITLE_NAME_VALUE = 2
ARRANGEMENT_TITLE_ENCODERS = 3
ARRANGEMENT_NUMERIC = 4

FEATURE_CC_BRIGHTNESS = 0x70
FEATURE_CC_TEMP_TIMEOUT = 0x71


def display_text_sysex(target, field, text):
    out = []
    for ch in text[:16]:
        c = ord(ch)
        out.append(c if 0x20 <= c <= 0x7E or 0x1B <= c <= 0x1E else 0x3F)  # '?'
    return SYSEX_HEADER + (0x06, target, field & 0x7F) + tuple(out) + (0xF7,)


def bitmap_sysex(target, packed):
    """Bitmap: 64 rows x 19 bytes (7 px/byte). Target 0x20 stationary or 0x21 temporary."""
    return SYSEX_HEADER + (0x09, target) + tuple(b & 0x7F for b in packed) + (0xF7,)


def is_bitmap_ack(data):
    """Measured on a Mini MK4 25: F0 00 20 29 02 13 09 F7. Accept the guide's "09 7F F7" too."""
    head = SYSEX_HEADER + (0x09,)
    data = tuple(data)
    if data[: len(head)] != head:
        return False
    rest = data[len(head):]
    return rest == (0xF7,) or rest == (0x7F, 0xF7)


def relative_delta(value):
    """Relative encoder value -> signed delta (64 = no move)."""
    return value - 64


# A small palette subset (Novation palette indices).
COLOR = {
    "off": 0, "grey": 1, "white": 3, "red": 5, "orange": 9, "yellow": 13, "lime": 17, "green": 21,
    "mint": 29, "cyan": 37, "sky": 41, "blue": 45, "purple": 49, "magenta": 53, "pink": 57, "dimRed": 7,
    "dimGreen": 23, "dimBlue": 47, "dimWhite": 2,
}
