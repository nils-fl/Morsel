import Live
from _Framework.ControlSurface import ControlSurface

KEYBED_CHANNEL = 0  # the Launchkey's keybed sends on ch1
PADS_CHANNEL = 9  # translated notes go out on ch10, so a translated note can be told from a played one


class MorselKeysSurface(ControlSurface):
    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._main = None
        self._logged_keys = 0  # the first few keys go to the log (which form Live hands the script)

    def connect_script_instances(self, instanciated_scripts):
        """Live hands every script the others: find the Morsel surface (duck-typed, no import of its package)."""
        ControlSurface.connect_script_instances(self, instanciated_scripts)
        if self._main is not None:
            self._main.unlink_keys(self)
        self._main = None
        for script in instanciated_scripts:
            if script is not self and hasattr(script, "on_key") and hasattr(script, "link_keys"):
                self._main = script
                script.link_keys(self)
                break
        self.log_message("Morsel Keys: %s" % ("linked to Morsel" if self._main else "Morsel surface not found"))
        self.request_rebuild_midi_map()

    def _key_map(self):
        return self._main.key_map() if self._main is not None else None

    def build_midi_map(self, midi_map_handle):
        key_map = self._key_map()
        self.log_message("Morsel Keys: %s" % ("keys -> drum pads (C3 = pad 1)" if key_map else "keys as played"))
        for note in range(128):
            if key_map is not None:
                self._c_instance.set_note_translation(note, KEYBED_CHANNEL, key_map[note], PADS_CHANNEL)
            else:
                self._c_instance.set_note_translation(note, KEYBED_CHANNEL, note, KEYBED_CHANNEL)
        # should_consume_event=False (the 5th argument, as Live's own scripts use it for keys that play and are
        # heard by the script): the notes still reach the tracks.
        h = self._c_instance.handle()
        for ch in range(16):
            for note in range(128):
                Live.MidiMap.forward_midi_note(h, midi_map_handle, ch, note, False)

    def receive_midi(self, midi_bytes):
        if self._main is None or len(midi_bytes) < 3:
            return
        status, channel = midi_bytes[0] & 0xF0, midi_bytes[0] & 0x0F
        note, velocity = midi_bytes[1], midi_bytes[2]
        if status not in (0x80, 0x90):
            return
        key_map = self._key_map()
        if self._logged_keys < 6 and status == 0x90:
            self._logged_keys += 1
            self.log_message("Morsel Keys: heard ch%d note %d (map %s)" % (channel + 1, note, "on" if key_map else "off"))
        if key_map is not None and channel == KEYBED_CHANNEL:
            note = key_map[note]  # heard before the translation: map it the same way
        self._main.on_key(note, velocity, status == 0x90 and velocity > 0)

    def disconnect(self):
        if self._main is not None:
            self._main.unlink_keys(self)
            self._main = None
        ControlSurface.disconnect(self)
