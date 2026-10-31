from Morsel import protocol as P


def test_pad_notes_round_trip():
    for layout in ("drum", "daw"):
        for pad in range(16):
            assert P.pad_from_note(layout, P.note_for_pad(layout, pad)) == pad
    assert P.pad_from_note("drum", 60) == -1


def test_mpc_layout():
    assert P.note_for_pad("drum", 0) == 36  # bottom left
    assert P.note_for_pad("drum", 8) == 40  # top left
    assert P.note_for_pad("daw", 0) == 112
    assert P.note_for_pad("daw", 8) == 96


def test_led_messages():
    assert P.pad_led_message("drum", 0, 5) == (0x99, 36, 5)
    assert P.pad_led_message("daw", 8, 21, "pulse") == (0x92, 96, 21)
    assert P.button_led_message(51, 127) == (0xB3, 51, 127)
    # RGB, 8 bits per channel halved: table 2 (0x6_) for the drum-layout pads, table 0 (0x4_) for the DAW layout.
    assert P.pad_rgb_sysex("drum", 0, 0xFF8001) == (0xF0, 0, 0x20, 0x29, 2, 0x13, 1, 0x63, 36, 0x7F, 0x40, 0, 0xF7)
    assert P.pad_rgb_sysex("daw", 8, 0x020406)[7:12] == (0x43, 96, 1, 2, 3)


def test_display_sysex():
    assert P.display_config_sysex(0x20, 1) == (0xF0, 0, 0x20, 0x29, 2, 0x13, 4, 0x20, 1, 0xF7)
    assert P.display_text_sysex(0x23, 0, "Aé") == (0xF0, 0, 0x20, 0x29, 2, 0x13, 6, 0x23, 0, 0x41, 0x3F, 0xF7)
    assert P.keyboard_to_daw(True) == (0xB6, 76, 127) and P.keyboard_to_daw(False) == (0xB6, 76, 0)


def test_bitmap_framing_and_ack():
    msg = P.bitmap_sysex(0x20, bytes(1216))
    assert msg[:8] == P.SYSEX_HEADER + (0x09, 0x20)
    assert len(msg) == 1216 + 9 and msg[-1] == 0xF7
    assert P.is_bitmap_ack((0xF0, 0, 0x20, 0x29, 2, 0x13, 9, 0xF7))  # measured
    assert P.is_bitmap_ack((0xF0, 0, 0x20, 0x29, 2, 0x13, 9, 0x7F, 0xF7))  # the guide's form
    assert not P.is_bitmap_ack((0xF0, 0, 0x20, 0x29, 2, 0x13, 4, 0xF7))


def test_relative_delta():
    assert P.relative_delta(0x41) == 1
    assert P.relative_delta(0x3F) == -1
