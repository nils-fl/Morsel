from fakes import FakeClip, FakeDevice, FakeHost, FakeNote, FakePlugin, FakeTrack, Obj, Wrap, WrappingView

from Morsel import protocol as P
from Morsel.colors import nearest_color
from Morsel import browse as BROWSE
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
    for mode in ("track", "clips", "play"):
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
    # The Drum Rack's 8 macros are one bank; Reverb has 11 parameters: its best 8, then the other 3.
    assert keys == ["PAD", "DEV0.0", "DEV1.0", "DEV1.1", "TRK", "MIX", "GLB", "POS"]
    tap(c, "encPageDown")
    assert c.page_key == "DEV1.0" and song.tracks[0].view.selected_device is song.tracks[0].devices[1]
    tap(c, "encPageDown")
    assert c.page_key == "DEV1.1" and c.current_page().summary == "Reverb 2/2" and c.current_page().tag == "REVER2"
    for _ in range(3):
        tap(c, "encPageDown")
    assert c.page_key == "GLB"
    tap(c, "encPageDown")
    tap(c, "encPageDown")  # no wrap past POS
    assert c.page_key == "POS"
    tap(c, "encPageUp")
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
    assert c.page_key == "DEV1.0"


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


def test_tick_draws_the_screen():
    host, c = setup()
    c.handle_midi(P.SYSEX_HEADER + (0x09, 0xF7))  # the first frame's ack
    host.song.tempo = 99.0  # the screen changes, so a new frame goes
    c.set_page(c.pages()[-1])
    c.tick()
    bitmaps = [m for m in host.sent if m[:8] == P.SYSEX_HEADER + (0x09, P.DISPLAY_STATIONARY)]
    assert len(bitmaps) == 1 and len(bitmaps[0]) == 1225


def test_every_mode_renders():
    host, c = setup()
    host.song.tracks[0].clip_slots[0].clip = FakeClip()
    host.song.tracks[0].clip_slots[0].clip.is_playing = True
    for mode in ("play", "step", "track", "clips"):
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


def scroll(c, entries, index=0):
    """Turn a Browse encoder slowly by `entries` (BROWSE.UNITS_PER_ENTRY messages each)."""
    for _ in range(abs(entries) * BROWSE.UNITS_PER_ENTRY):
        enc(c, index, 1 if entries > 0 else -1)


def to_browse(c):
    shift(c, True)
    tap(c, "encPageUp")
    shift(c, False)
    assert c.mode == "browse" and c.layout == "daw"


def test_browse_opens_and_closes_back_to_the_mode_before():
    host, c = setup()
    c.set_mode("step")
    to_browse(c)
    labels = [e[0] for e in c.browse.entries()]
    assert labels == ["Drums", "Instruments", "Samples"]  # Live's categories, missing ones left out
    shift(c, True)
    tap(c, "encPageUp")
    shift(c, False)
    assert c.mode == "step"


def test_browse_navigates_previews_and_loads_onto_the_pad():
    host, c = setup()
    b = host.browser
    to_browse(c)
    scroll(c, 2)  # Samples
    tap(c, "func")  # open
    assert c.browse.folder_label() == "Samples"
    tap(c, "encPageDown")
    host.t += 1
    c.tick()
    assert b.previews == ["Clap.wav"]  # previewed after a moment
    hit(c, 4)  # pad 5 (note 44): picks that pad and previews again
    rack = host.song.tracks[0].devices[0]
    assert rack.view.selected_drum_pad.note == 44 and b.previews[-1] == "Clap.wav"
    tap(c, "func")  # load onto the selected pad, stay in Browse
    assert b.loaded == [("Clap.wav", rack.drum_pads[44])]
    assert b.hotswap_target is rack.drum_pads[44]  # kept while browsing, as Push does
    assert c.mode == "browse" and c.overlay[0] == "LOADED > PAD 5"
    assert "Detail/DeviceChain" in host.views
    tap(c, "scene")  # up a folder: the cursor goes back to Samples
    assert c.browse.folder_label() == "Top" and c.browse.index == 2


def test_browse_kit_replaces_the_rack_and_letters_jump():
    host, c = setup()
    b = host.browser
    to_browse(c)
    tap(c, "func")  # Drums
    tap(c, "func")  # 808 Core: onto the track, replacing the whole Drum Rack (Live won't hot-swap a rack)
    assert b.loaded == [("808 Core", None)] and c.overlay[0] == "KIT LOADED"
    assert host.song.tracks[0].devices[0].name == "808 Core"
    tap(c, "scene")
    scroll(c, 2, 7)
    tap(c, "func")  # Samples
    tap(c, "func")  # Kicks
    enc(c, 1, 1)  # next letter: nothing after K, stays
    assert c.browse.index == 0
    enc(c, 0, 9)  # clamped to 3 a turn
    assert c.browse.index == 3


def test_browse_shift_func_folder_to_pads_and_load_and_exit():
    host, c = setup()
    b = host.browser
    rack = host.song.tracks[0].devices[0]
    to_browse(c)
    scroll(c, 2)
    tap(c, "func")  # Samples; Kicks is highlighted
    shift(c, True)
    tap(c, "func")  # the folder's first 16 samples onto pads 1-16, and leave
    shift(c, False)
    assert len(b.loaded) == 16 and b.loaded[4] == ("Kick 5.wav", rack.drum_pads[44])
    assert c.mode == "play" and c.overlay[0] == "FOLDER > PADS 1-16"


def test_browse_on_a_keys_track_opens_the_instruments_presets():
    host, c = setup()
    b = host.browser
    track = host.song.tracks[1]
    host.song.view.selected_track = track
    track.devices[0].name = "Wobble"  # Drift with the Wobble preset
    to_browse(c)
    assert c.browse.folder_label() == "Drift"
    assert [e[0] for e in c.browse.entries()] == ["Sub Bass", "Wobble", "Warm Pad", "Pad Rack"]  # one list
    assert c.browse.index == 1  # on the loaded one
    host.t += 1
    c.tick()
    assert b.loaded == []  # opening loads nothing
    scroll(c, 1)  # Warm Pad
    c.tick()
    assert b.loaded == []  # not while the cursor moves
    host.t += 0.4
    c.tick()
    assert b.loaded[0][0] == "Warm Pad.adv" and track.devices[0].name == "Warm Pad"  # Drift replaced
    scroll(c, 1)  # a rack preset: it replaces the instrument too
    host.t += 0.4
    c.tick()
    assert track.devices[0].name == "Pad Rack" and len(track.devices) == 1
    scroll(c, -3)  # Sub Bass, and a key before the cursor rests: the rack is replaced as well
    c.handle_midi((0x98, 60, 100))
    assert b.loaded[-1][0] == "Sub Bass.adv" and track.devices[0].name == "Sub Bass"
    tap(c, "scene")  # up: all instruments
    assert c.browse.folder_label() == "Instruments"


def test_browse_on_a_keys_track_without_presets_opens_where_it_was():
    host, c = setup()
    track = host.song.tracks[1]
    host.song.view.selected_track = track
    track.devices[0].class_display_name = "Some Plugin"
    to_browse(c)
    assert c.browse.folder_label() == "Top"


def test_browse_renders():
    host, c = setup()
    to_browse(c)
    host.t += 1
    c.tick()
    assert c.button_leds()[P.CC_SCENE] == 0  # nothing to go up to at the top


def test_browse_targets_the_pad_until_it_closes():
    host, c = setup()
    b = host.browser
    rack = host.song.tracks[0].devices[0]
    to_browse(c)
    assert b.hotswap_target is rack.drum_pads[36]  # the selected pad, from the start
    rack.view.selected_drum_pad = rack.drum_pads[37]  # picked in Live
    c.tick()
    assert b.hotswap_target is rack.drum_pads[37]
    shift(c, True)
    tap(c, "encPageUp")
    shift(c, False)
    assert b.hotswap_target is None


def test_play_is_lives_play_and_stop():
    host, c = setup()
    song = host.song
    song.tracks[0].clip_slots[0].clip = FakeClip()
    tap(c, "play")
    assert song.is_playing and song.scenes[0].fired == 0  # no scene launch
    tap(c, "play")
    assert not song.is_playing


def test_clips_mode_launches_clips_scenes_and_stops_tracks():
    host, c = setup()
    song = host.song
    c.set_mode("clips")
    assert c.layout == "daw"
    hit(c, 9)  # top row, track 2, the selected scene (1)
    assert song.tracks[1].clip_slots[0].fired == 1
    hit(c, 0)  # bottom row, track 1, the next scene
    assert song.tracks[0].clip_slots[1].fired == 1
    press(c, "scene")
    hit(c, 3)  # Scene + bottom row: launch scene 2
    press(c, "scene", False)
    assert song.scenes[1].fired == 1
    press(c, "func")
    hit(c, 8)  # Func + pad: stop track 1, and Func doesn't switch modes
    press(c, "func", False)
    assert song.tracks[0].stopped == 1 and c.mode == "clips"
    tap(c, "func")  # Func alone: next mode on release
    assert c.mode == "play"


def test_clips_mode_scrolls_scenes_and_lights_slots():
    host, c = setup()
    song = host.song
    c.set_mode("clips")
    tap(c, "padDown")
    assert song.view.selected_scene is song.scenes[1] and song.scenes[1].fired == 0  # scrolls, doesn't launch
    slot = song.tracks[0].clip_slots[1]
    slot.clip = FakeClip()
    slot.is_playing = True
    leds = c.pad_leds()
    assert leds[8] == (("rgb", 0xFF3B3B), "pulse")  # playing: its colour, pulsing
    song.tracks[1].implicit_arm = True
    assert leds[9][1] == "static"
    assert c.pad_leds()[9] == (P.COLOR["dimRed"], "static")  # an empty slot on an armed track


def test_pads_get_lives_colours_from_the_palette():
    host, c = setup()
    c.set_mode("track")
    host.t += 1
    c.tick()
    assert not [m for m in host.sent if m[:8] == P.SYSEX_HEADER + (0x01, 0x43)]  # no RGB SysEx: it doesn't light
    assert P.pad_led_message("daw", 9, nearest_color(0x3B5BFF)) in host.sent  # track 2 (static)
    assert P.pad_led_message("daw", 8, P.COLOR["blue"], "pulse") in host.sent  # the selected track pulses


def test_held_step_length_and_quantize():
    host, c = setup()
    to_step(c)
    pad(c, 8)
    enc(c, 2, 6)  # encoder 3: length, a tick per detent
    pad(c, 8, False)
    clip = host.song.tracks[0].clip_slots[0].clip
    (n,) = clip.notes
    assert abs(n.duration - (0.25 + 6 / 96.0)) < 1e-9 and c.overlay[:2] == ("Length", "30")
    params = {p.name: i for i, p in enumerate(c.current_page().params) if p}
    assert "Page" not in params  # Pad up / down does that
    enc(c, params["Quant"], 1)
    assert clip.quantized == ("sixtenth", 1.0)


def test_glb_has_groove_not_swing_or_metro():
    host, c = setup()
    names = [p.name for p in c.pages()[-2].params if p]
    assert names == ["Tempo", "Groove", "RecQ", "Rept", "Launch"]
    c.set_page(c.pages()[-2])
    enc(c, 1, -10)
    assert abs(host.song.groove_amount - 0.9) < 1e-9 and c.overlay[1] == "90%"


def test_pos_page_moves_loops_jumps_and_zooms():
    host, c = setup()
    song = host.song
    c.set_page(c.pages()[-1])
    enc(c, 0, 2)  # two bars on
    assert song.current_song_time == 8.0 and c.overlay[1] == "3.1"
    enc(c, 1, 1)
    assert song.loop
    host.t += 1
    enc(c, 3, 1)  # loop a bar longer
    assert song.loop_length == 20.0
    host.t += 1
    enc(c, 4, 1)  # next marker
    assert song.current_song_time == 32.0 and c.overlay[1] == "Drop"
    host.t += 1
    enc(c, 6, 1)
    host.t += 1
    enc(c, 7, -1)
    assert host.zooms == [(1, True), (-1, False)]


def test_keys_on_the_daw_port_pick_the_step_pad():
    host, c = setup()
    to_step(c)
    c.handle_midi((0x99, 44, 100))  # a key mapped to pad 5 arrives on ch10
    assert host.song.tracks[0].devices[0].view.selected_drum_pad.note == 44
    host.song.view.selected_track = host.song.tracks[1]
    c.handle_midi((0x98, 67, 100))  # keys track: ch9, as played
    assert c.step.keys_note == 67


def test_scale_follows_both_ways():
    host, c = setup()
    song = host.song
    song.root_note, song.scale_name = 9, "Minor"
    host.sent.clear()
    c.tick()
    assert P.cc7(61, 9) in host.sent and P.cc7(81, 9) in host.sent
    assert P.cc7(62, 2) in host.sent and P.cc7(80, 2) in host.sent and c.overlay[:2] == ("Scale", "A Minor")
    host.sent.clear()
    c.handle_midi(P.cc7(62, 3))  # picked on the Launchkey: Dorian (the device counts from 1: Major)
    c.handle_midi(P.cc7(81, 2))  # root D
    assert song.scale_name == "Dorian" and song.root_note == 2
    c.handle_midi(P.cc7(62, 0))  # 0: no scale on the device, nothing for Live
    assert song.scale_name == "Dorian"
    c.tick()
    assert not any(m[:2] == (0xB6, 61) for m in host.sent)  # not echoed back


def test_shift_map_on_the_main_screen():
    host, c = setup()
    c.handle_midi(P.SYSEX_HEADER + (0x09, 0xF7))
    shift(c, True)
    c.tick()
    assert any(m[:8] == P.SYSEX_HEADER + (0x09, P.DISPLAY_STATIONARY) for m in host.sent)  # and under the popup


def test_live_objects_compare_by_value_not_identity(monkeypatch):
    """Live returns a new wrapper on every read: the selected track stays armed instead of being re-armed every tick."""
    host, c = setup()
    song = host.song
    sets = []
    monkeypatch.setattr(FakeTrack, "implicit_arm", property(lambda t: t.__dict__.get("_arm", False),
                                                            lambda t, v: (sets.append(v), t.__dict__.update(_arm=v))),
                        raising=False)
    song.view = WrappingView(song.view)
    c.armed = None
    c.tick()
    c.tick()
    c.tick()
    assert sets == [True]  # armed once, not off / on every tick
    song.view.selected_track = song.tracks[1]
    c.tick()
    assert sets == [True, False, True]


def test_drums_kit_found_through_a_new_wrapper():
    host, c = setup()
    b = host.browser
    drums = b.drums
    type(b).drums = property(lambda self: Wrap(drums))  # a fresh wrapper on every read, as in Live
    try:
        to_browse(c)
        tap(c, "func")  # Drums
        tap(c, "func")  # 808 Core
        assert c.overlay[0] == "KIT LOADED"
    finally:
        del type(b).drums
        b.drums = drums


def test_static_rgb_after_a_pulse_stops_the_pulse_first(monkeypatch):
    monkeypatch.setattr("Morsel.controller.RGB_PADS", True)
    host, c = setup()
    c.set_mode("track")
    c.set_pad(3, ("rgb", 0x112233), "pulse")
    host.sent.clear()
    c.set_pad(3, ("rgb", 0x112233), "static")
    assert host.sent == [P.pad_led_message("daw", 3, 0), P.pad_rgb_sysex("daw", 3, 0x08, 0x11, 0x19)]


def test_scale_echo_shows_no_popup():
    host, c = setup()
    c.overlay = None
    c.handle_midi(P.cc7(61, host.song.root_note))
    c.handle_midi(P.cc7(80, 1))  # Major, as it is
    assert c.overlay is None


def test_drum_pads_in_the_track_colour_get_morsels_pad_colours():
    host, c = setup()
    t = host.song.tracks[0]
    rack = c.drum_rack(t)
    leds = c.pad_leds()
    assert leds[1] == (("rgb", 0xFF0000), "static")  # a chain with a colour of its own keeps it
    for n in (36, 37):
        rack.drum_pads[n].chains[0].color = t.color  # Live's default: the track's colour
    leds = c.pad_leds()
    assert leds[0] == (P.PAD_COLORS[0], "pulse") and leds[1] == (P.PAD_COLORS[1], "static")


def test_shift_map_covers_the_devices_own_overlay():
    host, c = setup()
    temp = P.SYSEX_HEADER + (0x09, P.DISPLAY_TEMPORARY)
    host.sent.clear()
    shift(c, True)  # no tick, a frame still waiting for its ack
    assert [m for m in host.sent if m[:8] == temp]  # the shift map goes to the temporary popup at once
    host.sent.clear()
    shift(c, False)
    assert P.display_config_sysex(P.DISPLAY_TEMPORARY, 0) in host.sent  # closed on release


def test_a_pad_mode_picked_with_shift_keeps_the_pads():
    host, c = setup()
    host.song.view.selected_track = host.song.tracks[1]  # a keys track
    c.tick()
    shift(c, True)
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 14))  # Shift + the Chord Map pad
    host.sent.clear()
    shift(c, False)
    assert c.native_pads == 14 and P.cc7(P.CC_PAD_LAYOUT, 1) not in host.sent  # Chord Map stays
    host.song.view.selected_track = host.song.tracks[0]  # a drum track takes the pads back
    c.tick()
    assert c.native_pads is None and P.cc7(P.CC_PAD_LAYOUT, 1) in host.sent


def test_shift_without_a_pick_puts_our_layout_back():
    host, c = setup()
    shift(c, True)
    c.handle_midi((0xB6, P.CC_PAD_LAYOUT, 2))  # the device's picker
    host.sent.clear()
    shift(c, False)
    assert c.native_pads is None and P.cc7(P.CC_PAD_LAYOUT, 1) in host.sent


def test_a_step_lights_as_it_is_pressed():
    host, c = setup()
    to_step(c)
    host.sent.clear()
    pad(c, 8)  # no tick in between
    assert any(m[0] & 0xF0 == 0x90 and m[1] == P.note_for_pad("daw", 8) and m[2] for m in host.sent)


def test_play_in_step_mode_launches_the_clip():
    host, c = setup()
    to_step(c)
    pad(c, 8)
    pad(c, 8, False)
    slot = host.song.tracks[0].clip_slots[0]
    press(c, "play")
    assert slot.fired == 1


def test_holding_a_step_shows_its_values_on_the_encoders():
    host, c = setup()
    to_step(c)
    pad(c, 8)
    cells = c.step.held_cells()
    assert [(x.name, x.value) for x in cells[:3]] == [("Velocity", "100"), ("Nudge", "0"), ("Length", "24")]
    assert cells[3:] == [None] * 5
    pad(c, 8, False)
    assert c.step.held_cells() is None


def test_browse_moves_one_entry_per_two_encoder_messages():
    host, c = setup()
    to_browse(c)
    scroll(c, 2)
    tap(c, "func")  # Samples
    tap(c, "func")  # Kicks: 20 samples
    enc(c, 0, 1)
    assert c.browse.folder_label() == "Kicks" and c.browse.index == 0  # half an entry
    enc(c, 0, 1)
    assert c.browse.index == 1
    enc(c, 0, 8)  # a quick turn: faster, at most 3
    assert c.browse.index == 4
    host.t += 1
    enc(c, 0, -1)
    enc(c, 0, -1)  # back one: the turn counts afresh
    assert c.browse.index == 3


def test_clips_rows_stay_when_live_selects_the_launched_scene():
    host, c = setup()
    song = host.song
    c.set_mode("clips")
    press(c, "scene")
    hit(c, 0)  # Scene + bottom row: launch scene 2
    press(c, "scene", False)
    song.view.selected_scene = song.scenes[1]  # Live's Select on Launch
    assert c.clips.slot_at(8)[1] == 0 and c.clips.info().startswith("S1-2")  # the rows stay
    tap(c, "padDown")
    assert c.clips.slot_at(8)[1] == 1  # Pad down moves them


def test_browse_switches_a_plugins_own_presets_at_once():
    host, c = setup()
    b = host.browser
    track = host.song.tracks[1]
    plugin = FakePlugin("Synth", ["Init", "Bass", "Lead", "Pad"])
    plugin.selected_preset_index = 2
    track.devices[0] = plugin
    host.song.view.selected_track = track
    to_browse(c)
    assert c.browse.folder_label() == "Synth" and [e[0] for e in c.browse.entries()] == ["Init", "Bass", "Lead", "Pad"]
    assert c.browse.index == 2  # on the selected one
    scroll(c, 1)
    assert plugin.selected_preset_index == 3  # at once, no rest
    host.t += 1
    c.tick()
    assert b.loaded == []  # nothing loaded through the browser
    tap(c, "func")
    assert c.overlay[:2] == ("PRESET", "Pad") and c.mode == "browse"


def test_browse_kits_load_as_the_cursor_rests_and_the_pads_play_them():
    host, c = setup()
    b = host.browser
    rack = host.song.tracks[0].devices[0]
    to_browse(c)
    tap(c, "func")  # Drums: its kits
    host.t += 1
    c.tick()
    assert b.loaded == [] and c.layout == "drum"  # arriving loads nothing; the pads play the kit
    assert c.pad_leds()[0] == (c.pad_color(host.song.tracks[0], rack.drum_pads[36]), "static")
    scroll(c, 1)  # 909 Core
    c.tick()
    assert b.loaded == []  # not while the cursor moves
    host.t += 0.35
    c.tick()
    assert b.loaded == [("909 Core", None)] and host.song.tracks[0].devices[0].name == "909 Core"  # the Rack
    scroll(c, -1)  # 808 Core, and a key before the cursor rests
    c.handle_midi((0x99, 36, 100))
    assert b.loaded[-1][0] == "808 Core"
    scroll(c, 2)  # Drum Hits: a folder, nothing loads
    host.t += 1
    c.tick()
    assert len(b.loaded) == 2
    tap(c, "func")  # into Drum Hits: the pads pick pads again
    c.tick()
    assert c.layout == "daw"


def test_a_kit_inside_an_instrument_rack_still_counts_as_drums():
    host, c = setup()
    track = host.song.tracks[0]
    to_browse(c)
    tap(c, "func")  # Drums
    host.t += 1
    c.tick()
    assert c.layout == "drum"
    inner = track.devices[0]
    wrapper = FakeDevice("Acuff Kit", type=1)
    wrapper.can_have_chains = True
    wrapper.chains = [Obj(devices=[inner])]
    track.devices[0] = wrapper  # a kit that's an Instrument Rack around a Drum Rack
    c.tick()
    assert c.layout == "drum" and c.drum_rack(track) is inner  # the pads still play it


def to_chop(c):
    shift(c, True)
    tap(c, "encPageDown")
    shift(c, False)


def test_chop_the_selected_pads_sample_and_put_the_chops_on_pads():
    host, c = setup()
    song = host.song
    drums = song.tracks[0]
    to_chop(c)
    assert c.mode == "chop" and c.layout == "drum"  # the pads play the slices
    chop_track = song.tracks[1]
    assert chop_track.name == "Chop Pad 36" and song.view.selected_track == chop_track
    assert drums.devices[0].drum_pads[36].chains  # the pad stays as it was
    c.tick()
    simpler = chop_track.devices[0]
    assert simpler.sample.file_path == "/s/Pad 36.wav"
    assert simpler.playback_mode == 2 and simpler.sample.slicing_style == 2  # Slice mode, equal steps
    assert len(c.chop.slices()) == 16 and c.page_key == "CHOP"
    assert c.key_map()[48] == 36 and c.key_map()[49] == 37  # C3 = slice 1, one key each
    leds = c.pad_leds()
    assert leds[0][1] == "pulse" and leds[15][0] != P.COLOR["off"]  # 16 slices on the pads, slice 1 selected
    c.screen(None)  # draws
    tap(c, "padDown")  # the next slice
    assert c.chop.selected() == 1 and simpler.view.selected_slice == c.chop.slices()[1]
    c.handle_midi((0x99, 40, 100))  # a pad (or key) plays slice 5: it's the selected one
    assert c.chop.selected() == 4
    tap(c, "func")  # crop to the region
    assert simpler.cropped == 1
    to_chop(c)  # done: Slice to Drum Rack
    assert c.mode == "play" and c.drum_rack(chop_track) is not None
    assert c.overlay[:2] == ("CHOPS > PADS", "16 on Chop Pad 36")


def test_chop_page_edits_the_region_and_the_slices():
    host, c = setup()
    to_chop(c)
    c.tick()
    smp = host.song.tracks[1].devices[0].sample
    page = c.current_page()
    assert [p.name if p else None for p in page.params] == ["Scroll", "Zoom", "Start", "End", "Mode", "Count", "Split",
                                                            None]  # Start and End where SAMPLE has them
    enc(c, 5, -8)  # Count: 8 equal steps
    assert smp.slicing_region_count == 8 and len(c.chop.slices()) == 8
    tap(c, "encPageDown")  # SAMPLE: the region
    assert [p.name if p else None for p in c.current_page().params][:4] == ["Scroll", "Zoom", "Start", "End"]
    enc(c, 2, 10)  # Start: a screen pixel per detent
    assert smp.start_marker == 10 * ((88200 - 1) // 124)
    enc(c, 3, 50)  # End, past the sample's last frame: stops on it (Live refuses the length itself)
    assert smp.end_marker == 88200 - 1
    enc(c, 3, -20)
    assert smp.end_marker < 88200 - 1
    c.chop.select(2)
    c.chop._add_or_remove(1)  # split slice 3
    assert len(c.chop.slices()) == 9 and smp.slicing_style == 3  # by hand now
    c.chop._move_start(1)
    assert c.chop.slices()[2] > smp.start_marker


def test_chop_zooms_on_the_selected_slice_and_moves_it_a_pixel_a_detent():
    host, c = setup()
    to_chop(c)
    c.tick()
    smp = host.song.tracks[1].devices[0].sample
    c.handle_midi((0x99, 37, 100))  # pad for slice 2
    start = c.chop.slices()[1]
    assert c.chop.selected() == 1 and c.chop.shown() == (0, 88200)
    enc(c, 1, 10)  # Zoom in, around slice 2's start
    a, b = c.chop.shown()
    assert b - a < 88200 / 8 and a <= start <= b
    enc(c, 2, 3)  # Start: three pixels at this zoom
    assert c.chop.slices()[1] == start + 3 * ((b - a) // 124)
    assert host.song.tracks[1].devices[0].view.selected_slice == c.chop.slices()[1]  # still selected in Live
    end = c.chop.slices()[2]
    enc(c, 3, -2)  # End: where slice 2 ends, slice 3's start; slice 2 stays selected
    assert c.chop.slices()[2] == end - 2 * ((b - a) // 124) and c.chop.selected() == 1
    enc(c, 1, 100)  # no closer than 512 frames
    a, b = c.chop.shown()
    assert b - a == 512
    c.handle_midi((0x99, 51, 100))  # slice 16, off the screen: brought into view
    a, b = c.chop.shown()
    assert a <= c.chop.slices()[15] <= b


def test_chop_reads_the_wave_from_the_file(tmp_path):
    import math
    import struct
    import wave
    path = str(tmp_path / "Break.wav")
    w = wave.open(path, "wb")
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(44100)
    frames = 88200
    w.writeframes(b"".join(struct.pack("<hh", int(16000 * math.sin(i / 20.0)) if i < frames // 2 else 0, 0)
                           for i in range(frames)))
    w.close()
    host, c = setup()
    host.song.tracks[0].devices[0].drum_pads[36].chains[0].devices[0].sample.file_path = path
    to_chop(c)
    c.tick()
    host.song.tracks[1].devices[0].sample.length = frames
    c.tick()  # reads the file
    view = c.chop.view()
    wave_cols = view[6]
    assert len(wave_cols) == 124
    assert wave_cols[10][1] > 0.4 and abs(wave_cols[120][1]) < 0.01  # loud first half, silent second
    enc(c, 1, 30)  # zoomed in: read from the file again
    assert len(c.chop.view()[6]) == 124
    c.screen(None)  # draws


def test_chop_from_browse_and_where_it_cant():
    host, c = setup()
    to_browse(c)
    to_chop(c)  # on a folder: nothing to chop
    assert c.mode == "browse" and c.overlay[:2] == ("Chop", "Pick a sample")
    scroll(c, 2)
    tap(c, "func")  # Samples
    tap(c, "func")  # Kicks
    to_chop(c)  # Kick 1.wav onto a new Chop track
    assert c.mode == "chop" and host.song.view.selected_track.name == "Chop Kick 1"
    shift(c, True)
    tap(c, "encPageUp")  # leave Chop without converting
    shift(c, False)
    assert c.mode == "play"
    host.song.view.selected_track = host.song.tracks[-1]  # an empty track: no pad to chop
    to_chop(c)
    assert c.mode == "play" and c.overlay[:2] == ("Chop", "Pick a pad with a sample")


def test_chop_explains_a_drum_sampler_pad():
    host, c = setup()
    dp = host.song.tracks[0].devices[0].drum_pads[36]
    cell = FakeDevice("Drum Sampler", type=1)
    cell.class_name = "DrumCell"
    dp.chains[0].devices = [cell]
    to_chop(c)
    assert c.mode == "play" and c.overlay[:2] == ("Drum Sampler", "Chop it from Browse")


def test_an_encoder_turn_draws_at_once_paced_by_the_acks():
    host, c = setup()
    to_chop(c)
    c.tick()
    for _ in range(5):  # ack whatever's queued, so the device has taken every frame
        c.sender.on_ack()
    assert not c.sender.busy
    frames = lambda: [m for m in host.sent if m[:8] == P.SYSEX_HEADER + (0x09, P.DISPLAY_STATIONARY)]
    host.sent.clear()
    enc(c, 1, 1)  # Zoom, no tick: the device has taken the last frame, so it's drawn now
    assert len(frames()) == 1 and c.sender.busy
    enc(c, 1, 1)  # a frame in flight: not drawn yet...
    enc(c, 1, 1)
    assert len(frames()) == 1 and c.dirty
    c.handle_midi(P.SYSEX_HEADER + (0x09, 0xF7))  # ...the ack draws the latest
    assert len(frames()) == 2 and not c.dirty


def test_zoomed_in_waves_reuse_the_read_window(tmp_path, monkeypatch):
    import struct
    import wave
    from Morsel import wave_peaks as WP
    path = str(tmp_path / "Loop.wav")
    w = wave.open(path, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(44100)
    w.writeframes(b"".join(struct.pack("<h", (i * 37) % 20000 - 10000) for i in range(441000)))
    w.close()
    opens = []
    real = WP._open
    monkeypatch.setattr(WP, "_open", lambda p: (opens.append(p), real(p))[1])
    peaks = WP.Peaks(path)
    assert len(opens) == 1
    peaks.view(200000, 202000, 124)  # zoomed in: read around it
    assert len(opens) == 2
    for a in range(200000, 201500, 100):  # scrolling nearby: no more reads
        peaks.view(a, a + 2000, 124)
    peaks.view(200500, 201500, 124)  # zooming in there too
    assert len(opens) == 2
    peaks.view(300000, 302000, 124)  # far away: read again
    assert len(opens) == 3


def test_the_last_chops_end_is_the_regions_end():
    host, c = setup()
    to_chop(c)
    c.tick()
    smp = host.song.tracks[1].devices[0].sample
    c.chop.select(15)
    end = smp.end_marker
    enc(c, 3, -4)  # End of chop 16: the region's
    assert smp.end_marker == end - 4 * ((88200 - 1) // 124)


def test_scene_warps_the_region_to_the_beats_on_sample():
    host, c = setup()
    to_chop(c)
    c.tick()
    simpler = host.song.tracks[1].devices[0]
    tap(c, "encPageDown")  # SAMPLE
    page = c.current_page()
    assert page.params[4].name == "Beats" and page.params[4].format() == "2 bars"  # Live's guess (7.5) as a length
    enc(c, 4, 1)  # a step up: 3 bars
    assert c.current_page().params[4].format() == "3 bars"
    tap(c, "scene")  # warp to it
    assert simpler.warped == 12 and c.overlay[:2] == ("WARPED", "3 bars at 120 BPM")
