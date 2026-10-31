# Launchkey Mini MK4 firmware: what the code says (v1.3, build 1563, read 2026-10-31)

The firmware is read here so that Morsel doesn't have to guess the protocol. These notes describe what the firmware
does, in our own words. The firmware itself, the decoded image and the disassembly are not in this repo.

Marks: **code** = read in the firmware at the address given. **inferred** = an interpretation that fits the code but
isn't proven. Nothing here was **measured** on the device unless it says so; the measured facts are in
[`protocol_notes.md`](protocol_notes.md). Addresses are flash addresses in build 1563 and shift in other builds.

## Getting at it

- Novation Components keeps every build as SysEx in
  `~/Library/Application Support/Components/products/launchkey-mini-mk4/launchkey-mini-mk4-firmware-<build>.syx`
  (1157, 1244, 1414, 1490, 1563). `firmwares.json` in the folder above has the release notes.
- The update messages are `F0 00 20 29 00 <type> … F7`:

| Type | Content |
|---|---|
| `71` | Start: `02 13` (Launchkey Mini MK4), `01 <major> <minor>`, the build as two 7-bit bytes (`0C 1B` = 12 × 128 + 27 = 1563), two extra bytes (1244 has `00 0F`, its ".15"). |
| `7C` | Info: the same version bytes, then the size and a CRC as 8 nibbles each. The CRC is CRC-32/MPEG-2 (poly 04C11DB7, init FFFFFFFF, no final XOR) over flash 0x08008000 + size. Checked: 1563 → A1817A85, 1157 → 8E589C77. |
| `72` | 37 septets, read as one MSB-first 7-bit bit stream, give 32 bytes. These are the app from 0x08008020 upwards, in order; the last one is padded with FF. |
| `73` | The app's first 32 bytes (stack pointer, reset and fault vectors), sent last, so a half-written app has no reset vector (inferred). |

- Image = the `73` chunk, then the `72` chunks, loaded at 0x08008000. The code isn't encrypted.
- Xcode's `llvm-objdump -d --triple=thumbv7em-none-eabi --mcpu=cortex-m4` disassembles it once the image is wrapped
  in a minimal ELF. Its printed `adr` targets are wrong: the target is Align(PC + 4, 4) + imm.
- Initialised RAM data (0x15D0 bytes at 0x20000000) is stored LZ-compressed at 0x080370F3, so some templates (the
  identity reply, the USB device descriptor) only show up after decompressing it.

## Hardware and architecture

- **Chip:** an STM32F4, from the peripheral addresses (code). Very likely an STM32F401xC (256 KB flash, 64 KB RAM)
  running at 84 MHz from an 8 MHz crystal (inferred from the RAM top, the clock setup and the flash end).
- **Flash:** a 32 KB bootloader at 0x08000000 (not in the file), then the app at 0x08008000–0x0803FFFF.
- **Software:** built with IAR. A bare-metal main loop with no RTOS; the interrupts in use are SysTick, USB OTG FS and
  TIM10 (code).
- **Faults:** any fault writes a magic value at the top of RAM and resets into the bootloader. The upgrade path does
  the same (code).
- **External flash:** an SPI NOR chip (`serstor_hw.c`). An update is received into it and checked with the same CRC,
  and the bootloader installs it after the magic reset (inferred).
- **Source file names** left in the image include `feature_arp.cpp`, `feature_chord.cpp`, `feature_scale.cpp`,
  `displayproto.cpp`, `layout_channel.cpp`, `inputrelative.cpp`, `midiobj_feature.cpp` and `hui_state.cpp`.
- **UI text:** one table of 226 strings at 0x0802E994, looked up by index.

## USB

- VID 1235. **One image serves both sizes:** two hardware strap pins pick PID 0141 (25 keys) or 0142 (37 keys), and
  identity family `41 01` or `42 01`. The port names are `Launchkey Mini MK4 @@ …`, with `@@` replaced by the key
  count (code).
- MIDI streaming has two cables each way: cable 0 is the MIDI port and cable 1 the DAW port. A HID boot keyboard
  serves the keystroke controls of custom modes (code).
- A second USB configuration adds the "Easy Start Drive" mass-storage device, and a WebUSB landing page points to
  Novation's registration URL with the unit's serial (code).

## Input dispatch

- Each port has its own parser. Both feed the same SysEx dispatcher (0x08030342): a chain of handlers, and the first
  that accepts a message consumes it (code).
- **DAW port, short messages** (0x080302F6), in order:
  1. feature CCs on ch7 (set) and ch8 (query)
  2. CC on ch15 = display config
  3. DAW notes and CCs: LEDs, notes 11 and 12 on ch16, CCs on ch16
  4. HUI, only while DAW mode is off
  5. realtime messages (clock, start, stop, song position)
- **MIDI port, short messages:** notes, CCs and program changes go to the custom modes' "External Feedback"
  (inferred).
- **Everything in item 3 is ignored while DAW mode is off**, except notes 11 and 12 on ch16 (code, 0x0803072E).

## DAW mode and the DAW states

- The firmware has three states (0x08026858): 0 = off, 1 = DAW mode, 2 = HUI.
- **Note 12 on ch16** (`9F 0C 7F` / `00`) switches DAW mode and is echoed back (code).
- **SysEx `02 <v>`** does exactly the same: it is passed on as `9F 0C <7F if v ≠ 0 else 00>`, and the reply
  `F0 00 20 29 02 13 02 <7F or 00> F7` gives the state now in force (code, 0x08030AE4). So Live's "hello" is a DAW-mode
  switch.
- **When DAW mode turns on** (code):
  - every feature CC is accepted
  - CC 29, 30, 31, 61, 62 and 63 are also reported (see Feature CCs)
  - CC 84 (drum pads to the DAW port) is set to 127
  - touch output and CC 70 are switched off
  - the DAW-layout pad and button LEDs are cleared, and the drum-layout LEDs are set to palette 42
- **On any change of state** (code): CC 76 (keybed to the DAW port) goes back to 0, CC 83 to 21, and CC 84 to 0
  unless the new state is DAW mode. Then that state's default layouts are applied (pad layout 2 for DAW mode).
- **HUI:** while DAW mode is off, the HUI ping `90 00 00` is answered with `90 00 7F` and enters state 2 for 5 s,
  renewed by each ping. In state 2 the HUI fader, switch and V-pot CCs are parsed (code).
- **Mackie:** a Mackie-ID SysEx `F0 00 00 66 05 00 10 …`, in 5-byte groups, is parsed too. Its purpose is
  presumably HUI/MCU support (inferred).

## Feature CCs (ch7, and ch8 to query)

- **Access mode:** every one of the 128 CCs has one: ignored, accepted, or accepted and reported (code, 0x08026D14…).
  - Standalone, all are ignored.
  - DAW mode on: all are accepted, and **29, 30, 31, 61, 62, 63 are reported**. "Reported" means the device sends the
    resulting value back right after a host write, and sends it when it changes on the device. That is the echo of
    CC 29 in `protocol_notes.md`.
- **`9F 0B 7F`** (note 11 on ch16) makes every feature CC report; `9F 0B 00` restores the defaults. The note is echoed
  (code).
- **`B7 <cc> xx`** (a CC on ch8) asks for the current value of feature `cc` (code).
- Some CCs below 32 are 14-bit, with the LSB on cc + 32 (code). CC 3 is one of them.

| CC | What it does | |
|---|---|---|
| 3 (+35) | Host tempo, 14-bit, BPM × 64 (default 120 BPM); drives the internal clock / arp | code; use inferred |
| 27, 28 | 0–2, not traced | code |
| 29 / 30 / 31 | Pad / encoder / fader layout. **127 = back to the previous layout** of that kind | code |
| 61 / 62 | Root / scale (reported). Chord Map reads them. 81 / 80 per `protocol_notes.md` | code / measured |
| 63 | Shift. A host write sets the same Shift state the encoders read (see Shift) | code |
| 68, 70, 75 | On/off flags, not traced | code |
| 69 | Relative encoders. The device sends CC 69 itself after an encoder-layout change: 127 for encoder layout 5, else 0 | code |
| 71 | Encoder touch output | code |
| 76 | Keybed to the DAW port. Back to 0 on every state change | code |
| 77, 78 | 0–3 / a value (default 60), not traced | code |
| 83 | Used when the pad LEDs are drawn; set to 21 on every state change. Meaning unknown | code |
| 84 | **Drum-layout pads to the DAW port.** 127 when DAW mode turns on; decides layout 1 vs 15 | code |
| 79, 100–121 | Settings menu values (channels, velocity, brightness, display timeout, power-on modes …). 103 = Drums channel (default 9 = ch10), 116–118 = power-on pad / encoder / fader layout | values code; names inferred |

## Layouts (CC 29 / 30 / 31)

- **Accepted values** (code, 0x0801523C); anything else falls back:
  - pad (29): 1, 2, 4–19, else 1
  - encoder (30): 1–10, 12–17, 30, 32, 33, else 2
  - fader (31): 0–2, else 0
- **Pad layout 15 is the drum layout on the DAW port** (code, 0x080264C8 / 0x0802650C).
  - In DAW mode a request for 1, 12 or 13 becomes 15, and then CC 84 decides: on → 15, off → 1. Outside DAW mode, 15
    becomes 1.
  - DAW mode on sets CC 84 = 127, so asking for drum (1) always gives 15, with the drum notes (36–51, ch10) on the DAW
    port.
  - `B6 54 00` before `B6 1D 01` should keep them on the MIDI port as layout 1 (not measured).
- **Pad layout names** (from the label table, code):

| Value | Name |
|---|---|
| 1 | Drum |
| 2, 9 | DAW (renamable, target 0x22) |
| 4 | User Chord |
| 11 | Sequencer |
| 12 | Patterns |
| 13 | Arp Pattern |
| 14 | Chord Map |
| 15 | Drum (renamable, target 0x23) |
| 18 | Channel Rack |

  Sequencer, Patterns and Channel Rack are FL Studio pages.
- **Encoder layout names:** 1 Mixer (0x24), 2 Plugin (0x25), 3 / 13 Pan, 4 / 14 Sends (0x26), 5 / 15 Transport
  (0x27), 16 Play. **Fader layout:** 1 Volume (0x28), on the full-size MK4.
- **In the DAW pad layout** Scene, Func, Pad up and Pad down are CC 104, 105, 106 and 107, momentary 127 / 0 (code).
- Not traced: the `2` that comes before the `15`, why Shift down reports 2, and whether Shift + Pad down is CC 103.

## LEDs

- **The LED store** is 4 tables × 128 entries (code, 0x0801E7F6…). An entry is either a palette colour (colour A, a
  flash partner B and a mode) or a raw RGB value. Palette and RGB overwrite each other in the same entry.

| Message (DAW mode only) | Table | Mode |
|---|---|---|
| Note ch1 / ch2 / ch3 | 0: DAW-layout pads (notes 96–119) | static / flash / pulse |
| CC ch1 / ch2 / ch3 | 1: buttons by CC number | static / flash / pulse |
| CC ch4 | 1, static | the value is cut into 8 steps (v >> 4) and mapped to palette greys `0 0 112 1 118 2 119 3` |
| Note ch10 / ch11 / ch12 | 2: drum-layout pads (notes 36–51) | static / flash / pulse |

- A static write resets the mode, so a static colour ends a pulse or flash. A flash write sets only colour B, so the
  pad flashes between its last static colour and the new one (code).
- **SysEx `01`** carries any number of entries (code, 0x08030BBC).
  - Each entry starts with a spec byte. The high nibble picks the table: `4x` = 0, `5x` = 1, `6x` = 2, `7x` = 3.
    The low nibble picks the kind:

| Kind | Entry |
|---|---|
| 0 static | `spec idx colour` |
| 1 flash | `spec idx A B` |
| 2 pulse | `spec idx colour` |
| 3 RGB | `spec idx r g b` (7 bits each) |

  - **`01 43 <note> r g b` writes table 0**, the DAW-layout pads. That is why it lights nothing on the drum layout.
    **The drum-layout pads need `01 63 <note> r g b`** (not measured).
  - Buttons are `01 53 <cc> r g b`. Table 3 can only be reached by SysEx; what it drives is unknown.

## SysEx commands

All on `F0 00 20 29 02 13` unless noted (code, handler chain at 0x08030342):

| Cmd | Arguments | What it does | Reply |
|---|---|---|---|
| `01` | entries, see LEDs | LED colours, palette or RGB | – |
| `02` | `v` | DAW mode on (v ≠ 0) / off, same as `9F 0C` | `02 7F/00`: the state now in force |
| `04` | `tgt cfg` | Display config (also `BE tgt cfg`, a CC on ch15) | – |
| `05 00` | … | Custom-mode transfer (Components) (inferred) | yes |
| `06` | `tgt fld text` | Display text | – |
| `09` | `tgt` + 1216 bytes | Bitmap, targets 0x20 / 0x21 | `F0 00 20 29 02 13 09 F7` once drawn |
| `0A` | `hi lo` | Internal tempo, 14-bit BPM, 20–600 | – |
| `6F` | 1216 bytes | Bitmap to 0x20 without a target byte | the same ack |
| `70 …` | | Factory and test commands, locked until `70 60 01` | |
| `78` | `n` (r g b) × up to 56 | Fills a 56-colour table (packed 5:5:5) (inferred) | – |

Other headers:
- Universal identity request `F0 7E 7F 06 01 F7`: the reply carries family `41 01` (25 keys) / `42 01` (37 keys),
  then the version `01 03` and the build `0C 1B` (code).
- `00 20 29 00 …`: the update stream (`70`–`7C`) and Components queries (`42`, `43`, `7E`, `70`).
- Mackie `00 00 66 05 00 10 …`: see DAW states.

The bitmap ack in the firmware is exactly `F0 00 20 29 02 13 09 F7`. The programmer's guide's `09 7F F7` is wrong.
The ack goes out on the port the bitmap came in on, after the frame is drawn (code).

## Display

- **Screen:** 128 × 64, kept as a page-format framebuffer (a byte = 8 vertical pixels) in the style of SSD1306 /
  SH1106 chips (code). Which controller chip it is, and on which bus, is not identified.
- **Display targets** (code, table at 0x080318C4):

| Target | Size | Kind |
|---|---|---|
| 0x05–0x0D | 60 B | temporary; faders of the full-size MK4 (inferred) |
| 0x15–0x1C | 60 B | temporary; encoders 1–8 |
| 0x20 | 100 B | stationary |
| 0x21 | 100 B | global temporary |
| 0x22–0x28 | 20 B | DAW mode labels (see Shift overlay) |

- **Arrangements**, field lengths in characters:

| # | Fields |
|---|---|
| 0 and 4 | 60 |
| 1 | 20 + 40 |
| 2 | 20 + 20 + 20 |
| 3 | 20 + 8 × 10 (only 0x20 / 0x21) |

- **`04 <tgt> <cfg>`** (code, 0x080305BC → 0x0802A864…):
  - `cfg & 1F` = 0 hides or cancels what is shown and changes nothing else; `1F` shows the target now; 1–30 sets the
    arrangement (and clears the text if it changed).
  - Only when an arrangement is set, bits 5 and 6 are stored as two auto-show flags. Bit 6 shows the target when its
    control is moved on the device; bit 5 shows it when the DAW sends a value (a CC on ch16). The default is that
    both auto-show.
  - This is why config `01` (arrangement 1, both bits clear) stops the encoder popups and `00` only hides one, as
    measured.
- **`06 <tgt> <fld> <text>`** (code, 0x0802A902):
  - Bits 0–5 of `fld` are the field; **bit 6 shows the text at once** (no separate `04 tgt 1F` needed).
  - Text is copied up to the field's full length (20 / 40 / 10 / 60 characters, more than the 16 Morsel sends) and
    stops at 00 or any byte ≥ 80.
  - Writing to 0x22–0x28 runs callbacks; one redraws the Shift overlay while Shift is held.
- **`09 <tgt> <1216 bytes>`** (code, 0x08018CAC):
  - 64 rows, top row first, 19 bytes each. **Bit 6 of a byte is the leftmost of its 7 pixels.**
  - Only x < 128 is drawn, so the last 5 of the 133 packed pixels in a row are dropped.
  - A temporary (0x21) bitmap presumably times out like temporary text (inferred).
- **Mode-change popup** ("Pad Mode / …", "Encoder Mode / …"): it is suppressed when the matching label target
  (0x22–0x28) has both auto-show bits clear, e.g. `04 23 01` for the drum layout under DAW mode (code,
  0x08022E64). This explains why `04 22 01` did nothing under Live: there the pads are in layout 15, which uses 0x23.

## Shift

- **The Shift overlay** is display slot 4, drawn on Shift down (code, 0x08022A88): the encoder-layout label, a line
  of dashes, then the pad-layout label. The Settings, Arp and Chord Map screens put their own first line there.
- **No display flag or message turns it off** (code: nothing on that path reads the flags).
- **But in DAW mode its two labels are the DAW-writable texts 0x22–0x28.** `06 23 00 <text>` replaces "Drum"
  (layout 15), `06 22 00 <text>` replaces "DAW" (layout 2) and `06 25 00 <text>` replaces "Plugin", up to 20
  characters, without any `04` first. While Shift is held the overlay redraws when they are written (code; not
  measured).
- **Shift + encoder:** while Shift is held, the relative-encoder code passes each turn on with a delta of 0, so no CC
  is ever built. The absolute path also doesn't transmit (code, 0x08020F0C–0x08020F2C).
  - The encoders read the same Shift state that a host write of CC 63 sets. Answering the device's `B6 3F 7F` with
    `B6 3F 00` might let the encoders send while Shift is held, but it may also end the device's own Shift functions
    and overlay (inferred, worth a Lab test).

## Scales, chords, arp, drums

- **Scales:** a table of 30 scales at 0x08031DEC, numbered from 1 (0 = off). It is **identical, in order, to
  `FIRMWARE_SCALES` in `live/Morsel/scale.py`** (code). Options: Snap to Scale, Filter out of Scale, Easy Scale.
- **Chord Map:**
  - About 780 voicings of 3–7 notes, kept as semitone offsets (code). How they are indexed by pad, mood and spread is
    not traced.
  - Spread: Normal / Wide / Widest. Modifiers: Adventure, Explore, Spread, Roll.
  - Scale chords: Triads, 7ths, 9ths, 6/9s. Also User Chord, Fixed Chord and Strum (strings).
- **Arp:**
  - Types: Up, Down, Up/Down, Up/Down 2, As Played, Random, Chord.
  - Rates: 1/4, 1/8, 1/16, 1/32 and triplets.
  - Settings: Octave, Latch, Swing, Gate, Mutate, Rhythm. Steps can carry a Tie, Accent or Ratchet (strings).
  - It follows the host clock (realtime messages), CC 3 or SysEx `0A` (inferred).
- **Drums:** no table of notes 36–51 was found, so the map is probably computed with a bank offset (inferred). The
  measured map in `app/src/midi/protocol.ts` stands.

## 1.2 (1490) → 1.3 (1563)

- The image is 1472 bytes larger.
- The only new UI strings are "Rel #" and a ± meter, the display for the relative encoders that 1.3 adds to custom
  modes (code, strings).
- No new DAW-mode commands are visible from strings. A code-level diff wasn't done.

## For Morsel to try (not measured)

Tried in the Lab on 2026-10-31 (see `protocol_notes.md`): 1, 2 (with `06 23`), 3, 4, 5 and 9 work. But 9 can't be
used: the device echoes `B6 3F 00` straight back, and letting go of Shift afterwards reports nothing, because the
Shift state is already off. 6, 7 and 8 are untested. 1–3 are in Morsel and the Live script.

1. `01 63 <note> r g b` for RGB on the drum-layout pads; several entries per message.
2. `06 22/23/25 00 <text>` to put Morsel's own words in the device's Shift overlay, instead of covering it with a
   bitmap on 0x21.
3. `04 23 01` to stop the device's own "Pad Mode" popup under Live.
4. Bit 6 of the `06` field byte shows the text at once; text fields hold 20 / 40 / 60 characters.
5. `9F 0B 7F` for reports of every feature change, and `B7 <cc> 00` to read a setting back.
6. `B6 54 00` to keep the drum pads on the MIDI port (layout 1 instead of 15).
7. `B6 1D 7F` to go back to the previous pad layout (for instance after a device chord mode).
8. CC 3 / 35 on ch7 or SysEx `0A` to give the device the tempo (arp).
9. `B6 3F 00` in answer to Shift down, to see whether the encoders then send while Shift is held.
