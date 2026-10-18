# LaunchKit

<p align="center">
  <img src="docs/boot-animation.gif" alt="LaunchKit start-up animation on the Launchkey screen: a blob eats a waveform, burps, and the LAUNCHKIT logo bounces in" width="540">
</p>

A browser-based groovebox for the **Novation Launchkey Mini MK4 25**. LaunchKit puts the Launchkey in DAW mode over Web MIDI and takes over its pads, encoders, buttons and screen, turning it into a standalone sampler, step sequencer and song arranger. You don't need a DAW.

## Features

- **16-pad sampler**: velocity-sensitive pads with start/end, pitch, attack/decay, HP/LP filters with resonance, pan and volume. Pad pressure opens the filters.
- **Pad modes** (cycle with Func):
  - **Play**: play the pads.
  - **Step**: 16-step grid for the selected track (on a drum track, the selected pad; on a keys track, the last key you played is the note).
  - **Track**: top pad row selects tracks 1–8, bottom row mutes them (double-tap = solo).
  - **Mixer**: tap a pad of the drum track to mute it, double-tap to solo.
  - **Pattern**: switch patterns; while playing, the switch waits until the loop ends.
- **Tracks** (MPC style): up to 8 tracks, each a **Drum** rack (16 pads) or a **Keys** instrument. Pick one in the track strip under the pattern buttons or in Track mode. The pads play the last drum track you picked, the keybed the last keys track, so you can drum and play keys at once.
- **Sequencer**: 16 patterns (sequences) of 1–4 bars, each holding one clip per track, with live recording (count-in, overdub), quantize, swing, note repeat, metronome and undo.
- **Keys**: a synth/sample instrument per keys track, played from the keybed and recorded into that track's clip. The Launchkey's Arp and Scale still work.
- **Matrix** (Song tab): sequences × tracks; click a row to play it, a cell to edit that clip; copy, paste and clear single clips.
- **Mixer** (Mixer tab): per track a filter, 3-band EQ, drive and compressor, pan, level, mute/solo, and sends to a shared reverb (A) and tempo-synced delay (B). The Launchkey has a **Track FX** encoder page (selected track) and a **Mix** page (encoders 1–8 = track levels). Bounces include the FX.
- **Song mode**: chain patterns into a song, then bounce the song or one pattern to WAV.
- **Browse**: browse imported sample folders from the hardware, with auto-preview.
- **Sampling**: record the audio input onto a pad (Shift + Record), or resample the master out.
- **Tab capture**: pick source *Browser tab* and click *Share tab…* once (tick "Share tab audio" in Chrome's picker). The share stays open, so Shift + Record on the Launchkey arms a take, recording starts when the tab plays, and Shift + Record stops it. Takes (up to 2 minutes) go to the selected pad or into the Chop editor.
- **Keys presets**: 16 factory synth sounds (Sub Bass, Acid Bass, Reese, Pluck, Leads, Brass, Pads, Strings, Organ, Bell, …) plus your own (*Save as preset* on the Keys tab). On the Launchkey, the **Keys** encoder page scrolls presets with encoder 1 (the screen lists them) and edits waves, detune, cutoff, resonance, env, attack and release with encoders 2–8. A * marks an edited preset.
- **Pattern copy**: *Copy to…* on the Sequencer tab, or in Pattern mode hold a pattern pad and tap another. *Copy clip to…* (or holding Scene as well) copies only the selected track's clip.
- **Sidechain ducker** (like the MPC's Mother Ducker): every hit of an input pad dips a target (one pad, a whole track, or all others) by Depth, holds it down for Hold and lets it recover over Release. Set it in the Sidechain panel on the Pads page or on the Launchkey's **Duck** encoder page (enc 1 on/off, 2 input, 3 target, 4 depth, 5 attack, 6 hold, 7 release); on that page the screen shows the envelope and live gain reduction, and hitting a pad makes it the input. Sequenced hits duck sample-accurately and the duck is included in exports.
- **Start-up animation**: a blob eats a waveform on the Launchkey screen, burps, and the logo bounces in (any input skips it).
- **Light / dark theme**: the ☀ / ☾ button next to Guide switches the on-screen UI (remembered in this browser; the Launchkey screen preview stays dark). The layout tightens on short screens such as 13" and 14" laptops.
- **Deleting samples**: *Delete sample* on the Pads page or *Delete* in the Chop tab removes a sample from the library and clears every pad (and Keys zone) using it.
- **Chop editor** (Chop tab): zoomable waveform of a whole sample. Click to add slice markers, drag to move, double-click to remove; auto-place by transients or equal parts; Space plays the region and **M** drops a marker at the playhead (tap-chop); 1–9 audition slices. Markers snap to zero crossings. Send the slices to consecutive pads, or crop the region into a new sample. While the Chop tab is open the Launchkey works the chop too: pads play slices 1–16 (and select that slice's marker), encoder 1 scrolls, 2 zooms, 3 picks a marker, 4 moves it (Shift = fine, single samples), and the screen shows the zoomed waveform with markers.
- **Screen**: the Launchkey screen shows waveforms, the step grid, the browser and encoder popups, rendered as a bitmap.
- **Persistence**: everything autosaves in the browser's IndexedDB. Projects and kits export as single JSON files with the samples embedded.

The **Help** tab in the app has the full hardware map, mode overview, encoder pages and shortcuts. Press `?` anywhere to open it.

## Requirements

- A **Chromium-based browser** (Chrome, Edge, Arc, Brave). Web MIDI with SysEx is required, and Safari doesn't support it.
- A Launchkey Mini MK4 25, connected over USB.
- **Close Ableton Live** (or any other DAW using the Launchkey's DAW port) before connecting.

## Getting started

```sh
cd app
npm install
npm run dev
```

Open the URL Vite prints and allow MIDI (with SysEx) access when the browser asks. The dot next to the LaunchKit logo turns green once the Launchkey is found.

Load samples by dropping audio files onto an on-screen pad, or use **Import folder** to add a whole folder to the browser.

## Scripts

Run these inside `app/`:

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Type-check and production build to `app/dist` |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | Lint (Oxlint) |
| `npm run boot-gif` | Re-render `docs/boot-animation.gif` from the start-up animation code (needs ffmpeg) |

## Project layout

```
app/src/
  midi/      Launchkey connection, DAW-mode protocol, SysEx
  modes/     Hardware modes (play/step/track/mixer/pattern/browse) and controller logic
  seq/       Sequencer clock, timing/quantize, offline render + WAV export
  audio/     Audio engine, voices, DSP, sampling, sample chopping, kits
  display/   Screen bitmap: frame buffer, fonts, widgets, screens
  state/     Zustand store, types, IndexedDB persistence, project/kit files
  browse/    Sample browser tree
  ui/        React panels (Pads, Sequencer, Keys, Mixer, Song/Matrix, Help, Lab)
  params.ts  Encoder pages and parameters
kits/        Saved kit files (*.launchkit-kit.json, git-ignored: they embed samples)
protocol_notes.md  DAW-mode protocol details measured on the hardware
```

## Hardware notes

The Launchkey's DAW-mode protocol differs from Novation's programmer's guide in several places. For example, the bitmap ack, the button channels and the LED channels are different. `protocol_notes.md` lists what was measured on the device and what is still unverified. Use the **Lab** tab to test raw MIDI and screen bitmaps against the hardware.

## File formats

- **Project** (`*.launchkit.json`): `{ format: "launchkit", version: 2, project, samples }`. Version 1 projects (one drum rack and one Keys instrument) load as a Drums and a Keys track.
- **Kit** (`*.launchkit-kit.json`): `{ format: "launchkit-kit", version: 1, name, pads, samples }`.

In both formats, the samples are stored as 16-bit PCM, base64-encoded per channel.
