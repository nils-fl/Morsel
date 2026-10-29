# The Live side: a _Framework ControlSurface used only for its plumbing (MIDI in/out, the ~100 ms display tick,
# logging). The behaviour is in controller.py, which gets Live through LiveHost.
import time
import traceback

import Live
from _Framework.ControlSurface import ControlSurface

from . import pages as PG
from . import protocol as P
from .controller import Controller


class LiveHost(object):
    """What the controller needs from Live, beyond the song: sending, the note repeat, enums and the browser."""

    def __init__(self, surface, c_instance):
        self._surface = surface
        self._c = c_instance
        self.note_repeat = getattr(c_instance, "note_repeat", None)

    @property
    def song(self):
        return self._c.song()

    @property
    def browser(self):
        return Live.Application.get_application().browser

    def send(self, msg):
        self._surface._send_midi(msg)

    def log(self, msg):
        self._surface.log_message(msg)

    def show_view(self, name):
        Live.Application.get_application().view.show_view(name)

    def now(self):
        return time.time()

    def request_rebuild_midi_map(self):
        self._surface.request_rebuild_midi_map()

    def keys_routing_changed(self):
        """The keybed's map changed (drum track or not): rebuild it."""
        self._surface.request_rebuild_midi_map()

    def all_scales(self):
        """Live 12's scales as (name, intervals)."""
        return [(name, tuple(intervals)) for name, intervals in Live.Song.get_all_scales_ordered()]

    def set_launch_quantization(self, i):
        self.song.clip_trigger_quantization = Live.Song.Quantization.values[i]

    def set_record_quantization(self, i):
        self.song.midi_recording_quantization = Live.Song.RecordingQuantization.values[i]

    def add_note(self, clip, pitch, start, duration, velocity):
        spec = Live.Clip.MidiNoteSpecification(pitch=pitch, start_time=start, duration=duration, velocity=velocity,
                                               mute=False)
        clip.add_new_notes((spec,))

    def zoom(self, direction, horizontal):
        """Zoom the arrangement in (right / up) or out, as Live's own ZoomComponent does."""
        nav = Live.Application.Application.View.NavDirection
        if horizontal:
            d = nav.right if direction > 0 else nav.left
        else:
            d = nav.up if direction > 0 else nav.down
        Live.Application.get_application().view.zoom_view(d, "Arranger", False)

    def quantize(self, clip, grid):
        """Quantize a clip fully to a RecordingQuantization grid, by name ("sixtenth", "eight_triplet", ...)."""
        clip.quantize(getattr(Live.Song.RecordingQuantization, "rec_q_" + grid), 1.0)

    def device_bank(self, device):
        """Live's own best 8 parameters for its devices; the first 8 (after Device On) for anything else."""
        try:
            from _Generic.Devices import best_of_parameter_bank

            bank = list(best_of_parameter_bank(device))
            if any(p is not None for p in bank):
                return bank[:8]
        except Exception:
            pass
        return list(device.parameters)[1:9]

    # ---- Chop (chop.py) -----------------------------------------------------------------------------------------

    def create_midi_track(self, index, name):
        song = self.song
        song.create_midi_track(index)
        track = list(song.tracks)[index]
        track.name = name
        return track

    def insert_simpler(self, track, path):
        """A Simpler on `track` holding the sample file at `path` (Live 12: Track.insert_device and
        SimplerDevice.replace_sample). False when Live can't."""
        try:
            device = track.insert_device("Simpler")
            if device is None:
                device = next(d for d in track.devices if getattr(d, "class_name", "") == "OriginalSimpler")
            device.replace_sample(path)
            return True
        except Exception as e:
            self.log("Morsel Chop: no Simpler with %s: %r" % (path, e))
            return False

    def load_onto_track(self, track, item):
        """A browser item onto `track` (a sample onto an empty MIDI track: Live puts it in a Simpler)."""
        self.song.view.selected_track = track
        browser = self.browser
        try:
            browser.hotswap_target = None
        except Exception:
            pass
        browser.load_item(item)

    def set_enum(self, obj, prop, index):
        """Set one of Live's enum properties (Simpler's playback mode, slicing style, ...) by index: Live may want
        its own enum type, which is the type of the current value."""
        try:
            setattr(obj, prop, index)
        except Exception:
            setattr(obj, prop, type(getattr(obj, prop))(index))

    def slice_to_drum_rack(self, simpler):
        """Live's Slice to Drum Rack (Live.Conversions, as Push 2 does): a pad per slice. False when Live can't."""
        try:
            Live.Conversions.sliced_simpler_to_drum_rack(self.song, simpler)
            return True
        except Exception as e:
            self.log("Morsel Chop: Slice to Drum Rack failed: %r" % (e,))
            return False

    def device_banks(self, device):
        """All of a device's parameters, 8 at a time: Live's own banks for its devices, else in order."""
        try:
            from _Generic.Devices import parameter_banks

            banks = [list(b)[:8] for b in parameter_banks(device)]
            if any(p is not None for b in banks for p in b):
                return banks
        except Exception:
            pass
        params = list(device.parameters)[1:]
        return [params[i:i + 8] for i in range(0, len(params), 8)]



class MorselSurface(ControlSurface):
    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._controller = Controller(LiveHost(self, c_instance))
        self._errors = 0
        self._listening = []  # (DeviceParameter, callback) on the mapped encoders' parameters
        self._map_failed = False
        self.schedule_message(1, self._connect)

    def _connect(self):
        self._guard(self._controller.connect)

    def _guard(self, fn, *args):
        """Log a failure to Log.txt instead of taking the script down (only the first few, it runs every tick)."""
        try:
            fn(*args)
        except Exception:
            self._errors += 1
            if self._errors <= 20:
                self.log_message("Morsel error:\n" + traceback.format_exc())

    def build_midi_map(self, midi_map_handle):
        h = self._c_instance.handle()
        mapped = self._map_encoders(midi_map_handle)
        for ch in (P.CH_DAW_PADS, P.CH_FEATURE, P.CH_BUTTON):
            for cc in range(128):
                if ch != P.CH_BUTTON or cc not in mapped:
                    Live.MidiMap.forward_midi_cc(h, midi_map_handle, ch, cc)
        # The keybed on the DAW port (keyboard_to_daw): on a drum track Live maps it to the pads (C3 = pad 1, onto
        # ch10). Heard without taking it (should_consume_event=False), so it still plays.
        key_map = self._controller.key_map()
        for note in range(128):
            if key_map is not None:
                self._c_instance.set_note_translation(note, P.CH_KEYS, key_map[note], self._controller.key_channel())
            else:
                self._c_instance.set_note_translation(note, P.CH_KEYS, note, P.CH_KEYS)
            Live.MidiMap.forward_midi_note(h, midi_map_handle, P.CH_KEYS, note, False)
        if self._controller.hears_drum_notes() and (key_map is not None or self._controller.layout == "drum"):
            # The mapped keys arrive as ch10 pad notes; in DAW layout no pad sends those. In Browse's kits the pads
            # (drum layout) send them too, heard on their way to the track.
            for note in P.DRUM_NOTES:
                Live.MidiMap.forward_midi_note(h, midi_map_handle, P.CH_DRUM, note, False)
        # Drum layout (Play): the pads stay unforwarded, so they reach the track (and note repeat).
        # DAW layout (the other modes): they come to the script.
        if self._controller.layout == "daw":
            for note in P.DAW_NOTES:
                Live.MidiMap.forward_midi_note(h, midi_map_handle, P.CH_DAW_PADS, note)

    def _map_encoders(self, midi_map_handle):
        """The encoders on Live parameters go into Live's MIDI map, as Live's own Launchkey script does
        (_Framework ControlSurface._install_mapping): relative, Live's sensitivity per parameter, no feedback (the
        encoders are endless). Live turns the parameter itself; a value listener tells the controller. Returns the
        CCs mapped (those aren't forwarded)."""
        self._stop_listening()
        mapped = set()
        try:
            encoders = self._controller.mapped_encoders()
        except Exception:
            encoders = []
        for index, param in encoders:
            cc = P.CC_ENC_REL_FIRST + index
            try:
                rule = Live.MidiMap.CCFeedbackRule()
                rule.channel = P.CH_BUTTON
                rule.cc_no = cc
                rule.cc_value_map = tuple()
                rule.delay_in_ms = -1.0
                if hasattr(rule, "enabled"):
                    rule.enabled = False
                # avoid_takeover True (= not needs_takeover): relative encoders have nothing to take over.
                ok = Live.MidiMap.map_midi_cc_with_feedback_map(
                    midi_map_handle, param, P.CH_BUTTON, cc, Live.MidiMap.MapMode.relative_smooth_binary_offset,
                    rule, True, PG.mapping_sensitivity(param)) is not False
            except Exception as e:
                ok = False
                if not self._map_failed:
                    self._map_failed = True
                    self.log_message("Morsel: can't map encoder %d: %r" % (index + 1, e))
            if not ok:
                continue  # forwarded instead: the script turns it, as before
            mapped.add(cc)

            def changed(index=index):
                self._guard(self._controller.on_mapped_value, index)

            param.add_value_listener(changed)
            self._listening.append((param, changed))
        return mapped

    def _stop_listening(self):
        for param, callback in self._listening:
            try:
                if param.value_has_listener(callback):
                    param.remove_value_listener(callback)
            except Exception:  # the parameter's device was deleted
                pass
        self._listening = []

    def receive_midi(self, midi_bytes):
        self._guard(self._controller.handle_midi, tuple(midi_bytes))

    def update_display(self):
        ControlSurface.update_display(self)
        self._guard(self._controller.tick)

    def refresh_state(self):
        ControlSurface.refresh_state(self)
        self._connect()

    def port_settings_changed(self):
        ControlSurface.port_settings_changed(self)
        self.schedule_message(1, self._connect)

    def disconnect(self):
        self._stop_listening()
        self._guard(self._controller.disconnect)
        ControlSurface.disconnect(self)
