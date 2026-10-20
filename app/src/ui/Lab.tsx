// Protocol lab: watch raw MIDI and try LED / display / SysEx messages on the hardware.
import { useEffect, useState } from "react";
import { SHIFT_COVERS, launchkey, type ShiftCover } from "../midi/launchkey";
import { DISPLAY, displayConfigSysex, displayTextSysex, padRgbSysex } from "../midi/protocol";
import { pauseLeds } from "../modes/controller";
import { Frame, W, H } from "../display/frame";
import { ScreenPreview } from "./ScreenPreview";
import { useApp } from "../state/store";
import { Section } from "./controls";
import { engine } from "../audio/engine";

const LIVE_BUDGETS = [0, 4, 8, 12, 20];

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
const ms = (v: number | undefined) => (v === undefined ? "—" : `${v.toFixed(1)} ms`);

/** How long Launchkey messages wait for the main thread, against the live-note jitter budget. */
function TimingProbe() {
  const [budget, setBudget] = useState(engine.liveBudget);
  const [, redraw] = useState(0);
  useEffect(() => {
    const id = setInterval(() => redraw((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const d = [...launchkey.handleDelays].sort((a, b) => a - b);
  const over = d.filter((x) => x > budget).length;
  const ctx = engine.ctx;
  return (
    <Section title="Timing" actions={<button onClick={() => (launchkey.handleDelays.length = 0)}>Reset</button>}>
      <p className="hint">
        How long the last {d.length} Launchkey messages waited before Morsel handled them. Play pads with the sequencer
        running and the UI busy to see the worst case. Live notes start the budget after they were played, so a wait
        under the budget doesn't move the note.
      </p>
      <p className="mono">
        median {ms(pct(d, 50))} · p95 {ms(pct(d, 95))} · p99 {ms(pct(d, 99))} · max {ms(d.at(-1))} · over budget {over}
      </p>
      <p className="hint">
        Audio: {ctx.sampleRate} Hz · base latency {ms(ctx.baseLatency * 1000)} · output latency {ms((ctx.outputLatency ?? 0) * 1000)}
      </p>
      <div className="row">
        <span>Live budget</span>
        {LIVE_BUDGETS.map((b) => (
          <button key={b} className={b === budget ? "on" : ""} onClick={() => { engine.setLiveBudget(b); setBudget(b); }}>{b ? `${b} ms` : "off"}</button>
        ))}
      </div>
    </Section>
  );
}

const hex = (d: number[]) => d.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

export function Lab() {
  const connected = useApp((s) => s.connected);
  const [log, setLog] = useState<string[]>([]);
  const [paletteBase, setPaletteBase] = useState(0);
  const [custom, setCustom] = useState("F0 00 20 29 02 13 06 21 00 48 65 6C 6C 6F F7");
  const [text, setText] = useState(["Hello", "Launchkey"]);
  const [shiftCover, setShiftCover] = useState<ShiftCover>(launchkey.shiftCoverMode);

  useEffect(() => {
    launchkey.logRaw = true;
    pauseLeds(true);
    const off = launchkey.on((e) => {
      const line = e.type === "raw" ? `${e.port.padEnd(4)} ${hex(e.data)}` : `→ ${JSON.stringify(e)}`;
      setLog((l) => [line, ...l].slice(0, 300));
    });
    return () => {
      launchkey.logRaw = false;
      pauseLeds(false);
      off();
    };
  }, []);

  const [testFrame, setTestFrame] = useState<Frame | null>(null);
  const [ackInfo, setAckInfo] = useState("");
  const sendFrame = (f: Frame) => {
    setTestFrame(f);
    launchkey.showBitmap(f.pack());
  };
  const testPatterns: Record<string, () => Frame> = {
    Checkerboard: () => { const f = new Frame(); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f.set(x, y, (x + y) % 2); return f; },
    Border: () => { const f = new Frame(); f.rect(0, 0, W, H); f.text(4, 4, "128x64 border"); f.set(2, 2); f.set(W - 3, H - 3); return f; },
    Font: () => {
      const f = new Frame();
      const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
      for (let r = 0; r * 21 < chars.length; r++) f.text(0, r * 9, chars.slice(r * 21, r * 21 + 21));
      return f;
    },
  };
  const scrollFps = async () => {
    const start = launchkey.bitmapFrames;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) {
      const f = new Frame();
      f.fillRect((i * 4) % W, 0, 8, H);
      f.text(40, 28, `frame ${i}`);
      setTestFrame(f);
      launchkey.showBitmap(f.pack());
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 300));
    const acks = launchkey.bitmapFrames - start;
    setAckInfo(`${acks} acks in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${(acks / ((performance.now() - t0) / 1000)).toFixed(1)} fps`);
  };

  const ports = launchkey.portNames();
  const showPalette = (base: number) => {
    setPaletteBase(base);
    launchkey.setPads(Array.from({ length: 16 }, (_, i) => ({ color: (base + i) % 128 })));
  };

  return (
    <div className="lab">
      <Section title="Ports">
        <p>Status: {connected ? "connected (DAW mode)" : "not connected"}</p>
        <p className="hint">Inputs: {ports.inputs.join(", ") || "—"}</p>
        <p className="hint">Outputs: {ports.outputs.join(", ") || "—"}</p>
        <p className="hint">The app takes the Launchkey over, so close Ableton Live first.</p>
      </Section>
      <TimingProbe />
      <div className="row wrap">
        <Section title="Pad LEDs">
          <p className="hint">Use this to check pad numbering and palette indices. Normal LEDs come back when you leave the Lab.</p>
          <div className="row">
            <button onClick={() => showPalette(Math.max(0, paletteBase - 16))}>◀</button>
            <span>Palette {paletteBase}–{paletteBase + 15}</span>
            <button onClick={() => showPalette(Math.min(112, paletteBase + 16))}>▶</button>
                      </div>
          <div className="row">
            <button onClick={() => [0, 1, 2, 3].forEach((p) => launchkey.send(padRgbSysex(launchkey.layout, p, p === 0 ? 127 : 0, p === 1 ? 127 : 0, p === 2 ? 127 : 64)))}>
              Test RGB SysEx (pads 1–4)
            </button>
          </div>
        </Section>
        <Section title="Display">
          <div className="row">
            <input value={text[0]} onChange={(e) => setText([e.target.value, text[1]])} />
            <input value={text[1]} onChange={(e) => setText([text[0], e.target.value])} />
          </div>
          <div className="row">
            <button onClick={() => launchkey.showStationary(text[0], text[1])}>Stationary</button>
            <button onClick={() => launchkey.showTemporary(text[0], text[1])}>Temporary</button>
            <button onClick={() => {
              [1, 2, 3].forEach((arr) => {
                launchkey.send(displayConfigSysex(DISPLAY.temporary, arr));
              });
              launchkey.send(displayConfigSysex(DISPLAY.temporary, 2));
              launchkey.send(displayTextSysex(DISPLAY.temporary, 0, "Title"));
              launchkey.send(displayTextSysex(DISPLAY.temporary, 1, text[0]));
              launchkey.send(displayTextSysex(DISPLAY.temporary, 2, text[1]));
              launchkey.send(displayConfigSysex(DISPLAY.temporary, 0x7f));
              setTimeout(() => launchkey.send(displayConfigSysex(DISPLAY.temporary, 0x01)), 3000);
            }}>3-line test</button>
          </div>
        </Section>
        <Section title="Screen bitmap">
          <p className="hint">Bitmap ack: {launchkey.bitmapSupported === null ? "unknown (send a frame)" : launchkey.bitmapSupported ? `yes (${launchkey.bitmapFrames} frames)` : "no ack received"} {ackInfo}</p>
          <ScreenPreview source={() => testFrame} />
          <div className="row wrap">
            {Object.entries(testPatterns).map(([name, make]) => <button key={name} onClick={() => sendFrame(make())}>{name}</button>)}
            <button onClick={scrollFps}>Animate + measure fps</button>
            <button onClick={() => { launchkey.clearBitmap(); setTestFrame(null); }}>Back to text</button>
            <button onClick={() => launchkey.showTemporary("Overlay", "test 1s")}>Temp text on top</button>
          </div>
        </Section>
        <Section title="Shift popup">
          <p className="hint">
            How Morsel covers the Launchkey's own “Plugin | Drum” popup while Shift is held. Pick one, switch to another tab
            (the Lab pauses Morsel's screen), then hold Shift. Bitmap = the shift map as the popup, Text = two lines of text,
            Close = close the popup and redraw, Off = the device's own popup.
          </p>
          <div className="row">
            {SHIFT_COVERS.map((m) => (
              <button key={m} className={m === shiftCover ? "on" : ""} onClick={() => { launchkey.setShiftCover(m); setShiftCover(m); }}>{m}</button>
            ))}
          </div>
        </Section>
        <Section title="Send raw (DAW port)">
          <div className="row">
            <input className="mono wide" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button onClick={() => launchkey.send(custom.trim().split(/\s+/).map((h) => parseInt(h, 16)))}>Send</button>
          </div>
        </Section>
      </div>
      <Section title="Incoming MIDI" actions={<button onClick={() => setLog([])}>Clear</button>}>
        <pre className="log">{log.join("\n") || "Press pads, turn encoders, press buttons…"}</pre>
      </Section>
    </div>
  );
}
