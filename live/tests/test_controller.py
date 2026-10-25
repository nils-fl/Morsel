from fakes import FakeClip, FakeHost

from Morsel import protocol as P
from Morsel.controller import Controller


def setup(**kw):
    host = FakeHost(**kw)
    c = Controller(host)
    c.connect()
    c.tick()
    host.sent.clear()
    return host, c


def press(c, button, down=True):
    cc = {v: k for k, v in P.BUTTON_BY_CC.items()}[button]
    c.handle_midi((0xB0, cc, 0x7F if down else 0))


def tap(c, button):
    press(c, button)
    press(c, button, False)


def pad(c, i, down=True):
    c.handle_midi((0x90 if down else 0x80, P.note_for_pad("daw", i), 100 if down else 0))


def hit(c, i):
    pad(c, i)
    pad(c, i, False)


def shift(c, down):
    c.handle_midi((0xB6, P.CC_SHIFT, 0x7F if down else 0))


def enc(c, i, delta):
    c.handle_midi((0xBF, P.CC_ENC_REL_FIRST + i, 64 + delta))


def test_connect_enters_daw_mode():
    host = FakeHost()
    Controller(host).connect()
    assert host.sent[0] == P.DAW_MODE_ON
    assert P.cc7(P.CC_PAD_LAYOUT, 1) in host.sent


def test_func_cycles_modes_and_switches_layout():
    host, c = setup()
    tap(c, "func")  # Play switches on release (held, Func will erase)
    assert c.mode == "track"
    assert P.cc7(P.CC_PAD_LAYOUT, 2) in host.sent
    assert host.rebuilds == 1
    tap(c, "func")
    tap(c, "func")
    tap(c, "func")
    assert c.mode == "play"
    assert host.sent[-1] != P.cc7(P.CC_PAD_LAYOUT, 2)


def test_track_mode_select_mute_solo():
    host, c = setup()
    c.set_mode("track")
    song = host.song
    hit(c, 9)  # top row, second pad = track 2
    assert song.view.selected_track is song.tracks[1]
    hit(c, 0)  # bottom row = mute track 1
    assert song.tracks[0].mute
    host.t += 1
    hit(c, 1)
    host.t += 0.1
    hit(c, 1)  # double-tap = solo, the second tap undoes the first's mute
    assert song.tracks[1].solo and not song.tracks[1].mute


def test_auto_arm_follows_selection():
    host, c = setup()
    song = host.song
    assert song.tracks[0].implicit_arm
    song.view.selected_track = song.tracks[1]
    c.tick()
    assert song.tracks[1].implicit_arm and not song.tracks[0].implicit_arm


def test_add_track_takes_two_taps():
    host, c = setup()
    c.set_mode("track")
    hit(c, 10)  # the next free slot (2 tracks)
    assert len(host.song.tracks) == 2 and c.new_track == "drum"
    enc(c, 0, 1)
    assert c.new_track == "keys"
    hit(c, 10)
    assert len(host.song.tracks) == 3 and host.loaded == ["keys"]
    assert host.song.view.selected_track is host.song.tracks[2]


def test_pattern_select_vs_fire():
    host, c = setup()
    c.set_mode("pattern")
    song = host.song
    hit(c, 2)
    assert song.view.selected_scene is song.scenes[2] and song.scenes[2].fired == 0
    song.is_playing = True
    hit(c, 3)
    assert song.scenes[3].fired == 1


def test_pattern_copy_scene_and_clip():
    host, c = setup()
    c.set_mode("pattern")
    song = host.song
    song.tracks[0].clip_slots[0].clip = FakeClip()
    pad(c, 0)
    hit(c, 1)
    pad(c, 0, False)
    assert song.tracks[0].clip_slots[1].has_clip
    # Scene held: only the selected track's clip.
    song.tracks[1].clip_slots[0].clip = FakeClip()
    song.view.selected_track = song.tracks[1]
    press(c, "scene")
    pad(c, 0)
    hit(c, 2)
    pad(c, 0, False)
    press(c, "scene", False)
    assert song.tracks[1].clip_slots[2].has_clip and not song.tracks[0].clip_slots[2].has_clip


def test_mute_mode_drum_pads():
    host, c = setup()
    c.set_mode("mute")
    rack = host.song.tracks[0].devices[0]
    hit(c, 0)
    assert rack.drum_pads[36].mute
    leds = c.pad_leds()
    assert leds[0][0] == P.COLOR["dimRed"] and leds[1][0] == P.COLOR["green"] and leds[15][0] == P.COLOR["dimGreen"]


def test_note_repeat_hold_and_latch():
    host, c = setup()
    nr = host.note_repeat
    press(c, "scene")
    assert nr.enabled and nr.repeat_rate == 0.25
    press(c, "scene", False)
    assert not nr.enabled
    host.t += 0.1
    tap(c, "scene")  # second press soon after: latched
    assert nr.enabled and c.repeat_latch
    host.t += 1
    tap(c, "scene")  # a press while latched lets go
    assert not nr.enabled


def test_encoder_pages_and_stepped_params():
    host, c = setup()
    song = host.song
    keys = [p.key for p in c.pages()]
    assert keys == ["DEV0", "DEV1", "TRK", "MIX", "GLB"]
    tap(c, "encPageDown")
    assert c.page_key == "DEV1" and song.tracks[0].view.selected_device is song.tracks[0].devices[1]
    for _ in range(3):
        tap(c, "encPageDown")
    assert c.page_key == "GLB"
    tap(c, "encPageDown")  # no wrap
    assert c.page_key == "GLB"
    enc(c, 0, 2)
    assert song.tempo == 122.0
    # Repeat rate: the first detent of a fresh turn steps, then every 4th.
    enc(c, 3, 1)
    assert c.repeat == [2]
    enc(c, 3, 1)
    enc(c, 3, 1)
    assert c.repeat == [2]
    enc(c, 3, 1)
    enc(c, 3, 1)
    assert c.repeat == [3]


def test_device_page_follows_blue_hand():
    host, c = setup()
    t = host.song.tracks[0]
    t.view.selected_device = t.devices[1]
    c.tick()
    assert c.page_key == "DEV1"


def test_layout_reports():
    host, c = setup()
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 15))  # how the device confirms drum under Live
    assert P.cc7(P.CC_PAD_LAYOUT, 1) not in host.sent
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 2))
    assert host.sent.count(P.cc7(P.CC_PAD_LAYOUT, 1)) == 1
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 2))  # at most once a second
    assert host.sent.count(P.cc7(P.CC_PAD_LAYOUT, 1)) == 1
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 7))  # the device's own pad mode: leave it
    assert c.native_pads == 7


def test_shift_buttons():
    host, c = setup()
    song = host.song
    shift(c, True)
    tap(c, "func")
    assert song.undos == 1
    tap(c, "play")
    assert song.metronome
    c.handle_midi((0xB0, P.CC_TRACK_NEXT, 0x7F))
    assert song.view.selected_track is song.tracks[1]
    song.tracks[1].clip_slots[0].clip = FakeClip()
    tap(c, "scene")
    assert song.tracks[1].clip_slots[0].clip.removed
    shift(c, False)


def test_tick_draws_screen_and_shift_map():
    host, c = setup()
    c.handle_midi(P.SYSEX_HEADER + (0x09, 0xF7))  # the first frame's ack
    host.song.tempo = 99.0  # the screen changes, so a new frame goes
    c.set_page(c.pages()[-1])
    c.tick()
    bitmaps = [m for m in host.sent if m[:8] == P.SYSEX_HEADER + (0x09, P.DISPLAY_STATIONARY)]
    assert len(bitmaps) == 1 and len(bitmaps[0]) == 1225
    shift(c, True)
    c.handle_midi(P.SYSEX_HEADER + (0x09, 0xF7))  # ack
    c.tick()
    assert any(m[:8] == P.SYSEX_HEADER + (0x09, P.DISPLAY_TEMPORARY) for m in host.sent)
    shift(c, False)
    assert P.display_config_sysex(P.DISPLAY_TEMPORARY, 0) in host.sent


def test_play_fires_selected_scene_with_clips():
    host, c = setup()
    song = host.song
    tap(c, "play")
    assert song.is_playing and song.scenes[0].fired == 0  # no clips: just the transport
    tap(c, "play")
    assert not song.is_playing
    song.tracks[0].clip_slots[0].clip = FakeClip()
    tap(c, "play")
    assert song.scenes[0].fired == 1


def test_every_mode_renders():
    host, c = setup()
    for mode in ("play", "track", "mute", "pattern"):
        c.set_mode(mode)
        host.t += 2
        c.tick()
