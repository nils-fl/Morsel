# LaunchKit

A browser-based groovebox for the **Novation Launchkey Mini MK4 25**. LaunchKit puts the Launchkey in DAW mode over Web MIDI and takes over its pads, encoders, buttons and screen, turning it into a standalone sampler, step sequencer and song arranger. You don't need a DAW.

## Features

- **16-pad sampler**: velocity-sensitive pads with start/end, pitch, attack/decay, HP/LP filters with resonance, pan and volume. Pad pressure opens the filters.
- **Pad modes** (cycle with Func):
  - **Play**: play the pads.
  - **Step**: 16-step grid for the selected track.
  - **Mixer**: tap a pad to mute it, double-tap to solo.
  - **Pattern**: switch patterns; while playing, the switch waits until the loop ends.
- **Sequencer**: 16 patterns of 1–4 bars, with live recording (count-in, overdub), quantize, swing, note repeat, metronome and undo.
- **Keys**: a synth/sample instrument on the keybed, recorded into its own track. The Launchkey's Arp and Scale still work.
- **Song mode**: chain patterns into a song, then bounce the song or one pattern to WAV.
- **Browse**: browse imported sample folders from the hardware, with auto-preview.
- **Sampling**: record the audio input onto a pad (Shift + Record), or resample the master out.
- **Tab capture**: pick source *Browser tab* and click *Share tab…* once (tick "Share tab audio" in Chrome's picker). The share stays open, so Shift + Record on the Launchkey arms a take, recording starts when the tab plays, and Shift + Record stops it. Takes (up to 2 minutes) go to the selected pad or into the Chop editor.
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

## Project layout

```
app/src/
  midi/      Launchkey connection, DAW-mode protocol, SysEx
  modes/     Hardware modes (play/step/mixer/pattern/browse) and controller logic
  seq/       Sequencer clock, timing/quantize, offline render + WAV export
  audio/     Audio engine, voices, DSP, sampling, sample chopping, kits
  display/   Screen bitmap: frame buffer, fonts, widgets, screens
  state/     Zustand store, types, IndexedDB persistence, project/kit files
  browse/    Sample browser tree
  ui/        React panels (Pads, Sequencer, Keys, Song, Help, Lab)
  params.ts  Encoder pages and parameters
kits/        Saved kit files (*.launchkit-kit.json, git-ignored: they embed samples)
protocol_notes.md  DAW-mode protocol details measured on the hardware
```

## Hardware notes

The Launchkey's DAW-mode protocol differs from Novation's programmer's guide in several places. For example, the bitmap ack, the button channels and the LED channels are different. `protocol_notes.md` lists what was measured on the device and what is still unverified. Use the **Lab** tab to test raw MIDI and screen bitmaps against the hardware.

## File formats

- **Project** (`*.launchkit.json`): `{ format: "launchkit", version: 1, project, samples }`.
- **Kit** (`*.launchkit-kit.json`): `{ format: "launchkit-kit", version: 1, name, pads, samples }`.

In both formats, the samples are stored as 16-bit PCM, base64-encoded per channel.
