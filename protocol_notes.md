# Launchkey Mini MK4 25: DAW-mode facts measured with LaunchKit (2026-10-17)

| What | Measured | Notes |
|---|---|---|
| Web MIDI port names | In: `Launchkey Mini MK4 25 MIDI Out`, `… DAW Out`. Out: `… MIDI In`, `… DAW In` | Matched on the substrings `Launchkey` and `DAW` / `MIDI`. |
| Identity reply | `F0 7E 00 06 02 00 20 29 41 01 00 01 01 03 …` (17 bytes) | Sent in reply to `F0 7E 7F 06 01 F7`. |
| Bitmap ack | `F0 00 20 29 02 13 09 F7` | The guide prints `09 7F F7`. That form is wrong, and `isBitmapAck` accepts both. |
| Encoders | Relative: CC 85–92 (`BF 55…5C`) on ch16, `41` = +1 per detent | Measured after the app sent `B6 45 7F` (relative mode on). No absolute CC 21–28 messages arrived. |
| Encoder popups | The device shows its own popup (numeric "0") on every turn unless each encoder target 0x15–0x1C gets config `01` | Config `00` does **not** stop the popup; it only hides one that's showing. An arrangement with bits 5 and 6 clear does. |
| Encoder page arrows | Up = CC 51 (`B0 33`), down = CC 52 (`B0 34`), value 7F/00, on **ch1** | The guide says ch16. The app now accepts button CCs on ch1 and ch16. |
| Play / Record | Play = CC 115 (`B0 73`), Record = CC 117 (`B0 75`), on ch1 | So CC 117 is Record, not Shift. |
| Pad up / down | Up = CC 106 (`B0 6A`), down = CC 107 (`B0 6B`), on ch1 | LEDs on ch4 work (confirmed by eye). |
| Shift | CC 63 on **ch7** (`B6 3F 7F` / `B6 3F 00`) | Measured 2026-10-17. |
| Shift + Pad up | CC 102 (`B0 66 7F` / `00`) on ch1, **instead of** CC 106 | The device's own "< Track" function. LaunchKit uses it to toggle Browse. Shift + Pad down (presumably "Track >", CC 103) not measured yet. LaunchKit assumes CC 103 and uses it to toggle Chop; Pad down with Shift held is also accepted. |
| Button LEDs | `B3 <cc> <brightness>` (CC on ch4) lights the encoder page arrows (CC 51/52), Play and Record | Confirmed by eye. The buttons *send* on ch1, but their LEDs listen on ch4. |
| Bitmap rate | ~12 frames/s, paced by the ack | Each 1216-byte frame is sent only after the previous one is acked. |
| Pad layout after connect | The device reports `daw` (CC 29 on ch7) right after the handshake, even though the handshake asked for `drum` | The controller now sends the layout the current mode needs again (at most once a second). Confirmed 2026-10-17: Play mode plays with velocity straight after connecting. |

## Still to check by hand (Lab tab)
- Button CCs in DAW mode: Function (105), Scene (104).
- Does temporary text (`showTemporary`) appear on top of the bitmap, and does the bitmap come back after the 1 s timeout?
- Bit order on the real screen: Lab → Screen bitmap → Border and Font. Check that the border touches all 4 edges and the text isn't mirrored.
