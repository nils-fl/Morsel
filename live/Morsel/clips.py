# Clips mode: Live's session view on the pads, 8 tracks x 2 scenes. The top row starts on the selected scene, the
# bottom row is the next one, and only Pad up / down move them (Live selects a scene as it launches); the columns are
# the group of 8 tracks holding the selected track. It takes the place of Morsel's Pattern mode: a tap launches a clip,
# Scene + pad launches that row's scene, Func + pad stops that track.
from . import protocol as P
from .colors import rgb
from .display.screens import GridCell


class ClipsMode(object):
    def __init__(self, controller):
        self.c = controller
        self.top = 0  # the scene on the top row

    def enter(self):
        self.top = self.c.scene_index()

    def top_scene(self):
        return max(0, min(len(self.c.scenes()) - 1, self.top))  # scenes may have been deleted

    def offset(self):
        """The first of the 8 tracks on the pads: the group of 8 holding the selected track."""
        ts = self.c.tracks()
        t = self.c.sel_track()
        return (ts.index(t) // 8) * 8 if t in ts else 0

    def slot_at(self, pad):
        """The (track, scene index, slot) under a pad; track and slot are None past the last track or scene."""
        ts = self.c.tracks()
        col = self.offset() + pad % 8
        scene = self.top_scene() + (0 if pad >= 8 else 1)
        if col >= len(ts):
            return None, scene, None
        slots = list(ts[col].clip_slots)
        return ts[col], scene, slots[scene] if scene < len(slots) else None

    def press(self, pad):
        """Tap = launch the clip (or record on an armed track, or stop the track on an empty slot). Scene + pad =
        launch that row's scene. Func + pad = stop that track."""
        c = self.c
        track, scene, slot = self.slot_at(pad)
        if c.scene_held:
            sc = c.scenes()
            if scene < len(sc):
                sc[scene].fire()
                c.show_temp("Scene", "%d launched" % (scene + 1))
            return
        if track is None:
            return
        if c.func_held:
            c.func_used = True
            track.stop_all_clips()
            c.show_temp(track.name, "Stopped")
            return
        if slot is not None:
            slot.fire()
            c.show_temp(track.name, slot.clip.name if slot.has_clip and slot.clip.name else "Scene %d" % (scene + 1))

    def scroll(self, direction):
        """Pad up / down: move the two rows a scene; launching is the pads' job here."""
        c = self.c
        sc = c.scenes()
        i = max(0, min(len(sc) - 1, self.top_scene() + direction))
        self.top = i
        c.song.view.selected_scene = sc[i]
        c.show_temp("Scenes", "%d-%d" % (i + 1, i + 2))

    def cells(self):
        """For grid_screen: the track number in each slot; playing or recording = solid, a clip = a bar under it,
        queued = dotted."""
        ts = self.c.tracks()
        out = []
        for pad in range(16):
            track, _, slot = self.slot_at(pad)
            if slot is None:
                out.append(None)
                continue
            out.append(GridCell(str(ts.index(track) + 1), fill=slot.is_playing or slot.is_recording,
                                mark=slot.has_clip, dim=slot.is_triggered))
        return out

    def info(self):
        off, s0 = self.offset(), self.top_scene()
        return "S%d-%d T%d-%d" % (s0 + 1, s0 + 2, off + 1, off + 8)

    def leds(self):
        """Clips in their colours: playing pulses, queued flashes, recording is red; an empty slot on an armed track
        is dim red."""
        out = [(P.COLOR["off"], "static")] * 16
        for pad in range(16):
            track, _, slot = self.slot_at(pad)
            if slot is None:
                continue
            color = rgb(slot.clip.color) if slot.has_clip else None
            if slot.is_recording:
                out[pad] = (P.COLOR["red"], "pulse")
            elif slot.is_triggered:
                out[pad] = (color if color is not None else P.COLOR["green"], "flash")
            elif slot.is_playing:
                out[pad] = (color, "pulse")
            elif slot.has_clip:
                out[pad] = (color, "static")
            elif getattr(track, "arm", False) or getattr(track, "implicit_arm", False):
                out[pad] = (P.COLOR["dimRed"], "static")
        return out
