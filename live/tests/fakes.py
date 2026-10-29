# Minimal stand-ins for the Live objects the controller touches (same attribute names as Live's API).


class Obj(object):
    def __init__(self, **kw):
        self.__dict__.update(kw)


class Wrap(object):
    """What Live hands a script for a Live object: a new wrapper on every read, equal (==) but not identical (is)
    to the last one."""

    def __init__(self, obj):
        object.__setattr__(self, "_o", obj)

    def __getattr__(self, name):
        return getattr(self._o, name)

    def __setattr__(self, name, value):
        setattr(self._o, name, value)

    def __eq__(self, other):
        return self._o is (other._o if isinstance(other, Wrap) else other)

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return id(self._o)


def unwrap(obj):
    return obj._o if isinstance(obj, Wrap) else obj


class WrappingView(object):
    """A song view that, like Live's, returns a fresh wrapper for the selected track on every read."""

    def __init__(self, view):
        object.__setattr__(self, "_v", view)

    @property
    def selected_track(self):
        return Wrap(self._v.selected_track)

    def __getattr__(self, name):
        return getattr(self._v, name)

    def __setattr__(self, name, value):
        setattr(self._v, name, unwrap(value))


class FakeParam(object):
    def __init__(self, name, value=0.0, lo=0.0, hi=1.0, quantized=False):
        self.name, self.value, self.min, self.max = name, value, lo, hi
        self.is_quantized = quantized
        self.is_enabled = True

    def str_for_value(self, v):
        return "%.2f" % v

    def add_value_listener(self, f):
        self.__dict__.setdefault("listeners", []).append(f)

    def remove_value_listener(self, f):
        self.listeners.remove(f)

    def value_has_listener(self, f):
        return f in self.__dict__.get("listeners", [])


class FakeDrumPad(object):
    def __init__(self, note, loaded):
        self.name = "Pad %d" % note
        self.note = note
        self.chains = [Obj(color=0xFF0000, devices=[FakeSimpler(FakeSample("/s/Pad %d.wav" % note))])] if loaded else []
        self.mute = False
        self.solo = False

    def delete_all_chains(self):
        self.chains = []


class FakeRack(object):
    can_have_drum_pads = True

    def __init__(self, loaded=range(36, 40)):
        self.name = "Drum Rack"
        self.drum_pads = [FakeDrumPad(n, n in loaded) for n in range(128)]
        self.view = Obj(selected_drum_pad=self.drum_pads[36])
        self.parameters = [FakeParam("Device On")] + [FakeParam("Macro %d" % i) for i in range(1, 9)]

    def copy_pad(self, source, destination):
        self.drum_pads[destination].chains = list(self.drum_pads[source].chains)


class FakeDevice(object):
    can_have_drum_pads = False

    def __init__(self, name, type=2):
        self._deleted = False
        self.name = name
        self.class_display_name = name
        self.type = type  # Live.Device.DeviceType: 1 instrument, 2 audio effect
        self.parameters = [FakeParam("Device On")] + [FakeParam("%s %d" % (name, i)) for i in range(1, 12)]

    def __getattribute__(self, attr):
        # Like Live: a device that was replaced (hot-swapped) raises on any read.
        if attr != "_deleted" and object.__getattribute__(self, "_deleted"):
            raise RuntimeError("deleted device")
        return object.__getattribute__(self, attr)


class FakePlugin(FakeDevice):
    """A plug-in instrument with its own presets (PluginDevice.presets / selected_preset_index)."""

    def __init__(self, name, presets):
        FakeDevice.__init__(self, name, type=1)
        self.class_display_name = "Plug-in"
        self.presets = list(presets)
        self.selected_preset_index = 0


class FakeSample(object):
    """Simpler's sample in Slice mode: equal regions, or slices set by hand (editing one makes it Manual, as in
    Live)."""

    def __init__(self, path="/s/Break.wav", length=88200):
        self.file_path = path
        self.length = length
        self.sample_rate = 44100
        self._start, self._end = 0, length - 1
        self.slicing_style = 0
        self.slicing_region_count = 8
        self.slicing_sensitivity = 0.5
        self.slicing_beat_division = 4
        self._manual = None

    # Like Live: a marker past the last frame is refused.
    @property
    def start_marker(self):
        return self._start

    @start_marker.setter
    def start_marker(self, v):
        if not 0 <= v < self.length:
            raise RuntimeError("Cannot set marker outside of the sample")
        self._start = v

    @property
    def end_marker(self):
        return self._end

    @end_marker.setter
    def end_marker(self, v):
        if not 0 <= v < self.length:
            raise RuntimeError("Cannot set marker outside of the sample")
        self._end = v

    @property
    def slices(self):
        if self._manual is not None:
            return tuple(self._manual)
        n = self.slicing_region_count if self.slicing_style == 2 else 4
        span = self.end_marker - self.start_marker
        return tuple(self.start_marker + span * i // n for i in range(n))

    def _edit(self):
        if self._manual is None:
            self._manual = list(self.slices)
        self.slicing_style = 3

    def insert_slice(self, t):
        self._edit()
        self._manual = sorted(set(self._manual + [t]))

    def remove_slice(self, t):
        self._edit()
        self._manual.remove(t)

    def move_slice(self, old, new):
        self._edit()
        self._manual = sorted(new if x == old else x for x in self._manual)


class FakeSimpler(FakeDevice):
    def __init__(self, sample=None):
        FakeDevice.__init__(self, "Simpler", type=1)
        self.class_name = "OriginalSimpler"
        self.sample = sample
        self.playback_mode = 0
        self.view = Obj(selected_slice=0)
        self.cropped = 0

    def replace_sample(self, path):
        self.sample = FakeSample(path)

    def crop(self):
        self.cropped += 1

    can_warp_as = True

    def guess_playback_length(self):
        return 7.5  # Live's guess, in beats

    def warp_as(self, beats):
        self.warped = beats


class FakeCompressor(FakeDevice):
    """Live's Compressor: its parameters by name, and its sidechain routing (types are tracks, channels a Drum
    Rack's chains)."""

    def __init__(self, song):
        FakeDevice.__init__(self, "Compressor")
        self.class_name = "Compressor2"
        self.parameters = [FakeParam(n) for n in ("Device On", "Threshold", "Ratio", "Attack", "Release", "Dry/Wet")]
        self.parameters.append(FakeParam("S/C On", 0, 0, 1, quantized=True))
        self._song = song
        self.input_routing_type = Obj(display_name="No Input")
        self.input_routing_channel = Obj(display_name="")

    @property
    def available_input_routing_types(self):
        return [Obj(display_name="No Input")] + [Obj(display_name=t.name) for t in self._song.tracks]

    listed = True  # False: like Live, the new source's channels aren't listed yet (one empty one instead)

    @property
    def available_input_routing_channels(self):
        if self.input_routing_type.display_name == "No Input":
            return []
        if not self.listed:
            return [Obj(display_name="")]
        # As Live lists them: the track's taps, then per pad its own three and three more a level deeper.
        out = ["Pre FX", "Post FX", "Post Mixer"]
        for pad, sample in (("Bassdrum", "Bassdrum 505"), ("Snare", "Snare 505")):
            for tap in ("Pre FX", "Post FX", "Post Mixer"):
                out.append("505 Core Kit | %s | %s" % (pad, tap))
            for tap in ("Pre FX", "Post FX", "Post Mixer"):
                out.append("505 Core Kit | %s | %s | %s | %s" % (pad, pad, sample, tap))
        return [Obj(display_name=n) for n in out]


class FakeEffect(FakeDevice):
    """One of Live's audio effects: its class name and parameters by name ("Device On" first, as in Live)."""

    def __init__(self, name, class_name, params):
        FakeDevice.__init__(self, name)
        self.class_name = class_name
        self.parameters = [FakeParam("Device On", 1, 0, 1, quantized=True)] + params


def FakeAutoFilter():
    kind = FakeParam("Filter Type", 0, 0, 5, quantized=True)
    kind.value_items = ["Lowpass", "Highpass", "Bandpass", "Notch", "Morph", "DJ"]
    return FakeEffect("Auto Filter", "AutoFilter2", [kind, FakeParam("Frequency", 0.7), FakeParam("Resonance", 0.1)])


def FakeEq3():
    return FakeEffect("EQ Three", "FilterEQ3", [FakeParam(n, 0.5) for n in ("GainLo", "GainMid", "GainHi")])


def FakeSaturator():
    return FakeEffect("Saturator", "Saturator", [FakeParam("Drive", 0.0, -36.0, 36.0), FakeParam("Dry/Wet", 1.0)])


class FakeNote(object):
    def __init__(self, pitch, start_time, duration, velocity):
        self.pitch, self.start_time, self.duration, self.velocity = pitch, start_time, duration, velocity


class FakeClip(object):
    is_midi_clip = True
    color = 0xFF3B3B
    name = "Clip"

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

    def quantize(self, grid, amount):
        self.quantized = (grid, amount)

    def apply_note_modifications(self, notes):
        pass  # the fakes are modified in place

    def duplicate_loop(self):
        n = self.loop_end - self.loop_start
        self.notes += [FakeNote(x.pitch, x.start_time + n, x.duration, x.velocity) for x in self.notes]
        self.loop_end = self.end_marker = self.length = self.loop_end + n


class FakeSlot(object):
    def __init__(self, clip=None):
        self.clip = clip
        self.is_playing = False
        self.is_triggered = False
        self.is_recording = False
        self.fired = 0

    def fire(self):
        self.fired += 1

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
        self.arm = False
        self.stopped = 0
        self.view = Obj(selected_device=self.devices[0] if self.devices else None)
        self.mixer_device = Obj(volume=FakeParam("Track Volume", 0.85), panning=FakeParam("Track Panning", 0.5, -1.0),
                                sends=[FakeParam("A"), FakeParam("B")])


def _stop_all_clips(track):
    track.stopped += 1


FakeTrack.stop_all_clips = _stop_all_clips


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
            FakeTrack("Bass", [FakeDevice("Drift", type=1)], n_scenes),
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
        self.groove_amount = 1.0
        self.root_note = 0
        self.scale_name = "Major"
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 16.0
        self.cue_points = [Obj(name="Intro", time=0.0), Obj(name="Drop", time=32.0)]

    @property
    def can_jump_to_next_cue(self):
        return any(c.time > self.current_song_time for c in self.cue_points)

    @property
    def can_jump_to_prev_cue(self):
        return any(c.time < self.current_song_time for c in self.cue_points)

    def jump_to_next_cue(self):
        self.current_song_time = min(c.time for c in self.cue_points if c.time > self.current_song_time)

    def jump_to_prev_cue(self):
        self.current_song_time = max(c.time for c in self.cue_points if c.time < self.current_song_time)

    def jump_by(self, beats):
        self.current_song_time = max(0.0, self.current_song_time + beats)

    def undo(self):
        self.undos += 1

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def create_midi_track(self, i):
        self.tracks.insert(i, FakeTrack("%d-MIDI" % (i + 1), (), len(self.scenes)))


class FakeItem(object):
    def __init__(self, name, children=(), loadable=True, folder=False, device=False):
        self.name = name
        self.children = list(children)
        self.is_loadable = loadable
        self.is_folder = folder
        self.is_device = device


def folder(name, children):
    return FakeItem(name, children, loadable=False, folder=True)


class HotswapFiltered(FakeItem):
    """Like Live's browser: while a drum pad is the hot-swap target, only what fits a pad shows (no kits)."""

    def __init__(self, browser, name, children):
        FakeItem.__init__(self, name, children, loadable=False, folder=True)
        self._browser = browser
        self._all = list(children)

    def __getattribute__(self, attr):
        if attr == "children":
            target = object.__getattribute__(self, "_browser").hotswap_target
            everything = object.__getattribute__(self, "_all")
            return [i for i in everything if i.is_folder] if isinstance(target, FakeDrumPad) else everything
        return object.__getattribute__(self, attr)


class FakeBrowser(object):
    def __init__(self):
        kicks = folder("Kicks", [FakeItem("Kick %d.wav" % i) for i in range(1, 21)])
        self.samples = folder("Samples", [kicks, FakeItem("Clap.wav"), FakeItem("Snare.wav")])
        self.drums = HotswapFiltered(self, "Drums", [FakeItem("808 Core"), FakeItem("909 Core"),
                                                       folder("Drum Hits", [FakeItem("Kick Punch")])])
        drift = [folder("Bass", [FakeItem("Sub Bass.adv"), FakeItem("Wobble.adv")]),
                 folder("Pad", [FakeItem("Warm Pad.adv"), FakeItem("Pad Rack.adg")])]
        self.instruments = folder("Instruments", [FakeItem("Drift", drift, device=True), FakeItem("Simpler", device=True)])
        self.user_folders = []
        self.song = None  # for loading onto the selected track
        self._target = None
        self.loaded = []  # (item name, hotswap target)
        self.previews = []

    @property
    def hotswap_target(self):
        return self._target

    @hotswap_target.setter
    def hotswap_target(self, target):
        if isinstance(target, FakeRack):
            raise RuntimeError("Couldn't set hotswap target")  # as Live does for racks
        self._target = target

    def load_item(self, item):
        target = self.hotswap_target
        self.loaded.append((item.name, target))
        kits = [i for i in getattr(self.drums, "_all", []) if not i.is_folder]
        if target is None and item in kits and self.song is not None:
            # A kit loaded onto a drum track replaces its Drum Rack.
            devices = self.song.view.selected_track.devices
            old = next((d for d in devices if isinstance(d, FakeRack)), None)
            if old is not None:
                new = FakeRack(loaded=range(36, 52))
                new.name = item.name
                devices[devices.index(old)] = new
        elif target is None and item.name[-4:] in (".adv", ".adg") and self.song is not None:
            # An instrument preset loaded onto the selected track replaces its instrument (a .adg is a rack).
            devices = self.song.view.selected_track.devices
            old = next((d for d in devices if isinstance(d, FakeDevice) and d.type == 1), None)
            new = FakeDevice(item.name[:-4], type=1)
            if item.name.endswith(".adg"):
                new.class_display_name = "Instrument Rack"
            elif old is not None:
                new.class_display_name = old.class_display_name
            if old is not None:
                devices[devices.index(old)] = new
                old._deleted = True
            else:
                devices.insert(0, new)

    def preview_item(self, item):
        self.previews.append(item.name)

    def stop_preview(self):
        pass


class FakeHost(object):
    def __init__(self, song=None):
        self.song = song or FakeSong()
        self.sent = []
        self.t = 1000.0
        self.note_repeat = Obj(enabled=False, repeat_rate=0.25)
        self.rebuilds = 0
        self.keys_rebuilds = 0
        self.loaded = []
        self.browser = FakeBrowser()
        self.browser.song = self.song
        self.logs = []
        self.zooms = []
        self.views = []

    def send(self, msg):
        self.sent.append(tuple(msg))

    # Chop: Live's calls, as the controller sees them.
    def create_midi_track(self, index, name):
        track = FakeTrack(name, (), len(self.song.scenes))
        self.song.tracks.insert(index, track)
        return track

    def insert_simpler(self, track, path):
        if not getattr(self, "can_insert", True):
            return False
        simpler = FakeSimpler()
        simpler.replace_sample(path)
        track.devices.append(simpler)
        return True

    def load_onto_track(self, track, item):
        self.song.view.selected_track = track
        track.devices.append(FakeSimpler(FakeSample("/s/" + item.name)))

    def add_device(self, track, name, index=None):
        """Live's insert_device: the matching fake effect at `index` (or, with devices_later, not yet)."""
        if getattr(self, "devices_later", False):
            return
        make = {"Compressor": lambda: FakeCompressor(self.song), "Auto Filter": FakeAutoFilter, "EQ Three": FakeEq3,
                "Saturator": FakeSaturator}[name]
        track.devices.insert(len(track.devices) if index is None else index, make())

    def delete_device(self, track, device):
        track.devices.remove(device)

    def set_enum(self, obj, prop, index):
        setattr(obj, prop, index)

    def slice_to_drum_rack(self, simpler):
        for track in self.song.tracks:
            if simpler in track.devices:
                n = len(simpler.sample.slices)
                track.devices[track.devices.index(simpler)] = FakeRack(loaded=range(36, 36 + n))
                return True
        return False

    def log(self, msg):
        self.logs.append(msg)

    def show_view(self, name):
        self.views.append(name)

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

    def device_banks(self, device):
        params = list(device.parameters)[1:]
        return [params[i:i + 8] for i in range(0, len(params), 8)]

    def add_note(self, clip, pitch, start, duration, velocity):
        clip.add_new_notes([FakeNote(pitch, start, duration, velocity)])

    def quantize(self, clip, grid):
        clip.quantize(grid, 1.0)

    def all_scales(self):
        return [("Major", (0, 2, 4, 5, 7, 9, 11)), ("Minor", (0, 2, 3, 5, 7, 8, 10)), ("Dorian", (0, 2, 3, 5, 7, 9, 10))]

    def zoom(self, direction, horizontal):
        self.zooms.append((direction, horizontal))
