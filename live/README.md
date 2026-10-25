# Morsel for Live

A control surface script for Ableton Live 12 that makes the Launchkey Mini MK4 work like it does in Morsel. It has the same pad modes, encoder pages and Shift layer, and the same 128×64 screen, with the track, scene and transport always in the header.

In Live terms, a Morsel **track** is a Live track (a drum track has a Drum Rack), a **pattern** is a **scene**, and a **pad** is a Drum Rack pad (notes 36–51).

## Setup
1. Run `./install.sh`. It links `live/Morsel` into `~/Music/Ableton/User Library/Remote Scripts/`.
2. Restart Live. Live loads scripts only at start, so restart it after every change too.
3. Go to Settings → Link, Tempo & MIDI. Remove the stock Launchkey Mini MK4 control surface, then add **Morsel** with:
   - Input: **Launchkey Mini MK4 25 (DAW Out)**
   - Output: **Launchkey Mini MK4 25 (DAW In)**
4. Under the ports list, set the following:
   - **DAW Out** input: Track and Remote on. The Play-mode pads reach the track through it.
   - **MIDI Out** input: Track on, for the keybed.

Errors and logs go to `~/Library/Preferences/Ableton/Live 12.x/Log.txt` (search for `Morsel`).

## Controls
Func cycles the pad modes: **Play → Track → Mute → Pattern**. In Play mode the switch happens when Func is let go.

| Mode | Pads |
|---|---|
| Play | Play the selected track: Drum Rack pads in their chain colours, with the selected pad pulsing. On a keys track the pads are notes. Hold Scene for note repeat; press Scene twice to latch it. |
| Track | The top row selects tracks 1–8. Tap the next free slot to set up a new track (encoder 1 picks Drums or Keys), then tap again to add it with a Drum Rack or Drift. The bottom row mutes; double-tap solos. |
| Mute | The selected (or last) drum track's Drum Rack pads. Tap mutes; double-tap solos. |
| Pattern | Scenes 1–16, with 1 at the bottom left. Tap selects a scene, or launches it if Live is playing (Live's launch quantization queues it). Hold a scene and tap another to copy it there; also hold Scene to copy only the selected track's clip. |

| Button | Alone | With Shift |
|---|---|---|
| Play | Play the selected scene from the start, or stop | Metronome |
| Record | Session record (Live's count-in applies) | Capture MIDI |
| Func | Next mode | Undo (Live's undo, for the whole set) |
| Scene | Note repeat (hold, or press twice to latch) | Clear the selected track's clip in the selected scene |
| Pad ⌃ / ⌄ | Previous / next scene | Previous / next track |
| Encoder page ⌃ / ⌄ | Previous / next encoder page | (Browse / Chop, later) |

**Encoder pages** follow the selected track:
- one page per device, with Live's best 8 parameters. Paging to a device selects it in Live, and clicking a device in Live switches to its page.
- **TRK**: volume, pan and the sends.
- **MIX**: the levels of tracks 1–8.
- **GLB**: tempo, swing, record quantize, note repeat rate, launch quantize and metronome.

Settings with only a few values take 4 detents per step, except the first detent of a turn, which steps straight away.

The selected track is armed automatically, so the keybed and Record follow it.

## Differences from Morsel
- Undo is Live's global undo, not per track.
- On a keys track the Play-mode pads send notes 36–51 (C1–D#2), not from C3. The pads go straight to Live, so the script can't transpose them.
- Live Lite allows 8 scenes, so Pattern mode lights 8 pads.
- Not ported yet: Step mode, erase (Func + pads), the Pad page (the selected pad's Simpler), Browse and Chop.

## Tests
`python3 -m pytest live/tests` runs the protocol, screens and controller against fake Live objects (`tests/fakes.py`).
