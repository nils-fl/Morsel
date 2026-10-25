# Encoder pages over Live's parameters (the role of app/src/params.ts). No Live import: parameters are duck-typed
# DeviceParameters, and enum settings go through the host (Live wants its own enum values, not ints).
#
# A track shows one page per device (paging to one also selects it in Live, the blue hand), then TRK (its mixer),
# MIX (the levels of tracks 1-8) and GLB (tempo, swing, quantize, note repeat, launch quantize, metronome).

STEPPED = 4  # detents per step of a setting with only a few values, so a quick turn doesn't run through them all
FRESH_TURN = 0.4  # s: a turn after this long idle steps on its first detent
CONTINUOUS_STEPS = 100  # detents across a continuous parameter's range


def _sign(v):
    return (v > 0) - (v < 0)


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Param(object):
    name = ""
    detents = 1
    lo, hi = 0.0, 1.0

    def value(self):
        raise NotImplementedError

    def nudge(self, delta):
        """Apply `delta` detents (already divided down for stepped settings: one step per unit)."""
        raise NotImplementedError

    def format(self):
        raise NotImplementedError

    def level(self):
        return (self.value() - self.lo) / ((self.hi - self.lo) or 1.0)


class LiveParam(Param):
    """A Live DeviceParameter. Quantized ones (lists, on/off) step like Morsel's few-valued settings."""

    def __init__(self, p, name=None):
        self.p = p
        self.name = name or p.name
        self.lo, self.hi = float(p.min), float(p.max)
        self.detents = STEPPED if getattr(p, "is_quantized", False) else 1

    def value(self):
        return float(self.p.value)

    def nudge(self, delta):
        if not getattr(self.p, "is_enabled", True):
            return
        if self.detents > 1:
            v = round(self.p.value) + _sign(delta)
        else:
            v = self.p.value + delta * (self.hi - self.lo) / CONTINUOUS_STEPS
        self.p.value = _clamp(v, self.lo, self.hi)

    def format(self):
        try:
            return u"%s" % self.p.str_for_value(self.p.value)
        except Exception:
            return u"%s" % self.p


class ValueParam(Param):
    def __init__(self, name, get, put, lo, hi, step, fmt):
        self.name, self._get, self._put = name, get, put
        self.lo, self.hi, self._step, self._fmt = lo, hi, step, fmt

    def value(self):
        return float(self._get())

    def nudge(self, delta):
        self._put(_clamp(self._get() + delta * self._step, self.lo, self.hi))

    def format(self):
        return self._fmt(self._get())


class ChoiceParam(Param):
    detents = STEPPED

    def __init__(self, name, labels, get_index, put_index):
        self.name, self.labels, self._get, self._put = name, labels, get_index, put_index
        self.lo, self.hi = 0.0, float(len(labels) - 1)

    def value(self):
        return float(self._get())

    def nudge(self, delta):
        self._put(int(_clamp(self._get() + _sign(delta), 0, len(self.labels) - 1)))

    def format(self):
        i = self._get()
        return self.labels[i] if 0 <= i < len(self.labels) else "?"


class ActionParam(Param):
    """Not a value: each step of a turn does something (left or right), like Morsel's Double."""

    detents = STEPPED

    def __init__(self, name, act, fmt):
        self.name, self._act, self._fmt = name, act, fmt

    def value(self):
        return 0.0

    def level(self):
        return 0.0

    def nudge(self, delta):
        self._act(_sign(delta))

    def format(self):
        return self._fmt()


class Page(object):
    def __init__(self, key, tag, summary, params, device=None):
        self.key = key  # stays the same across rebuilds: "DEV0", "TRK", "MIX", "GLB"
        self.tag = tag  # footer tag
        self.summary = summary  # footer text
        self.params = (list(params) + [None] * 8)[:8]
        self.device = device  # a device page selects its device in Live


class Turner(object):
    """Turns encoders: continuous parameters move per detent; stepped ones need STEPPED detents a step, except the
    first detent of a fresh turn, which steps straight away."""

    def __init__(self):
        self._acc = {}
        self._last = {}

    def turn(self, key, param, delta, now):
        if param.detents <= 1:
            param.nudge(delta)
            return
        fresh = now - self._last.get(key, -1e9) > FRESH_TURN
        self._last[key] = now
        if fresh:
            self._acc[key] = 0
            param.nudge(_sign(delta))
            return
        acc = self._acc.get(key, 0) + delta
        while abs(acc) >= param.detents:
            param.nudge(_sign(acc))
            acc -= _sign(acc) * param.detents
        self._acc[key] = acc


LAUNCH_Q = ["None", "8 Bars", "4 Bars", "2 Bars", "1 Bar", "1/2", "1/2T", "1/4", "1/4T", "1/8", "1/8T", "1/16",
            "1/16T", "1/32"]
REC_Q = ["Off", "1/4", "1/8", "1/8T", "1/8+T", "1/16", "1/16T", "1/16+T", "1/32"]
REPEAT_RATES = [("1/8", 0.5), ("1/16", 0.25), ("1/16T", 1 / 6.0), ("1/32", 0.125)]
SEND_NAMES = "ABCDEFGHIJKL"


def device_tag(name):
    """Footer tag for a device page: its name without spaces, at most 6 characters, upper case like Morsel's tags."""
    return "".join(name.split())[:6].upper() or "DEV"


def device_pages(track, bank_for):
    pages = []
    for i, d in enumerate(getattr(track, "devices", [])):
        params = [LiveParam(p) if p is not None else None for p in bank_for(d)]
        pages.append(Page("DEV%d" % i, device_tag(d.name), d.name, params, device=d))
    return pages


def track_page(track, returns):
    m = track.mixer_device
    params = [LiveParam(m.volume, "Vol"), LiveParam(m.panning, "Pan")]
    for i, s in enumerate(list(m.sends)[:6]):
        name = returns[i].name if i < len(returns) else "Send %s" % SEND_NAMES[i]
        params.append(LiveParam(s, "Snd" + SEND_NAMES[i]) if len(name) > 5 else LiveParam(s, name))
    return Page("TRK", "TRK", track.name, params)


def mix_page(tracks):
    params = [LiveParam(t.mixer_device.volume, "%d%s" % (i + 1, t.name)) for i, t in enumerate(tracks[:8])]
    return Page("MIX", "MIX", "Levels T1-%d" % min(8, len(tracks)), params)


def global_page(song, host, repeat):
    """`repeat`: [index] into REPEAT_RATES, shared with the controller (note repeat uses it)."""

    def set_repeat(i):
        repeat[0] = i

    params = [
        ValueParam("Tempo", lambda: song.tempo, lambda v: setattr(song, "tempo", v), 20.0, 999.0, 1.0,
                   lambda v: "%.0f" % v),
        ValueParam("Swing", lambda: song.swing_amount, lambda v: setattr(song, "swing_amount", v), 0.0, 1.0, 0.01,
                   lambda v: "%d%%" % round(v * 100)),
        ChoiceParam("RecQ", REC_Q, lambda: int(song.midi_recording_quantization), host.set_record_quantization),
        ChoiceParam("Rept", [r[0] for r in REPEAT_RATES], lambda: repeat[0], set_repeat),
        ChoiceParam("Launch", LAUNCH_Q, lambda: int(song.clip_trigger_quantization), host.set_launch_quantization),
        ChoiceParam("Metro", ["Off", "On"], lambda: int(song.metronome), lambda i: setattr(song, "metronome", bool(i))),
    ]
    summary = "%.0f BPM Rpt %s" % (song.tempo, REPEAT_RATES[repeat[0]][0])
    return Page("GLB", "GLB", summary, params)


def pages_for(song, track, host, repeat):
    tracks = list(song.tracks)
    pages = device_pages(track, host.device_bank)
    if hasattr(track, "mixer_device"):
        pages.append(track_page(track, list(song.return_tracks)))
    pages.append(mix_page(tracks))
    pages.append(global_page(song, host, repeat))
    return pages
