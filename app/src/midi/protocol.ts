// Launchkey Mini MK4 DAW-mode protocol (Novation MK4 Programmer's Reference v2).
// Pure data + byte builders only, so it can be unit tested without Web MIDI.
// Channels in this file are 0-based (ch1 = 0).

export const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x13];

export const CH = {
  dawPads: 0, // ch1
  feature: 6, // ch7
  drum: 9, // ch10
  button: 15, // ch16
  daw: 15, // ch16 (note 12 = DAW mode)
} as const;

export const CC = {
  padLayout: 29, // ch7
  encoderMode: 30, // ch7
  encoderRelative: 69, // ch7
  drumToDaw: 84, // ch7
  keyboardToDaw: 76, // ch7: the keybed on the DAW port (Live's script turns it on; Morsel wants it off)
  shift: 63,
  play: 115,
  record: 117,
  encPageUp: 51,
  encPageDown: 52,
  padUp: 106,
  padDown: 107,
  trackPrev: 102, // measured: what Pad up sends while Shift is held ("< Track" on the device), ch1
  trackNext: 103, // assumed: Shift + Pad down ("Track >"), not measured yet
  scene: 104,
  func: 105,
  encAbsFirst: 21, // 21..28 on ch16
  encRelFirst: 85, // 85..92 on ch16
} as const;

export const PAD_LAYOUT = { drum: 1, daw: 2 } as const;

export type Button =
  | "shift" | "play" | "record" | "encPageUp" | "encPageDown"
  | "padUp" | "padDown" | "trackPrev" | "trackNext" | "scene" | "func";

export const BUTTON_BY_CC: Record<number, Button> = {
  [CC.shift]: "shift",
  [CC.play]: "play",
  [CC.record]: "record",
  [CC.encPageUp]: "encPageUp",
  [CC.encPageDown]: "encPageDown",
  [CC.padUp]: "padUp",
  [CC.padDown]: "padDown",
  [CC.trackPrev]: "trackPrev",
  [CC.trackNext]: "trackNext",
  [CC.scene]: "scene",
  [CC.func]: "func",
};

// Pad index 0..15, MPC style: 0..7 = bottom row left->right, 8..15 = top row.
const DRUM_BOTTOM = [36, 37, 38, 39, 44, 45, 46, 47];
const DRUM_TOP = [40, 41, 42, 43, 48, 49, 50, 51];
export const DRUM_NOTES = [...DRUM_BOTTOM, ...DRUM_TOP];
export const DAW_NOTES = [
  ...Array.from({ length: 8 }, (_, i) => 112 + i),
  ...Array.from({ length: 8 }, (_, i) => 96 + i),
];

export type PadLayout = "drum" | "daw";

export function padFromNote(layout: PadLayout, note: number): number {
  return (layout === "drum" ? DRUM_NOTES : DAW_NOTES).indexOf(note);
}

export function noteForPad(layout: PadLayout, pad: number): number {
  return (layout === "drum" ? DRUM_NOTES : DAW_NOTES)[pad];
}

export type LedMode = "static" | "flash" | "pulse";
const LED_CH_OFFSET: Record<LedMode, number> = { static: 0, flash: 1, pulse: 2 };

export function padLedMessage(layout: PadLayout, pad: number, color: number, mode: LedMode = "static"): number[] {
  const base = layout === "drum" ? CH.drum : CH.dawPads;
  return [0x90 | (base + LED_CH_OFFSET[mode]), noteForPad(layout, pad), color & 0x7f];
}

// Monochrome button LEDs: CC on ch4, value = brightness.
export function buttonLedMessage(cc: number, brightness: number): number[] {
  return [0xb3, cc, brightness & 0x7f];
}

export function padRgbSysex(layout: PadLayout, pad: number, r: number, g: number, b: number): number[] {
  return [...SYSEX_HEADER, 0x01, 0x43, noteForPad(layout, pad), r & 0x7f, g & 0x7f, b & 0x7f, 0xf7];
}

export const DAW_MODE_ON = [0x9f, 0x0c, 0x7f];
export const DAW_MODE_OFF = [0x9f, 0x0c, 0x00];
export const cc7 = (cc: number, v: number) => [0xb0 | CH.feature, cc, v & 0x7f];

// Display. Targets: 0x15..0x1C encoders, 0x20 stationary, 0x21 global temporary.
export const DISPLAY = { stationary: 0x20, temporary: 0x21, encoder: (i: number) => 0x15 + i } as const;

export function displayConfigSysex(target: number, config: number): number[] {
  return [...SYSEX_HEADER, 0x04, target, config & 0x7f, 0xf7];
}

export const ARRANGEMENT = { nameValue: 1, titleNameValue: 2, titleEncoders: 3, numeric: 4 } as const;

/** Device glyphs usable in display text. */
export const GLYPH = { emptyBox: "\x1b", filledBox: "\x1c", flat: "\x1d", heart: "\x1e" } as const;

export const FEATURE_CC = { brightness: 0x70, tempTimeout: 0x71 } as const;

export function displayTextSysex(target: number, field: number, text: string): number[] {
  const bytes = [...text.slice(0, 16)].map((ch) => {
    const c = ch.charCodeAt(0);
    return (c >= 0x20 && c <= 0x7e) || (c >= 0x1b && c <= 0x1e) ? c : 0x3f; // '?'
  });
  return [...SYSEX_HEADER, 0x06, target, field & 0x7f, ...bytes, 0xf7];
}

// Bitmap: 64 rows x 19 bytes (7 px/byte). Target 0x20 stationary or 0x21 temporary.
export function bitmapSysex(target: number, packed: Uint8Array): number[] {
  const out = new Array<number>(SYSEX_HEADER.length + 3 + packed.length);
  let i = 0;
  for (const b of SYSEX_HEADER) out[i++] = b;
  out[i++] = 0x09;
  out[i++] = target;
  for (const b of packed) out[i++] = b & 0x7f;
  out[i] = 0xf7;
  return out;
}

// Measured on a Mini MK4 25: the ack is F0 00 20 29 02 13 09 F7 (the guide's "09 7F" is a misprint
// of the terminator). Accept the guide's form too, in case other firmware sends it.
export function isBitmapAck(data: ArrayLike<number>): boolean {
  const head = [...SYSEX_HEADER, 0x09];
  if (!head.every((b, i) => data[i] === b)) return false;
  const rest = Array.from(data).slice(head.length);
  return (rest.length === 1 && rest[0] === 0xf7) || (rest.length === 2 && rest[0] === 0x7f && rest[1] === 0xf7);
}

// Relative encoder value -> signed delta (64 = no move).
export function relativeDelta(value: number): number {
  return value - 64;
}

// A small palette subset (Novation palette indices).
export const COLOR = {
  off: 0, grey: 1, white: 3, red: 5, orange: 9, yellow: 13, lime: 17, green: 21,
  mint: 29, cyan: 37, sky: 41, blue: 45, purple: 49, magenta: 53, pink: 57, dimRed: 7,
  dimGreen: 23, dimBlue: 47, dimWhite: 2,
} as const;
