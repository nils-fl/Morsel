// Preferences: how this browser (or the desktop app) runs Morsel. Not part of the project. Esc or the backdrop closes it.
import { useEffect, useState } from "react";
import { LIVE_BUDGETS, engine, type VoiceEngine } from "../audio/engine";
import { BEND_RANGES, bendRangePref } from "../actions";
import { SHIFT_COVERS, launchkey, type ShiftCover } from "../midi/launchkey";
import { isNative } from "../platform/native";
import { isBoolean, pref } from "../state/prefs";
import { useApp } from "../state/store";
import { applyTheme } from "./theme";
import { applyTips } from "./tips";

/** Desktop app only; electron/main.ts reads it when it opens the window. */
const fullScreenPref = pref("morsel.fullScreen", false, isBoolean);

const SHIFT_COVER_LABEL: Record<ShiftCover, string> = { bitmap: "Shift map", text: "Text", cancel: "Close", off: "Off" };

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="prefs-row">
      <span className="prefs-label">{label}</span>
      <div className="prefs-ctl">{children}</div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

function Choice<T extends string | number>({ value, options, label, onPick }: { value: T; options: readonly T[]; label: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <>
      {options.map((o) => <button key={o} className={o === value ? "on" : ""} onClick={() => onPick(o)}>{label(o)}</button>)}
    </>
  );
}

export function Preferences({ onClose, onLab }: { onClose: () => void; onLab: () => void }) {
  const theme = useApp((s) => s.theme);
  const tips = useApp((s) => s.tips);
  const connected = useApp((s) => s.connected);
  const [budget, setBudget] = useState(engine.liveBudget);
  const [voices, setVoices] = useState<VoiceEngine>(engine.nextVoiceEngine);
  const [output, setOutput] = useState(engine.outputDevice);
  const [outputs, setOutputs] = useState<{ id: string; label: string }[]>([]);
  const [device, setDevice] = useState(launchkey.device);
  const [shiftCover, setShiftCover] = useState(launchkey.shiftCoverMode);
  const [bendRange, setBendRange] = useState(bendRangePref.get);
  const [fullScreen, setFullScreen] = useState(fullScreenPref.get);
  const devices = launchkey.devices();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    void engine.outputDevices().then(setOutputs);
  }, []);

  const restart = isNative() ? "the next start" : "the next reload";
  return (
    <div className="g-overlay" onClick={onClose}>
      <div className="confirm prefs" role="dialog" aria-modal="true" aria-labelledby="prefs-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="prefs-title">Preferences</h2>

        <h3>Screen</h3>
        <Row label="Theme">
          <Choice value={theme} options={["light", "dark"] as const} label={(t) => (t === "light" ? "☀ Light" : "☾ Dark")} onPick={applyTheme} />
        </Row>
        <Row label="Tips">
          <Choice value={tips ? "on" : "off"} options={["on", "off"] as const} label={(t) => (t === "on" ? "Show" : "Hide")} onPick={(t) => applyTips(t === "on")} />
        </Row>
        {isNative() && (
          <Row label="Start">
            <label className="prefs-check">
              <input type="checkbox" checked={fullScreen} onChange={(e) => { fullScreenPref.set(e.target.checked); setFullScreen(e.target.checked); }} />
              Open in full screen
            </label>
          </Row>
        )}

        <h3>Audio</h3>
        {engine.canPickOutput && (
          <Row label="Output" hint={!isNative() && outputs.some((o) => o.label.startsWith("Output ")) ? "The browser shows device names after you allow the microphone once (Sample → Audio input)." : undefined}>
            <select value={output} onChange={(e) => { setOutput(e.target.value); void engine.setOutputDevice(e.target.value); }}>
              <option value="">System default</option>
              {outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              {output && !outputs.some((o) => o.id === output) && <option value={output}>Not connected</option>}
            </select>
          </Row>
        )}
        <Row label="Live budget" hint="Pads and keys sound this long after they're played, every time, so the timing doesn't wobble when Morsel is busy. Off plays at once.">
          <Choice value={budget} options={LIVE_BUDGETS} label={(b) => (b ? `${b} ms` : "Off")} onPick={(b) => { engine.setLiveBudget(b); setBudget(b); }} />
        </Row>
        <Row label="Voices" hint={`Worklet plays sample-accurately off the main thread; Nodes is the fallback. From ${restart}.`}>
          <Choice value={voices} options={["worklet", "nodes"] as const} label={(v) => (v === "worklet" ? "Worklet" : "Nodes")} onPick={(v) => { engine.setVoiceEngine(v); setVoices(v); }} />
        </Row>

        <h3>Launchkey</h3>
        <Row label="Device" hint={connected ? undefined : "No Launchkey connected."}>
          <select value={device} onChange={(e) => { launchkey.setDevice(e.target.value); setDevice(e.target.value); }}>
            <option value="">First one found</option>
            {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            {device && !devices.includes(device) && <option value={device}>{device} (not connected)</option>}
          </select>
        </Row>
        <Row label="Bend range" hint="How far the Pitch strip bends the Keys notes at either end.">
          <Choice value={bendRange} options={BEND_RANGES} label={(n) => `±${n} st`} onPick={(n) => { bendRangePref.set(n); setBendRange(n); }} />
        </Row>
        <Row label="Shift popup" hint="What covers the Launchkey's own popup while Shift is held: Morsel's shift map, two lines of text, nothing (the popup is closed), or the device's popup.">
          <Choice value={shiftCover} options={SHIFT_COVERS} label={(m) => SHIFT_COVER_LABEL[m]} onPick={(m) => { launchkey.setShiftCover(m); setShiftCover(m); }} />
        </Row>

        <h3>Developer</h3>
        <Row label="Lab" hint="Raw MIDI, LED and screen tests, timing and the engine comparison.">
          <button onClick={onLab}>Open Lab…</button>
        </Row>

        <div className="confirm-buttons">
          <button className="primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
