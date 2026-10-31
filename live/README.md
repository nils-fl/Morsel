# Morsel for Live

A control surface script for Ableton Live 12 that makes the Launchkey Mini MK4 work like it does in Morsel. It has the same pad modes, encoder pages and Shift layer, and the same 128×64 screen, with the track, scene and transport always in the header. It also has the best of Live's own Launchkey script: clip launching, scale sync, device banks and transport controls.

In Live terms, a Morsel **track** is a Live track (a drum track has a Drum Rack), and a **pad** is a Drum Rack pad (notes 36–51).

## Setup
1. Download it from [morselbox.com](https://morselbox.com/), unzip it and put the `Morsel` folder into `Remote Scripts` in Live's User Library (`~/Music/Ableton/User Library/Remote Scripts/` on a Mac; make the folder if it isn't there). From the repo, run `./install.sh` instead: it links `live/Morsel` there, so edits are what Live loads.
2. Restart Live. Live loads scripts only at start, so restart it after every change too.
3. Go to Settings → Link, Tempo & MIDI. Remove the stock Launchkey Mini MK4 control surface, then add **Morsel** with:
   - Input: **Launchkey Mini MK4 25 (DAW Out)**
   - Output: **Launchkey Mini MK4 25 (DAW In)**
4. Under the ports list, set **DAW Out** input to Track and Remote on. The pads, and the keybed, reach the track through it. Keep **MIDI Out** input on Track.

Errors and logs go to `~/Library/Preferences/Ableton/Live <version>/Log.txt` (search for `Morsel`).

## Controls
Func cycles the pad modes: **Play → Step → Track → Clips**. In Play and Clips the switch happens when Func is let go, because Func + pads does something there.

| Mode | Pads |
|---|---|
| Play | Play the selected track: Drum Rack pads in their chain colours, with the selected pad pulsing. On a keys track the pads are notes. Hold Scene for note repeat; press Scene twice to latch it. Hold Func and hold pads to erase their notes as the playhead passes (MPC style). |
| Step | The selected track's clip in the selected scene, 16 steps on the pads (top row 1–8, bottom row 9–16; rows of 6 on a triplet grid). A step goes on when pressed; tapping a lit step takes it off (holding it, longer than 0.4 s, keeps it). While holding steps, encoder 1 sets velocity, 2 nudges and 3 sets the length, and the screen shows those three with the held step's values. Pad ⌃/⌄ change the bar page. The keys pick what the steps write: on a drum track the pad you play, on a keys track the note. Or use the Pad / Note encoder. The first step makes a 1-bar clip. |
| Track | The top row selects tracks 1–8. The bottom row mutes; double-tap solos. |
| Clips | Live's session view on the pads: 8 tracks (the 8 around the selected one) × 2 scenes (the top row starts on the selected scene, the bottom row is the next; they stay put when a launch selects another scene). Tap launches a clip, records on an armed track, or stops the track on an empty slot. Scene + pad launches that row's scene. Func + pad stops that track. Pad ⌃/⌄ scroll the scenes. Clips light in their colours: playing pulses, queued flashes, recording is red, an empty slot on an armed track is dim red. |
| Browse | Live's browser on the screen; Shift + Encoder page ⌃ opens and closes it, back to the mode before. Encoders 1 and 8 scroll, 2 and 7 jump to the next or previous letter, and the encoder page arrows move one item. Func or Pad ⌄ opens a folder or loads the item; Scene or Pad ⌃ goes up a folder. Shift + Func loads and leaves Browse; on a sample folder it puts the first 16 samples on pads 1–16. Samples preview as the cursor lands on them. On a track with an instrument, Browse opens on that instrument's presets (all its folders in one list, the cursor on the loaded one); the preset under the cursor loads onto the instrument once the cursor rests, or when you play a key, so the keys play it. Every load is a step in Live's undo. Scene or Pad ⌃ goes up to all instruments. A plug-in instrument lists its own presets instead, and they switch as the cursor lands on them, with nothing to load. In Drums on a drum track, the kits load the same way (the cursor resting a moment, or a key or pad), and the pads play the kit there instead of picking a pad. A pad press picks that pad (drum track) and previews again. On a drum track a sample (or instrument) loads onto the selected pad and a kit from Drums replaces the Drum Rack; on other tracks things load onto the track. |
| Chop | Morsel's Chop with Live's Simpler. Shift + Encoder page ⌄ chops the selected pad's sample if it plays in a Simpler (the pad stays as it is; Live doesn't let a script read a Drum Sampler's sample, so chop those from Browse) or, in Browse, the highlighted sample: it goes into a Simpler on a new "Chop …" track, sliced into 16 equal steps. The pads play the slices (as on a Drum Rack) and so do the keys (C3 = slice 1, one key each); playing one selects it, as do Pad ⌃/⌄. Func keeps only the region (Simpler's Crop), and Scene warps it to the Beats on SAMPLE. Hold a key and tap a pad to put that chop there (Morsel's way to keep only the chops you want). Shift + Encoder page ⌄ again is done: Live's Slice to Drum Rack makes the Chop track a drum track, with the chosen chops on their pads, or all of them in order. Shift + Encoder page ⌃ leaves Chop with the Simpler still sliced. The screen shows the wave (read from the sample's WAV or AIFF file, as Live doesn't hand a script the audio), the region and the slices, the selected one inverted. |

| Button | Alone | With Shift |
|---|---|---|
| Play | Live's play / stop (Step mode: also launches the clip being edited) | Metronome |
| Record | Session record (Live's count-in applies) | Capture MIDI |
| Func | Next mode | Undo (Live's undo, for the whole set) |
| Scene | Note repeat (hold, or press twice to latch); in Clips, hold + pad launches a scene | Clear the selected track's clip in the selected scene (Step mode on a drum track: only the selected pad) |
| Pad ⌃ / ⌄ | Previous / next scene (Step mode: bar page; Clips: scroll) | Previous / next track |
| Encoder page ⌃ / ⌄ | Previous / next encoder page | ⌃: Browse on / off (in Chop: leave it). ⌄: Chop (in Chop: done, the chops onto pads) |

Holding Shift shows what it does with each button on the screen.

### Chop a sample → pads
1. **Find the sample.** On a drum track open Browse (Shift + Encoder page ⌃) and highlight a loop or a break in Samples (or Drums → Drum Hits). Or select a pad whose sound plays in a Simpler.
2. **Shift + Encoder page ⌄.** The sample goes into a Simpler on a new "Chop …" track, cut into 16 equal chops, and the screen shows its wave. The pads and keys play the chops (C3 = chop 1).
3. **The region**, on the SAMPLE page (Encoder page ⌄): encoders 3 and 4 set its Start and End; Func keeps only the region. To fit it to the tempo, set Beats (encoder 5, Live's guess to start with) and press Scene.
4. **The chops**, on the CHOP page (Encoder page ⌃): Mode and Count (encoders 5 and 6) place them, equal steps or at the hits. To move one, hit its pad, zoom in (encoder 2) and turn Start or End (encoders 3 and 4); Split (encoder 7) cuts it in two or removes it.
5. **Pick the chops to keep** (optional): hold a chop's key and tap the pad it should go on, in any order; a chop can go on several pads. The chosen pads light in their chop's colour.
6. **Shift + Encoder page ⌄** again: Live's Slice to Drum Rack makes the drum track, with the chosen chops on their pads (or, if you picked none, chop 1 to 16 in order), and the Launchkey goes back to Play mode on it.

**Encoder pages** follow the selected track; the footer names the page as soon as you change it.
- **CHOP** and **SAMPLE** (Chop mode only, first): on both, encoder 1 scrolls, 2 zooms (around the selected chop; a pad or key you play is brought into view), and 3 and 4 are Start and End: on SAMPLE the region's, on CHOP the selected chop's (its end is the next chop's start; on the last chop, the region's end). They move a screen pixel per detent, so zooming in makes them finer, and moving a chop makes the slicing Manual. CHOP also has Mode (Equal, Hits, Beat or Manual: Simpler's Region, Transient, Beat and Manual slicing), Count (Equal), Sens (Hits) or Div (Beat) and Split (right splits the selected chop in two, left removes it). Chops past 16 are picked with Pad ⌃/⌄ or the keys. SAMPLE also has Beats: the region's length (Live's guess at first, as a musical length), and Scene warps the sample to it, so it plays in time with Live's tempo (Simpler's Warp as). Func keeps only the region.
- **STEP** (Step mode only, first): Bars, Grid (1/16, 1/32, 1/8T, 1/16T), Double (right doubles the loop with its notes, left halves it), Vel for new steps, Quant (turn right: quantize the clip to the grid), and Pad (drum track) or Note (keys track).
- **PAD** (drum tracks): the selected Drum Rack pad's instrument, usually its Simpler.
- **Devices**: each device's best 8 parameters, then all of them 8 at a time ("Drift 2/5"). Paging to a device selects it in Live, and clicking a device in Live switches to its page.
- **TRK**: volume, pan and the sends.
- **FX**: Morsel's Track FX with Live's effects, each added at the end of the track (before the duck) the first time its encoder is turned: **Filter** (Off, LP, HP, BP: Auto Filter; Off switches it off), **Cutoff** and **Reso**, **Low**, **Mid** and **High** (EQ Three), **Drive** (Saturator, 0–100 %) and **Comp** (a Compressor's threshold, 0–100 %); Drive and Comp at 0 switch their effect off. The footer lists what's on.
- **DUCK**: sidechain ducking, Morsel's ducker done the Live way. Turn **Duck** right to put Live's Compressor at the end of the track with its sidechain on, fed by the drum track's kick chain (when it finds one); left removes it. **Source** and **Pad** pick the sidechain's track and chain (any pad, or the whole track), then the Compressor's **Thresh**, **Ratio**, **Attack**, **Release** and **Mix**. A Compressor follows the kick's sound, not each sequenced hit as Morsel's does.
- **MIX**: the levels of tracks 1–8.
- **GLB**: tempo, groove (Live's Global Groove Amount: how much the groove pool's swing applies), record quantize, note repeat rate, launch quantize.
- **POS**: song position (a bar per detent), loop on / off, loop start and length, markers (previous / next, with the name), arrangement zoom across and up / down.

In Play, Track and Clips, encoders on a Live parameter (the device pages, TRK and MIX) go through Live's own MIDI map, as with Live's Launchkey script: Live turns the parameter itself, with its own sensitivity (lists step at a rate that suits their length), a whole turn is one undo step, and the screen follows the parameter. The script's own settings (Step, Browse, Chop, GLB, POS) take 4 detents per step when they have only a few values, except the first detent of a turn, which steps straight away.

**Keybed**: on a drum track the keys play the pads as in Morsel, at octave 0: C3 is pad 1 and D#4 is pad 16, in the Launchkey's pad order, repeating every 16 keys. Live translates the notes, so there's no extra delay and recording gets the pads. Other tracks get the keys as played.

**Scale**: the Launchkey's Scale mode follows Live 12's song scale (root and scale), and picking a scale on the Launchkey sets Live's.

The selected track is armed automatically, so the keybed and Record follow it. Pads show Live's track, clip and pad colours. A lit pad gets Live's exact colour; a pulsing or flashing one gets the nearest of the device's own colours, as Live's own Launchkey script does. Drum Rack pads that only have the track's colour (Live's default) get Morsel's pad colours.

## Differences from Morsel
- Undo is Live's global undo, not per track.
- On a keys track the Play-mode pads send notes 36–51 (C1–D#2), not from C3. The pads go straight to Live, so the script can't transpose them.
- Patterns are Live's scenes, launched from Clips mode; Live Lite allows 8.
- Morsel's Pattern and Mute modes and adding tracks from the Launchkey are left out: Live has its own clip launching, Drum Rack pad mutes and ⇧⌘T.
- Chop shows no wave for MP3 or FLAC files.

## Tests
`python3 -m pytest live/tests` runs the protocol, screens and controller against fake Live objects (`tests/fakes.py`).
