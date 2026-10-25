# The Live side: a _Framework ControlSurface used only for its plumbing (MIDI in/out, the ~100 ms display tick,
# logging). The behaviour is in controller.py, which gets Live through LiveHost.
import time
import traceback

import Live
from _Framework.ControlSurface import ControlSurface

from . import protocol as P
from .controller import Controller

# What a new track in Track mode gets (Live's browser, Instruments): the first of these that exists.
INSTRUMENTS = {"drum": ("Drum Rack",), "keys": ("Drift", "Simpler")}


class LiveHost(object):
    """What the controller needs from Live, beyond the song: sending, the note repeat, enums and the browser."""

    def __init__(self, surface, c_instance):
        self._surface = surface
        self._c = c_instance
        self.note_repeat = getattr(c_instance, "note_repeat", None)

    @property
    def song(self):
        return self._c.song()

    def send(self, msg):
        self._surface._send_midi(msg)

    def now(self):
        return time.time()

    def request_rebuild_midi_map(self):
        self._surface.request_rebuild_midi_map()

    def keys_routing_changed(self):
        for keys in self._surface.keys_surfaces:
            keys.request_rebuild_midi_map()

    def set_launch_quantization(self, i):
        self.song.clip_trigger_quantization = Live.Song.Quantization.values[i]

    def set_record_quantization(self, i):
        self.song.midi_recording_quantization = Live.Song.RecordingQuantization.values[i]

    def add_note(self, clip, pitch, start, duration, velocity):
        spec = Live.Clip.MidiNoteSpecification(pitch=pitch, start_time=start, duration=duration, velocity=velocity,
                                               mute=False)
        clip.add_new_notes((spec,))

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

    def load_instrument(self, kind):
        browser = Live.Application.get_application().browser
        items = {item.name: item for item in browser.instruments.children}
        for name in INSTRUMENTS[kind]:
            item = items.get(name)
            if item is not None and item.is_loadable:
                browser.load_item(item)
                return True
        return False


class MorselSurface(ControlSurface):
    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._controller = Controller(LiveHost(self, c_instance))
        self._errors = 0
        self.keys_surfaces = []  # Morsel Keys instances (the keybed port), linked through connect_script_instances
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

    # ---- Morsel Keys (live/Morsel_Keys) -------------------------------------------------------------------------

    def link_keys(self, keys):
        if keys not in self.keys_surfaces:
            self.keys_surfaces.append(keys)

    def unlink_keys(self, keys):
        if keys in self.keys_surfaces:
            self.keys_surfaces.remove(keys)

    def key_map(self):
        return self._controller.key_map()

    def on_key(self, note, velocity, on):
        """A key played on the keybed (after the key map)."""
        self._guard(self._controller.on_key, note, velocity, on)

    def build_midi_map(self, midi_map_handle):
        h = self._c_instance.handle()
        for ch in (P.CH_DAW_PADS, P.CH_FEATURE, P.CH_BUTTON):
            for cc in range(128):
                Live.MidiMap.forward_midi_cc(h, midi_map_handle, ch, cc)
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
