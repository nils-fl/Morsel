# The FX page: Morsel's Track FX (filter, EQ, drive, comp) with Live's own effects at the end of the track, each
# added the first time its encoder is turned: Auto Filter, EQ Three, Saturator and a Compressor (without sidechain,
# so not the duck's, which stays last). Cutoff, Reso and the EQ are Live's parameters (turned through Live's MIDI map
# where encoders are mapped); Filter, Drive and Comp are the script's, as they switch their effect on and off.
from . import pages as PG
from .duck import is_duck, param

LOAD_TIMEOUT = 3.0  # s for an effect loaded through the browser to appear
ORDER = ["filter", "eq", "drive", "comp"]  # the order they go in on the track
BROWSER_NAME = {"filter": "Auto Filter", "eq": "EQ Three", "drive": "Saturator", "comp": "Compressor"}
CLASSES = {"filter": ("AutoFilter2", "AutoFilter"), "eq": ("FilterEQ3",), "drive": ("Saturator",),
           "comp": ("Compressor2",)}
FILTERS = ["Off", "LP", "HP", "BP"]
FILTER_WORDS = {"LP": "low", "HP": "high", "BP": "band"}  # matched against Filter Type's names
COMP_DEPTH = 0.45  # Comp at 100 %: the threshold this far down its range (about -30 dB on Live's Compressor)


def _on(device):
    p = param(device, "Device On")
    return p is None or p.value > 0


def _set_on(device, on):
    p = param(device, "Device On")
    if p is not None and (p.value > 0) != on:
        p.value = 1.0 if on else 0.0


class TrackFx(object):
    def __init__(self, controller):
        self.c = controller
        self.pending = {}  # kind -> (track, since, how many there were, then: what to do once it's there)

    # ---- finding and adding -------------------------------------------------------------------------------------

    def find(self, track, kind):
        for d in getattr(track, "devices", []):
            if getattr(d, "class_name", "") in CLASSES[kind] and not (kind == "comp" and is_duck(d)):
                return d
        return None

    def _count(self, track, kind):
        return len([d for d in getattr(track, "devices", []) if getattr(d, "class_name", "") in CLASSES[kind]
                    and not (kind == "comp" and is_duck(d))])

    def _insert_index(self, track, kind):
        """Before the effects that come after it (ORDER) and before the duck, else at the end."""
        later = ORDER[ORDER.index(kind) + 1:]
        devices = list(getattr(track, "devices", []))
        for i, d in enumerate(devices):
            if is_duck(d) or any(getattr(d, "class_name", "") in CLASSES[k] for k in later):
                return i
        return len(devices)

    def add(self, track, kind, then=None):
        """Put the effect on the track (once), then call `then(device)` when it's there."""
        if kind in self.pending:
            return
        self.pending[kind] = (track, self.c.host.now(), self._count(track, kind), then)
        self.c.host.add_device(track, BROWSER_NAME[kind], self._insert_index(track, kind))
        self.tick(self.c.host.now())  # Live may have put it there at once

    def tick(self, now):
        for kind, (track, since, before, then) in list(self.pending.items()):
            if self._count(track, kind) > before:
                del self.pending[kind]
                if then is not None:
                    then(self.find(track, kind))
                self.c.request_draw()
            elif now - since > LOAD_TIMEOUT:
                del self.pending[kind]
                self.c.show_temp("FX", "No %s" % BROWSER_NAME[kind])

    def ensure(self, track, kind, then):
        """`then(device)` now if the effect is there, else once it's been added."""
        d = self.find(track, kind)
        if d is not None:
            then(d)
        else:
            self.add(track, kind, then)

    # ---- filter -------------------------------------------------------------------------------------------------

    def filter_index(self, track):
        d = self.find(track, "filter")
        if d is None or not _on(d):
            return 0
        kind = param(d, "Filter Type")
        items = [str(n).lower() for n in getattr(kind, "value_items", [])] if kind is not None else []
        name = items[int(kind.value)] if kind is not None and 0 <= int(kind.value) < len(items) else ""
        for i, label in enumerate(FILTERS[1:], 1):
            if FILTER_WORDS[label] in name:
                return i
        return 1

    def set_filter(self, track, i):
        if i == 0:
            d = self.find(track, "filter")
            if d is not None:
                _set_on(d, False)
            return

        def setup(d):
            _set_on(d, True)
            kind = param(d, "Filter Type")
            items = [str(n).lower() for n in getattr(kind, "value_items", [])] if kind is not None else []
            match = next((j for j, n in enumerate(items) if FILTER_WORDS[FILTERS[i]] in n), None)
            if match is not None:
                kind.value = match

        self.ensure(track, "filter", setup)

    # ---- amounts: drive and comp (0 = their effect off) ---------------------------------------------------------

    def drive_amount(self, track):
        d = self.find(track, "drive")
        p = param(d, "Drive") if d is not None else None
        if p is None or not _on(d):
            return 0.0
        mid = (p.min + p.max) / 2.0  # 0 dB on Saturator's -36..+36
        return max(0.0, min(1.0, (p.value - mid) / ((p.max - mid) or 1.0)))

    def set_drive(self, track, a):
        def setup(d):
            p = param(d, "Drive")
            _set_on(d, a > 0)
            if p is not None:
                mid = (p.min + p.max) / 2.0
                p.value = mid + (p.max - mid) * a

        if a > 0 or self.find(track, "drive") is not None:
            self.ensure(track, "drive", setup)

    def comp_amount(self, track):
        d = self.find(track, "comp")
        p = param(d, "Threshold") if d is not None else None
        if p is None or not _on(d):
            return 0.0
        return max(0.0, min(1.0, (p.max - p.value) / (COMP_DEPTH * ((p.max - p.min) or 1.0))))

    def set_comp(self, track, a):
        def setup(d):
            p = param(d, "Threshold")
            _set_on(d, a > 0)
            if p is not None:
                p.value = p.max - COMP_DEPTH * (p.max - p.min) * a

        if a > 0 or self.find(track, "comp") is not None:
            self.ensure(track, "comp", setup)

    # ---- the page -----------------------------------------------------------------------------------------------

    def _live_or_add(self, track, kind, name, label, then=None):
        """The effect's parameter as a Live one; without the effect, a turn adds it."""
        d = self.find(track, kind)
        p = param(d, name) if d is not None else None
        if p is not None:
            return PG.LiveParam(p, label)
        return PG.ActionParam(label, lambda delta: self.add(track, kind, then),
                              lambda: "..." if kind in self.pending else "Add")

    def summary(self, track):
        on = []
        f = self.filter_index(track)
        if f:
            on.append(FILTERS[f])
        eq = self.find(track, "eq")
        if eq is not None and _on(eq):
            on.append("EQ")
        if self.drive_amount(track) > 0:
            on.append("Drive")
        if self.comp_amount(track) > 0:
            on.append("Comp")
        return " ".join(on) or "Off"

    def page(self, track):
        """FX: Filter, Cutoff, Reso, Low, Mid, High, Drive, Comp (see the top of this file)."""
        def lp(d):
            self.set_filter(track, 1)

        pct = lambda v: "%d%%" % round(v * 100)
        params = [
            PG.ChoiceParam("Filter", FILTERS, lambda: self.filter_index(track), lambda i: self.set_filter(track, i)),
            self._live_or_add(track, "filter", "Frequency", "Cutoff", lp),
            self._live_or_add(track, "filter", "Resonance", "Reso", lp),
            self._live_or_add(track, "eq", "GainLo", "Low"),
            self._live_or_add(track, "eq", "GainMid", "Mid"),
            self._live_or_add(track, "eq", "GainHi", "High"),
            PG.ValueParam("Drive", lambda: self.drive_amount(track), lambda v: self.set_drive(track, v), 0.0, 1.0, 0.02,
                          pct),
            PG.ValueParam("Comp", lambda: self.comp_amount(track), lambda v: self.set_comp(track, v), 0.0, 1.0, 0.02,
                          pct),
        ]
        return PG.Page("FX", "FX", self.summary(track), params)
