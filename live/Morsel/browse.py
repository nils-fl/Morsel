# Browse mode: Live's browser on the Launchkey screen, like Morsel's MPC-style Browse (app/src/modes/browse.ts).
# Samples load onto the selected Drum Rack pad, a kit from Drums replaces the Drum Rack, anything else loads onto the pad
# (drum track) or the track. Samples preview as the cursor lands on them.
# Loading onto a pad works like Push's browser (pushbase/browser_modes.py): the browser's hot-swap target is the
# selected pad for as long as Browse is open (set on entering and when the pad changes, with the device chain shown),
# and is cleared only on leaving.
# No Live import: the browser is duck-typed (Live.Application.get_application().browser, through the host).
from . import protocol as P

PREVIEW_DELAY = 0.15  # s
PRESET_LOAD_DELAY = 0.15  # s the cursor rests on a preset before it loads (a key loads it at once)
KIT_LOAD_DELAY = 0.3  # s the same for a kit in Drums: a whole Drum Rack takes Live longer to load
INSTRUMENT = 1  # Live.Device.DeviceType.instrument
MAX_STEP = 3  # entries a quick encoder turn moves at most
UNITS_PER_ENTRY = 2  # encoder messages per entry: the encoders have no detents, one message is a very small turn
TURN_IDLE = 0.5  # s: a turn after this long starts counting afresh
SAMPLE_EXTENSIONS = (".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a", ".alac")

# The browser's top level: (label, attribute of Live's Browser), in Live's order. Missing ones are left out.
CATEGORIES = [
    ("Sounds", "sounds"), ("Drums", "drums"), ("Instruments", "instruments"), ("Audio Effects", "audio_effects"),
    ("MIDI Effects", "midi_effects"), ("Plugins", "plugins"), ("Clips", "clips"), ("Samples", "samples"),
    ("Packs", "packs"), ("User Library", "user_library"), ("Current Project", "current_project"),
]


def is_sample(item):
    return getattr(item, "name", "").lower().endswith(SAMPLE_EXTENSIONS)  # a plug-in preset is only an index


def is_folder(item):
    """Something to open: a folder, or a device with presets under it (Shift + Func loads the device itself)."""
    if getattr(item, "is_folder", False) or not getattr(item, "is_loadable", False):
        return True
    return getattr(item, "is_device", False) and len(item.children) > 0


class PresetList(object):
    """An instrument's presets as one list (Live keeps them in folders under the device): looks like a browser
    folder, for BrowseMode's path."""

    def __init__(self, device_item):
        self.name = device_item.name
        self._item = device_item
        self._children = None

    @property
    def children(self):
        if self._children is None:
            self._children = []
            self._collect(self._item)
        return self._children

    def _collect(self, item):
        """Live's order: each folder's presets where the folder is."""
        for child in item.children:
            if getattr(child, "is_folder", False) or not getattr(child, "is_loadable", False):
                self._collect(child)
            else:
                self._children.append(child)


class PluginPresets(object):
    """A plug-in's own presets (PluginDevice.presets): picked by index, at once, with nothing to load."""

    def __init__(self, device):
        self.name = device.name
        self.names = list(device.presets)


def preset_name(name):
    """"Warm Pad.adv" -> "Warm Pad" (Live names a device after the preset it loaded, without the extension)."""
    return name[:-4] if name[-4:].lower() in (".adv", ".adg") else name


def instrument(track):
    """The track's instrument device, or None."""
    for d in getattr(track, "devices", []):
        if getattr(d, "type", None) == INSTRUMENT:
            return d
    return None


def initial(name):
    c = name[:1].upper()
    return c if c.isalpha() else "#"


def jump_letter(names, index, direction):
    """The first entry of the next letter (right), or the start of this / the previous letter group (left)."""
    if not names:
        return 0
    cur = initial(names[index])
    if direction > 0:
        for i in range(index + 1, len(names)):
            if initial(names[i]) != cur:
                return i
        return index
    i = index
    while i > 0 and initial(names[i - 1]) == cur:
        i -= 1
    if i < index or i == 0:
        return i
    prev = initial(names[i - 1])
    i -= 1
    while i > 0 and initial(names[i - 1]) == prev:
        i -= 1
    return i


class BrowseMode(object):
    def __init__(self, controller):
        self.c = controller
        self.path = []  # [(label, item)] from the top level down
        self.history = []  # the cursor in each parent, restored going up
        self.index = 0
        # Cached listing of the current folder: [(label, item, is a folder)]. Worked out once per folder: the screen
        # redraws ten times a second, and asking Live's browser about every entry each time is slow.
        self._entries = None
        self.preview_at = None
        self.load_at = None  # when the preset under the cursor loads (in an instrument's preset list)
        self.loaded_index = None  # the preset in the list that's on the instrument
        self.previewing = False
        self.turn = 0  # encoder messages not yet a whole entry
        self.turned_at = 0.0
        self.refused = None  # a hot-swap target Live refused: not asked again every tick
        self.kits_track = None  # the drum track Drums' kits load onto, while that list is open
        self.target = None  # the hot-swap target we set last (Live may move it to what got loaded)

    # ---- the listing --------------------------------------------------------------------------------------------

    @property
    def browser(self):
        return self.c.host.browser

    def entries(self):
        if self._entries is None:
            if not self.path:
                self._entries = [(label, getattr(self.browser, attr), True) for label, attr in CATEGORIES
                                 if getattr(self.browser, attr, None) is not None]
                self._entries += [(f.name, f, True) for f in getattr(self.browser, "user_folders", [])]
            elif self.in_plugin_presets():
                self._entries = [(name, i, False) for i, name in enumerate(self.path[-1][1].names)]
            elif self.in_presets():
                self._entries = [(preset_name(item.name), item, False) for item in self.path[-1][1].children]
            else:
                self._entries = [(item.name, item, is_folder(item)) for item in self.listed_children()]
        return self._entries

    def listed_children(self):
        """The open folder's children. Live filters the browser to what fits the hot-swap target, and for a pad
        that hides the kits at the top of Drums; so Drums is listed with the target cleared, then set again."""
        folder = self.path[-1][1]
        is_drums = self.at_drums_top()
        if not is_drums:
            return folder.children
        self._set_target(None)
        children = list(folder.children)
        if self.target is not None:
            self._set_target(self.target)
        return children

    def current(self):
        e = self.entries()
        return e[self.index][1] if 0 <= self.index < len(e) else None

    def folder_label(self):
        return self.path[-1][0] if self.path else "Top"

    def can_enter(self):
        return len(self.entries()) > 0

    def can_up(self):
        return len(self.path) > 0

    def on_sample(self):
        item = self.current()
        return item is not None and is_sample(item)

    def on_folder(self):
        e = self.entries()
        return 0 <= self.index < len(e) and e[self.index][2]

    # ---- moving -------------------------------------------------------------------------------------------------

    def move(self, delta):
        n = len(self.entries())
        self.index = max(0, min(n - 1, self.index + delta)) if n else 0
        self.schedule_preview()

    def encoder(self, index, delta):
        """Encoders 1 and 8 scroll, 2 and 7 jump by letter, so either hand can browse."""
        if index in (0, 7):
            # A slow turn moves one entry per UNITS_PER_ENTRY messages, so the cursor stops on every entry; a quick
            # turn (bigger deltas) moves faster, MAX_STEP at most.
            now = self.c.host.now()
            if now - self.turned_at > TURN_IDLE or (delta > 0) != (self.turn > 0):
                self.turn = 0
            self.turned_at = now
            self.turn += delta
            steps = int(self.turn / UNITS_PER_ENTRY)
            if steps:
                self.turn -= steps * UNITS_PER_ENTRY
                self.move(max(-MAX_STEP, min(MAX_STEP, steps)))
        elif index in (1, 6):
            self.index = jump_letter([e[0] for e in self.entries()], self.index, 1 if delta > 0 else -1)
            self.schedule_preview()

    def enter_folder(self, label, item):
        self.loaded_index = None
        self.history.append(self.index)
        self.path.append((label, item))
        self.index = 0
        self._entries = None
        self._arrived()
        self.schedule_preview()
        self.load_at = None  # arriving loads nothing: the cursor has to rest on something

    def up(self):
        if not self.path:
            return
        self.path.pop()
        self.index = self.history.pop() if self.history else 0
        self._entries = None
        self._arrived()
        self.schedule_preview()
        self.load_at = None

    # ---- preview ------------------------------------------------------------------------------------------------

    def schedule_preview(self):
        if self.previewing or self.preview_at is not None:
            self.stop_preview()
        if self.on_sample():
            self.preview_at = self.c.host.now() + PREVIEW_DELAY
        # In an instrument's presets or Drums' kits, the one under the cursor loads once the cursor rests, so the
        # keys (and in the kits, the pads) play it.
        if self.in_presets():
            self.load_at = self.c.host.now() + PRESET_LOAD_DELAY
        elif self.in_kits() and not self.on_folder():
            self.load_at = self.c.host.now() + KIT_LOAD_DELAY
        else:
            self.load_at = None
        if self.in_plugin_presets():
            self.select_plugin_preset()  # a plug-in switches at once

    def preview(self):
        item = self.current()
        if item is not None and is_sample(item):
            self.browser.preview_item(item)
            self.previewing = True

    def stop_preview(self):
        self.preview_at = None
        self.previewing = False
        self.browser.stop_preview()

    def tick(self, now):
        self.retarget()  # the pad picked in Live, or a kit just loaded
        if self.preview_at is not None and now >= self.preview_at:
            self.preview_at = None
            self.preview()
        if self.load_at is not None and now >= self.load_at:
            self.load_listed()

    # ---- the instrument's presets (keys tracks) -----------------------------------------------------------------

    def in_presets(self):
        return bool(self.path) and isinstance(self.path[-1][1], PresetList)

    def in_plugin_presets(self):
        return bool(self.path) and isinstance(self.path[-1][1], PluginPresets)

    def select_plugin_preset(self):
        dev = instrument(self.c.sel_track())
        if dev is not None and 0 <= self.index < len(getattr(dev, "presets", None) or ()):
            dev.selected_preset_index = self.index

    def open_presets(self):
        """Browse on a track with an instrument: straight to its presets, the cursor on the one loaded. A plug-in
        lists its own presets. False when there are none (a rack, a plug-in without presets): Browse then opens
        where it was."""
        dev = instrument(self.c.sel_track())
        if dev is not None and getattr(dev, "presets", None):
            self.path = [(dev.name, PluginPresets(dev))]
            self.history = [0]
            self._entries = None
            self.index = max(0, min(len(self.entries()) - 1, getattr(dev, "selected_preset_index", 0)))
            return True
        instruments = getattr(self.browser, "instruments", None)
        if dev is None or instruments is None:
            return False
        name = getattr(dev, "class_display_name", dev.name)
        item = next((i for i in instruments.children if i.name == name and len(i.children)), None)
        if item is None:
            return False
        presets = PresetList(item)
        self.path = [("Instruments", instruments), (name, presets)]
        self.history = [0, 0]
        self._entries = None
        names = [e[0] for e in self.entries()]
        self.index = names.index(dev.name) if dev.name in names else 0
        self.loaded_index = self.index
        return True

    def load_preset(self):
        """The preset under the cursor onto the track, replacing its instrument, unless it's loaded already."""
        self.load_at = None
        item = self.current()
        if not self.in_presets() or item is None or self.index == self.loaded_index:
            return None
        track = self.c.sel_track()
        # Loaded onto the track, which replaces its instrument, rather than hot-swapped: an instrument preset can
        # be a rack (.adg), and Live refuses a rack as a hot-swap target, so the next preset wouldn't load.
        self._set_target(None)
        self.browser.load_item(item)
        # Live has replaced the device now: the old one raises on any read.
        self.loaded_index = self.index
        return "LOADED > %s" % track.name.upper(), preset_name(item.name)

    def in_kits(self):
        """Drums' own list (its kits) on a drum track: kits load as the cursor rests, and the pads play them. The
        track counts as a drum track for as long as the list is open, whatever kit got loaded: some kits are an
        Instrument Rack around a Drum Rack, and the pads would otherwise stop playing after one of those."""
        return self.at_drums_top() and self.kits_track is not None and self.c.sel_track() == self.kits_track

    def _arrived(self):
        """Opening Drums (down into it, back up to it, or opening Browse there) on a drum track: that's the track
        its kits load onto."""
        if not self.at_drums_top():
            return
        track = self.c.sel_track()
        if track != self.kits_track:
            self.kits_track = track if self.c.drum_rack(track) is not None else None

    def pad_layout(self):
        """The pads play the kit in Drums' list; elsewhere they pick a pad (or preview) and come to the script."""
        return "drum" if self.in_kits() else "daw"

    def load_listed(self):
        """The preset or kit under the cursor, unless it's the one loaded already. Returns the popup, or None."""
        self.load_at = None
        if self.in_presets():
            return self.load_preset()
        item = self.current()
        if not self.in_kits() or item is None or self.on_folder() or self.index == self.loaded_index:
            return None
        popup = self.load(item)  # replaces the Drum Rack
        self.loaded_index = self.index
        return popup

    def on_key(self):
        """A key while the cursor waits on a preset or kit: load it now (that note may still be the old sound)."""
        if self.load_at is not None:
            self.load_listed()

    def enter(self):
        self.target = None
        self.kits_track = None
        self._arrived()
        if self.c.drum_rack(self.c.sel_track()) is None:
            self.open_presets()
        self.retarget()
        self.schedule_preview()
        self.load_at = None  # opening doesn't load: the cursor is on what's loaded

    def exit(self):
        self.load_at = None
        self.refused = None
        self.stop_preview()
        self._set_target(None)
        self.target = None

    def retarget(self):
        """Point the hot-swap target at the selected pad (drum track) when that changed; nothing on other tracks."""
        rack = self.c.drum_rack(self.c.sel_track())
        want = self._selected_pad(rack) if rack is not None else None
        if want is None or want == self.target or want == self.refused:
            return
        if self._set_target(want):
            self.target = want
            self.refused = None
            self.c.host.show_view("Detail/DeviceChain")
        else:
            self.refused = want

    # ---- loading ------------------------------------------------------------------------------------------------

    def _set_target(self, target):
        try:
            self.browser.hotswap_target = target
            return True
        except Exception as e:  # Live raises RuntimeError for something it can't hot-swap
            self.c.host.log("Morsel Browse: can't hot-swap %s: %r" % (getattr(target, "name", target), e))
            return False

    def _selected_pad(self, rack):
        return getattr(rack.view, "selected_drum_pad", None)

    def at_drums_top(self):
        """In the Drums category itself, known by the label Browse gave it (Live's browser items may not compare
        equal across reads)."""
        return len(self.path) == 1 and self.path[0][0] == "Drums"

    def _is_kit(self, item):
        """A whole Drum Rack: an item at the top of the Drums category, or anything named a kit."""
        return self.at_drums_top() or " kit" in item.name.lower()

    def load(self, item):
        """Load onto the selected pad (drum track), as a kit, or onto the track. Returns the popup."""
        track = self.c.sel_track()
        rack = self.c.drum_rack(track)
        name = item.name
        if rack is not None and not self._is_kit(item):
            dp = self._selected_pad(rack)
            if dp is None:
                return "Load", "Pick a pad"
            self.retarget()
            if self.target is None:
                return "Can't load", "on this pad"
            self.browser.load_item(item)
            n = P.DRUM_NOTES.index(dp.note) + 1 if dp.note in P.DRUM_NOTES else dp.note
            return "LOADED > PAD %s" % n, name
        if rack is not None:
            # A kit: the whole Drum Rack, loaded onto the track (which replaces its instrument) rather than
            # hot-swapped: Live may refuse a rack as a hot-swap target, and the kit then lands inside the selected
            # pad. Then point at the new rack's selected pad again.
            self._set_target(None)
            self.browser.load_item(item)
            self.target = None
            return "KIT LOADED", name
        self._set_target(None)
        self.target = None
        self.browser.load_item(item)
        return "LOADED > %s" % track.name.upper(), name

    def load_folder(self, folder):
        """A sample folder onto the drum track's pads: its first 16 samples, pad 1 to 16 in the Launchkey's order."""
        rack = self.c.drum_rack(self.c.sel_track())
        if rack is None:
            return "Folder", "Drum track only"
        samples = [item for item in folder.children if not is_folder(item) and is_sample(item)][:16]
        if not samples:
            return folder.name, "No samples"
        for i, item in enumerate(samples):
            dp = rack.drum_pads[P.DRUM_NOTES[i]]
            if self._set_target(dp):
                self.browser.load_item(item)
        self.target = None
        return "FOLDER > PADS 1-%d" % len(samples), folder.name

    def press(self):
        """Func / Pad down: open a folder, or load the item (and stay)."""
        e = self.entries()
        if not e:
            return None
        label, item, folder = e[self.index]
        if folder:
            self.enter_folder(label, item)
            return None
        if self.in_plugin_presets():
            return "PRESET", label  # already switched as the cursor landed
        if self.in_presets() or self.in_kits():
            return self.load_listed() or ("LOADED", label)  # or already loaded as the cursor rested
        return self.load(item)

    def shift_press(self):
        """Shift + Func: load and leave (returns (popup, leave)); a sample folder goes on the pads."""
        item = self.current()
        if item is None:
            return None, False
        if self.in_plugin_presets():
            return ("PRESET", self.entries()[self.index][0]), True
        if self.in_presets():
            return self.load_preset(), True
        if getattr(item, "is_loadable", False):
            return self.load(item), True
        return self.load_folder(item), True

    # ---- pads and LEDs ------------------------------------------------------------------------------------------

    def pad(self, pad):
        """A pad: on a drum track it picks that pad (to load onto); any pad previews the highlighted sample."""
        rack = self.c.drum_rack(self.c.sel_track())
        if rack is not None:
            rack.view.selected_drum_pad = rack.drum_pads[P.DRUM_NOTES[pad]]
            self.retarget()
        self.preview()

    def leds(self):
        track = self.c.sel_track()
        rack = self.c.drum_rack(track)
        if rack is None:
            return [(P.COLOR["dimWhite"], "static")] * 16
        if self.in_kits():
            # The pads play the loaded kit: its pads in their colours, as in Play mode.
            out = []
            for i in range(16):
                dp = rack.drum_pads[P.DRUM_NOTES[i]]
                out.append((self.c.pad_color(track, dp) if len(dp.chains) else P.COLOR["off"], "static"))
            return out
        sel = self._selected_pad(rack)
        out = []
        for i in range(16):
            dp = rack.drum_pads[P.DRUM_NOTES[i]]
            if dp == sel:
                out.append((P.COLOR["white"], "flash"))
            else:
                out.append((P.COLOR["dimWhite"] if len(dp.chains) else P.COLOR["off"], "static"))
        return out

    def target_label(self):
        """The pad things load onto ("P3"), on a drum track."""
        rack = self.c.drum_rack(self.c.sel_track())
        if rack is None:
            return ""
        dp = self._selected_pad(rack)
        if dp is None:
            return ""
        return "P%d" % (P.DRUM_NOTES.index(dp.note) + 1) if dp.note in P.DRUM_NOTES else "P-"
