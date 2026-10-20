import {
  ARRANGEMENT, BUTTON_BY_CC, CC, CH, DAW_MODE_OFF, DAW_MODE_ON, DISPLAY, FEATURE_CC, PAD_LAYOUT,
  bitmapSysex, buttonLedMessage, cc7, displayConfigSysex, isBitmapAck, displayTextSysex, padFromNote, padLedMessage, relativeDelta,
  type Button, type LedMode, type PadLayout,
} from "./protocol";

export type LaunchkeyEvent =
  | { type: "pad"; pad: number; velocity: number; on: boolean }
  | { type: "padPressure"; pad: number; pressure: number }
  | { type: "key"; note: number; velocity: number; on: boolean; channel: number }
  | { type: "keyCC"; cc: number; value: number; channel: number }
  | { type: "pitchbend"; value: number }
  | { type: "encoder"; index: number; delta: number }
  | { type: "button"; button: Button; down: boolean }
  | { type: "layout"; layout: PadLayout }
  | { type: "connection"; connected: boolean }
  | { type: "raw"; port: string; data: number[] };

type Listener = (e: LaunchkeyEvent) => void;

const TEMP_TIMEOUT_TENTHS = 10; // temporary display popup: 1 s
/** After Shift goes down, cover the device's own Shift popup again at these delays (it may be drawn late)... */
const SHIFT_COVER_RETRY_MS = [40, 120, 250, 500];
/** ...and then this often while Shift stays held, before a temporary popup times out. */
const SHIFT_COVER_KEEP_MS = 700;

/**
 * Covering the device's own "Plugin | Drum" popup while Shift is held:
 * "bitmap" draws the screen (the shift map) into the temporary popup itself; "text" shows our two-line text
 * popup (shiftCover); "cancel" closes the device popup and redraws the stationary bitmap; "off" leaves it.
 * Measured 2026-10-20: "bitmap" covers it (the shift map shows while Shift is held); "cancel" doesn't hide it.
 */
export type ShiftCover = "bitmap" | "text" | "cancel" | "off";
export const SHIFT_COVERS: ShiftCover[] = ["bitmap", "text", "cancel", "off"];
const SHIFT_COVER_KEY = "morsel.shiftCover";

function loadShiftCover(): ShiftCover {
  try {
    const v = localStorage.getItem(SHIFT_COVER_KEY);
    if (SHIFT_COVERS.includes(v as ShiftCover)) return v as ShiftCover;
  } catch { /* storage blocked: use the default */ }
  return "bitmap";
}

export class Launchkey {
  private access: MIDIAccess | null = null;
  private dawIn: MIDIInput | null = null;
  private dawOut: MIDIOutput | null = null;
  private midiIn: MIDIInput | null = null;
  private listeners = new Set<Listener>();
  private lastAbs = new Map<number, number>();
  private padColors = Array.from({ length: 16 }, () => ({ color: 0, mode: "static" as LedMode }));
  private sentColors = new Map<string, number>();
  private sentButtonLeds = new Map<number, number>();
  layout: PadLayout = "drum";
  /** null until known: true after the first bitmap ack, false if none arrives in time. */
  bitmapSupported: boolean | null = null;
  bitmapFrames = 0;
  private bmpInFlight = false;
  private bmpPending: { packed: Uint8Array; target: number } | null = null;
  private bmpLast: { packed: Uint8Array; target: number } | null = null;
  private bmpTimer = 0;
  private resendTimer = 0;
  private textResendTimer = 0;
  connected = false;
  logRaw = false;
  /** The two lines of the device text popup shown while Shift is held (set by the controller per mode). */
  shiftCover: [string, string] = ["Shift", ""];
  /** How the device's own Shift popup is covered (see ShiftCover); picked in the Lab tab, remembered per browser. */
  shiftCoverMode: ShiftCover = loadShiftCover();
  private shiftTimers: number[] = [];

  async init() {
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.scan();
    this.scan();
    window.addEventListener("beforeunload", () => this.release());
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LaunchkeyEvent) {
    for (const fn of this.listeners) fn(e);
  }

  portNames() {
    if (!this.access) return { inputs: [], outputs: [] };
    return {
      inputs: [...this.access.inputs.values()].map((p) => p.name ?? "?"),
      outputs: [...this.access.outputs.values()].map((p) => p.name ?? "?"),
    };
  }

  private scan() {
    if (!this.access) return;
    const find = <T extends MIDIPort>(ports: Iterable<T>, kind: string) =>
      [...ports].find((p) => p.state === "connected" && /launchkey/i.test(p.name ?? "") && (p.name ?? "").includes(kind)) ?? null;
    const dawIn = find(this.access.inputs.values(), "DAW");
    const dawOut = find(this.access.outputs.values(), "DAW");
    const midiIn = find(this.access.inputs.values(), "MIDI");
    const ok = !!(dawIn && dawOut);
    if (ok && (dawIn !== this.dawIn || dawOut !== this.dawOut)) {
      this.dawIn = dawIn;
      this.dawOut = dawOut;
      this.dawIn!.onmidimessage = (m) => this.handle("DAW", m);
      this.bindMidiIn(midiIn);
      this.connected = true;
      this.handshake();
      this.emit({ type: "connection", connected: true });
    } else if (ok) {
      // statechange fires once per port: the keys port can show up (or go away) after the DAW ports.
      this.bindMidiIn(midiIn);
    } else if (!ok && this.connected) {
      this.bindMidiIn(null);
      this.dawIn = this.dawOut = null;
      this.connected = false;
      this.emit({ type: "connection", connected: false });
    }
  }

  private bindMidiIn(port: MIDIInput | null) {
    if (port === this.midiIn) return;
    if (this.midiIn) this.midiIn.onmidimessage = null;
    this.midiIn = port;
    if (port) port.onmidimessage = (m) => this.handle("MIDI", m);
  }

  private handshake() {
    this.sentColors.clear();
    this.sentButtonLeds.clear();
    this.send(DAW_MODE_ON);
    this.send(cc7(CC.drumToDaw, 1));
    this.send(cc7(CC.encoderRelative, 127));
    this.send(cc7(CC.padLayout, PAD_LAYOUT.drum));
    this.layout = "drum";
    // Stationary display: two lines (name + value). Temporary: same arrangement.
    this.send(displayConfigSysex(DISPLAY.stationary, ARRANGEMENT.nameValue));
    this.send(displayConfigSysex(DISPLAY.temporary, ARRANGEMENT.nameValue));
    this.send(cc7(FEATURE_CC.tempTimeout, TEMP_TIMEOUT_TENTHS));
    // The device pops up its own per-encoder display (name + numeric value, "0" for us) on every turn.
    // Config = arrangement with both auto bits (6: on change, 5: on touch) clear, so it never pops up;
    // feedback is drawn by the app instead. (0x00 only cancels a showing display.)
    for (let i = 0; i < 8; i++) this.send(displayConfigSysex(DISPLAY.encoder(i), ARRANGEMENT.nameValue));
    clearTimeout(this.bmpTimer);
    this.bitmapSupported = null;
    this.bmpInFlight = false;
    this.bmpPending = this.bmpLast = null;
    this.refreshLeds();
    // Like a layout switch: LED messages sent while the device is still entering DAW mode can be
    // dropped, and the sent-colour cache would never resend them.
    clearTimeout(this.resendTimer);
    this.resendTimer = window.setTimeout(() => {
      this.sentColors.clear();
      this.refreshLeds();
    }, 300);
  }

  release() {
    if (!this.dawOut) return;
    this.send(cc7(CC.drumToDaw, 0));
    this.send(DAW_MODE_OFF);
  }

  send(data: number[]) {
    try {
      this.dawOut?.send(data);
    } catch (err) {
      console.warn("MIDI send failed", data, err);
    }
  }

  setLayout(layout: PadLayout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.send(cc7(CC.padLayout, PAD_LAYOUT[layout]));
    this.sentColors.clear();
    this.refreshLeds();
    // The device can drop LED messages that arrive while it is still switching layout, and the
    // sent-colour cache would then never resend them. Send everything again once it has settled.
    clearTimeout(this.resendTimer);
    this.resendTimer = window.setTimeout(() => {
      this.sentColors.clear();
      this.refreshLeds();
    }, 150);
  }

  /** Monochrome button LED (CC on ch4, value = brightness). Measured working for the encoder page arrows. */
  setButtonLed(cc: number, brightness: number) {
    if (this.sentButtonLeds.get(cc) === brightness) return;
    this.sentButtonLeds.set(cc, brightness);
    this.send(buttonLedMessage(cc, brightness));
  }

  setPad(pad: number, color: number, mode: LedMode = "static") {
    this.padColors[pad] = { color, mode };
    this.flushPad(pad);
  }

  setPads(colors: { color: number; mode?: LedMode }[]) {
    colors.forEach((c, i) => (this.padColors[i] = { color: c.color, mode: c.mode ?? "static" }));
    this.refreshLeds();
  }

  private flushPad(pad: number) {
    const { color, mode } = this.padColors[pad];
    const key = `${this.layout}:${pad}`;
    const sig = color * 4 + (mode === "static" ? 0 : mode === "flash" ? 1 : 2);
    if (this.sentColors.get(key) === sig) return;
    this.sentColors.set(key, sig);
    // Flash/pulse alternate with the static colour, so set static first.
    if (mode !== "static") this.send(padLedMessage(this.layout, pad, 0));
    this.send(padLedMessage(this.layout, pad, color, mode));
  }

  refreshLeds() {
    for (let i = 0; i < 16; i++) this.flushPad(i);
  }

  showStationary(line1: string, line2: string) {
    this.send(displayTextSysex(DISPLAY.stationary, 0, line1));
    this.send(displayTextSysex(DISPLAY.stationary, 1, line2));
    this.send(displayConfigSysex(DISPLAY.stationary, 0x7f));
  }

  showTemporary(name: string, value: string) {
    this.send(displayTextSysex(DISPLAY.temporary, 0, name));
    this.send(displayTextSysex(DISPLAY.temporary, 1, value));
    this.send(displayConfigSysex(DISPLAY.temporary, 0x7f));
    // Triggering text may drop the device's bitmap; resend it once the popup times out.
    clearTimeout(this.textResendTimer);
    if (this.bmpLast) {
      const last = this.bmpLast;
      this.textResendTimer = window.setTimeout(() => {
        if (this.bmpLast === last) {
          this.bmpLast = null;
          this.showBitmap(last.packed, last.target);
        }
      }, TEMP_TIMEOUT_TENTHS * 100 + 100);
    }
  }

  /**
   * Holding Shift makes the device show its own "Plugin | Drum" (encoder and pad mode). It can draw it after
   * our reply to the Shift message, so while Shift is held it is covered again a few times. On release, close
   * the popup and redraw the screen.
   */
  private coverShiftOverlay(down: boolean) {
    this.shiftTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.shiftTimers = [];
    const mode = this.shiftCoverMode;
    if (mode === "off") return;
    if (!down) return this.closeTemporary();
    const cover = () => {
      if (mode === "text") return this.showTemporary(...this.shiftCover);
      if (mode === "cancel") return this.closeTemporary();
      // The controller draws the shift map into the stationary frame once it sees Shift; show that frame as the popup.
      const last = this.bmpPending ?? this.bmpLast;
      if (last) this.send(bitmapSysex(DISPLAY.temporary, last.packed));
    };
    cover();
    for (const ms of SHIFT_COVER_RETRY_MS) this.shiftTimers.push(window.setTimeout(cover, ms));
    this.shiftTimers.push(window.setInterval(cover, SHIFT_COVER_KEEP_MS));
  }

  setShiftCover(mode: ShiftCover) {
    this.shiftCoverMode = mode;
    try {
      localStorage.setItem(SHIFT_COVER_KEY, mode);
    } catch { /* storage blocked: applies until reload */ }
  }

  /** Close the temporary popup (ours or the device's) and redraw the latest bitmap over it. */
  private closeTemporary() {
    this.send(displayConfigSysex(DISPLAY.temporary, 0));
    const last = this.bmpPending ?? this.bmpLast;
    if (last) this.showBitmap(last.packed, last.target, true);
  }

  /** Ack-paced bitmap send: one frame in flight, latest pending frame wins, identical frames skipped (unless `force`). */
  showBitmap(packed: Uint8Array, target: number = DISPLAY.stationary, force = false) {
    const last = this.bmpLast;
    if (!force && last && last.target === target && sameBytes(last.packed, packed)) {
      this.bmpPending = null;
      return;
    }
    this.bmpPending = { packed, target };
    if (!this.bmpInFlight) this.flushBitmap();
  }

  /** Leave bitmap mode: re-trigger the text display. */
  clearBitmap() {
    this.bmpPending = this.bmpLast = null;
    this.send(displayConfigSysex(DISPLAY.stationary, 0x7f));
  }

  private flushBitmap() {
    const next = this.bmpPending;
    if (!next || !this.dawOut) return;
    this.bmpPending = null;
    this.send(bitmapSysex(next.target, next.packed));
    this.bmpLast = next;
    this.bmpInFlight = true;
    clearTimeout(this.bmpTimer);
    const wait = this.bitmapSupported === null ? 500 : 150;
    this.bmpTimer = window.setTimeout(() => {
      if (this.bitmapSupported === null) this.bitmapSupported = false;
      this.bmpInFlight = false;
      this.flushBitmap();
    }, wait);
  }

  private onBitmapAck() {
    this.bitmapSupported = true;
    this.bitmapFrames++;
    clearTimeout(this.bmpTimer);
    this.bmpInFlight = false;
    this.flushBitmap();
  }

  private handle(port: "DAW" | "MIDI", m: MIDIMessageEvent) {
    const data = [...(m.data ?? [])];
    if (data.length === 0 || data[0] === 0xf8 || data[0] === 0xfe) return;
    if (this.logRaw) this.emit({ type: "raw", port, data });
    if (data[0] === 0xf0) {
      if (port === "DAW" && isBitmapAck(data)) this.onBitmapAck();
      return;
    }
    const status = data[0] & 0xf0;
    const ch = data[0] & 0x0f;
    const [, d1, d2] = data;

    if (port === "MIDI") {
      if (status === 0x90 || status === 0x80) {
        this.emit({ type: "key", note: d1, velocity: d2, on: status === 0x90 && d2 > 0, channel: ch });
      } else if (status === 0xb0) {
        this.emit({ type: "keyCC", cc: d1, value: d2, channel: ch });
      } else if (status === 0xe0) {
        this.emit({ type: "pitchbend", value: ((d2 << 7) | d1) - 8192 });
      }
      return;
    }

    if (status === 0x90 || status === 0x80) {
      const on = status === 0x90 && d2 > 0;
      if (ch === CH.drum || ch === CH.dawPads) {
        const pad = padFromNote(ch === CH.drum ? "drum" : "daw", d1);
        if (pad >= 0) this.emit({ type: "pad", pad, velocity: d2, on });
      }
    } else if (status === 0xa0) {
      const pad = padFromNote(ch === CH.drum ? "drum" : "daw", d1);
      if (pad >= 0) this.emit({ type: "padPressure", pad, pressure: d2 });
    } else if (status === 0xb0) {
      if (ch === CH.feature) {
        if (d1 === CC.padLayout) {
          const layout = d2 === PAD_LAYOUT.daw ? "daw" : d2 === PAD_LAYOUT.drum ? "drum" : null;
          if (layout) {
            this.layout = layout;
            this.sentColors.clear();
            this.refreshLeds();
            this.emit({ type: "layout", layout });
          }
        } else if (d1 === CC.shift) {
          this.coverShiftOverlay(d2 > 0);
          this.emit({ type: "button", button: "shift", down: d2 > 0 });
        }
      } else if (ch === CH.button) {
        if (d1 >= CC.encRelFirst && d1 < CC.encRelFirst + 8) {
          this.emit({ type: "encoder", index: d1 - CC.encRelFirst, delta: relativeDelta(d2) });
        } else if (d1 >= CC.encAbsFirst && d1 < CC.encAbsFirst + 8) {
          // Fallback if the device ignores relative mode: derive a delta.
          const prev = this.lastAbs.get(d1);
          this.lastAbs.set(d1, d2);
          if (prev !== undefined && prev !== d2) this.emit({ type: "encoder", index: d1 - CC.encAbsFirst, delta: d2 - prev });
        } else if (BUTTON_BY_CC[d1]) {
          this.emit({ type: "button", button: BUTTON_BY_CC[d1], down: d2 > 0 });
        }
      } else if (ch === CH.dawPads && BUTTON_BY_CC[d1]) {
        // Measured: the encoder page arrows (CC 51/52) arrive on ch1, not ch16 as the guide says.
        this.emit({ type: "button", button: BUTTON_BY_CC[d1], down: d2 > 0 });
      }
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const launchkey = new Launchkey();
