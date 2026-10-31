# Akai MPC Sample: how its performance effects work (firmware 1.3.0, read 2026-10-31)

Morsel's **Perform** section (Pad FX, Flex Beat, Knob FX) is modelled on the MPC Sample's effect engines. These
notes describe what the MPC Sample's firmware does, in our own words, so that Morsel's effects behave alike. Morsel's
DSP is its own code; no Akai code, data tables or presets are in this repo, and the firmware, the unpacked filesystem
and the disassembly stay out of it too.

Marks: **code** = read in the firmware at the address given. **inferred** = an interpretation that fits the code but
isn't proven. **manual** = Akai's MPC Sample User Guide v1.3.0 (pp. 46–55). Nothing here was measured on a device.
Addresses are virtual addresses in the 1.3.0 `MPC Sample` binary (image base 0) and move in other builds.

## Getting at it

- Akai's downloads page for the MPC Sample has *MPC SAMPLE – Firmware Update v1.3 (MAC)*:
  `MPC Sample 1.3.0 Updater.app.zip` (172 MB, 2026-04-08). The app holds `Contents/Resources/Update.img`.
- `Update.img` is inMusic's own container (magic `AZ0x`, build tag `SNAPSHOT-20260402131256`, product `AC50`). After a
  header come sections tagged `BOOT` (a U-Boot FIT with idbloader and u-boot: a Rockchip SoC) and `PARR`/`PART`
  entries, each an xz stream. The last `PART` (offset 0x19967d8 in the file) decompresses to the rootfs, an ext4 image
  of ~430 MB; the one before it is the boot partition (ext2). `debugfs -R "rdump / out"` (e2fsprogs) extracts it.
- The partition table string names `spl`, `env`, `uboot`, `factory`, `boot`, `recovery`, `rootfs` (1 GB), `content`
  (4 GB) and `data`.
- Everything audio is one stripped aarch64 ELF, `/usr/bin/MPC Sample` (119 MB, JUCE). It is the same engine as the
  MPC desktop and standalone software, with the MPC Sample's screens (class names `AC50…`).
- The binary is stripped, but its C++ RTTI names survive, and the `.eh_frame_hdr` table gives every function's
  bounds (193,907 of them). Vtables are found from the RTTI names through `R_AARCH64_RELATIVE` relocations. Ghidra
  (headless, `-loader-imagebase 0`, no auto-analysis, disassembling only the wanted functions) decompiles them.

## Architecture

- The four engines of the manual are plugin-like classes inside the app:
  - **Pad FX**: 16 classes `PadControlledHalfSpeed`, `…Chorus`, `…Flanger`, `…Phaser`, `…CombFilter`,
    `…LfoFilter` (LP, HP and BP pads), `…RingModulator`, `…LoFi`, `…Flavor` (the Color pad), `…Granulator`,
    `…BeatRepeat`, `…RevStepper`, `…Delay`, `…Reverb`, on a base `PadControlledEffect`. **code**
  - **Flex Beat**: a Gross Beat engine (Image-Line): namespace `flexbeat`, presets as XML `grossBeatPreset` with
    `GBDECK`/`GBSLOT`, wrapped by `FlexBeatPlayer`. **code**
  - **Knob FX**: AIR effect classes (`FX_TapeDel`, `FX_Pumper`, `FX_Degrade`, …) plus `TapeEmulatorFX`,
    `VinylEmulatorFX` and `VintageEmulationInsert`. **code**
- Chorus, Flanger, Reverb, Half Speed and Color wrap AIR DSP modules (VintageChorus, VintageFlanger,
  DattorroReverbSimplified, H3M HalfSpeed, FlavourMKII); the others are written directly in the pad classes. **code**

## Pad FX: the shared behaviour

- **Pressure** becomes each effect's amount, 0..1, linearly (no curve). The amount follows the pad with a linear ramp
  of **25 ms**. **code** (setter at 0x2526e50 / 0x2526e90, ramp default 0x251e0f0)
- **On and off** is a separate crossfade with the dry signal over **10 ms** (`dry + gate·(wet − dry)`). **code**
  Some effects (Beat Repeat, Rev Stepper, Granulator) ignore it and cut hard. **code**
- **Four at once**: active pads are kept in press order. A fifth press takes the oldest one's place: that one fades out
  (10 ms) but isn't stopped. When an active pad is let go and three or fewer remain, the one taken over last comes back
  where it was (last in, first out), without restarting. **code** (0x2525870, 0x2526800)
- **Chain order**: the active effects run in **pad order** (1 to 16), not press order. **code**
- **Latch**: while latched, pressure is stored but not applied; the effect keeps its state. **code** (0x2527600)
- **LFO** (filters, phaser, comb): one shape for all, a unipolar parabolic sine `0.5 + 2φ(1 − |φ|)` over φ in −1..1.
  The code has more shapes (ramps, triangle, square, S&H) but no setting picks them. **code** (0x252ae90)
- **Note values**: speeds and divisions are in beats. The entries labelled "t" (1/4t, 1/8t, …) are **4/3 or 3/4 of the
  straight value** (dotted-like), not triplets. **code** Morsel's "t" values are real triplets.

## Pad FX, one by one

- **Half Speed** (pad 1): a playback tap whose delay grows as it plays (rate 0.75 / 0.5 / 0.25 for the Speed settings
  x1.5 / x2 / x4). On every bar line a new tap starts from the live input and crossfades in (~60 ms; at most half a
  loop; the first segment at least a quarter loop). Mix is `wet = 2m − m², dry = 1 − m²`. **Pressure isn't used.**
  **code** (wrapper 0x2524700, DSP 0x3c04700)
- **LP / HP / BP Filter** (pads 6–8): pressure `p` and the LFO make `x = (1 + (lfo − 1)·depth)·p`, then `t = x²`
  (clamped) and the cutoff runs linearly from one end to the other: **LP 8 kHz → 40 Hz, HP 0 → 8 kHz,
  BP 40 Hz → 10 kHz**. Range is the LFO depth, at most half (`Range/200`). Resonance sets the damping
  `0.7071·(1 − 0.75·r²)`: Q from about 1.4 to 5.7 (default 50 %). The filter is a Chamberlin state-variable filter run
  twice per sample (2× oversampled), its coefficient and damping smoothed at about 10 Hz. **code** (0x252ae90)
- **Phaser** (pad 4): six first-order all-passes a side; pressure sweeps them from 40 Hz to 8 kHz (`40 + 7960·x²`,
  same `x` as the filters); feedback `F·0.98`; output `(x + y)·0.5·(1 − 0.75F)`. **code** (0x252d730)
- **Comb Filter** (pad 5): the LFO sweeps a delay between 2.5 and 10 ms (100–400 Hz); pressure sets **inverted
  feedback** up to 0.95; the output is the delayed signal, softly clipped (`4(u − 4u³/27)`, `u = out/4`). **code**
  (0x251f100)
- **Ring Mod** (pad 9): really a unipolar amplitude modulation (the level swings 0..1). Its rate is
  `10 + (0.7p)²·(Max − 10)` Hz, so pressed hard it gets about half way to Max Freq (40–400 Hz, default 40). **code**
  (0x25304a0)
- **LoFi** (pad 10): amount `a = 1 − (1 − p)³`. Bits go from 24 towards the Bitcrush setting by `a` (truncation);
  the sample rate is held 1 to 32 times by the Decimator, also by `a`, with a fractional hold. **code** (0x252c700)
- **Color** (pad 11): AIR's FlavourMKII with a 64-value preset per mode (wobble, tape or tube drive, an EQ "timbre"
  profile, noise, crackle, dropouts). Pressure is the dry/wet. **code**; what each mode sounds like is **inferred** from
  the preset values (Cassette: wow, drive, hiss; Tube Amp: slow wobble, tube drive, old-studio EQ; Vinyl: surface noise
  and dropouts; Saturation: drive; Radio: low-pass and a transistor-radio EQ).
- **Granulator** (pad 12): grains on a steady clock (Density, no randomness on the pad), each ending just behind the
  write position, scattered over the last ~20 ms; window `(4x(1 − x))²`; grains summed without normalising. Feedback
  writes the grains back into a ~2 s grain buffer **inverted**, through a 10 Hz DC blocker, clamped and soft-clipped.
  Pressure is the dry/wet. **code** (0x2522680, engine 0x18b0da0)
- **Beat Repeat** (pad 13): the slice is the division **just before the press** (a look-back; no quantize), looped
  hard (no crossfade), forwards or reversed, its length following the tempo. **Pressure isn't the wet**: it closes a
  low-pass over the repeats, `10000 − 9960·p²` Hz, with the same 2× Chamberlin filter and Resonance as the LFO filters.
  **code** (0x251d360, engine 0x18af0e0)
- **Rev Stepper** (pad 14): records one slice of the Delay Time (the dry mix passes meanwhile), plays it **reversed,
  forwards, reversed…** Repeats times in all while ignoring the input, then records the next slice. Hard cuts.
  Pressure isn't used. **code** (0x252ff20)
- **Delay** (pad 15): 17 note lengths, feedback −1..1 (×0.99, negative inverts), no filter in the loop. Normal,
  X-Feedback (the channels swap in the feedback) and Ping-Pong (left takes `(L+R)/2` plus the right's echo, right takes
  the left's). The line keeps recording while idle; pressure crossfades dry to wet, so letting go ends the echoes.
  **code** (0x251fef0)
- **Reverb** (pad 16): a Dattorro plate, used as a send: `dry + gate·p·wet`. **code**

## Flex Beat

- **A preset** is two envelopes over **one bar**: time and volume. Each point has a length in beats, a value 0..1, a
  tension and a segment shape (hold, linear, exponential, S-curve, stairs, pulse, wave; also power and spline curves).
  The shape belongs to the segment ending at the point. **code** (0xd45350, 0xd46370)
- **Time** value `v` means a delay of `8·(1 − v)` beats: the playback reads the dry input that far back. Flat = live
  at a fixed delay; falling 1/8 per beat = frozen; 1/4 per beat = reversed. **Volume** is a gain 0..1 on the wet signal.
  **code** (0xd49390)
- **The position in the envelopes is the position in the current bar** (0–4 beats), not the time since the press.
  **code**
- **Buffer**: two bars of dry input, the write index locked to the song position (resynced on start, tempo change or
  drift over a tenth of a beat). Reads use 6-point Lagrange interpolation. **code** (0xd41570)
- **De-click**: a jump in the read position over 2 ms crossfades from the last output over ~25 ms; the volume goes
  through two one-pole smoothers (2 ms up, 3.7 ms down); mix and on/off ramp linearly over 10 ms. **code**
- **Triggering**: a pad selects its slot. Quantize queues the change to the next grid line, and the MPC Sample's
  switch only uses **1 bar**. Loop (default) keeps the effect; One Shot returns to Empty at the next bar line; Hold
  returns to the previous pad on release. **code** (0x2506e50, 0xd49980)
- **The 16 pads** are bank "Default" of the engine's factory presets (pad 1 Empty, then repeats, scratches, a
  backspin, a reverse, gates and a trance gate). 349 factory presets exist, all one bar long. **code**
- **Morsel's Flex Beat** uses the same model (time and volume curves read at the bar position, two-bar-plus history,
  queued to the bar line, de-clicked jumps), with its own 15 curves (`app/src/audio/perform/flexBeat.ts`).

## Knob FX

- **Tape and Vinyl** run the same AIR FlavourMKII engine as the Color pad, each with its own 64-value preset; a knob
  sets one engine parameter linearly. The chain: pitch wobble (a delay line of up to 20 ms) → distortion → noise →
  level wobble and dropouts → a "timbre" EQ profile → gain → 12 dB high- and low-pass → stereo width. **code**
  (engine 0x3c03370)
- **Tape Emulator**: the knob names don't say what they do. *Wow* sets the **level** wobble (a fast ~5.9 Hz and a slow
  ~1.7 Hz dip), *Noise* the hiss (ducked by up to half under a loud signal), and *Pitch* the **pitch** wow and flutter
  (a fast ~3.6 Hz and a slow ~1.4 Hz LFO). Depths go in cubed and wander with a random walk that re-aims every
  0.4–1.2 s, so it never sounds like a plain LFO; flat out it is about ±20 % speed, at half about ±2.5 %. Always on:
  light tape saturation, an old-studio EQ, a low-pass near 19 kHz. **code**
- **Vinyl Emulator**: *Tone* is a low-pass below noon (20 kHz down to a few hundred Hz) and a high-pass above it
  (20 Hz up to 1.2 kHz), flat at noon. *Crackle* is a noise generator added to the signal, at depth²: dust (a random
  tick per sample with a small probability, the right side 90 ms later), clicks (a 1–2 sample pulse rung through a
  resonant band at 500–3500 Hz, small ones often, big ones rarely: the next gap is `exp(1.69 − 4.69·rate)·u⁴` s), pops,
  rumble (noise low-passed at 70 Hz), hiss and a little hum. *Pitch* is a slow ~0.5 Hz wow (a disc turning at 33⅓)
  with heavy drift. **code**
- **Vintage Emulator** **code**:
  - MPC3000: 16-bit truncation and a steep low-pass near 20 kHz.
  - MPC60: 12 bits that lose more low bits as the level rises (2, 3 or 4 below/above 0.25 and 0.5), a +3 dB bump at
    98 Hz, a resonant low-pass at 17 kHz.
  - SP1200: a cut around 85 Hz, an asymmetric soft clip (linear from −0.65 to 0.75, flat at ±0.95), 12 bits, then
    held at 26 kHz between 16 kHz low-passes (run 4× oversampled).
  - SP1200 Ring: a crusher on top: dry/wet 92 %, 8 bits, held at about 36 kHz.
- **Pumper** **code**: triggers on the tempo (Bar … 1/32T). Each trigger the gain falls exponentially to its floor
  `(1 − depth)²` over the attack (1–101 ms), holds, then comes back as `0.01^((1 − p)^c)` with `c = 100^Shape`, so Shape
  keeps it down longer before a late snap back. Attack, hold, release and a ±100 ms shift are the Shift settings.
- **Morsel's Knob FX** follow these: Tape (*Wobble*, *Noise*, *Wow*: named for what they do), Vinyl (*Tone*,
  *Crackle*, *Wow*), Vintage (the four types), Pumper (Speed, Shape, Depth; a 10 ms attack and the release over the
  rest of the period). DJ Filter, Auto-Pan, Tape Delay and Soft Clip are Morsel's own takes.

## What Morsel does differently

- Morsel's Pad FX always crossfade in and out over 10 ms, also where the MPC cuts hard (Beat Repeat, Rev Stepper,
  Granulator), and Beat Repeat and Rev Stepper fade 2 ms at their seams.
- Morsel's Delay and Reverb pads ring on after the pad is let go (a throw); the MPC's stop with the pad.
- Morsel's "t" note values are triplets.
- Pad pressure starts from the hit's velocity until the Launchkey's aftertouch takes over.
