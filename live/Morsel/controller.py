# Maps Launchkey events to Live per hardware mode, and renders LEDs + the screen. The behaviour mirrors
# app/src/modes/controller.ts where Live has no better way of its own; the music lives in Live instead of Morsel's
# store: track -> Live track (drums = it has a Drum Rack), pad -> Drum Rack pad (notes 36-51), and Morsel's patterns
# are Live's scenes, launched from Clips mode (clips.py). Step mode is step.py, Browse browse.py.
# No Live import: `host` (see surface.py) gives the song and the few things that need Live's own module.
from . import pages as PG
from . import protocol as P
from . import scale as SC
from .colors import is_rgb, nearest_color, rgb, rgb7
from .display import screens as S
from .display.sender import BitmapSender
from .display.widgets import overlay_bar
from .browse import BrowseMode, is_sample
from .chop import ChopMode
from .clips import ClipsMode
from .step import StepMode, note_name, row_steps

MODES = ["play", "step", "track", "clips"]
MODE_NAMES = {"play": "Play", "step": "Step", "track": "Track", "clips": "Clips", "browse": "Browse", "chop": "Chop"}
# Entered on top of another mode (Shift + Encoder page up); leaving goes back to it.
TEMPORARY = ("browse", "chop")

LED_FULL, LED_DIM = 127, 16
DOUBLE_TAP = 0.3  # s
OVERLAY_S = 1.0  # s a popup stays
LAYOUT_FIX_INTERVAL = 1.0  # s between layout resends, so a device that keeps refusing can't cause a loop
LED_RESEND_DELAY = 0.15  # s after a layout switch: the device drops LED messages while it switches
TEMP_TIMEOUT_TENTHS = 10  # the device's temporary display: 1 s
# The shift map is drawn on the screen while Shift is held. The device still draws its own "Plugin | Drum" over it
# (DISABLE_DAW_LABEL doesn't stop that, tested 2026-10-28), so SHIFT_COVER sends the map to the temporary target too,
# which covers it (as Morsel's "bitmap" shift cover does; protocol_notes.md).
SHIFT_COVER = True
SHIFT_COVER_AT = (0.0, 0.1, 0.25, 0.5)  # s after Shift goes down
SHIFT_COVER_EVERY = 0.7  # s, then, while held
MAX_TRACKS = 8
MAX_SCENES = 16
ERASE_AHEAD = 0.1  # beats: erase a little ahead of the playhead, so a note about to sound goes too
AUTO_ARM = True  # the selected track is armed (implicitly, like Push), so the keybed and Record follow it
RGB_PADS = False  # True: Live's colours as RGB SysEx. It doesn't light the pads in DAW mode (tested 2026-10-28),
# and Live's own script uses the palette too; so the nearest palette colour.


def layout_for(mode):
    """Play and Chop use the drum layout (velocity, pressure, straight into the track: in Chop the pads play the
    slices); the other modes light the pads in DAW layout, and their notes come to the script."""
    return "drum" if mode in ("play", "chop") else "daw"


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
        self.shift_pick = None  # the layout the device reported while Shift was held: a pad mode picked on it
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
        self.step = StepMode(self)
        self.browse = BrowseMode(self)
        self.clips = ClipsMode(self)
        self.chop = ChopMode(self)
        self.prev_mode = "play"
        self.page_before_step = None
        self.page_before_chop = None
        self.erasing = {}  # pad -> [pitch, last playhead position]
        self.scale_sent = None  # (root, scale name) last sent to the device
        self._scale_names = None
        self.keys_drums = None  # whether the keybed maps to the pads (the selected track is a drum track)

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
        """The track's Drum Rack: a device of its own, or in an Instrument Rack's chain (some of Live's kits are
        built that way)."""
        for d in getattr(track, "devices", []):
            if getattr(d, "can_have_drum_pads", False):
                return d
            if getattr(d, "can_have_chains", False):
                for chain in getattr(d, "chains", []):
                    for inner in getattr(chain, "devices", []):
                        if getattr(inner, "can_have_drum_pads", False):
                            return inner
        return None

    def kind(self, track):
        if self.drum_rack(track) is not None:
            return "drum"
        return "keys" if getattr(track, "has_midi_input", False) else "audio"

    @staticmethod
    def drum_pad(rack, pad):
        """The Drum Rack pad under Launchkey pad `pad` (the drum layout's notes, so the pads match Play mode)."""
        return rack.drum_pads[P.DRUM_NOTES[pad]]

    @staticmethod
    def pad_color(track, dp):
        """A Drum Rack pad's colour: its chain's, or Morsel's colour for that pad when the chain just has the track's
        (Live's default, which would make every pad the same)."""
        color = getattr(dp.chains[0], "color", track.color)
        if color != track.color:
            return rgb(color)
        note = getattr(dp, "note", P.DRUM_NOTES[0])
        return P.PAD_COLORS[P.DRUM_NOTES.index(note) if note in P.DRUM_NOTES else note % 16]

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

    # ---- device -------------------------------------------------------------------------------------------------

    def send(self, msg):
        self.host.send(tuple(msg))

    def connect(self):
        """The handshake from Launchkey.handshake (app/src/midi/launchkey.ts)."""
        self.send(P.DAW_MODE_ON)
        self.send(P.live_connection(True))
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
        # From Live's own Launchkey script: the keybed on the DAW port, and its "Plugin | DAW" label off.
        self.send(P.keyboard_to_daw(True))
        self.send(P.DISABLE_DAW_LABEL)
        self.scale_sent = None  # send Live's scale again
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
        self.send(P.keyboard_to_daw(False))  # the keybed back on the MIDI port, for Morsel and other apps
        self.send(P.live_connection(False))
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
        if status in (0x90, 0x80) and (ch == P.CH_KEYS or (ch == P.CH_DRUM and self.hears_drum_notes())):
            # The keybed on the DAW port: ch9 as played, ch10 once mapped to the pads (drum tracks). In DAW layout
            # no pad sends on ch10, so a ch10 note is a key; in Browse's kits a pad counts as one too.
            self.on_key(d1, d2, status == 0x90 and d2 > 0)
            return
        if status == 0xB0 and ch == P.CH_FEATURE and (d1 in SC.CC_ROOT or d1 in SC.CC_SCALE):
            self.on_device_scale(d1, d2)
            return
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
        # Not while Shift is held: Shift + pad picks one of the device's own pad modes; Shift up decides.
        if self.shift:
            self.shift_pick = value
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

    def on_shift_up_layout(self):
        """A pad mode picked on the device while Shift was held (Chord Map reports 14) gets the pads; the DAW
        layout (2: the device's picker, or its DAW mode) puts ours back."""
        pick, self.shift_pick = self.shift_pick, None
        if pick is None or self.native_pads is not None or layout_reported(self.layout, pick):
            return
        if pick in (1, 2, 15):
            self.send(P.cc7(P.CC_PAD_LAYOUT, P.PAD_LAYOUT[self.layout]))
            self.sent_pads.clear()
            self.leds_resend_at = self.host.now() + LED_RESEND_DELAY
            return
        self.native_pads = pick
        self.show_temp("Pads", "Launchkey mode")

    # ---- modes --------------------------------------------------------------------------------------------------

    def set_mode(self, mode):
        prev = self.mode
        if prev == mode:
            return
        if prev == "play" and self.repeat_latch:
            self.set_repeat(False)
        if prev == "browse":
            self.browse.exit()
        if prev == "chop" and self.page_key == "CHOP":
            self.page_key = self.page_before_chop
        if prev not in TEMPORARY:
            self.prev_mode = prev
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
        if mode == "browse":
            self.browse.enter()
        elif mode == "clips":
            self.clips.enter()
        elif mode == "chop":
            self.page_before_chop = self.page_key
            self.page_key = "CHOP"
        if "chop" in (prev, mode):
            self.host.keys_routing_changed()  # in Chop the keys play the slices
        # The Func cycle shows where you are in it ("Mode 2/5"); Browse sits outside it.
        at = "Mode %d/%d" % (MODES.index(mode) + 1, len(MODES)) if mode in MODES else "Mode"
        self.show_temp(at, MODE_NAMES[mode])

    def next_mode(self):
        mode = self.prev_mode if self.mode in TEMPORARY else self.mode
        self.set_mode(MODES[(MODES.index(mode) + 1) % len(MODES)])

    def key_map(self):
        """What Live does with the keybed's notes (on the DAW port):
        on a drum track every key plays a pad, C3 (48) = pad 1 up to D#4 = pad 16, repeating every 16 keys (Morsel's
        mapping, in the Launchkey's pad order). None: the keys pass as they are."""
        if self.mode == "chop":
            return self.chop.key_map()
        if not self.keys_drums:
            return None
        return [P.DRUM_NOTES[n % 16] for n in range(128)]

    def hears_drum_notes(self):
        """Whether ch10 pad notes come to the script (heard, not taken): in DAW layout they can only be keys; in
        Browse's kits the pads play the kit and a pad or key loads the kit under the cursor."""
        return self.layout == "daw" or self.mode == "chop" or (self.mode == "browse" and self.browse.in_kits())

    def on_key(self, note, velocity, on):
        """A key, heard while it plays the track (on the DAW port). In Step mode it picks
        what the steps write: on a drum track the Drum Rack pad you hear, on a keys track the note."""
        if on and self.mode == "browse":
            self.browse.on_key()
        if on and self.mode == "chop":
            self.chop.on_note(note)
        if not on or self.mode != "step":
            return
        rack = self.drum_rack(self.sel_track())
        if rack is not None:
            rack.view.selected_drum_pad = rack.drum_pads[note]
            self.show_temp("Pad", self.step.item())
        else:
            self.step.keys_note = note
            self.show_temp("Note", note_name(note))

    # ---- scale (the Launchkey's Scale mode follows Live 12's song scale, both ways) ------------------------------

    def scale_names(self):
        if self._scale_names is None:
            self._scale_names = SC.scale_names(self.host.all_scales())
        return self._scale_names

    def on_device_scale(self, cc, value):
        song = self.song
        if cc in SC.CC_ROOT and 0 <= value < 12:
            if value == song.root_note:
                return  # the device echoing what we sent
            song.root_note = value
        elif cc in SC.CC_SCALE and value < len(self.scale_names()) and self.scale_names()[value]:
            if self.scale_names()[value] == song.scale_name:
                return
            song.scale_name = self.scale_names()[value]
        else:
            return
        self.scale_sent = (song.root_note, song.scale_name)  # the device has it already
        self.show_temp("Scale", SC.label(song.root_note, song.scale_name))

    def sync_scale(self):
        """Send Live's scale to the device when it changed (also right after connecting)."""
        song = self.song
        now = (song.root_note, song.scale_name)
        if now == self.scale_sent:
            return
        first = self.scale_sent is None
        self.scale_sent = now
        for cc in SC.CC_ROOT:
            self.send(P.cc7(cc, now[0]))
        index = SC.device_index(self.scale_names(), now[1])
        if index is not None:
            for cc in SC.CC_SCALE:
                self.send(P.cc7(cc, index))
        if not first:
            self.show_temp("Scale", SC.label(*now))

    def tap_is_double(self, pad):
        """Second tap of the same pad within DOUBLE_TAP (Track mode: double-tap = solo)."""
        now = self.host.now()
        last_pad, at = self.last_tap
        double = last_pad == pad and now - at < DOUBLE_TAP
        self.last_tap = (-1, 0.0) if double else (pad, now)
        return double

    def on_pad(self, pad, velocity):
        if self.mode == "play":
            if self.func_held:
                self.start_erase(pad)
        elif self.mode == "browse":
            self.browse.pad(pad)
        elif self.mode == "step":
            self.step.press(pad)
        elif self.mode == "track":
            self.track_pad(pad)
        elif self.mode == "clips":
            self.clips.press(pad)
        self.render_leds()  # right away, not on the next tick: a step lights as it's pressed

    def on_pad_release(self, pad):
        self.step.release(pad)
        self.stop_erase(pad)
        self.render_leds()

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
        """Top row = select tracks 1-8. Bottom row = mute, double-tap = solo."""
        ts = self.tracks()
        if pad >= 8:
            if pad - 8 < len(ts):
                t = ts[pad - 8]
                self.select_track(t)
                self.show_temp("Track %d" % (pad - 7), "%s (%s)" % (t.name, self.kind_label(t)))
            return
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
            self.shift_since = self.host.now() if down and SHIFT_COVER else None
            self.shift_cover_next = 0
            if down and SHIFT_COVER:
                # The device draws its own "Plugin | Drum" the moment Shift goes down: cover it right away, without
                # waiting for the next tick or for the ack of a frame in flight (as Morsel does). The retries follow.
                self.send(P.bitmap_sysex(P.DISPLAY_TEMPORARY, S.shift_screen(self.shift_rows(), "MORSEL").pack()))
                self.shift_cover_next = 1
            if not down and SHIFT_COVER:
                # Close the shift map on the temporary target and show our screen again.
                self.send(P.display_config_sysex(P.DISPLAY_TEMPORARY, 0))
                self.sender.forget(P.DISPLAY_TEMPORARY)
                self.sender.forget(P.DISPLAY_STATIONARY)
            if down:
                self.shift_pick = None
            else:
                self.on_shift_up_layout()
            return
        if down and self.shift and button in ("encPageUp", "encPageDown"):
            # Shift + Encoder page up: Browse on / off (in Chop: leave it, the Simpler stays sliced). Down: Chop
            # (the selected pad's sample, or the sample highlighted in Browse); in Chop: done, the chops onto pads.
            if button == "encPageDown":
                self.toggle_chop()
            elif self.mode in TEMPORARY:
                self.set_mode(self.prev_mode)
            else:
                self.set_mode("browse")
            return
        if self.mode == "chop" and down and self.chop_button(button):
            return
        if self.mode == "browse" and down and self.browse_button(button):
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
            elif self.mode in ("play", "clips"):
                # Held with pads it erases (Play) or stops tracks (Clips); the mode switch waits for the release.
                # In Play the pads meanwhile come to the script (DAW layout) instead of playing.
                self.func_held = True
                self.func_used = False
                if self.mode == "play":
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
            if self.mode == "clips":
                self.clips.scroll(d)
                return
            queued = sorted(self.queued_scenes())
            at = queued[0] if queued else self.scene_index()
            n = min(len(self.scenes()), MAX_SCENES)
            self.go_to_scene(max(0, min(n - 1, at + d)))

    def toggle_chop(self):
        """Shift + Encoder page down: chop the sample highlighted in Browse, or the selected pad's; in Chop, done."""
        if self.mode == "chop":
            popup = self.chop.done()
            self.set_mode(self.prev_mode)
            self.show_temp(*popup)
            return
        if self.mode == "browse":
            item = self.browse.current()
            if item is None or not is_sample(item):
                self.show_temp("Chop", "Pick a sample")
                return
            ok, popup = self.chop.open_from_item(item)
        else:
            ok, popup = self.chop.open_from_pad()
        if ok:
            self.set_mode("chop")
        else:
            self.show_temp(*popup)

    def chop_button(self, button):
        """Chop: Func keeps only the region (crop), Pad up / down pick the slice before / after. Returns whether it
        took the button."""
        if button == "func" and not self.shift:
            self.chop.crop()
            return True
        if button in ("padUp", "padDown") and not self.shift:
            self.chop.select(self.chop.selected() + (-1 if button == "padUp" else 1))
            return True
        return False

    def browse_button(self, button):
        """Browse owns Func / Pad down (open / load), Scene / Pad up (up a folder) and the encoder page arrows (one
        item), so the left hand selects while the right scrolls. Returns whether it took the button."""
        b = self.browse
        if button == "func" and self.shift:
            popup, leave = b.shift_press()
            if leave and popup is not None:
                self.set_mode(self.prev_mode)
            if popup is not None:
                self.show_temp(*popup)
            return True
        if (button == "func" or button == "padDown") and not self.shift:
            popup = b.press()
            if popup is not None:
                self.show_temp(*popup)
            return True
        if button == "scene" or (button == "padUp" and not self.shift):
            b.up()
            return True
        if button in ("encPageUp", "encPageDown"):
            b.move(-1 if button == "encPageUp" else 1)
            return True
        return False

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
        elif self.mode == "clips":
            self.show_temp("Scene", "Pad: launch row", hold=True)

    def toggle_play(self):
        """Live's own play / stop (scenes launch from Clips mode). In Step mode, starting also launches the clip
        being edited: in the session view the transport alone plays nothing."""
        song = self.song
        if song.is_playing:
            song.stop_playing()
            return
        slot = self.step.slot() if self.mode == "step" else None
        if slot is not None and slot.has_clip and not slot.is_playing:
            slot.fire()  # starts the transport too
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
        elif self.mode == "chop":
            front += [self.chop.page(), self.chop.sample_page()]
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
        if self.mode == "browse":
            self.browse.encoder(index, delta)
            return
        if self.mode == "step" and self.step.held and index < 3:
            self.step.edit_held(index, delta)
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
        # Live objects compare with == / != (a new Python wrapper comes back on every read), as Live's own
        # liveobj_changed does; `is` would see a new track every tick.
        if AUTO_ARM and t != self.armed:
            if self.armed is not None:
                self._arm(self.armed, False)
            self.armed = t if self._arm(t, True) else None
        drums = self.drum_rack(t) is not None
        if drums != self.keys_drums:
            self.keys_drums = drums
            self.host.keys_routing_changed()  # the keybed's map
            if drums and self.native_pads is not None:
                self.set_layout(layout_for(self.mode))  # the device's chords are for keys tracks, as in Morsel
        dev = getattr(getattr(t, "view", None), "selected_device", None)
        if dev is not None and dev != self.last_device:
            self.last_device = dev
            devices = list(getattr(t, "devices", []))
            if dev in devices and (self.page_key is None or self.page_key.startswith("DEV")):
                i = devices.index(dev)
                if not (self.page_key or "").startswith("DEV%d." % i):  # stay on this device's bank
                    self.page_key = "DEV%d.0" % i

    @staticmethod
    def _arm(track, on):
        # A deleted track raises on any attribute, the reads too.
        try:
            if not getattr(track, "can_be_armed", False) or not hasattr(track, "implicit_arm"):
                return False
            track.implicit_arm = on
            return True
        except Exception:
            return False

    def shift_rows(self):
        if self.mode == "chop":
            return [
                ("Play", "Metronome"),
                ("Rec", "Capture MIDI"),
                ("Func", "Undo"),
                ("Pad ^v", "Track -/+"),
                ("Enc ^", "Leave chop"),
                ("Enc v", "Done > pads"),
            ]
        if self.mode == "browse":
            drums = self.drum_rack(self.sel_track()) is not None
            return [
                ("Play", "Metronome"),
                ("Rec", "Capture MIDI"),
                ("Func", "Folder>pads" if self.browse.on_folder() and drums else "Load + exit"),
                ("Scene", "Up folder"),
                ("Enc ^", "Exit browse"),
                ("Enc v", "Chop sample"),
            ]
        return [
            ("Play", "Metronome"),
            ("Rec", "Capture MIDI"),
            ("Func", "Undo"),
            ("Scene", "Clear pad" if self.mode == "step" and self.drum_rack(self.sel_track()) is not None
             else "Clear clip"),
            ("Pad ^v", "Track -/+"),
            ("Enc ^v", "Browse/Chop"),
        ]

    def screen(self, overlay, pages=None):
        """The mode's screen; `pages`: the encoder pages, when the caller has built them already."""
        title, status = self.track_label(), self.status()
        if self.mode == "browse":
            b = self.browse
            items = [(label, folder) for label, _, folder in b.entries()]
            return S.browser_screen(title, b.target_label(), b.folder_label(), b.index, items)
        if self.mode == "chop":
            page = self.current_page(pages)
            return S.chop_screen(title, status, self.chop.name, self.chop.view(), page.tag, page.summary)
        if self.mode == "track":
            ts = self.tracks()
            cells = []
            for i in range(16):
                j = i - 8 if i >= 8 else i
                t = ts[j] if j < len(ts) and j < MAX_TRACKS else None
                if t is None:
                    cells.append(S.GridCell("", dim=True))
                elif i >= 8:
                    cells.append(S.GridCell(str(j + 1), fill=t == self.sel_track(), mark=self.kind(t) == "keys"))
                else:
                    cells.append(S.GridCell("S" if t.solo else "M" if t.mute else "", fill=self.audible(t)))
            return S.grid_screen(title, status, cells, "TRACK", "Up:pick Dn:mute")
        if self.mode == "clips":
            return S.grid_screen(title, status, self.clips.cells(), "CLIPS", self.clips.info())
        if self.mode == "step" and self.step.held:
            # Holding steps: encoders 1-3 edit them, so the screen shows those three.
            cells = self.step.held_cells()
            if cells is not None:
                return S.encoder_screen(title, status, "HOLD", self.step.item(), cells,
                                        active=overlay[2] if overlay else None)
        if self.mode == "step":
            page = self.current_page(pages)
            return S.step_screen(title, status, self.step.item(), self.step.bar_label(), self.step.bars(),
                                 self.step.steps(), self.step.playhead(), page.tag, page.summary,
                                 per_row=self.step_row())
        page = self.current_page(pages)
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
        if self.mode == "chop":
            self.chop.tick(now)
        if self.mode == "browse":
            self.browse.tick(now)
            if self.browse.pad_layout() != self.layout:
                self.set_layout(self.browse.pad_layout())  # in Drums' kits the pads play them
        self.sync_scale()
        pages = self.pages()  # once a tick: building them reads every device's parameters
        msg = self.active_overlay()
        # On the 8-encoder screen the turned cell is highlighted instead; a popup would cover the bottom row.
        on_encoders = self.mode == "play" or (self.mode == "step" and bool(self.step.held))
        if self.shift and msg is None:
            frame = S.shift_screen(self.shift_rows(), "MORSEL")  # what Shift does with each button
        else:
            frame = self.screen(msg, pages)
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
        self.render_leds(pages)

    def shift_cover(self, now):
        held = now - self.shift_since
        n = self.shift_cover_next
        due = SHIFT_COVER_AT[n] if n < len(SHIFT_COVER_AT) else (
            SHIFT_COVER_AT[-1] + SHIFT_COVER_EVERY * (n - len(SHIFT_COVER_AT) + 1))
        if held >= due:
            self.shift_cover_next = n + 1
            self.sender.show(P.DISPLAY_TEMPORARY, S.shift_screen(self.shift_rows(), "MORSEL").pack(), force=True)

    # ---- LEDs ---------------------------------------------------------------------------------------------------

    def render_leds(self, pages=None):
        if self.native_pads is None:
            for i, (color, mode) in enumerate(self.pad_leds()):
                self.set_pad(i, color, mode)
        for cc, value in self.button_leds(pages).items():
            if self.sent_buttons.get(cc) != value:
                self.sent_buttons[cc] = value
                self.send(P.button_led_message(cc, value))

    def set_pad(self, pad, color, mode="static"):
        """`color`: a palette index, or a Live colour (colors.rgb). The device animates only palette colours, so
        a flashing or pulsing Live colour goes as its nearest palette colour."""
        key = (self.layout, pad)
        sig = (color, mode)
        prev = self.sent_pads.get(key)
        if prev == sig:
            return
        self.sent_pads[key] = sig
        if is_rgb(color) and mode == "static" and RGB_PADS:
            if prev is None or prev[1] != "static":
                self.send(P.pad_led_message(self.layout, pad, 0))  # stop a flash / pulse first
            self.send(P.pad_rgb_sysex(self.layout, pad, *rgb7(color[1])))
            return
        if is_rgb(color):
            color = nearest_color(color[1])
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
                        leds[i] = (self.pad_color(t, dp), "pulse" if dp == sel else "static")
            elif getattr(t, "has_midi_input", False):
                # Note pads in the track colour, the Cs white.
                tc = rgb(t.color)
                leds = [(P.COLOR["dimWhite"] if P.DRUM_NOTES[i] % 12 == 0 else tc, "static") for i in range(16)]
        elif self.mode == "browse":
            leds = self.browse.leds()
        elif self.mode == "chop":
            leds = self.chop.leds()
        elif self.mode == "step":
            t = self.sel_track()
            rack = self.drum_rack(t)
            color = rgb(t.color)
            if rack is not None:
                dp = rack.drum_pads[self.step.pitch()]
                if len(dp.chains):
                    color = self.pad_color(t, dp)
            leds = self.step.leds(color)
        elif self.mode == "track":
            # Top row: tracks in their colours, the selected one pulsing. Bottom row: their mute / solo state.
            for i in range(16):
                j = i - 8 if i >= 8 else i
                if j >= MAX_TRACKS or j >= len(ts):
                    continue
                t = ts[j]
                if i >= 8:
                    leds[i] = (rgb(t.color), "pulse" if t == self.sel_track() else "static")
                else:
                    color = "yellow" if t.solo else "green" if self.audible(t) else "dimRed"
                    leds[i] = (P.COLOR[color], "static")
        elif self.mode == "clips":
            leds = self.clips.leds()
        return leds

    def button_leds(self, pages=None):
        song = self.song
        on_beat = (song.current_song_time % 1.0) < 0.5
        counting = getattr(song, "is_counting_in", False)
        play = (LED_FULL if on_beat else LED_DIM) if song.is_playing and not counting else 0
        if counting:
            record = LED_FULL if on_beat else 0
        else:
            record = LED_FULL if song.session_record or song.record_mode else 0
        func = LED_FULL
        scene = LED_FULL if self.repeat_on() else LED_DIM
        if self.shift:
            # Pad arrows: previous / next track. Encoder page up: Browse on / off; down: Chop.
            many = LED_FULL if len(self.tracks()) > 1 else 0
            pad_up = pad_down = many
            enc_up, enc_down = LED_FULL, LED_FULL
        elif self.mode == "browse":
            # Func / Pad down open or load, Scene / Pad up go up a folder, the encoder page arrows step the list.
            enter = LED_FULL if self.browse.can_enter() else 0
            up = LED_FULL if self.browse.can_up() else 0
            func, scene, pad_up, pad_down, enc_up, enc_down = enter, up, up, enter, enter, enter
        else:
            pages = pages if pages is not None else self.pages()
            pi = pages.index(self.current_page(pages))
            if self.mode == "step":
                n, at = self.step.pages(), self.step.page
            elif self.mode == "chop":
                n, at = len(self.chop.slices()), self.chop.selected()
            elif self.mode == "clips":
                n, at = len(self.scenes()) - 1, self.scene_index()
            else:
                n, at = min(len(self.scenes()), MAX_SCENES), self.scene_index()
            pad_up = LED_FULL if at > 0 else 0
            pad_down = LED_FULL if at < n - 1 else 0
            enc_up = LED_FULL if pi > 0 else 0
            enc_down = LED_FULL if pi < len(pages) - 1 else 0
        return {
            P.CC_PLAY: play,
            P.CC_RECORD: record,
            P.CC_FUNC: func,
            P.CC_SCENE: scene,
            P.CC_PAD_UP: pad_up,
            P.CC_PAD_DOWN: pad_down,
            P.CC_ENC_PAGE_UP: enc_up,
            P.CC_ENC_PAGE_DOWN: enc_down,
        }
