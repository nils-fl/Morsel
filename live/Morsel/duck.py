# Ducking (Morsel's sidechain ducker) with Live's own way of doing it: a Compressor at the end of the track, its
# sidechain fed by another track, by default the drum track's kick chain (Live lists a Drum Rack's chains as a
# sidechain's channels). The DUCK page (after TRK) turns it on and off and sets it. Unlike Morsel's, which dips on
# each sequenced hit, a Compressor follows the kick's sound.
# Live's calls go through the host; the routing (Compressor's input_routing_type / _channel) is set here.
from . import pages as PG

COMPRESSOR = "Compressor2"  # the class Live's Compressor has
LOAD_TIMEOUT = 3.0  # s for a Compressor loaded through the browser to appear
# Morsel-like starting point: deep, quick down, back within a beat.
DEFAULTS = {"Ratio": 1.0, "Attack": 0.1, "Release": 0.35, "Threshold": 0.55}  # 0..1 of each parameter's range
KICK_WORDS = ("kick", "bassdrum", "bass drum", "bd ")


def pad_channels(channels):
    """The sidechain channels worth offering, as (short label, channel). Live lists six per Drum Rack pad ("Kit | Pad |
    Pre FX / Post FX / Post Mixer", and again a level deeper with the sample's name): only each pad's own Post FX is
    kept (after its effects), named by the pad, and the whole track's Post FX as "Whole track". Anything else (a
    track without a rack) is offered as Live names it."""
    out = []
    for ch in channels:
        parts = [p.strip() for p in ch.display_name.split("|")]
        if parts == ["Post FX"]:
            out.insert(0, ("Whole track", ch))
        elif len(parts) == 3 and parts[2] == "Post FX":
            out.append((parts[1], ch))
    return out or [(ch.display_name or "-", ch) for ch in channels]


def short_channel(name):
    """"505 Core Kit | Bassdrum | Post FX" -> "Bassdrum"; the track's own taps -> ""."""
    parts = [p.strip() for p in name.split("|")]
    if len(parts) >= 3:
        return parts[1]
    return "" if parts[-1] in ("Post FX", "Post Mixer", "Pre FX", "") else name


def is_duck(device):
    """A Compressor with its sidechain on: ours, or one set up the same way in Live."""
    if getattr(device, "class_name", "") != COMPRESSOR:
        return False
    on = param(device, "S/C On")
    return on is not None and on.value > 0


def param(device, name):
    return next((p for p in device.parameters if p.name == name), None)


def set_fraction(p, f):
    """A parameter to a fraction of its range."""
    if p is not None:
        p.value = p.min + (p.max - p.min) * f


class Duck(object):
    def __init__(self, controller):
        self.c = controller
        self.pending = None  # (track, since, compressors before): a Compressor asked for, not there yet
        self.choosing = None  # (Compressor, since): its source just set, waiting for Live to list the pads

    def find(self, track):
        return next((d for d in getattr(track, "devices", []) if is_duck(d)), None)

    def _compressors(self, track):
        return [d for d in getattr(track, "devices", []) if getattr(d, "class_name", "") == COMPRESSOR]

    # ---- on / off -----------------------------------------------------------------------------------------------

    def toggle(self, direction):
        """Duck encoder: right adds the duck, left removes it."""
        track = self.c.sel_track()
        duck = self.find(track)
        if direction > 0 and duck is None and self.pending is None:
            self.pending = (track, self.c.host.now(), len(self._compressors(track)))
            self.c.host.add_device(track, "Compressor")
            self.tick(self.c.host.now())  # set it up now if Live put it there at once
        elif direction < 0 and duck is not None:
            self.c.host.delete_device(track, duck)
            self.c.show_temp("Duck", "Off")

    def tick(self, now):
        """Set up the Compressor once it's on the track (loaded through the browser it can take a moment), then pick
        the kick once Live lists the source's channels."""
        if self.choosing is not None:
            self._choose_kick(now)
        if self.pending is None:
            return
        track, since, before = self.pending
        comps = self._compressors(track)
        if len(comps) > before:
            self.pending = None
            self.setup(track, comps[-1])
        elif now - since > LOAD_TIMEOUT:
            self.pending = None
            self.c.show_temp("Duck", "No Compressor")

    def setup(self, track, comp):
        """Sidechain on, Morsel-like timing, and the source: the drum track's kick, if there's one."""
        set_fraction(param(comp, "S/C On"), 1.0)
        for name, f in DEFAULTS.items():
            set_fraction(param(comp, name), f)
        types = list(comp.available_input_routing_types)
        self.c.host.log("Morsel Duck: sidechain sources %s" % [t.display_name for t in types])
        src = self._drum_track(track)
        pick = next((t for t in types if src is not None and t.display_name == src.name), None)
        if pick is not None:
            comp.input_routing_type = pick
            # Live lists the new source's channels (a Drum Rack's chains among them) a moment later.
            self.choosing = (comp, self.c.host.now())
            self._choose_kick(self.c.host.now())
        self.c.show_temp("Duck", "From %s" % self.source_label(comp))

    CHOOSE_TIMEOUT = 2.0  # s for Live to list the source's channels

    def _choose_kick(self, now):
        comp, since = self.choosing
        try:
            channels = list(comp.available_input_routing_channels)
        except Exception:  # the Compressor was deleted
            self.choosing = None
            return
        names = [ch.display_name for ch in channels]
        if not any(names) and now - since < self.CHOOSE_TIMEOUT:
            return  # not listed yet
        self.choosing = None
        self.c.host.log("Morsel Duck: %s's channels %s" % (getattr(comp.input_routing_type, "display_name", "?"), names))
        kick = next((ch for label, ch in pad_channels(channels) if any(w in label.lower() + " " for w in KICK_WORDS)),
                    None)
        if kick is not None:
            comp.input_routing_channel = kick
            self.c.show_temp("Duck", "From %s" % self.source_label(comp))

    def _drum_track(self, track):
        """The first drum track other than `track`."""
        for t in self.c.tracks():
            if t != track and self.c.drum_rack(t) is not None:
                return t
        return None

    # ---- the page -----------------------------------------------------------------------------------------------

    def source_label(self, comp):
        """"Drums Bassdrum", or just "Drums" for the whole track."""
        t = getattr(comp.input_routing_type, "display_name", "?")
        ch = short_channel(getattr(comp.input_routing_channel, "display_name", ""))
        return "%s %s" % (t, ch) if ch else t

    def _choice(self, name, options, current, put):
        labels = [o.display_name for o in options] or ["-"]
        names = [o.display_name for o in options]
        cur = getattr(current(), "display_name", None)
        return PG.ChoiceParam(name, labels, lambda: names.index(cur) if cur in names else 0,
                              lambda i: put(options[i]) if i < len(options) else None)

    def _pad_choice(self, comp):
        """Pad: one entry per Drum Rack pad (its Post FX), plus the whole track (see pad_channels)."""
        options = pad_channels(list(comp.available_input_routing_channels))
        names = [ch.display_name for _, ch in options]
        cur = getattr(comp.input_routing_channel, "display_name", None)

        def put(i):
            if i < len(options):
                comp.input_routing_channel = options[i][1]

        return PG.ChoiceParam("Pad", [label for label, _ in options] or ["-"],
                              lambda: names.index(cur) if cur in names else 0, put)

    def page(self, track):
        """DUCK: Duck (on / off), Source and Pad (the sidechain's track and chain), then the Compressor's Thresh,
        Ratio, Attack, Release and Mix."""
        comp = self.find(track)
        on = PG.ActionParam("Duck", self.toggle, lambda: "On" if comp is not None else
                            ("..." if self.pending is not None else "Off"))
        if comp is None:
            return PG.Page("DUCK", "DUCK", "Off: turn Duck right", [on])

        def set_type(t):
            comp.input_routing_type = t

        params = [
            on,
            self._choice("Source", list(comp.available_input_routing_types), lambda: comp.input_routing_type,
                         set_type),
            self._pad_choice(comp),
        ]
        for name, label in (("Threshold", "Thresh"), ("Ratio", "Ratio"), ("Attack", "Attack"),
                            ("Release", "Release"), ("Dry/Wet", "Mix")):
            p = param(comp, name)
            params.append(PG.LiveParam(p, label) if p is not None else None)
        return PG.Page("DUCK", "DUCK", "From %s" % self.source_label(comp), params)
