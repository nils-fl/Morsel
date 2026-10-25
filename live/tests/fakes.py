# Minimal stand-ins for the Live objects the controller touches (same attribute names as Live's API).


class Obj(object):
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeParam(object):
    def __init__(self, name, value=0.0, lo=0.0, hi=1.0, quantized=False):
        self.name, self.value, self.min, self.max = name, value, lo, hi
        self.is_quantized = quantized
        self.is_enabled = True

    def str_for_value(self, v):
        return "%.2f" % v


class FakeDrumPad(object):
    def __init__(self, note, loaded):
        self.name = "Pad %d" % note
        self.note = note
        self.chains = [Obj(color=0xFF0000, devices=[FakeDevice("Simpler")])] if loaded else []
        self.mute = False
        self.solo = False


class FakeRack(object):
    can_have_drum_pads = True

    def __init__(self, loaded=range(36, 40)):
        self.name = "Drum Rack"
        self.drum_pads = [FakeDrumPad(n, n in loaded) for n in range(128)]
        self.view = Obj(selected_drum_pad=self.drum_pads[36])
        self.parameters = [FakeParam("Device On")] + [FakeParam("Macro %d" % i) for i in range(1, 9)]


class FakeDevice(object):
    can_have_drum_pads = False

    def __init__(self, name):
        self.name = name
        self.parameters = [FakeParam("Device On")] + [FakeParam("%s %d" % (name, i)) for i in range(1, 12)]


class FakeNote(object):
    def __init__(self, pitch, start_time, duration, velocity):
        self.pitch, self.start_time, self.duration, self.velocity = pitch, start_time, duration, velocity


class FakeClip(object):
    is_midi_clip = True

    def __init__(self, length=4.0):
        self.removed = []
        self.notes = []
        self.loop_start = 0.0
        self.loop_end = self.end_marker = self.length = length
        self.is_playing = False
        self.playing_position = 0.0

    def _in(self, n, pitch, span, start, dur):
        return pitch <= n.pitch < pitch + span and start <= n.start_time < start + dur

    def get_notes_extended(self, pitch, span, start, dur):
        return [n for n in self.notes if self._in(n, pitch, span, start, dur)]

    def remove_notes_extended(self, pitch, span, start, dur):
        self.removed.append((pitch, span, start, dur))
        self.notes = [n for n in self.notes if not self._in(n, pitch, span, start, dur)]

    def add_new_notes(self, notes):
        self.notes.extend(notes)

    def apply_note_modifications(self, notes):
        pass  # the fakes are modified in place

    def duplicate_loop(self):
        n = self.loop_end - self.loop_start
        self.notes += [FakeNote(x.pitch, x.start_time + n, x.duration, x.velocity) for x in self.notes]
        self.loop_end = self.end_marker = self.length = self.loop_end + n


class FakeSlot(object):
    def __init__(self, clip=None):
        self.clip = clip

    @property
    def has_clip(self):
        return self.clip is not None

    def duplicate_clip_to(self, other):
        other.clip = FakeClip()

    def delete_clip(self):
        self.clip = None

    def create_clip(self, length):
        self.clip = FakeClip(length)


class FakeTrack(object):
    def __init__(self, name, devices=(), scenes=8, midi=True, color=0x3B5BFF):
        self.name = name
        self.devices = list(devices)
        self.clip_slots = [FakeSlot() for _ in range(scenes)]
        self.color = color
        self.has_midi_input = midi
        self.can_be_armed = True
        self.implicit_arm = False
        self.mute = False
        self.solo = False
        self.fired_slot_index = -1
        self.playing_slot_index = -1
        self.view = Obj(selected_device=self.devices[0] if self.devices else None)
        self.mixer_device = Obj(volume=FakeParam("Track Volume", 0.85), panning=FakeParam("Track Panning", 0.5, -1.0),
                                sends=[FakeParam("A"), FakeParam("B")])


class FakeScene(object):
    def __init__(self, song, i):
        self._song, self._i = song, i
        self.fired = 0

    @property
    def clip_slots(self):
        return [t.clip_slots[self._i] for t in self._song.tracks]

    def fire(self):
        self.fired += 1
        self._song.is_playing = True


class FakeSong(object):
    def __init__(self, n_scenes=8):
        self.tracks = [
            FakeTrack("Drums", [FakeRack(), FakeDevice("Reverb")], n_scenes),
            FakeTrack("Bass", [FakeDevice("Drift")], n_scenes),
        ]
        self.return_tracks = [Obj(name="A-Reverb"), Obj(name="B")]
        self.scenes = [FakeScene(self, i) for i in range(n_scenes)]
        self.view = Obj(selected_track=self.tracks[0], selected_scene=self.scenes[0])
        self.view.select_device = lambda d: setattr(self.view.selected_track.view, "selected_device", d)
        self.tempo = 120.0
        self.swing_amount = 0.0
        self.midi_recording_quantization = 0
        self.clip_trigger_quantization = 4
        self.metronome = False
        self.is_playing = False
        self.session_record = False
        self.record_mode = False
        self.current_song_time = 0.0
        self.can_undo = True
        self.undos = 0
        self.can_capture_midi = False
        self.signature_numerator = 4
        self.signature_denominator = 4

    def undo(self):
        self.undos += 1

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def create_midi_track(self, i):
        self.tracks.insert(i, FakeTrack("%d-MIDI" % (i + 1), (), len(self.scenes)))


class FakeHost(object):
    def __init__(self, song=None):
        self.song = song or FakeSong()
        self.sent = []
        self.t = 1000.0
        self.note_repeat = Obj(enabled=False, repeat_rate=0.25)
        self.rebuilds = 0
        self.keys_rebuilds = 0
        self.loaded = []

    def send(self, msg):
        self.sent.append(tuple(msg))

    def now(self):
        return self.t

    def request_rebuild_midi_map(self):
        self.rebuilds += 1

    def keys_routing_changed(self):
        self.keys_rebuilds += 1

    def set_launch_quantization(self, i):
        self.song.clip_trigger_quantization = i

    def set_record_quantization(self, i):
        self.song.midi_recording_quantization = i

    def device_bank(self, device):
        return list(device.parameters)[1:9]

    def add_note(self, clip, pitch, start, duration, velocity):
        clip.add_new_notes([FakeNote(pitch, start, duration, velocity)])

    def load_instrument(self, kind):
        self.loaded.append(kind)
        return True
