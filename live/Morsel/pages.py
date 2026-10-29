# Encoder pages over Live's parameters (the role of app/src/params.ts). No Live import: parameters are duck-typed
# DeviceParameters, and enum settings go through the host (Live wants its own enum values, not ints).
#
# A track shows its devices (their best 8 parameters, then the rest 8 at a time; paging to one also selects it in
# Live, the blue hand), then TRK (its mixer), MIX (the levels of tracks 1-8), GLB (tempo, groove, quantize, note
# repeat, launch quantize) and POS (position, loop, markers, zoom).

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
    """Not a value: each step of a turn does something (left or right), like Morsel's Double. With detents=1 every
    detent acts, and `act` gets how many (moving through a song, zooming)."""

    def __init__(self, name, act, fmt, detents=STEPPED):
        self.name, self._act, self._fmt, self.detents = name, act, fmt, detents

    def value(self):
        return 0.0

    def level(self):
        return 0.0

    def nudge(self, delta):
        self._act(delta if self.detents <= 1 else _sign(delta))

    def format(self):
        return self._fmt()


class Page(object):
    def __init__(self, key, tag, summary, params, device=None):
        """`params`: the 8 params, or a function making them: device pages make theirs only when shown, as every
        parameter read is a call into Live."""
        self.key = key  # stays the same across rebuilds: "DEV0", "TRK", "MIX", "GLB"
        self.tag = tag  # footer tag
        self.summary = summary  # footer text
        self._params = params
        self.device = device  # a device page selects its device in Live

    @property
    def params(self):
        if callable(self._params):
            self._params = self._params()
        if len(self._params) != 8:
            self._params = (list(self._params) + [None] * 8)[:8]
        return self._params


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
GROOVE_MAX = 1.3125  # Live's Global Groove Amount goes to 131 %


def device_tag(name):
    """Footer tag for a device page: its name without spaces, at most 6 characters, upper case like Morsel's tags."""
    return "".join(name.split())[:6].upper() or "DEV"


class BankCache(object):
    """Each device's banks (lists of DeviceParameters), worked out once: listing them reads every parameter, and the
    pages are built on every tick and event. A device is known by == (Live hands out a new wrapper each read) and its
    parameter count (a plug-in's can change)."""

    def __init__(self):
        self._entries = []  # (device, parameter count, banks)

    def banks(self, device, host):
        n = len(device.parameters)
        for d, count, banks in self._entries:
            if d == device and count == n:
                return banks
        best = host.device_bank(device)
        banks = [best] + [b for b in host.device_banks(device) if list(b) != list(best)]
        self._entries = [e for e in self._entries if e[0] != device][-31:] + [(device, n, banks)]
        return banks


def mapping_sensitivity(p):
    """How far Live's MIDI map turns `p` per encoder message, as Live's own Launchkey script sets it
    (ableton/v3/control_surface/parameter_mapping_sensitivities): 1.0 for a continuous parameter; a list a tenth of
    its range over 8; on / off 0.1."""
    if not getattr(p, "is_quantized", False):
        return 1.0
    span = float(p.max) - float(p.min)
    return 0.1 * (1.0 if span == 1.0 else span / 8.0)


def device_pages(track, host, cache=None):
    """Per device: its best 8 parameters first ("DEV0.0"), then all of them 8 at a time ("DEV0.1", ...), skipping
    a bank that is just the best 8 again. A page's params are only made when it's shown."""
    cache = cache or BankCache()
    pages = []
    for i, d in enumerate(getattr(track, "devices", [])):
        banks = cache.banks(d, host)
        name = d.name
        tag = device_tag(name)
        for b, bank in enumerate(banks):
            summary = name if len(banks) == 1 else "%s %d/%d" % (name, b + 1, len(banks))
            pages.append(Page("DEV%d.%d" % (i, b), tag if b == 0 else (tag[:5] + str(b + 1)), summary,
                              lambda bank=bank: [LiveParam(p) if p is not None else None for p in bank], device=d))
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
        # Live's Global Groove Amount: how much the groove pool's grooves (Live's swing) apply, 0-131 %.
        ValueParam("Groove", lambda: song.groove_amount, lambda v: setattr(song, "groove_amount", v), 0.0,
                   GROOVE_MAX, 0.01, lambda v: "%d%%" % round(v * 100)),
        ChoiceParam("RecQ", REC_Q, lambda: int(song.midi_recording_quantization), host.set_record_quantization),
        ChoiceParam("Rept", [r[0] for r in REPEAT_RATES], lambda: repeat[0], set_repeat),
        ChoiceParam("Launch", LAUNCH_Q, lambda: int(song.clip_trigger_quantization), host.set_launch_quantization),
    ]
    summary = "%.0f BPM Rpt %s" % (song.tempo, REPEAT_RATES[repeat[0]][0])
    return Page("GLB", "GLB", summary, params)


def pages_for(song, track, host, repeat, cache=None):
    tracks = list(song.tracks)
    pages = device_pages(track, host, cache)
    if hasattr(track, "mixer_device"):
        pages.append(track_page(track, list(song.return_tracks)))
    pages.append(mix_page(tracks))
    pages.append(global_page(song, host, repeat))
    pages.append(transport_page(song, host))
    return pages


def bar_beats(song):
    return 4.0 * song.signature_numerator / song.signature_denominator


def bar_label(song, time):
    """"5.3": bar and beat of a song time (in beats)."""
    bar = bar_beats(song)
    return "%d.%d" % (int(time // bar) + 1, int((time % bar) // 1) + 1)


def cue_at(song, time):
    """The last marker at or before `time`, if any."""
    before = [c for c in song.cue_points if c.time <= time + 1e-6]
    return max(before, key=lambda c: c.time) if before else None


def transport_page(song, host):
    """POS: move the song position by bars, set the loop, jump between markers, zoom the arrangement."""
    bar = bar_beats(song)

    def jump(direction):
        song.jump_by(direction * bar)

    def marker(direction):
        if direction > 0 and song.can_jump_to_next_cue:
            song.jump_to_next_cue()
        elif direction < 0 and song.can_jump_to_prev_cue:
            song.jump_to_prev_cue()

    def marker_name():
        cue = cue_at(song, song.current_song_time)
        return cue.name if cue is not None else ("-" if not len(song.cue_points) else "Start")

    def set_loop_start(v):
        song.loop_start = max(0.0, round(v / bar) * bar)

    def set_loop_length(v):
        song.loop_length = max(bar, round(v / bar) * bar)

    params = [
        ActionParam("Pos", jump, lambda: bar_label(song, song.current_song_time), detents=1),
        ChoiceParam("Loop", ["Off", "On"], lambda: int(song.loop), lambda i: setattr(song, "loop", bool(i))),
        ValueParam("LpStrt", lambda: song.loop_start, set_loop_start, 0.0, 999 * bar, bar,
                   lambda v: bar_label(song, v)),
        ValueParam("LpLen", lambda: song.loop_length, set_loop_length, bar, 256 * bar, bar,
                   lambda v: "%d bar%s" % (round(v / bar), "" if round(v / bar) == 1 else "s")),
        ActionParam("Marker", marker, marker_name),
        None,
        ActionParam("ZoomH", lambda d: host.zoom(_sign(d), True), lambda: "<>", detents=1),
        ActionParam("ZoomV", lambda d: host.zoom(_sign(d), False), lambda: "^v", detents=1),
    ]
    summary = "%s%s" % (bar_label(song, song.current_song_time), " loop" if song.loop else "")
    return Page("POS", "POS", summary, params)
