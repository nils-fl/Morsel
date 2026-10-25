# Step mode: the selected track's clip in the selected scene as Morsel's 16-step pads (app/src/modes/stepMap.ts, the
# step parts of controller.ts, timing.ts). Times are in beats, relative to the clip's start like Live's notes.
# A step owns the notes starting within half a step of it, so a nudged note stays on its step.
import math

from . import pages as PG
from . import protocol as P

GRIDS = [("1/16", 0.25), ("1/32", 0.125), ("1/8T", 1 / 3.0), ("1/16T", 1 / 6.0)]
TICK = 1 / 96.0  # Morsel's nudge unit (96 per quarter note)
MAX_BARS = 16
DEFAULT_VELOCITY = 100
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(n):
    """Live's names: middle C (60) is C3."""
    return "%s%d" % (NOTE_NAMES[n % 12], n // 12 - 2)


def is_triplet(span):
    per_beat = 1.0 / span
    return abs(per_beat - round(per_beat)) < 1e-6 and int(round(per_beat)) % 3 == 0


def row_steps(span):
    """Steps in a pad row: whole beats, so 8 (16ths, 32nds) or 6 (triplets)."""
    return 6 if is_triplet(span) else 8


def page_steps(span):
    return row_steps(span) * 2


def step_for_pad(pad, per_row=8):
    """Top row = steps 1-8, bottom row = 9-16 (rows of 6 from the left on a triplet grid); -1 for an unused pad."""
    col = pad % 8
    if col >= per_row:
        return -1
    return col if pad >= 8 else col + per_row


def max_nudge(span):
    return span / 2 - TICK


def _sign(v):
    return (v > 0) - (v < 0)


class StepMode(object):
    def __init__(self, controller):
        self.c = controller
        self.grid = 0  # index into GRIDS
        self.page = 0
        self.held = {}  # pad -> {"time", "pitch", "remove"}
        self.velocity = DEFAULT_VELOCITY
        self.keys_note = 60

    # ---- what the steps edit ------------------------------------------------------------------------------------

    @property
    def span(self):
        return GRIDS[self.grid][1]

    def bar(self):
        s = self.c.song
        return 4.0 * s.signature_numerator / s.signature_denominator

    def clip(self, create=False):
        track = self.c.sel_track()
        slots = list(getattr(track, "clip_slots", []))
        i = self.c.scene_index()
        if i >= len(slots):
            return None
        slot = slots[i]
        if not slot.has_clip:
            if not create or not getattr(track, "has_midi_input", False):
                return None
            slot.create_clip(self.bar())
        clip = slot.clip
        return clip if getattr(clip, "is_midi_clip", False) else None

    def rack(self):
        return self.c.drum_rack(self.c.sel_track())

    def selected_pad(self):
        """The selected Drum Rack pad's index among the Launchkey pads (0-15), or -1."""
        rack = self.rack()
        dp = getattr(rack.view, "selected_drum_pad", None) if rack is not None else None
        note = getattr(dp, "note", -1)
        return P.DRUM_NOTES.index(note) if note in P.DRUM_NOTES else -1

    def pitch(self):
        """The note the steps write: the selected Drum Rack pad's (any of its 128, the keys can pick any), or on a
        keys track the step note."""
        rack = self.rack()
        if rack is not None:
            dp = getattr(rack.view, "selected_drum_pad", None)
            return getattr(dp, "note", P.DRUM_NOTES[0]) if dp is not None else P.DRUM_NOTES[0]
        return self.keys_note

    def item(self):
        """"5 Snare" (the Launchkey pad number) or "D3 Clap" for a pad off the Launchkey's 16; "Note C3"."""
        rack = self.rack()
        if rack is not None:
            note = self.pitch()
            name = rack.drum_pads[note].name
            return "%d %s" % (P.DRUM_NOTES.index(note) + 1, name) if note in P.DRUM_NOTES else \
                "%s %s" % (note_name(note), name)
        return "Note %s" % note_name(self.keys_note)

    # ---- grid ---------------------------------------------------------------------------------------------------

    def length(self, clip):
        return clip.loop_end - clip.loop_start

    def pages(self, clip=None):
        clip = clip if clip is not None else self.clip()
        if clip is None:
            return 1
        return max(1, int(math.ceil(self.length(clip) / (page_steps(self.span) * self.span) - 1e-9)))

    def fix_page(self):
        self.page = max(0, min(self.pages() - 1, self.page))

    def step_time(self, clip, step):
        """Start of a step on the current page, in clip time; None past the loop."""
        t = (self.page * page_steps(self.span) + step) * self.span
        return clip.loop_start + t if t < self.length(clip) - 1e-9 else None

    def notes_at(self, clip, time, pitch):
        """The step's notes, as Live's own vector (apply_note_modifications wants that back, not a list)."""
        lo = max(0.0, time - self.span / 2)
        return clip.get_notes_extended(pitch, 1, lo, time + self.span / 2 - lo)

    def steps(self):
        """Which steps of the page on the pads have notes (of the selected pad, on a drum track)."""
        n = page_steps(self.span)
        clip = self.clip()
        if clip is None:
            return [False] * n
        pitch = self.pitch()
        lo = max(0.0, self.step_time(clip, 0) - self.span / 2) if self.step_time(clip, 0) is not None else 0.0
        notes = list(clip.get_notes_extended(pitch, 1, lo, n * self.span + self.span))
        out = []
        for step in range(n):
            t = self.step_time(clip, step)
            out.append(t is not None and any(self.owns(t, x.start_time) for x in notes))
        return out

    def owns(self, t, start):
        """Whether the step starting at `t` owns a note starting at `start`."""
        return t - self.span / 2 - 1e-9 <= start < t + self.span / 2 - 1e-9

    def playhead(self):
        clip = self.clip()
        if clip is None or not getattr(clip, "is_playing", False):
            return -1
        rel = clip.playing_position - clip.loop_start
        step = int(math.floor(rel / self.span + 1e-9)) - self.page * page_steps(self.span)
        return step if 0 <= step < page_steps(self.span) else -1

    def bar_label(self):
        start = self.page * page_steps(self.span) * self.span
        bar = self.bar()
        n = int(start // bar) + 1
        if page_steps(self.span) * self.span < bar - 1e-9:
            return "%d.%d" % (n, int((start % bar) // 1) + 1)
        return str(n)

    def bars(self):
        clip = self.clip()
        return max(1, int(round(self.length(clip) / self.bar()))) if clip is not None else 0

    # ---- pads ---------------------------------------------------------------------------------------------------

    def press(self, pad):
        step = step_for_pad(pad, row_steps(self.span))
        if step < 0:
            return
        clip = self.clip(create=True)
        if clip is None:
            self.c.show_temp("Step", "MIDI track only")
            return
        t = self.step_time(clip, step)
        if t is None:
            return
        pitch = self.pitch()
        lit = len(self.notes_at(clip, t, pitch)) > 0
        # A lit step goes on release, so it can be held and edited first.
        if not lit:
            self.c.host.add_note(clip, pitch, t, self.span, self.velocity)
        self.held[pad] = {"time": t, "pitch": pitch, "remove": lit}

    def release(self, pad):
        step = self.held.pop(pad, None)
        if step is None or not step["remove"]:
            return
        clip = self.clip()
        if clip is not None:
            lo = max(0.0, step["time"] - self.span / 2)
            clip.remove_notes_extended(step["pitch"], 1, lo, step["time"] + self.span / 2 - lo)

    def edit_held(self, index, delta):
        """Encoder 1 (velocity) or 2 (nudge) turned while steps are held: edit those steps' notes."""
        clip = self.clip()
        if clip is None:
            return
        first = None
        for step in self.held.values():
            step["remove"] = False
            notes = self.notes_at(clip, step["time"], step["pitch"])
            for n in notes:
                if index == 0:
                    n.velocity = max(1.0, min(127.0, n.velocity + delta * 2))
                else:
                    off = n.start_time - step["time"] + delta * TICK
                    off = max(-max_nudge(self.span), min(max_nudge(self.span), off))
                    n.start_time = max(0.0, step["time"] + off)
            if len(notes):
                clip.apply_note_modifications(notes)
                first = first or notes[0]
        if first is None:
            return
        if index == 0:
            self.c.show_temp("Velocity", "%d" % first.velocity, encoder=0)
        else:
            ticks = int(round((first.start_time - min(s["time"] for s in self.held.values())) / TICK))
            self.c.show_temp("Nudge", "%+d" % ticks if ticks else "0", encoder=1)

    def clear_pad(self):
        """Shift + Scene on a drum track: only the selected pad's notes."""
        clip = self.clip()
        if clip is None:
            return False
        clip.remove_notes_extended(self.pitch(), 1, 0.0, max(clip.length, clip.loop_end, clip.end_marker) + 1.0)
        return True

    # ---- the Step encoder page ----------------------------------------------------------------------------------

    def set_bars(self, n):
        clip = self.clip()
        if clip is None:
            return
        end = clip.loop_start + n * self.bar()
        if end > clip.loop_end:
            clip.end_marker = end
            clip.loop_end = end
        else:
            clip.loop_end = end
            clip.end_marker = end
        self.fix_page()

    def double(self, direction):
        """Right: double the loop (its notes repeat). Left: halve it, down to a bar."""
        clip = self.clip()
        if clip is None:
            return
        if direction > 0:
            if self.bars() * 2 <= MAX_BARS:
                clip.duplicate_loop()
        elif self.length(clip) / 2 >= self.bar() - 1e-9:
            self.set_bars(max(1, self.bars() // 2))
        self.fix_page()

    def set_grid(self, i):
        self.grid = i
        self.page = 0

    def set_selected_pad(self, i):
        rack = self.rack()
        if rack is not None:
            rack.view.selected_drum_pad = rack.drum_pads[P.DRUM_NOTES[i]]

    def page_params(self):
        clip_bars = self.bars()
        params = [
            PG.ChoiceParam("Bars", [str(i) for i in range(1, MAX_BARS + 1)], lambda: max(0, self.bars() - 1),
                           lambda i: self.set_bars(i + 1)),
            PG.ChoiceParam("Page", [str(i) for i in range(1, self.pages() + 1)], lambda: self.page,
                           lambda i: setattr(self, "page", i)),
            PG.ChoiceParam("Grid", [g[0] for g in GRIDS], lambda: self.grid, self.set_grid),
            PG.ActionParam("Double", self.double,
                           lambda: "%d bar%s" % (clip_bars, "" if clip_bars == 1 else "s") if clip_bars else "-"),
            PG.ValueParam("Vel", lambda: self.velocity, lambda v: setattr(self, "velocity", int(v)), 1, 127, 1,
                          lambda v: "%d" % v),
        ]
        if self.rack() is not None:
            params.append(PG.ChoiceParam("Pad", [str(i + 1) for i in range(16)], lambda: max(0, self.selected_pad()),
                                         self.set_selected_pad))
        else:
            params.append(PG.ValueParam("Note", lambda: self.keys_note, lambda v: setattr(self, "keys_note", int(v)),
                                        0, 127, 1, lambda v: note_name(int(v))))
        summary = "%s %s" % (GRIDS[self.grid][0], "%d bar%s" % (clip_bars, "" if clip_bars == 1 else "s")
                             if clip_bars else "no clip")
        return PG.Page("STEP", "STEP", summary, params)

    # ---- LEDs ---------------------------------------------------------------------------------------------------

    def leds(self, color):
        out = [(P.COLOR["off"], "static")] * 16
        clip = self.clip()
        steps = self.steps()
        head = self.playhead()
        per_row = row_steps(self.span)
        for pad in range(16):
            step = step_for_pad(pad, per_row)
            if step < 0:
                continue
            if clip is None:
                t = step * self.span if step * self.span < self.bar() else None
            else:
                t = self.step_time(clip, step)
            if t is None:
                continue
            on_beat = abs(t - round(t)) < 1e-6
            c = color if steps[step] else P.COLOR["dimWhite"] if on_beat else P.COLOR["off"]
            if step == head:
                c = P.COLOR["white"]
            out[pad] = (c, "static")
        return out
