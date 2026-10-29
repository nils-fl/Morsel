# The surface's Live side (MIDI map, listeners), with small stand-ins for Live's MidiMap and _Framework: what goes
# into Live's MIDI map, what's forwarded to the script, and which parameters are listened to.
import sys
import types

from fakes import FakeSong

calls = []


class _Rule(object):
    pass


def _stub_live():
    live = types.ModuleType("Live")
    midi_map = types.SimpleNamespace(
        CCFeedbackRule=_Rule,
        MapMode=types.SimpleNamespace(relative_smooth_binary_offset="rel_smooth_bo"),
        forward_midi_cc=lambda h, m, ch, cc: calls.append(("fwd_cc", ch, cc)),
        forward_midi_note=lambda h, m, ch, note, *consume: calls.append(("fwd_note", ch, note)),
        map_midi_cc_with_feedback_map=lambda m, p, ch, cc, mode, rule, avoid, sens: (
            calls.append(("map", p, ch, cc, mode, avoid, sens)) or True),
    )
    live.MidiMap = midi_map
    live.Song = types.SimpleNamespace(get_all_scales_ordered=lambda: [])
    framework = types.ModuleType("_Framework")
    cs_module = types.ModuleType("_Framework.ControlSurface")

    class ControlSurface(object):
        def __init__(self, c_instance):
            self._c_instance = c_instance

        def schedule_message(self, delay, fn):
            pass

        def log_message(self, *a):
            calls.append(("log",) + a)

        def request_rebuild_midi_map(self):
            pass

        def disconnect(self):
            pass

    cs_module.ControlSurface = ControlSurface
    sys.modules.setdefault("Live", live)
    sys.modules.setdefault("_Framework", framework)
    sys.modules.setdefault("_Framework.ControlSurface", cs_module)


_stub_live()
from Morsel.surface import MorselSurface  # noqa: E402


class _CInstance(object):
    def __init__(self, song):
        self._song = song

    def handle(self):
        return 1

    def song(self):
        return self._song

    def set_note_translation(self, *a):
        pass

    def send_midi(self, msg):
        pass


def _surface():
    song = FakeSong()
    s = MorselSurface(_CInstance(song))
    s._controller.host.device_bank = lambda d: list(d.parameters)[1:9]
    s._controller.host.device_banks = lambda d: [list(d.parameters)[1:9]]
    return s, song


def test_encoders_on_live_parameters_are_mapped_not_forwarded():
    s, song = _surface()
    song.view.selected_track = song.tracks[1]  # Bass: Drift, Play mode
    del calls[:]
    s.build_midi_map(2)
    maps = [c for c in calls if c[0] == "map"]
    assert [c[3] for c in maps] == list(range(85, 93)) and all(c[2] == 15 and c[4] == "rel_smooth_bo" for c in maps)
    assert all(c[5] is True and c[6] == 1.0 for c in maps)  # no takeover; continuous: Live's 1.0
    forwarded = {c[2] for c in calls if c[0] == "fwd_cc" and c[1] == 15}
    assert not forwarded & set(range(85, 93)) and 51 in forwarded  # the page arrows still come to the script
    drift = song.tracks[1].devices[0]
    listened = [p for p in drift.parameters if p.__dict__.get("listeners")]
    assert len(listened) == 8
    listened[0].listeners[0]()  # Live turned it: the screen shows it
    assert s._controller.overlay is not None


def test_step_mode_forwards_every_encoder_and_drops_the_listeners():
    s, song = _surface()
    song.view.selected_track = song.tracks[1]
    s.build_midi_map(2)
    drift = song.tracks[1].devices[0]
    s._controller.mode = "step"
    del calls[:]
    s.build_midi_map(2)
    assert not [c for c in calls if c[0] == "map"]
    assert set(range(85, 93)) <= {c[2] for c in calls if c[0] == "fwd_cc" and c[1] == 15}
    assert not any(p.__dict__.get("listeners") for p in drift.parameters)
