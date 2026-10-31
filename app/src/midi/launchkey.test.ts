import { describe, expect, it, vi } from "vitest";
import { Launchkey, type LaunchkeyEvent } from "./launchkey";
import { CC } from "./protocol";

// Layout switches schedule an LED resend on window's timers.
vi.stubGlobal("window", globalThis);

/** A Launchkey with a fake DAW out: what it sends, what it emits, and a way to feed it DAW-port messages. */
function device() {
  const lk = new Launchkey();
  const sent: number[][] = [];
  const events: LaunchkeyEvent[] = [];
  (lk as unknown as { dawOut: { send: (d: number[]) => void } }).dawOut = { send: (d) => sent.push(d) };
  lk.on((e) => events.push(e));
  const receive = (...data: number[]) => (lk as unknown as { handle: (p: string, m: object) => void }).handle("DAW", { data: new Uint8Array(data), timeStamp: 0 });
  return { lk, sent, events, receive };
}

describe("the device's own pad modes (chords)", () => {
  it("leaves it the pads: no pad LEDs while it has them", () => {
    const { lk, sent, events, receive } = device();
    receive(0xb6, 29, 14); // measured under Live: Chord Map picked with Shift + pad
    expect(events.at(-1)).toEqual({ type: "nativePads", value: 14 });
    sent.length = 0;
    lk.setPads(Array.from({ length: 16 }, () => ({ color: 5 })));
    expect(sent).toEqual([]);
  });

  it("takes them back with setLayout, even to the layout it had before", () => {
    const { lk, sent, receive } = device();
    receive(0xb6, 29, 14);
    sent.length = 0;
    lk.setLayout("drum");
    expect(sent[0]).toEqual([0xb6, 29, 1]);
    expect(lk.nativePads).toBeNull();
  });

  it("takes 15 for the drum layout, as the device reports it in DAW mode (measured on connect: 2, then 15 three times)", () => {
    const { lk, sent, events, receive } = device();
    receive(0xb6, 29, 2);
    for (let i = 0; i < 3; i++) receive(0xb6, 29, 15);
    expect(events.at(-1)).toEqual({ type: "layout", layout: "drum" });
    expect(lk.nativePads).toBeNull();
    sent.length = 0;
    lk.setPads(Array.from({ length: 16 }, () => ({ color: 5 })));
    expect(sent.filter((m) => m[0] === 0x99)).toHaveLength(16);
  });

  it("reports Morsel's own layouts as before", () => {
    const { lk, events, receive } = device();
    receive(0xb6, 29, 14);
    receive(0xb6, 29, 2);
    expect(events.at(-1)).toEqual({ type: "layout", layout: "daw" });
    expect(lk.nativePads).toBeNull();
  });
});

describe("pad LEDs", () => {
  it("stops a pulsing pad with a lit colour before turning it off (static 0 alone leaves it pulsing)", () => {
    const { lk, sent } = device();
    lk.setPads(Array.from({ length: 16 }, () => ({ color: 3, mode: "pulse" as const })));
    sent.length = 0;
    lk.setPads(Array.from({ length: 16 }, (_, i) => ({ color: i === 0 ? 5 : 0 })));
    expect(sent.length).toBe(1 + 15 * 2);
    expect(sent.slice(1, 3).map((m) => m[2])).toEqual([1, 0]);
  });
});

describe("pad LEDs going out of step", () => {
  const colors = (c: number) => Array.from({ length: 16 }, () => ({ color: c }));

  it("resync sends every pad again, though nothing changed", () => {
    const { lk, sent } = device();
    lk.setPads(colors(5));
    sent.length = 0;
    lk.resync();
    expect(sent).toHaveLength(16);
  });

  it("leaves the pads to the device's pad-mode picker while Shift is held, and resends nothing then", () => {
    const { lk, sent, receive } = device();
    lk.setPads(colors(5));
    receive(0xb6, CC.shift, 127); // Shift down (feature channel)
    receive(0xb6, 29, 2); // the device reports the DAW layout for its picker
    sent.length = 0;
    lk.setPads(colors(6));
    expect(sent).toEqual([]);
    receive(0xb6, CC.shift, 0);
    lk.resync();
    // Pad LEDs are note-ons; Shift up also closes the screen's popup.
    expect(sent.filter((m) => (m[0] & 0xf0) === 0x90)).toHaveLength(16);
  });

  it("sends static pads again every couple of seconds, but not pulsing ones (that would restart them)", () => {
    const { lk, sent } = device();
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const leds = colors(5).map((c, i) => (i === 0 ? { color: 9, mode: "pulse" as const } : c));
    lk.setPads(leds);
    sent.length = 0;
    lk.setPads(leds);
    expect(sent).toEqual([]);
    now.mockReturnValue(12_500);
    lk.setPads(leds);
    expect(sent).toHaveLength(15);
    now.mockRestore();
  });
});

describe("the device's mode labels", () => {
  const isConfig = (m: number[], target: number) => m[6] === 0x04 && m[7] === target;
  const textOf = (m: number[], target: number) => (m[6] === 0x06 && m[7] === target ? String.fromCharCode(...m.slice(9, -1)) : null);

  it("on connect, turns their popup off before writing them (a new arrangement clears the text)", () => {
    const { lk, sent } = device();
    (lk as unknown as { handshake: () => void }).handshake();
    for (const target of [0x22, 0x23, 0x25]) {
      const config = sent.findIndex((m) => isConfig(m, target));
      const text = sent.findIndex((m) => textOf(m, target) !== null);
      expect(sent[config]).toEqual([0xf0, 0, 0x20, 0x29, 2, 0x13, 4, target, 1, 0xf7]);
      expect(text).toBeGreaterThan(config);
    }
  });

  it("puts the Shift lines in the device's Shift popup: the top one as the encoder label, the other as the pad label", () => {
    const { lk, sent } = device();
    lk.shiftCover = ["Play=Met Rec=Smp", "Fn=Undo Scn=Clr"];
    expect(sent.map((m) => textOf(m, 0x25)).filter(Boolean)).toEqual(["Play=Met Rec=Smp"]);
    expect(sent.map((m) => textOf(m, 0x23)).filter(Boolean)).toEqual(["Fn=Undo Scn=Clr"]);
    expect(sent.map((m) => textOf(m, 0x22)).filter(Boolean)).toEqual(["Fn=Undo Scn=Clr"]);
    sent.length = 0;
    lk.shiftCover = ["Play=Met Rec=Smp", "Fn=Undo Scn=Clr"]; // set on every render: sent only when it changes
    expect(sent).toEqual([]);
  });
});
