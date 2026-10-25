from Morsel.display import screens as S
from Morsel.display.widgets import HEADER_H, overlay_bar
from Morsel.colors import nearest_color
from Morsel import protocol as P


def test_short_names_and_values():
    assert S.short_name("Track Volume") == "Vol"
    assert S.short_name("Filter Freq") == "Filte"
    assert S.short_value("2.51 kHz") == "2.51k"
    assert S.short_value("-12.0 dB") == "-12.0"
    assert S.short_value("Lowpass") == "LP"


def test_grid_screen_draws_cells_like_the_pads():
    cells = [S.GridCell(str(i + 1), fill=i == 8) for i in range(16)]
    f = S.grid_screen("T1 Drums", "S1 STOP", cells, "TRACK", "info")
    top_left = (1, HEADER_H + 3)  # pad 9 (index 8): top row, filled
    assert f.get(*top_left) == 1 and f.get(top_left[0] + 6, top_left[1] + 1) == 1
    assert f.get(5, HEADER_H + 3 + 22 + 2) == 0  # pad 1: bottom row, outline only


def test_encoder_screen_inverts_the_active_cell():
    cells = [S.EncoderCell("Vol", "0.0 dB", 0.5)] + [None] * 7
    plain = S.encoder_screen("T1", "S1", "TRK", "Drums", cells)
    active = S.encoder_screen("T1", "S1", "TRK", "Drums", cells, active=0)
    assert plain.get(0, HEADER_H) == 0 and active.get(0, HEADER_H) == 1


def test_overlay_bar_wraps_to_two_lines():
    f = S.shift_screen([("Play", "Metronome")])
    assert overlay_bar(f, "Short", "1") == ("Short", "1")
    name, value = overlay_bar(f, "A rather long name here", "and a long value")
    assert name.startswith("A rather") and value.startswith("and a")


def test_colors():
    assert nearest_color(0xFF0000) == P.COLOR["red"]
    assert nearest_color(0x00FF00) == P.COLOR["green"]
    assert nearest_color(0x808080) == P.COLOR["white"]
