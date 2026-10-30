import { describe, expect, it, vi } from "vitest";
import { Launchkey, type LaunchkeyEvent } from "./launchkey";

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
    receive(0xb6, 29, 15); // measured: a chord mode picked with Shift + pad
    expect(events.at(-1)).toEqual({ type: "nativePads", value: 15 });
    sent.length = 0;
    lk.setPads(Array.from({ length: 16 }, () => ({ color: 5 })));
    expect(sent).toEqual([]);
  });

  it("takes them back with setLayout, even to the layout it had before", () => {
    const { lk, sent, receive } = device();
    receive(0xb6, 29, 15);
    sent.length = 0;
    lk.setLayout("drum");
    expect(sent[0]).toEqual([0xb6, 29, 1]);
    expect(lk.nativePads).toBeNull();
  });

  it("reports Morsel's own layouts as before", () => {
    const { lk, events, receive } = device();
    receive(0xb6, 29, 15);
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
