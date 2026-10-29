# Chop mode: Morsel's Chop with Live's Simpler (Slice mode). A chop gets its own MIDI track ("Chop ...") with a Simpler
# holding the sample: the selected pad's sample file (the pad stays as it is) or the sample highlighted in Browse.
# Simpler slices it (equal steps, at the hits, by beats, or by hand); the pads and keys play the slices (C3 = slice 1,
# as in Morsel). Done (Shift + Encoder page down again) is Live's Slice to Drum Rack: the Chop track becomes a drum
# track with a chop on each pad.
# Live's calls (new track, Simpler, conversion) go through the host. Live doesn't hand a script the audio, so the wave
# on the screen is read from Simpler's sample file (wave_peaks.py). Scroll and zoom pick the part shown; moving a start
# goes a screen pixel per detent, so zooming in makes it finer.
from . import pages as PG
from . import protocol as P
from .wave_peaks import Peaks

LOAD_TIMEOUT = 3.0  # s for the Simpler to appear on the Chop track
SLICING = 2  # Simpler's playback modes: classic, one-shot, slicing
# Simpler's slicing styles, in Live's order, under Morsel's names where it has them.
STYLES = ["Hits", "Beat", "Equal", "Manual"]  # Live: Transient, Beat, Region, Manual
EQUAL = 2
DIVISIONS = ["1/16", "1/16T", "1/8", "1/8T", "1/4", "1/4T", "1/2", "1/2T", "1 Bar", "2 Bars", "4 Bars"]
DEFAULT_COUNT = 16  # Morsel's default: 16 equal steps
MAX_COUNT = 64  # Simpler's most slices
KEY0 = 48  # C3 plays slice 1 (Simpler's slices start at C1, 36)
SLICE_NOTE0 = 36
COLUMNS = 124  # the wave's width on the screen, in pixels
MIN_SPAN = 512  # frames across the screen at the closest zoom (Morsel's)
ZOOM_STEP = 0.7  # the span per Zoom detent
BEAT_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]  # lengths to warp to (Scene), in beats
SCROLL_STEP = 1 / 8.0  # of the screen per Scroll detent


def is_simpler(device):
    return getattr(device, "class_name", "") == "OriginalSimpler"


def find_simpler(devices):
    return next((d for d in devices if is_simpler(d)), None)


def pad_sampler(devices):
    """The Simpler on a pad, also inside a rack on it; else the first Drum Sampler (which Live doesn't let a script
    read the sample of), else None."""
    cell = None
    for d in devices:
        if is_simpler(d):
            return d
        if getattr(d, "class_name", "") == "DrumCell":
            cell = cell or d
        for chain in getattr(d, "chains", []) if getattr(d, "can_have_chains", False) else []:
            inner = find_simpler(getattr(chain, "devices", []))
            if inner is not None:
                return inner
    return cell


class ChopMode(object):
    def __init__(self, controller):
        self.c = controller
        self.track = None  # the Chop track
        self.name = ""
        self.pending_since = None  # waiting for the Simpler to appear
        self.sel = 0  # the selected slice
        self.view_a, self.view_b = 0, None  # the frames shown (None: to the end)
        self.peaks = None  # the wave, read from the sample's file
        self.beats = None  # the Beats choice (index into BEAT_CHOICES); None: Live's guess

    # ---- opening ------------------------------------------------------------------------------------------------

    def open_from_pad(self):
        """The selected pad's sample, on a drum track. Returns (ok, popup)."""
        c = self.c
        rack = c.drum_rack(c.sel_track())
        dp = getattr(rack.view, "selected_drum_pad", None) if rack is not None else None
        device = pad_sampler(dp.chains[0].devices) if dp is not None and len(dp.chains) else None
        if device is not None and not is_simpler(device):
            # Live's object model has no sample for Drum Sampler (only its gain), so its file can't be found.
            return False, ("Drum Sampler", "Chop it from Browse")
        path = getattr(getattr(device, "sample", None), "file_path", "") if device is not None else ""
        if not path:
            return False, ("Chop", "Pick a pad with a sample")
        track = self._new_track(dp.name)
        if not c.host.insert_simpler(track, path):
            return False, ("Chop", "Live can't load it")
        return True, None

    def open_from_item(self, item):
        """A sample highlighted in Browse: loaded onto a new Chop track (Live puts it in a Simpler)."""
        track = self._new_track(item.name.rsplit(".", 1)[0])
        self.c.host.load_onto_track(track, item)
        return True, None

    def _new_track(self, name):
        c = self.c
        ts = c.tracks()
        t = c.sel_track()
        index = ts.index(t) + 1 if t in ts else len(ts)
        self.name = name
        self.track = c.host.create_midi_track(index, "Chop %s" % name)
        c.song.view.selected_track = self.track  # armed with it, so the keys play the slices
        self.pending_since = c.host.now()
        self.sel = 0
        self.view_a, self.view_b = 0, None
        self.peaks = None
        self.beats = None
        return self.track

    def tick(self, now):
        if self.pending_since is None:
            smp = self.sample()
            path = getattr(smp, "file_path", "") if smp is not None else ""
            if path and (self.peaks is None or self.peaks.path != path):  # loaded, or cropped into a new file
                self.peaks = Peaks(path)
                if not self.peaks.ok:
                    self.c.host.log("Morsel Chop: no wave for %s" % path)
            return
        simpler = self.simpler()
        if simpler is not None and getattr(simpler, "sample", None) is not None:
            self.pending_since = None
            self._slice(simpler)
        elif now - self.pending_since > LOAD_TIMEOUT:
            self.pending_since = None
            self.c.show_temp("Chop", "No Simpler on the track")

    def _slice(self, simpler):
        """Slice mode, Morsel's default: 16 equal steps."""
        host = self.c.host
        host.set_enum(simpler, "playback_mode", SLICING)
        host.set_enum(simpler.sample, "slicing_style", EQUAL)
        simpler.sample.slicing_region_count = DEFAULT_COUNT
        self.c.host.keys_routing_changed()  # the keys play the slices

    # ---- what's chopped -----------------------------------------------------------------------------------------

    def simpler(self):
        if self.track is None:
            return None
        try:
            return find_simpler(self.track.devices)
        except Exception:  # the track was deleted
            return None

    def sample(self):
        s = self.simpler()
        return getattr(s, "sample", None) if s is not None and self.pending_since is None else None

    def slices(self):
        """Slice starts in sample frames, sorted, inside the region."""
        smp = self.sample()
        if smp is None:
            return []
        return sorted(t for t in smp.slices if smp.start_marker <= t < smp.end_marker)

    def selected(self):
        sl = self.slices()
        return min(self.sel, len(sl) - 1) if sl else -1

    def select(self, index):
        sl = self.slices()
        if not sl:
            return
        self.sel = max(0, min(len(sl) - 1, index))
        s = self.simpler()
        try:
            s.view.selected_slice = sl[self.sel]
        except Exception:
            pass
        self.show_frame(sl[self.sel])
        self.c.show_temp("Slice", "%d/%d" % (self.sel + 1, len(sl)))

    def on_note(self, note):
        """A pad or key (slice notes from C1): that slice is the selected one."""
        if SLICE_NOTE0 <= note < SLICE_NOTE0 + MAX_COUNT:
            self.sel = note - SLICE_NOTE0
            s = self.simpler()
            sl = self.slices()
            if s is not None and self.sel < len(sl):
                try:
                    s.view.selected_slice = sl[self.sel]
                except Exception:
                    pass
                self.show_frame(sl[self.sel])

    # ---- the part shown -----------------------------------------------------------------------------------------

    def shown(self):
        """(a, b): the frames across the screen."""
        smp = self.sample()
        length = max(1, smp.length) if smp is not None else 1
        b = self.view_b if self.view_b is not None else length
        span = max(1, min(length, b - self.view_a))
        a = max(0, min(length - span, self.view_a))
        return a, a + span

    def _set_shown(self, a, span):
        smp = self.sample()
        length = max(1, smp.length) if smp is not None else 1
        span = int(max(min(MIN_SPAN, length), min(length, span)))
        a = int(max(0, min(length - span, a)))
        self.view_a, self.view_b = a, a + span

    def focus(self):
        """Where zooming centres: the selected slice's start."""
        sl = self.slices()
        i = self.selected()
        a, b = self.shown()
        return sl[i] if i >= 0 else (a + b) // 2

    def zoom(self, delta):
        a, b = self.shown()
        f = self.focus()
        span = (b - a) * (ZOOM_STEP ** delta)
        rel = float(f - a) / max(1, b - a) if a <= f <= b else 0.5
        self._set_shown(f - rel * span, span)

    def scroll(self, delta):
        a, b = self.shown()
        self._set_shown(a + delta * (b - a) * SCROLL_STEP, b - a)

    def show_frame(self, frame):
        """Bring `frame` into view (centred) when it's off the screen."""
        a, b = self.shown()
        if not a <= frame <= b:
            self._set_shown(frame - (b - a) / 2.0, b - a)

    def follow(self, frame):
        """While moving a marker: keep it on the screen, scrolling only as far as it went off (no jump)."""
        a, b = self.shown()
        if frame < a:
            self._set_shown(frame, b - a)
        elif frame > b:
            self._set_shown(frame - (b - a), b - a)

    def zoom_label(self):
        smp = self.sample()
        a, b = self.shown()
        return "x%.0f" % (float(smp.length) / max(1, b - a)) if smp is not None else "-"

    # ---- editing ------------------------------------------------------------------------------------------------

    def _frames_step(self, smp):
        """A screen pixel at the current zoom: a detent moves a marker by that much."""
        a, b = self.shown()
        return max(1, (b - a) // COLUMNS)

    def _move_marker(self, which, delta):
        smp = self.sample()
        if smp is None:
            return
        step = self._frames_step(smp)
        last = smp.length - 1  # Live refuses a marker at the length itself ("outside of the sample")
        if which == "start":
            smp.start_marker = int(max(0, min(smp.end_marker - step, smp.start_marker + delta * step)))
            self.follow(smp.start_marker)
        else:
            smp.end_marker = int(max(smp.start_marker + step, min(last, smp.end_marker + delta * step)))
            self.follow(smp.end_marker)

    def _style(self):
        smp = self.sample()
        return int(smp.slicing_style) if smp is not None else EQUAL

    def _set_style(self, i):
        smp = self.sample()
        if smp is not None:
            self.c.host.set_enum(smp, "slicing_style", i)

    def _shift_slice(self, j, delta):
        """Slice j's start, a screen pixel per detent, between its neighbours (Live makes the slicing Manual).
        Returns where it went, or None."""
        smp = self.sample()
        sl = self.slices()
        step = self._frames_step(smp)
        lo = sl[j - 1] + step if j > 0 else smp.start_marker
        hi = sl[j + 1] - step if j + 1 < len(sl) else smp.end_marker - step
        new = int(max(lo, min(hi, sl[j] + delta * step)))
        if new == sl[j]:
            return None
        smp.move_slice(sl[j], new)
        self.follow(new)
        return new

    def _move_start(self, delta):
        """Start: the selected chop's start (encoder 3, where SAMPLE has the region's)."""
        i = self.selected()
        if self.sample() is None or i < 0:
            return
        new = self._shift_slice(i, delta)
        if new is not None:
            try:
                self.simpler().view.selected_slice = new  # Live's Simpler keeps it highlighted
            except Exception:
                pass

    def _move_end(self, delta):
        """End: where the selected chop ends, the next one's start; on the last chop, the region's end."""
        i = self.selected()
        if self.sample() is None or i < 0:
            return
        if i + 1 < len(self.slices()):
            self._shift_slice(i + 1, delta)
        else:
            self._move_marker("end", delta)

    def chop_end(self):
        sl = self.slices()
        i = self.selected()
        return sl[i + 1] if 0 <= i < len(sl) - 1 else self.sample().end_marker

    def _add_or_remove(self, direction):
        """Right: split the selected slice in two. Left: remove it (joined to the one before)."""
        smp = self.sample()
        sl = self.slices()
        i = self.selected()
        if smp is None or i < 0:
            return
        if direction > 0:
            end = sl[i + 1] if i + 1 < len(sl) else smp.end_marker
            if len(sl) < MAX_COUNT:
                smp.insert_slice((sl[i] + end) // 2)
                self.c.show_temp("Slice", "Split: %d" % (len(sl) + 1))
        elif len(sl) > 1 and i > 0:
            smp.remove_slice(sl[i])
            self.sel = i - 1
            self.c.show_temp("Slice", "Removed: %d" % (len(sl) - 1))

    def _seconds(self, frames):
        smp = self.sample()
        rate = float(getattr(smp, "sample_rate", 44100) or 44100)
        return "%.2fs" % (frames / rate)

    def _view_params(self):
        """Encoders 1 and 2 on both pages: scroll and zoom."""
        return [
            PG.ActionParam("Scroll", self.scroll, lambda: self._seconds(self.shown()[0]), detents=1),
            PG.ActionParam("Zoom", self.zoom, self.zoom_label, detents=1),
        ]

    def page(self):
        """CHOP: pick a slice (or hit its pad), move its start, and how the sample is sliced."""
        smp = self.sample()
        if smp is None:
            return PG.Page("CHOP", "CHOP", "Loading..." if self.pending_since is not None else "No sample", [])
        style = self._style()
        n = len(self.slices())
        params = self._view_params() + [
            # 3 and 4 as on SAMPLE: there the region's start and end, here the selected chop's.
            PG.ActionParam("Start", self._move_start, lambda: self._seconds(self.focus()), detents=1),
            PG.ActionParam("End", self._move_end, lambda: self._seconds(self.chop_end()), detents=1),
            PG.ChoiceParam("Mode", STYLES, self._style, self._set_style),
        ]
        if style == EQUAL:
            params.append(PG.ValueParam("Count", lambda: smp.slicing_region_count,
                                        lambda v: setattr(smp, "slicing_region_count", int(round(v))), 2, MAX_COUNT, 1,
                                        lambda v: "%d" % v))
        elif style == 0:
            params.append(PG.ValueParam("Sens", lambda: smp.slicing_sensitivity,
                                        lambda v: setattr(smp, "slicing_sensitivity", v), 0.0, 1.0, 0.02,
                                        lambda v: "%d%%" % round(v * 100)))
        elif style == 1:
            params.append(PG.ChoiceParam("Div", DIVISIONS, lambda: int(smp.slicing_beat_division),
                                         lambda i: self.c.host.set_enum(smp, "slicing_beat_division", i)))
        else:
            params.append(None)
        params.append(PG.ActionParam("Split", self._add_or_remove, lambda: "%d" % n))
        return PG.Page("CHOP", "CHOP", "%s %d chops" % (STYLES[style] if 0 <= style < 4 else "?", n), params)

    # ---- warping (Morsel's stretch to the tempo) ---------------------------------------------------------------

    def beats_index(self):
        """The Beats choice: Live's guess of the region's length (Simpler.guess_playback_length) until it's turned."""
        if self.beats is None:
            try:
                guess = float(self.simpler().guess_playback_length())
            except Exception:
                guess = 4.0
            self.beats = min(range(len(BEAT_CHOICES)), key=lambda i: abs(BEAT_CHOICES[i] - guess))
        return self.beats

    def _set_beats(self, i):
        self.beats = i

    def beats_label(self, beats):
        bar = 4.0 * self.c.song.signature_numerator / self.c.song.signature_denominator
        if beats >= bar and beats % bar == 0:
            bars = int(beats / bar)
            return "%d bar%s" % (bars, "" if bars == 1 else "s")
        return "%d beat%s" % (beats, "" if beats == 1 else "s")

    def warp(self):
        """Scene: warp the sample so the region lasts Beats (Simpler's Warp as), playing in time with Live's tempo."""
        s = self.simpler()
        if s is None or self.sample() is None:
            return
        if not getattr(s, "can_warp_as", True):
            self.c.show_temp("Warp", "Not possible here")
            return
        beats = BEAT_CHOICES[self.beats_index()]
        s.warp_as(beats)
        self.c.show_temp("WARPED", "%s at %.0f BPM" % (self.beats_label(beats), self.c.song.tempo))

    def sample_page(self):
        """SAMPLE: the region's start and end (Func keeps only the region), and its length in beats (Scene warps to
        it)."""
        smp = self.sample()
        if smp is None:
            return PG.Page("SAMPLE", "SAMPLE", "No sample", [])
        params = self._view_params() + [
            PG.ActionParam("Start", lambda d: self._move_marker("start", d), lambda: self._seconds(smp.start_marker),
                           detents=1),
            PG.ActionParam("End", lambda d: self._move_marker("end", d), lambda: self._seconds(smp.end_marker),
                           detents=1),
            PG.ChoiceParam("Beats", [self.beats_label(b) for b in BEAT_CHOICES], self.beats_index, self._set_beats),
        ]
        return PG.Page("SAMPLE", "SAMPLE", "%s %s" % (self._seconds(smp.end_marker - smp.start_marker),
                                                     self.zoom_label()), params)

    # ---- buttons ------------------------------------------------------------------------------------------------

    def crop(self):
        """Func: keep only the region (Morsel's Func in Chop)."""
        s = self.simpler()
        if s is None or self.sample() is None:
            return
        s.crop()
        self.c.show_temp("Cropped", self.name)

    def done(self):
        """Slice to Drum Rack: the chops onto pads. Returns the popup."""
        s = self.simpler()
        if s is None or self.sample() is None:
            return "Chop", "Nothing to slice"
        n = len(self.slices())
        if not self.c.host.slice_to_drum_rack(s):
            return "Chop", "Live can't convert it"
        return "CHOPS > PADS", "%d on %s" % (n, self.track.name)

    def key_map(self):
        """The keys play the slices from C3, one key each, as in Morsel's Chop."""
        return [max(0, n - (KEY0 - SLICE_NOTE0)) for n in range(128)]

    # ---- screen and pads ----------------------------------------------------------------------------------------

    def view(self):
        """For the screen: (shown from, to, region start, end, slice starts, selected, wave or None), in frames;
        None while loading."""
        smp = self.sample()
        if smp is None:
            return None
        a, b = self.shown()
        wave = self.peaks.view(a, b, COLUMNS) if self.peaks is not None and self.peaks.ok else None
        return a, b, smp.start_marker, smp.end_marker, self.slices(), self.selected(), wave

    def leds(self):
        """A pad per slice (Simpler's notes from C1, as on a Drum Rack), the selected one pulsing."""
        n = len(self.slices())
        sel = self.selected()
        out = []
        for i in range(16):
            k = P.DRUM_NOTES[i] - SLICE_NOTE0
            if k < n:
                out.append((P.PAD_COLORS[k % 16], "pulse" if k == sel else "static"))
            else:
                out.append((P.COLOR["off"], "static"))
        return out
