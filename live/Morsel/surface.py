# The Live side: a _Framework ControlSurface used only for its plumbing (MIDI in/out, the ~100 ms display tick,
# logging). The behaviour is in controller.py, which gets Live through LiveHost.
import time
import traceback

import Live
from _Framework.ControlSurface import ControlSurface

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
        for ch in (P.CH_DAW_PADS, P.CH_FEATURE, P.CH_BUTTON):
            for cc in range(128):
                Live.MidiMap.forward_midi_cc(h, midi_map_handle, ch, cc)
        # The keybed on the DAW port (keyboard_to_daw): on a drum track Live maps it to the pads (C3 = pad 1, onto
        # ch10). Heard without taking it (should_consume_event=False), so it still plays.
        key_map = self._controller.key_map()
        for note in range(128):
            if key_map is not None:
                self._c_instance.set_note_translation(note, P.CH_KEYS, key_map[note], P.CH_DRUM)
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
        self._guard(self._controller.disconnect)
        ControlSurface.disconnect(self)
