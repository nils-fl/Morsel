# Maps Launchkey events to Live per hardware mode, and renders LEDs + the screen. The behaviour mirrors
# app/src/modes/controller.ts; the music lives in Live instead of Morsel's store:
#   track -> Live track (drums = it has a Drum Rack), pattern -> scene, pad -> Drum Rack pad (notes 36-51).
# No Live import: `host` (see surface.py) gives the song and the few things that need Live's own module.
from . import pages as PG
from . import protocol as P
from .colors import nearest_color
from .display import screens as S
from .display.sender import BitmapSender
from .display.widgets import overlay_bar
from .step import StepMode, note_name, row_steps

MODES = ["play", "step", "track", "mute", "pattern"]
MODE_NAMES = {"play": "Play", "step": "Step", "track": "Track", "mute": "Mute", "pattern": "Pattern"}

LED_FULL, LED_DIM = 127, 16
DOUBLE_TAP = 0.3  # s
OVERLAY_S = 1.0  # s a popup stays
LAYOUT_FIX_INTERVAL = 1.0  # s between layout resends, so a device that keeps refusing can't cause a loop
LED_RESEND_DELAY = 0.15  # s after a layout switch: the device drops LED messages while it switches
TEMP_TIMEOUT_TENTHS = 10  # the device's temporary display: 1 s
# The device draws its own Shift overlay; the shift map sent to the temporary target covers it (protocol_notes.md).
SHIFT_COVER_AT = (0.0, 0.1, 0.25, 0.5)  # s after Shift goes down
SHIFT_COVER_EVERY = 0.7  # s, then, while held
MAX_TRACKS = 8
MAX_SCENES = 16
ERASE_AHEAD = 0.1  # beats: erase a little ahead of the playhead, so a note about to sound goes too
AUTO_ARM = True  # the selected track is armed (implicitly, like Push), so the keybed and Record follow it


def layout_for(mode):
    """Play uses the drum layout (velocity, pressure, straight into the track); the other modes light the pads in
    DAW layout, and their notes come to the script."""
    return "drum" if mode == "play" else "daw"


def layout_reported(layout, value):
    """Whether a CC 29 report means `layout`. Measured under Live: asking for drum (1) is answered with 15."""
    return value in (1, 15) if layout == "drum" else value == 2


class Controller(object):
    def __init__(self, host):
        self.host = host
        self.sender = BitmapSender(host.send, host.now)
        self.mode = "play"
        self.layout = "drum"
        self.native_pads = None  # the device's own pad mode (CC 29 value), when it has the pads
        self.reported = None  # the last CC 29 value the device reported
        self.shift = False
        self.page_key = None
        self.turner = PG.Turner()
        self.repeat = [1]  # index into pages.REPEAT_RATES (1/16)
        self.repeat_latch = False
        self.scene_held = False
        self.last_scene_tap = 0.0
        self.func_held = False
        self.func_used = False
        self.held_pads = []
        self.new_track = None  # "drum" / "keys" while a track is being set up in Track mode
        self.last_tap = (-1, 0.0)
        self.overlay = None  # (name, value, encoder, until)
        self.last_layout_fix = -1e9
        self.leds_resend_at = None
        self.sent_pads = {}
        self.sent_buttons = {}
        self.shift_since = None
        self.shift_cover_next = 0
        self.armed = None
        self.last_device = None
        self.last_drum_track = None
        self.step = StepMode(self)
        self.page_before_step = None
        self.erasing = {}  # pad -> [pitch, last playhead position]
        self.keys_drums = None  # whether Morsel Keys maps the keybed to the pads (the selected track is a drum track)

    # ---- Live helpers -------------------------------------------------------------------------------------------

    @property
    def song(self):
        return self.host.song

    def tracks(self):
        return list(self.song.tracks)

    def sel_track(self):
        return self.song.view.selected_track

    def track_number(self, t):
        ts = self.tracks()
        return ts.index(t) + 1 if t in ts else None

    def scenes(self):
        return list(self.song.scenes)

    def scene_index(self):
        sc = self.scenes()
        sel = self.song.view.selected_scene
        return sc.index(sel) if sel in sc else 0

    @staticmethod
    def drum_rack(track):
        for d in getattr(track, "devices", []):
            if getattr(d, "can_have_drum_pads", False):
                return d
        return None

    def kind(self, track):
        if self.drum_rack(track) is not None:
            return "drum"
        return "keys" if getattr(track, "has_midi_input", False) else "audio"

    def drum_track(self):
        """The selected track if it has a Drum Rack, else the last drum track picked, else the first one."""
        t = self.sel_track()
        if self.drum_rack(t) is not None:
            return t
        ts = self.tracks()
        if self.last_drum_track in ts and self.drum_rack(self.last_drum_track) is not None:
            return self.last_drum_track
        for t in ts:
            if self.drum_rack(t) is not None:
                return t
        return None

    @staticmethod
    def drum_pad(rack, pad):
        """The Drum Rack pad under Launchkey pad `pad` (the drum layout's notes, so the pads match Play mode)."""
        return rack.drum_pads[P.DRUM_NOTES[pad]]

    def track_label(self):
        t = self.sel_track()
        n = self.track_number(t)
        return "T%d %s" % (n, t.name) if n else t.name

    def transport(self):
        s = self.song
        if getattr(s, "is_counting_in", False):
            return "COUNT"
        if s.session_record or s.record_mode:
            return "REC"
        return "PLAY" if s.is_playing else "STOP"

    def status(self):
        return "S%d %s" % (self.scene_index() + 1, self.transport())

    def queued_scenes(self):
        return set(t.fired_slot_index for t in self.tracks() if t.fired_slot_index >= 0)

    @staticmethod
    def scene_has_clips(scene):
        return any(cs.has_clip for cs in scene.clip_slots)

    # ---- device -------------------------------------------------------------------------------------------------

    def send(self, msg):
        self.host.send(tuple(msg))

    def connect(self):
        """The handshake from Launchkey.handshake (app/src/midi/launchkey.ts)."""
        self.send(P.DAW_MODE_ON)
        self.send(P.cc7(P.CC_DRUM_TO_DAW, 1))
        self.send(P.cc7(P.CC_ENCODER_RELATIVE, 127))
        self.send(P.cc7(P.CC_PAD_LAYOUT, P.PAD_LAYOUT[self.layout]))
        self.native_pads = None
        self.send(P.display_config_sysex(P.DISPLAY_STATIONARY, P.ARRANGEMENT_NAME_VALUE))
        self.send(P.display_config_sysex(P.DISPLAY_TEMPORARY, P.ARRANGEMENT_NAME_VALUE))
        self.send(P.cc7(P.FEATURE_CC_TEMP_TIMEOUT, TEMP_TIMEOUT_TENTHS))
        # Arrangement with both auto bits clear: the device never pops up its own per-encoder display.
        for i in range(8):
            self.send(P.display_config_sysex(P.display_encoder(i), P.ARRANGEMENT_NAME_VALUE))
        self.sender.reset()
        self.sent_pads.clear()
        self.sent_buttons.clear()
        # LED messages sent while the device is still entering DAW mode can be dropped.
        self.leds_resend_at = self.host.now() + 0.3

    def disconnect(self):
        self.set_repeat(False)
        if self.armed is not None:
            self._arm(self.armed, False)
            self.armed = None
        self.send(P.cc7(P.CC_DRUM_TO_DAW, 0))
        self.send(P.DAW_MODE_OFF)

    def set_layout(self, layout):
        """Put the pads in one of our layouts; also takes them back from the device's own pad mode."""
        if layout == self.layout and self.native_pads is None:
            return
        self.layout = layout
        self.native_pads = None
        self.reported = None
        del self.held_pads[:]
        self.send(P.cc7(P.CC_PAD_LAYOUT, P.PAD_LAYOUT[layout]))
        self.host.request_rebuild_midi_map()  # DAW-layout notes come to the script, drum-layout ones go to the track
        self.sent_pads.clear()
        self.leds_resend_at = self.host.now() + LED_RESEND_DELAY

    # ---- popups -------------------------------------------------------------------------------------------------

    def show_temp(self, name, value, encoder=None, hold=False):
        until = float("inf") if hold else self.host.now() + OVERLAY_S
        self.overlay = (name, value, encoder, until)

    def release_hold(self):
        if self.overlay and self.overlay[3] == float("inf"):
            self.overlay = None

    def active_overlay(self):
        if self.overlay and self.host.now() > self.overlay[3]:
            self.overlay = None
        return self.overlay

    # ---- MIDI in ------------------------------------------------------------------------------------------------

    def handle_midi(self, data):
        if not data:
            return
        if data[0] == 0xF0:
            if P.is_bitmap_ack(data):
                self.sender.on_ack()
            return
        status, ch = data[0] & 0xF0, data[0] & 0x0F
        d1 = data[1] if len(data) > 1 else 0
        d2 = data[2] if len(data) > 2 else 0
        if status in (0x90, 0x80) and ch == P.CH_DAW_PADS:
            pad = P.pad_from_note("daw", d1)
            if pad >= 0:
                if status == 0x90 and d2 > 0:
                    if pad not in self.held_pads:
                        self.held_pads.append(pad)
                    self.on_pad(pad, d2)
                elif pad in self.held_pads:
                    self.held_pads.remove(pad)
                    self.on_pad_release(pad)
        elif status == 0xB0 and ch == P.CH_FEATURE:
            if d1 == P.CC_PAD_LAYOUT:
                self.on_layout_report(d2)
            elif d1 == P.CC_SHIFT:
                self.on_button("shift", d2 > 0)
        elif status == 0xB0 and ch == P.CH_BUTTON and P.CC_ENC_REL_FIRST <= d1 < P.CC_ENC_REL_FIRST + 8:
            self.on_encoder(d1 - P.CC_ENC_REL_FIRST, P.relative_delta(d2))
        elif status == 0xB0 and ch in (P.CH_DAW_PADS, P.CH_BUTTON) and d1 in P.BUTTON_BY_CC:
            self.on_button(P.BUTTON_BY_CC[d1], d2 > 0)

    def on_layout_report(self, value):
        self.reported = value
        # Not while Shift is held: that is the device's pad-mode picker (it reports "daw"); Shift up decides.
        if self.shift:
            return
        if value not in (1, 2, 15):
            # The device's own pad mode (chords): leave it the pads. Func or a mode change takes them back.
            self.native_pads = value
            self.show_temp("Pads", "Launchkey mode")
            return
        self.native_pads = None
        # The layout we asked for last, not the mode's: Func held in Play asks for DAW (for erasing) while the mode
        # is still Play.
        want = self.layout
        now = self.host.now()
        if not layout_reported(want, value) and now - self.last_layout_fix > LAYOUT_FIX_INTERVAL:
            self.last_layout_fix = now
            self.send(P.cc7(P.CC_PAD_LAYOUT, P.PAD_LAYOUT[want]))
            self.sent_pads.clear()
            self.leds_resend_at = now + LED_RESEND_DELAY

    # ---- modes --------------------------------------------------------------------------------------------------

    def set_mode(self, mode):
        prev = self.mode
        if prev == mode:
            return
        self.cancel_new_track()
        if prev == "play" and self.repeat_latch:
            self.set_repeat(False)
        if prev == "step":
            self.step.held.clear()  # a step let go in another mode stays
        if mode == "step":
            self.page_before_step = self.page_key
            self.page_key = "STEP"
            self.step.fix_page()
        elif prev == "step" and self.page_key == "STEP":
            self.page_key = self.page_before_step
        self.mode = mode
        self.set_layout(layout_for(mode))
        self.show_temp("Mode %d/%d" % (MODES.index(mode) + 1, len(MODES)), MODE_NAMES[mode])

    def next_mode(self):
        self.set_mode(MODES[(MODES.index(self.mode) + 1) % len(MODES)])

    def key_map(self):
        """What Morsel Keys has Live do with the keybed's notes: on a drum track every key plays a pad, C3 (48) =
        pad 1 up to D#4 = pad 16, repeating every 16 keys (Morsel's mapping, in the Launchkey's pad order).
        None: the keys pass as they are."""
        if not self.keys_drums:
            return None
        return [P.DRUM_NOTES[n % 16] for n in range(128)]

    def on_key(self, note, velocity, on):
        """A key from Morsel Keys, which hears the keybed while it plays the track. In Step mode it picks what the
        steps write: on a drum track the Drum Rack pad you hear (its note; C1-D#2 are the Launchkey's 16 pads), on a
        keys track the note."""
        if not on or self.mode != "step":
            return
        rack = self.drum_rack(self.sel_track())
        if rack is not None:
            rack.view.selected_drum_pad = rack.drum_pads[note]
            self.show_temp("Pad", self.step.item())
        else:
            self.step.keys_note = note
            self.show_temp("Note", note_name(note))

    def tap_is_double(self, pad):
        """Second tap of the same pad within DOUBLE_TAP (Track and Mute mode: double-tap = solo)."""
        now = self.host.now()
        last_pad, at = self.last_tap
        double = last_pad == pad and now - at < DOUBLE_TAP
        self.last_tap = (-1, 0.0) if double else (pad, now)
        return double

    def on_pad(self, pad, velocity):
        if self.mode == "play":
            if self.func_held:
                self.start_erase(pad)
        elif self.mode == "step":
            self.step.press(pad)
        elif self.mode == "track":
            self.track_pad(pad)
        elif self.mode == "mute":
            self.mute_pad(pad)
        elif self.mode == "pattern":
            self.pattern_pad(pad)

    def on_pad_release(self, pad):
        self.step.release(pad)
        self.stop_erase(pad)

    # ---- erase (hold Func + pads in Play mode, MPC style) -------------------------------------------------------

    def playing_clip(self, track):
        i = getattr(track, "playing_slot_index", -1)
        slots = list(getattr(track, "clip_slots", []))
        if 0 <= i < len(slots) and slots[i].has_clip and getattr(slots[i].clip, "is_midi_clip", False):
            return slots[i].clip
        return None

    def start_erase(self, pad):
        """Func + pad in Play mode: erase that note of the selected track as the playhead passes it, while held."""
        self.func_used = True
        clip = self.playing_clip(self.sel_track())
        if not self.song.is_playing or clip is None:
            self.show_temp("Erase", "Play a clip first")
            return
        pitch = P.DRUM_NOTES[pad]
        self.erasing[pad] = [pitch, clip.playing_position]
        rack = self.drum_rack(self.sel_track())
        self.show_temp("Erase", rack.drum_pads[pitch].name if rack is not None else note_name(pitch), hold=True)

    def stop_erase(self, pad=None):
        for p in ([pad] if pad is not None else list(self.erasing)):
            self.erasing.pop(p, None)
        if not self.erasing:
            self.release_hold()

    def erase_tick(self):
        clip = self.playing_clip(self.sel_track())
        if clip is None:
            return
        pos = clip.playing_position
        for e in self.erasing.values():
            pitch, last = e
            if pos >= last:
                ranges = [(last, pos + ERASE_AHEAD)]
            else:  # looped round
                ranges = [(last, clip.loop_end), (clip.loop_start, pos + ERASE_AHEAD)]
            for a, b in ranges:
                if b > a:
                    clip.remove_notes_extended(pitch, 1, a, b - a)
            e[1] = pos

    def track_pad(self, pad):
        """Top row = select tracks 1-8 (the next empty slot adds one). Bottom row = mute, double-tap = solo."""
        ts = self.tracks()
        if pad >= 8:
            i = pad - 8
            if i >= len(ts):
                if i == len(ts):
                    # The next free slot: set up a new track, then a second tap adds it.
                    if self.new_track is None:
                        self.new_track = "drum"
                        self.show_new_track()
                    else:
                        kind = self.new_track
                        self.cancel_new_track()
                        self.add_track(kind)
                return
            self.cancel_new_track()
            t = ts[i]
            self.select_track(t)
            self.show_temp("Track %d" % (i + 1), "%s (%s)" % (t.name, self.kind_label(t)))
            return
        self.cancel_new_track()
        if pad >= len(ts):
            return
        t = ts[pad]
        double = self.tap_is_double(pad)
        if double:
            t.mute = not t.mute  # the second tap undoes the first tap's mute
            t.solo = not t.solo
            self.show_temp(t.name, "Solo" if t.solo else "Solo off")
        else:
            t.mute = not t.mute
            self.show_temp(t.name, "Muted" if t.mute else "On")

    def kind_label(self, t):
        return {"drum": "drums", "keys": "keys", "audio": "audio"}[self.kind(t)]

    def show_new_track(self):
        if self.new_track is None:
            return
        n = len(self.tracks()) + 1
        self.show_temp("New T%d: %s" % (n, "Drums" if self.new_track == "drum" else "Keys"), "Enc 1 kind, tap: add",
                       hold=True)

    def cancel_new_track(self):
        if self.new_track is None:
            return
        self.new_track = None
        self.release_hold()

    def add_track(self, kind):
        """A MIDI track at the end with a Drum Rack (drums) or an instrument (keys), selected."""
        song = self.song
        n = len(self.tracks())
        try:
            song.create_midi_track(n)
        except Exception:
            self.show_temp("Track", "Can't add one")
            return
        t = self.tracks()[n]
        self.select_track(t)
        loaded = self.host.load_instrument("drum" if kind == "drum" else "keys")
        self.show_temp("T%d added" % (n + 1), t.name if loaded else "Add an instrument")

    def mute_pad(self, pad):
        """The pads of the drum track: tap = mute, double-tap = solo (the second tap undoes the first's mute)."""
        t = self.drum_track()
        if t is None:
            self.show_temp("Mute", "No Drum Rack")
            return
        dp = self.drum_pad(self.drum_rack(t), pad)
        double = self.tap_is_double(pad)
        dp.mute = not dp.mute
        if double:
            dp.solo = not dp.solo
            self.show_temp(dp.name, "Solo" if dp.solo else "Solo off")
        else:
            self.show_temp(dp.name, "Muted" if dp.mute else "On")

    def pattern_pad(self, pad):
        """Tap = go to that scene (queued while playing). Hold one + tap another = copy the held scene there; with
        Scene held too, only the selected track's clip."""
        sc = self.scenes()
        if pad >= min(len(sc), MAX_SCENES):
            return
        held = [p for p in self.held_pads if p != pad]
        if held:
            src = held[0]
            if src >= len(sc):
                return
            if self.scene_held:
                t = self.sel_track()
                self.copy_clip(t, src, pad)
                self.show_temp("Copied clip", "%s %d > %d" % (t.name, src + 1, pad + 1))
            else:
                for t in self.tracks():
                    self.copy_clip(t, src, pad)
                self.show_temp("Copied", "Scene %d > %d" % (src + 1, pad + 1))
            return
        self.go_to_scene(pad)

    @staticmethod
    def copy_clip(track, src, dst):
        slots = list(track.clip_slots)
        if src >= len(slots) or dst >= len(slots):
            return
        if slots[src].has_clip:
            slots[src].duplicate_clip_to(slots[dst])
        elif slots[dst].has_clip:
            slots[dst].delete_clip()

    def go_to_scene(self, i):
        """Select scene i; while playing also launch it (Live's launch quantization queues it, like Morsel)."""
        sc = self.scenes()
        if not 0 <= i < len(sc):
            return
        self.song.view.selected_scene = sc[i]
        playing = self.song.is_playing
        if playing:
            sc[i].fire()
        self.show_temp("Scene", "%d%s" % (i + 1, " (queued)" if playing else ""))

    def select_track(self, t):
        self.song.view.selected_track = t

    def step_track(self, direction):
        ts = self.tracks()
        if not ts:
            return
        cur = self.sel_track()
        i = ts.index(cur) + direction if cur in ts else 0
        t = ts[max(0, min(len(ts) - 1, i))]
        self.select_track(t)
        self.show_temp("Track %d/%d" % (ts.index(t) + 1, len(ts)), "%s (%s)" % (t.name, self.kind_label(t)))

    # ---- note repeat --------------------------------------------------------------------------------------------

    def set_repeat(self, on):
        nr = self.host.note_repeat
        if nr is not None:
            nr.repeat_rate = PG.REPEAT_RATES[self.repeat[0]][1]
            nr.enabled = on
        if not on:
            self.repeat_latch = False

    def repeat_on(self):
        nr = self.host.note_repeat
        return nr is not None and nr.enabled

    # ---- buttons ------------------------------------------------------------------------------------------------

    def on_button(self, button, down):
        if button == "shift":
            self.shift = down
            self.shift_since = self.host.now() if down else None
            self.shift_cover_next = 0
            if not down:
                # Close the shift map on the temporary target and show our screen again.
                self.send(P.display_config_sysex(P.DISPLAY_TEMPORARY, 0))
                self.sender.forget(P.DISPLAY_TEMPORARY)
                self.sender.forget(P.DISPLAY_STATIONARY)
                # Shift let go without picking one of the device's own pad modes: put back our layout.
                if self.native_pads is None and not layout_reported(self.layout, self.reported):
                    self.send(P.cc7(P.CC_PAD_LAYOUT, P.PAD_LAYOUT[self.layout]))
                    self.sent_pads.clear()
                    self.leds_resend_at = self.host.now() + LED_RESEND_DELAY
            return
        if down and self.shift and button in ("encPageUp", "encPageDown"):
            self.show_temp("Browse / Chop", "Not in Live yet")
            return
        if button == "scene" and not down:
            self.scene_held = False
            # Latched, note repeat keeps going.
            if not self.repeat_latch:
                self.set_repeat(False)
            self.release_hold()
            return
        # Shift + Pad up / down: previous / next track. The device sends its own Track CCs for them.
        direction = 0
        if button == "trackPrev" or (button == "padUp" and self.shift):
            direction = -1
        elif button == "trackNext" or (button == "padDown" and self.shift):
            direction = 1
        if direction:
            if down:
                self.step_track(direction)
            return
        if button == "scene":
            self.scene_down()
            return
        if button == "func" and not down and self.func_held:
            self.func_held = False
            self.stop_erase()
            if not self.func_used:
                self.next_mode()
            else:
                self.set_layout(layout_for(self.mode))
            return
        if not down:
            return
        if button == "play":
            if self.shift:
                self.song.metronome = not self.song.metronome
                self.show_temp("Metronome", "On" if self.song.metronome else "Off")
            else:
                self.toggle_play()
        elif button == "record":
            if self.shift:
                self.capture_midi()
            else:
                self.song.session_record = not self.song.session_record
        elif button == "func":
            if self.shift:
                self.undo()
            elif self.native_pads is not None:
                self.set_layout(layout_for(self.mode))  # take the pads back from the device's own mode
            elif self.mode == "play":
                # Held with pads it erases; the mode switch waits for the release. Meanwhile the pads come to the
                # script (DAW layout) instead of playing.
                self.func_held = True
                self.func_used = False
                self.set_layout("daw")
            else:
                self.next_mode()
        elif button in ("encPageUp", "encPageDown"):
            self.step_page(-1 if button == "encPageUp" else 1)
        elif button in ("padUp", "padDown"):
            d = -1 if button == "padUp" else 1
            if self.mode == "step":
                self.step.page = max(0, min(self.step.pages() - 1, self.step.page + d))
                self.show_temp("Bar", "%s / %d" % (self.step.bar_label(), self.step.bars()))
                return
            queued = sorted(self.queued_scenes())
            at = queued[0] if queued else self.scene_index()
            n = min(len(self.scenes()), MAX_SCENES)
            self.go_to_scene(max(0, min(n - 1, at + d)))

    def scene_down(self):
        if self.shift:
            if self.mode == "step" and self.drum_rack(self.sel_track()) is not None:
                # Step mode on a drum track clears the selected pad's notes; elsewhere the whole clip.
                if self.step.clear_pad():
                    self.show_temp("Cleared", self.step.item())
                else:
                    self.show_temp("Clear", "Nothing to clear")
                return
            self.clear_clip()
            return
        self.scene_held = True
        rate = PG.REPEAT_RATES[self.repeat[0]][0]
        if self.mode == "play":
            # A press while latched lets go; a second press in quick succession latches.
            now = self.host.now()
            if self.repeat_latch:
                self.set_repeat(False)
                self.last_scene_tap = 0.0
                self.scene_held = False
                self.show_temp("Repeat", "Off")
                return
            latch = now - self.last_scene_tap < DOUBLE_TAP
            self.last_scene_tap = 0.0 if latch else now
            self.set_repeat(True)
            self.repeat_latch = latch
            self.show_temp("Repeat", "%s latched" % rate if latch else rate, hold=not latch)
        elif self.mode == "pattern":
            self.show_temp("Scene", "Hold+2 pads: clip", hold=True)

    def toggle_play(self):
        song = self.song
        if song.is_playing:
            song.stop_playing()
            return
        # Like Morsel: Play plays the current pattern (scene) from its start.
        sc = self.scenes()
        i = self.scene_index()
        if i < len(sc) and self.scene_has_clips(sc[i]):
            sc[i].fire()
        else:
            song.start_playing()

    def capture_midi(self):
        song = self.song
        if getattr(song, "can_capture_midi", False):
            song.capture_midi()
            self.show_temp("Capture", "MIDI captured")
        else:
            self.show_temp("Capture", "Nothing to capture")

    def undo(self):
        song = self.song
        if song.can_undo:
            song.undo()
            self.show_temp("Undo", "Done")
        else:
            self.show_temp("Undo", "Nothing to undo")

    def current_clip(self, track):
        slots = list(getattr(track, "clip_slots", []))
        i = self.scene_index()
        return slots[i].clip if i < len(slots) and slots[i].has_clip else None

    def clear_clip(self):
        """Shift + Scene: remove the notes of the selected track's clip in the selected scene (the clip stays)."""
        t = self.sel_track()
        clip = self.current_clip(t)
        if clip is None or not getattr(clip, "is_midi_clip", False):
            self.show_temp("Clear", "Nothing to clear")
            return
        span = max(clip.length, clip.loop_end, clip.end_marker) + 1.0
        clip.remove_notes_extended(0, 128, 0.0, span)
        self.show_temp("Cleared", t.name)

    # ---- encoders -----------------------------------------------------------------------------------------------

    def pages(self):
        front = []
        if self.mode == "step":
            front.append(self.step.page_params())
        pad = self.pad_page()
        if pad is not None:
            front.append(pad)
        return front + PG.pages_for(self.song, self.sel_track(), self.host, self.repeat)

    def pad_page(self):
        """Drum tracks: the selected pad's instrument (its Simpler), like Morsel's Pad page."""
        rack = self.drum_rack(self.sel_track())
        if rack is None:
            return None
        dp = getattr(rack.view, "selected_drum_pad", None)
        if dp is None:
            return None
        n = P.DRUM_NOTES.index(dp.note) + 1 if dp.note in P.DRUM_NOTES else dp.note
        devices = list(dp.chains[0].devices) if len(dp.chains) else []
        if not devices:
            return PG.Page("PAD", "PAD", "%s empty" % n, [])
        params = [PG.LiveParam(p) if p is not None else None for p in self.host.device_bank(devices[0])]
        return PG.Page("PAD", "PAD", "%s %s" % (n, dp.name), params)

    def current_page(self, pages=None):
        pages = pages if pages is not None else self.pages()
        for p in pages:
            if p.key == self.page_key:
                return p
        return pages[0]

    def set_page(self, page):
        self.page_key = page.key
        if page.device is not None:
            self.song.view.select_device(page.device)
            self.last_device = page.device

    def step_page(self, direction):
        """No wrap-around: the arrow LEDs show which directions are available."""
        pages = self.pages()
        cur = self.current_page(pages)
        i = max(0, min(len(pages) - 1, pages.index(cur) + direction))
        self.set_page(pages[i])
        self.show_temp("Encoders", pages[i].summary)

    def on_encoder(self, index, delta):
        if self.mode == "step" and self.step.held and index < 2:
            self.step.edit_held(index, delta)
            return
        if self.mode == "track" and self.new_track is not None and index == 0:
            # Setting up a new track: encoder 1 picks the kind (right = Keys, left = Drums).
            self.new_track = "keys" if delta > 0 else "drum"
            self.show_new_track()
            return
        page = self.current_page()
        prm = page.params[index]
        if prm is None:
            return
        self.turner.turn((page.key, index), prm, delta, self.host.now())
        if page.key == "GLB" and prm.name == "Rept" and self.repeat_on():
            self.host.note_repeat.repeat_rate = PG.REPEAT_RATES[self.repeat[0]][1]
        self.show_temp(prm.name, prm.format(), encoder=index)

    # ---- rendering ----------------------------------------------------------------------------------------------

    def follow_live(self):
        """Things the selection in Live drives: the armed track, and the device page following the blue hand."""
        t = self.sel_track()
        if AUTO_ARM and t is not self.armed:
            if self.armed is not None:
                self._arm(self.armed, False)
            self.armed = t if self._arm(t, True) else None
        if self.drum_rack(t) is not None:
            self.last_drum_track = t
        drums = self.drum_rack(t) is not None
        if drums != self.keys_drums:
            self.keys_drums = drums
            self.host.keys_routing_changed()
        dev = getattr(getattr(t, "view", None), "selected_device", None)
        if dev is not None and dev is not self.last_device:
            self.last_device = dev
            devices = list(getattr(t, "devices", []))
            if dev in devices and (self.page_key is None or self.page_key.startswith("DEV")):
                self.page_key = "DEV%d" % devices.index(dev)

    @staticmethod
    def _arm(track, on):
        if not getattr(track, "can_be_armed", False) or not hasattr(track, "implicit_arm"):
            return False
        try:
            track.implicit_arm = on
            return True
        except Exception:
            return False

    def shift_rows(self):
        return [
            ("Play", "Metronome"),
            ("Rec", "Capture MIDI"),
            ("Func", "Undo"),
            ("Scene", "Clear pad" if self.mode == "step" and self.drum_rack(self.sel_track()) is not None
             else "Clear clip"),
            ("Pad ^v", "Track -/+"),
            ("Enc ^v", "Browse/Chop"),
        ]

    def screen(self, overlay):
        title, status = self.track_label(), self.status()
        if self.mode == "track":
            ts = self.tracks()
            cells = []
            for i in range(16):
                j = i - 8 if i >= 8 else i
                t = ts[j] if j < len(ts) else None
                if t is None and i >= 8 and j == len(ts) and j < MAX_TRACKS:
                    # The next free slot: "+" to add a track there, its kind (D / K) while one is set up.
                    if self.new_track is not None:
                        cells.append(S.GridCell("D" if self.new_track == "drum" else "K", fill=True))
                    else:
                        cells.append(S.GridCell("+"))
                elif t is None or j >= MAX_TRACKS:
                    cells.append(S.GridCell("", dim=True))
                elif i >= 8:
                    cells.append(S.GridCell(str(j + 1), fill=t == self.sel_track(), mark=self.kind(t) == "keys"))
                else:
                    cells.append(S.GridCell("S" if t.solo else "M" if t.mute else "", fill=self.audible(t)))
            info = "Enc1 kind Tap:add" if self.new_track is not None else "Up:pick Dn:mute"
            return S.grid_screen(title, status, cells, "TRACK", info)
        if self.mode == "mute":
            t = self.drum_track()
            if t is None:
                return S.grid_screen(title, status, [], "MUTE", "1x mute 2x solo", note="No Drum Rack")
            rack = self.drum_rack(t)
            cells = []
            for i in range(16):
                dp = self.drum_pad(rack, i)
                has = len(dp.chains) > 0
                label = "S" if dp.solo else "M" if dp.mute else str(i + 1)
                cells.append(S.GridCell(label, fill=has and not dp.mute, dim=not has))
            n = self.track_number(t)
            return S.grid_screen("T%d %s" % (n, t.name) if n else t.name, status, cells, "MUTE", "1x mute 2x solo")
        if self.mode == "pattern":
            sc = self.scenes()[:MAX_SCENES]
            queued = self.queued_scenes()
            cur = self.scene_index()
            cells = [S.GridCell(str(i + 1), fill=i == cur, mark=self.scene_has_clips(s), dim=i in queued)
                     for i, s in enumerate(sc)]
            info = "Next: S%d" % (min(queued) + 1) if queued else "Hold+tap copy"
            return S.grid_screen(title, status, cells, "SCENE", info)
        if self.mode == "step":
            page = self.current_page()
            return S.step_screen(title, status, self.step.item(), self.step.bar_label(), self.step.bars(),
                                 self.step.steps(), self.step.playhead(), page.tag, page.summary,
                                 per_row=self.step_row())
        page = self.current_page()
        cells = []
        for prm in page.params:
            if prm is None:
                cells.append(None)
            else:
                cells.append(S.EncoderCell(prm.name, prm.format(), prm.level()))
        return S.encoder_screen(title, status, page.tag, page.summary, cells,
                                active=overlay[2] if overlay else None)

    def step_row(self):
        return row_steps(self.step.span)

    def audible(self, t):
        if t.mute:
            return False
        soloed = any(x.solo for x in self.tracks())
        return t.solo or not soloed

    def tick(self):
        """Called by Live about every 100 ms: follow Live, draw the screen, light the LEDs."""
        now = self.host.now()
        self.follow_live()
        if self.erasing:
            self.erase_tick()
        msg = self.active_overlay()
        # On the 8-encoder screen the turned cell is highlighted instead; a popup would cover the bottom row.
        on_encoders = self.mode == "play"
        frame = self.screen(msg)
        if msg and not (msg[2] is not None and on_encoders):
            overlay_bar(frame, msg[0], msg[1])
        self.sender.show(P.DISPLAY_STATIONARY, frame.pack())
        if self.shift_since is not None:
            self.shift_cover(now)
        self.sender.pump()
        if self.leds_resend_at is not None and now >= self.leds_resend_at:
            self.leds_resend_at = None
            self.sent_pads.clear()
            self.sent_buttons.clear()
        self.render_leds()

    def shift_cover(self, now):
        held = now - self.shift_since
        n = self.shift_cover_next
        due = SHIFT_COVER_AT[n] if n < len(SHIFT_COVER_AT) else (
            SHIFT_COVER_AT[-1] + SHIFT_COVER_EVERY * (n - len(SHIFT_COVER_AT) + 1))
        if held >= due:
            self.shift_cover_next = n + 1
            self.sender.show(P.DISPLAY_TEMPORARY, S.shift_screen(self.shift_rows(), "MORSEL").pack(), force=True)

    # ---- LEDs ---------------------------------------------------------------------------------------------------

    def render_leds(self):
        if self.native_pads is None:
            for i, (color, mode) in enumerate(self.pad_leds()):
                self.set_pad(i, color, mode)
        for cc, value in self.button_leds().items():
            if self.sent_buttons.get(cc) != value:
                self.sent_buttons[cc] = value
                self.send(P.button_led_message(cc, value))

    def set_pad(self, pad, color, mode="static"):
        key = (self.layout, pad)
        sig = (color, mode)
        if self.sent_pads.get(key) == sig:
            return
        self.sent_pads[key] = sig
        # Flash / pulse alternate with the static colour, so set static first.
        if mode != "static":
            self.send(P.pad_led_message(self.layout, pad, 0))
        self.send(P.pad_led_message(self.layout, pad, color, mode))

    def pad_leds(self):
        off = (P.COLOR["off"], "static")
        leds = [off] * 16
        ts = self.tracks()
        if self.mode == "play":
            t = self.sel_track()
            rack = self.drum_rack(t)
            if rack is not None:
                sel = getattr(rack.view, "selected_drum_pad", None)
                for i in range(16):
                    dp = self.drum_pad(rack, i)
                    if len(dp.chains):
                        color = nearest_color(getattr(dp.chains[0], "color", t.color))
                        leds[i] = (color, "pulse" if dp == sel else "static")
            elif getattr(t, "has_midi_input", False):
                # Note pads in the track colour, the Cs white.
                tc = nearest_color(t.color)
                leds = [(P.COLOR["dimWhite"] if P.DRUM_NOTES[i] % 12 == 0 else tc, "static") for i in range(16)]
        elif self.mode == "step":
            t = self.sel_track()
            rack = self.drum_rack(t)
            color = nearest_color(t.color)
            if rack is not None:
                dp = rack.drum_pads[self.step.pitch()]
                if len(dp.chains):
                    color = nearest_color(getattr(dp.chains[0], "color", t.color))
            leds = self.step.leds(color)
        elif self.mode == "track":
            # Top row: tracks in their colours, the selected one pulsing. Bottom row: their mute / solo state.
            # The next free slot glows dimly (tap to add a track), pulsing while one is set up.
            for i in range(16):
                j = i - 8 if i >= 8 else i
                if j >= MAX_TRACKS:
                    continue
                if j >= len(ts):
                    if i >= 8 and j == len(ts):
                        leds[i] = (P.COLOR["white"], "pulse") if self.new_track else (P.COLOR["dimWhite"], "static")
                    continue
                t = ts[j]
                if i >= 8:
                    leds[i] = (nearest_color(t.color), "pulse" if t == self.sel_track() else "static")
                else:
                    color = "yellow" if t.solo else "green" if self.audible(t) else "dimRed"
                    leds[i] = (P.COLOR[color], "static")
        elif self.mode == "mute":
            t = self.drum_track()
            if t is not None:
                rack = self.drum_rack(t)
                for i in range(16):
                    dp = self.drum_pad(rack, i)
                    color = "yellow" if dp.solo else "dimRed" if dp.mute else "green" if len(dp.chains) else "dimGreen"
                    leds[i] = (P.COLOR[color], "static")
        elif self.mode == "pattern":
            queued = self.queued_scenes()
            cur = self.scene_index()
            for i, s in enumerate(self.scenes()[:MAX_SCENES]):
                if i in queued:
                    leds[i] = (P.COLOR["green"], "flash")
                elif i == cur:
                    leds[i] = (P.COLOR["green"], "static")
                elif self.scene_has_clips(s):
                    leds[i] = (P.COLOR["blue"], "static")
        return leds

    def button_leds(self):
        song = self.song
        on_beat = (song.current_song_time % 1.0) < 0.5
        counting = getattr(song, "is_counting_in", False)
        play = (LED_FULL if on_beat else LED_DIM) if song.is_playing and not counting else 0
        if counting:
            record = LED_FULL if on_beat else 0
        else:
            record = LED_FULL if song.session_record or song.record_mode else 0
        pages = self.pages()
        pi = pages.index(self.current_page(pages))
        if self.shift:
            many = LED_FULL if len(self.tracks()) > 1 else 0
            pad_up = pad_down = many
            enc_up = enc_down = 0
        else:
            if self.mode == "step":
                n, at = self.step.pages(), self.step.page
            else:
                n, at = min(len(self.scenes()), MAX_SCENES), self.scene_index()
            pad_up = LED_FULL if at > 0 else 0
            pad_down = LED_FULL if at < n - 1 else 0
            enc_up = LED_FULL if pi > 0 else 0
            enc_down = LED_FULL if pi < len(pages) - 1 else 0
        return {
            P.CC_PLAY: play,
            P.CC_RECORD: record,
            P.CC_FUNC: LED_FULL,
            P.CC_SCENE: LED_FULL if self.repeat_on() else LED_DIM,
            P.CC_PAD_UP: pad_up,
            P.CC_PAD_DOWN: pad_down,
            P.CC_ENC_PAGE_UP: enc_up,
            P.CC_ENC_PAGE_DOWN: enc_down,
        }
