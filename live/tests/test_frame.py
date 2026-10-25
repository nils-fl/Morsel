from Morsel.display.fonts import font5x7
from Morsel.display.frame import PACKED_SIZE, Frame, fit_text


def test_pack_size_and_7bit():
    f = Frame()
    f.fill_rect(0, 0, 128, 64)
    p = f.pack()
    assert len(p) == PACKED_SIZE
    assert all(b < 0x80 for b in p)
    assert p[18] == 0b1100000  # last byte: only 2 real pixels (126, 127)


def test_pixel_positions():
    f = Frame()
    f.set(0, 0)
    f.set(127, 5)
    p = f.pack()
    assert p[0] == 1 << 6
    assert p[5 * 19 + 18] == 1 << (6 - (127 % 7))


def test_font():
    for c in range(32, 127):
        assert len(font5x7.glyph(c)) == 5
    assert font5x7.glyph(65) == [0x7E, 0x11, 0x11, 0x11, 0x7E]  # 'A'


def test_fit_text():
    assert fit_text("Hello", 29) == "Hello"
    assert fit_text("Hello world", 29) == "Hell~"
