from fakes import FakeClip, FakeHost, FakeNote

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
    tap(c, "func")  # Play switches on release (held, Func erases)
    assert c.mode == "step"
    assert P.cc7(P.CC_PAD_LAYOUT, 2) in host.sent
    for mode in ("track", "mute", "pattern", "play"):
        tap(c, "func")
        assert c.mode == mode
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
    assert keys == ["PAD", "DEV0", "DEV1", "TRK", "MIX", "GLB"]
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
    host.song.tracks[0].clip_slots[0].clip = FakeClip()
    host.song.tracks[0].clip_slots[0].clip.is_playing = True
    for mode in ("play", "step", "track", "mute", "pattern"):
        c.set_mode(mode)
        host.t += 2
        c.tick()


def to_step(c):
    c.set_mode("step")
    assert c.layout == "daw" and c.page_key == "STEP"


def test_step_mode_adds_a_clip_and_toggles_steps():
    host, c = setup()
    to_step(c)
    song = host.song
    hit(c, 8)  # top left = step 1, selected pad (note 36)
    clip = song.tracks[0].clip_slots[0].clip
    assert clip is not None and clip.length == 4.0
    assert [(n.pitch, n.start_time, n.duration) for n in clip.notes] == [(36, 0.0, 0.25)]
    hit(c, 0)  # bottom left = step 9
    assert sorted(n.start_time for n in clip.notes) == [0.0, 2.0]
    assert c.step.steps()[:9] == [True] + [False] * 7 + [True]
    hit(c, 8)  # a lit step goes on release
    assert [n.start_time for n in clip.notes] == [2.0]


def test_step_mode_held_step_velocity_and_nudge():
    host, c = setup()
    to_step(c)
    pad(c, 9)  # step 2 (t = 0.25), held
    enc(c, 0, -5)
    enc(c, 1, 3)
    pad(c, 9, False)
    clip = host.song.tracks[0].clip_slots[0].clip
    (n,) = clip.notes  # edited, so the release didn't remove it
    assert n.velocity == 90 and abs(n.start_time - (0.25 + 3 / 96.0)) < 1e-9
    assert c.step.steps()[1]  # still its step
    hit(c, 9)  # the nudged note still belongs to step 2: removed
    assert clip.notes == []


def test_step_page_bars_double_grid():
    host, c = setup()
    to_step(c)
    hit(c, 8)
    clip = host.song.tracks[0].clip_slots[0].clip
    params = {p.name: i for i, p in enumerate(c.current_page().params) if p}
    enc(c, params["Double"], 1)
    assert clip.loop_end == 8.0 and len(clip.notes) == 2 and c.step.pages() == 2
    tap(c, "padDown")
    assert c.step.page == 1 and c.step.bar_label() == "2"
    host.t += 1
    enc(c, params["Grid"], 1)  # 1/32: half a bar per page
    assert c.step.span == 0.125 and c.step.pages() == 4 and c.step.bar_label() == "1.1"
    host.t += 1
    enc(c, params["Bars"], -1)
    assert clip.loop_end == 4.0


def test_step_triplet_rows_use_six_pads():
    host, c = setup()
    to_step(c)
    c.step.set_grid(2)  # 1/8T
    hit(c, 14)  # top row, 7th pad: unused on a triplet grid
    assert host.song.tracks[0].clip_slots[0].clip is None
    hit(c, 0)  # bottom left = step 7 (t = 6 * 1/3)
    (n,) = host.song.tracks[0].clip_slots[0].clip.notes
    assert abs(n.start_time - 2.0) < 1e-9


def test_step_mode_pad_choice_and_shift_scene_clears_only_that_pad():
    host, c = setup()
    to_step(c)
    hit(c, 8)
    params = {p.name: i for i, p in enumerate(c.current_page().params) if p}
    enc(c, params["Pad"], 1)  # pad 2 = note 37
    rack = host.song.tracks[0].devices[0]
    assert rack.view.selected_drum_pad.note == 37
    hit(c, 9)
    clip = host.song.tracks[0].clip_slots[0].clip
    assert sorted(n.pitch for n in clip.notes) == [36, 37]
    shift(c, True)
    tap(c, "scene")
    shift(c, False)
    assert [n.pitch for n in clip.notes] == [36]


def test_leaving_step_restores_the_page():
    host, c = setup()
    tap(c, "encPageDown")
    before = c.page_key
    c.set_mode("step")
    c.set_mode("track")
    assert c.page_key == before


def test_pad_page_shows_the_selected_pads_instrument():
    host, c = setup()
    page = c.pages()[0]
    assert page.key == "PAD" and page.summary == "1 Pad 36" and page.params[0].name == "Simpler 1"


def test_erase_while_func_held():
    host, c = setup()
    song = host.song
    t = song.tracks[0]
    clip = FakeClip()
    clip.notes = [FakeNote(36, x, 0.25, 100) for x in (0.0, 1.0, 2.0, 3.0)] + [FakeNote(38, 1.0, 0.25, 100)]
    t.clip_slots[0].clip = clip
    t.playing_slot_index = 0
    song.is_playing = True
    clip.playing_position = 0.5
    press(c, "func")
    assert c.layout == "daw"  # pads come to the script while Func is held
    pad(c, 0)  # pad 1 = note 36
    clip.playing_position = 1.5
    c.tick()
    assert sorted(n.start_time for n in clip.notes if n.pitch == 36) == [0.0, 2.0, 3.0]
    clip.playing_position = 0.2  # looped round: the rest of the loop and its start
    c.tick()
    assert [n.pitch for n in clip.notes] == [38]  # only the held pad's note
    press(c, "func", False)  # used for erasing: no mode switch, the pads play again
    assert c.mode == "play" and c.layout == "drum" and not c.erasing


def test_func_in_play_keeps_the_daw_layout_the_device_confirms():
    host, c = setup()
    press(c, "func")
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 2))  # the device confirms DAW while the mode is still Play
    press(c, "func", False)
    assert c.mode == "step" and c.layout == "daw"
    assert P.cc7(P.CC_PAD_LAYOUT, 1) not in host.sent  # not switched back to drum


def test_keys_pick_the_step_pad_or_note():
    host, c = setup()
    c.on_key(44, 100, True)  # outside Step mode: just played
    rack = host.song.tracks[0].devices[0]
    assert rack.view.selected_drum_pad.note == 36
    c.set_mode("step")
    c.on_key(44, 100, True)  # the Drum Rack pad you hear: note 44 = Launchkey pad 5
    assert rack.view.selected_drum_pad.note == 44 and c.step.item() == "5 Pad 44"
    hit(c, 8)
    assert [n.pitch for n in host.song.tracks[0].clip_slots[0].clip.notes] == [44]
    c.on_key(62, 100, True)  # off the Launchkey's 16 pads: still that Drum Rack pad
    assert c.step.pitch() == 62 and c.step.item() == "D3 Pad 62"
    host.song.view.selected_track = host.song.tracks[1]  # a keys track: the key is the note
    c.on_key(67, 100, True)
    assert c.step.keys_note == 67


def test_keys_map_to_the_pads_on_drum_tracks():
    host, c = setup()
    assert host.keys_rebuilds == 1  # set up for the drum track selected at start
    km = c.key_map()
    assert km[48] == 36 and km[52] == 44 and km[56] == 40 and km[63] == 51 and km[64] == 36  # C3 = pad 1, wraps
    host.song.view.selected_track = host.song.tracks[1]  # a keys track: the keys pass as they are
    c.tick()
    assert c.key_map() is None and host.keys_rebuilds == 2
    c.tick()
    assert host.keys_rebuilds == 2  # only when it changes
