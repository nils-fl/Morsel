import {
  ARRANGEMENT, BUTTON_BY_CC, CC, CH, DAW_MODE_OFF, DAW_MODE_ON, DISPLAY, FEATURE_CC, PAD_LAYOUT, PAD_LAYOUT_DRUM_ON_DAW,
  bitmapSysex, buttonLedMessage, cc7, displayConfigSysex, isBitmapAck, displayTextSysex, padFromNote, padLedMessage, relativeDelta,
  type Button, type LedMode, type PadLayout,
} from "./protocol";
import { isString, oneOf, pref } from "../state/prefs";

/** How often static pad colours are sent again whether or not they changed (setPads). */
const HEAL_MS = 2000;

export type LaunchkeyEvent =
  | { type: "pad"; pad: number; velocity: number; on: boolean }
  | { type: "padPressure"; pad: number; pressure: number }
  | { type: "key"; note: number; velocity: number; on: boolean; channel: number }
  | { type: "keyCC"; cc: number; value: number; channel: number }
  | { type: "pitchbend"; value: number }
  | { type: "encoder"; index: number; delta: number }
  | { type: "button"; button: Button; down: boolean }
  | { type: "layout"; layout: PadLayout }
  /** The device switched the pads to one of its own modes (chords, arp, custom: CC 29 value `value`, e.g. 14 for Chord Map). */
  | { type: "nativePads"; value: number }
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
const shiftCoverPref = pref<ShiftCover>("morsel.shiftCover", "bitmap", oneOf(SHIFT_COVERS));

/** Which Launchkey to use when more than one is plugged in, by name ("" = the first one found). */
const devicePref = pref("morsel.midiDevice", "", isString);

/** A port's device name: "Launchkey Mini MK4 25 DAW Out" → "Launchkey Mini MK4 25". */
const deviceName = (port: MIDIPort) => (port.name ?? "").replace(/\s+(DAW|MIDI)\b.*$/i, "");

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
  /** The device's own pad mode (CC 29 value) while it has the pads, else null: no pad LEDs are sent meanwhile. */
  nativePads: number | null = null;
  /** null until known: true after the first bitmap ack, false if none arrives in time. */
  bitmapSupported: boolean | null = null;
  bitmapFrames = 0;
  private bmpInFlight = false;
  private bmpPending: { packed: Uint8Array; target: number } | null = null;
  private bmpLast: { packed: Uint8Array; target: number } | null = null;
  private bmpTimer = 0;
  private resendTimer = 0;
  /** Shift held: the device shows its own pad-mode picker on the pads. */
  private shiftDown = false;
  /** When static pads were last sent again regardless of the cache (setPads). */
  private lastHeal = 0;
  private textResendTimer = 0;
  connected = false;
  logRaw = false;
  /** The two lines of the device text popup shown while Shift is held (set by the controller per mode). */
  shiftCover: [string, string] = ["Shift", ""];
  /** How the device's own Shift popup is covered (see ShiftCover); picked in Preferences or the Lab. */
  shiftCoverMode: ShiftCover = shiftCoverPref.get();
  /** The picked device's name, or "" for the first Launchkey found. */
  device = devicePref.get();
  private shiftTimers: number[] = [];
  /** performance.now() time the message being handled arrived at (undefined outside a handler): live notes use it. */
  eventTime: number | undefined;
  /** How long the last messages waited before their handler ran, ms (newest last; for the Lab's timing probe). */
  readonly handleDelays: number[] = [];

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

  /** The Launchkeys plugged in, by name. */
  devices() {
    if (!this.access) return [];
    const names = [...this.access.inputs.values()].filter((p) => p.state === "connected" && /launchkey/i.test(p.name ?? "")).map(deviceName);
    return [...new Set(names)];
  }

  /** Use another Launchkey ("" = the first one found) and remember it. */
  setDevice(name: string) {
    this.device = name;
    devicePref.set(name);
    this.scan();
  }

  private scan() {
    if (!this.access) return;
    const find = <T extends MIDIPort>(ports: Iterable<T>, kind: string) =>
      [...ports].find((p) => p.state === "connected" && /launchkey/i.test(p.name ?? "") && (p.name ?? "").includes(kind) &&
        (!this.device || deviceName(p) === this.device)) ?? null;
    const dawIn = find(this.access.inputs.values(), "DAW");
    const dawOut = find(this.access.outputs.values(), "DAW");
    const midiIn = find(this.access.inputs.values(), "MIDI");
    const ok = !!(dawIn && dawOut);
    if (ok && (dawIn !== this.dawIn || dawOut !== this.dawOut)) {
      // Another Launchkey picked: hand the one before back to its standalone mode.
      if (this.dawOut?.state === "connected") this.release();
      if (this.dawIn) this.dawIn.onmidimessage = null;
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
      if (this.dawOut?.state === "connected") this.release();
      if (this.dawIn) this.dawIn.onmidimessage = null;
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
    // Morsel reads the keys on the MIDI port. Morsel for Live (live/) moves them to the DAW port; if Live quit without
    // moving them back (a crash), they would never arrive here.
    this.send(cc7(CC.keyboardToDaw, 0));
    this.send(cc7(CC.encoderRelative, 127));
    this.send(cc7(CC.padLayout, PAD_LAYOUT.drum));
    this.layout = "drum";
    this.nativePads = null;
    this.shiftDown = false;
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
    this.resendSoon(300);
  }

  /** Send every pad again in a moment, cache or not (the device may have dropped what came while it was busy). */
  private resendSoon(ms: number) {
    clearTimeout(this.resendTimer);
    this.resendTimer = window.setTimeout(() => {
      this.sentColors.clear();
      this.refreshLeds();
    }, ms);
  }

  /** Send every pad again, now and in a moment: after something else had the pads (the Shift picker, the Lab). */
  resync() {
    this.sentColors.clear();
    this.refreshLeds();
    this.resendSoon(150);
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

  /** Put the pads in one of Morsel's layouts; also takes them back from the device's own pad mode. */
  setLayout(layout: PadLayout) {
    if (layout === this.layout && this.nativePads === null) return;
    this.layout = layout;
    this.nativePads = null;
    this.send(cc7(CC.padLayout, PAD_LAYOUT[layout]));
    // The device can drop LED messages that arrive while it is still switching layout, and the
    // sent-colour cache would then never resend them. Send everything again once it has settled.
    this.resync();
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
    // A safety net for a message the device missed (e.g. while a screen bitmap streams in): every couple of seconds
    // the static pads go out again. Flashing and pulsing ones are left alone: sending them restarts their animation.
    const now = performance.now();
    if (now - this.lastHeal > HEAL_MS) {
      this.lastHeal = now;
      for (const [key, sig] of this.sentColors) if (sig % 4 === 0) this.sentColors.delete(key);
    }
    this.refreshLeds();
  }

  private flushPad(pad: number) {
    // The device's own pad mode draws its own pads, and while Shift is held its pad-mode picker does.
    if (this.nativePads !== null || this.shiftDown) return;
    const { color, mode } = this.padColors[pad];
    const key = `${this.layout}:${pad}`;
    const sig = color * 4 + (mode === "static" ? 0 : mode === "flash" ? 1 : 2);
    const prev = this.sentColors.get(key);
    if (prev === sig) return;
    this.sentColors.set(key, sig);
    // Flash/pulse alternate with the static colour, so set static first.
    if (mode !== "static") this.send(padLedMessage(this.layout, pad, 0));
    // Static 0 (a note-off) leaves a flashing / pulsing pad going (Chop's pads after the key is let go): a lit static
    // colour stops it first.
    else if (color === 0 && prev !== undefined && prev % 4 !== 0) this.send(padLedMessage(this.layout, pad, 1));
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
    shiftCoverPref.set(mode);
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
    this.handleDelays.push(performance.now() - m.timeStamp);
    if (this.handleDelays.length > 500) this.handleDelays.shift();
    this.eventTime = m.timeStamp;
    try {
      this.dispatch(port, m);
    } finally {
      this.eventTime = undefined;
    }
  }

  private dispatch(port: "DAW" | "MIDI", m: MIDIMessageEvent) {
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
          // In DAW mode the drum layout is reported as 15. Taken for a device mode, it stopped the pad LEDs on connect.
          const layout = d2 === PAD_LAYOUT.daw ? "daw" : d2 === PAD_LAYOUT.drum || d2 === PAD_LAYOUT_DRUM_ON_DAW ? "drum" : null;
          if (layout) {
            this.layout = layout;
            this.nativePads = null;
            this.sentColors.clear();
            this.refreshLeds();
            this.emit({ type: "layout", layout });
          } else {
            this.nativePads = d2;
            this.emit({ type: "nativePads", value: d2 });
          }
        } else if (d1 === CC.shift) {
          this.shiftDown = d2 > 0;
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
