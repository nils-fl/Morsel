# Morsel for Live

A control surface script for Ableton Live 12 that makes the Launchkey Mini MK4 work like it does in Morsel. It has the same pad modes, encoder pages and Shift layer, and the same 128×64 screen, with the track, scene and transport always in the header.

In Live terms, a Morsel **track** is a Live track (a drum track has a Drum Rack), a **pattern** is a **scene**, and a **pad** is a Drum Rack pad (notes 36–51).

## Setup
1. Run `./install.sh`. It links `live/Morsel` and `live/Morsel_Keys` into `~/Music/Ableton/User Library/Remote Scripts/`.
2. Restart Live. Live loads scripts only at start, so restart it after every change too.
3. Go to Settings → Link, Tempo & MIDI. Remove the stock Launchkey Mini MK4 control surface, then add **Morsel** with:
   - Input: **Launchkey Mini MK4 25 (DAW Out)**
   - Output: **Launchkey Mini MK4 25 (DAW In)**

   In the next row, add **Morsel_Keys** with input **Launchkey Mini MK4 25 (MIDI Out)** (the keybed) and output None. This step is optional. On a drum track, Morsel_Keys maps the keys to the pads as in Morsel. The keys still play the track, and in Step mode they also pick the step pad or note.
4. Under the ports list, set the following:
   - **DAW Out** input: Track and Remote on. The Play-mode pads reach the track through it.
   - **MIDI Out** input: Track on for the keybed, and Remote on for Morsel_Keys.

Errors and logs go to `~/Library/Preferences/Ableton/Live 12.x/Log.txt` (search for `Morsel`).

## Controls
Func cycles the pad modes: **Play → Step → Track → Mute → Pattern**. In Play mode the switch happens when Func is let go, because Func + pads erases there.

| Mode | Pads |
|---|---|
| Play | Play the selected track: Drum Rack pads in their chain colours, with the selected pad pulsing. On a keys track the pads are notes. Hold Scene for note repeat; press Scene twice to latch it. Hold Func and hold pads to erase their notes as the playhead passes (MPC style). |
| Step | The selected track's clip in the selected scene, 16 steps on the pads (top row 1–8, bottom row 9–16; rows of 6 on a triplet grid). A step goes on when pressed; a lit step goes off when let go. While holding steps, encoder 1 sets velocity and encoder 2 nudges. Pad ⌃/⌄ change the bar page. With Morsel_Keys, the keys pick what the steps write: on a drum track the pad you play, and on a keys track the note you play. Without Morsel_Keys, use the Pad or Note encoder. The first step makes a 1-bar clip. |
| Track | The top row selects tracks 1–8. Tap the next free slot to set up a new track (encoder 1 picks Drums or Keys), then tap again to add it with a Drum Rack or Drift. The bottom row mutes; double-tap solos. |
| Mute | The selected (or last) drum track's Drum Rack pads. Tap mutes; double-tap solos. |
| Pattern | Scenes 1–16, with 1 at the bottom left. Tap selects a scene, or launches it if Live is playing (Live's launch quantization queues it). Hold a scene and tap another to copy it there; also hold Scene to copy only the selected track's clip. |

| Button | Alone | With Shift |
|---|---|---|
| Play | Play the selected scene from the start, or stop | Metronome |
| Record | Session record (Live's count-in applies) | Capture MIDI |
| Func | Next mode | Undo (Live's undo, for the whole set) |
| Scene | Note repeat (hold, or press twice to latch) | Clear the selected track's clip in the selected scene (Step mode on a drum track: only the selected pad) |
| Pad ⌃ / ⌄ | Previous / next scene (Step mode: bar page) | Previous / next track |
| Encoder page ⌃ / ⌄ | Previous / next encoder page | (Browse / Chop, later) |

**Encoder pages** follow the selected track:
- **STEP** (Step mode only, first): Bars, Page, Grid (1/16, 1/32, 1/8T, 1/16T), Double (right doubles the loop with its notes, left halves it), Vel for new steps, and Pad (drum track) or Note (keys track).
- **PAD** (drum tracks): the selected Drum Rack pad's instrument, usually its Simpler.
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
- Erase works with the pads, not the keybed: the keybed goes straight to Live, so the script never sees it.
- Keybed on a drum track (with Morsel_Keys): the keys play the pads as in Morsel, at octave 0. C3 is pad 1 and D#4 is pad 16, in the Launchkey's pad order, repeating every 16 keys. Live translates the notes, so there's no extra delay, and recording works too. Other tracks get the keys as played.
- Not ported yet: Browse and Chop.

## Tests
`python3 -m pytest live/tests` runs the protocol, screens and controller against fake Live objects (`tests/fakes.py`).
