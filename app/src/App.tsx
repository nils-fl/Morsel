import { useEffect, useState } from "react";
import { togglePlay, toggleRecord } from "./actions";
import { currentFrame, setHwMode } from "./modes/controller";
import { ScreenPreview } from "./ui/ScreenPreview";
import { toggleTheme } from "./ui/theme";
import { sequencer } from "./seq/sequencer";
import { QUANTIZE_OPTIONS } from "./seq/timing";
import { patternHasNotes, selectedTrack, set, undo, updateProject, useApp } from "./state/store";
import { TABS, type HwMode, type Tab } from "./state/types";
import { ChopEditor } from "./ui/ChopEditor";
import { EncoderStrip } from "./ui/EncoderStrip";
import { Guide, GuideOverlay } from "./ui/Guide";
import { KeysPanel } from "./ui/KeysPanel";
import { Mixer } from "./ui/Mixer";
import { Lab } from "./ui/Lab";
import { PadEditor } from "./ui/PadEditor";
import { PadGrid } from "./ui/PadGrid";
import { SeqGrid } from "./ui/SeqGrid";
import { SongPanel } from "./ui/SongPanel";
import { TrackStrip } from "./ui/TrackStrip";

// Each page has its own colour, like the page LEDs on an Elektron box.
const TAB_COLOR: Record<Tab, string> = {
  Track: "var(--amber)", Chop: "var(--orange)", Sequencer: "var(--cyan)", Mixer: "var(--yellow)", Song: "var(--lime)", Help: "var(--white)", Lab: "var(--magenta)",
};
const KEYS_COLOR = "var(--violet)";

export default function App() {
  const track = useApp(selectedTrack);
  // Chop makes drum racks: its tab is there on a drum track, or while a chop is open.
  const chopOpen = useApp((s) => s.chop !== null);
  const showChop = track.kind === "drum" || chopOpen;
  const chosen = useApp((s) => s.tab);
  const tab = chosen === "Chop" && !showChop ? "Track" : chosen;
  const color = (t: Tab) => (t === "Track" && track.kind === "keys" ? KEYS_COLOR : TAB_COLOR[t]);
  const setTab = (t: Tab) => set({ tab: t });
  const [guide, setGuide] = useState(false);
  useEffect(() => { document.documentElement.style.setProperty("--page", color(tab)); });
  useEffect(() => {
    // "?" opens the guide, unless you're typing in a field.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) setGuide(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="app">
      <AudioBanner />
      <TopBar onGuide={() => setGuide(true)} />
      {guide && <GuideOverlay onClose={() => setGuide(false)} />}
      <PadGrid />
      <nav className="tabs">
        {TABS.filter((t) => t !== "Chop" || showChop).map((t) => (
          <button key={t} className={t === tab ? "on" : ""} style={{ "--tab": color(t) } as React.CSSProperties} onClick={() => setTab(t)}>
            {t === "Track" ? `${track.kind === "drum" ? "▦" : "♪"} ${track.name}` : t}
          </button>
        ))}
      </nav>
      <main>
        {tab === "Track" && (track.kind === "drum" ? <PadEditor /> : <KeysPanel />)}
        {tab === "Chop" && <ChopEditor />}
        {tab === "Sequencer" && <SeqGrid />}
        {tab === "Mixer" && <Mixer />}
        {tab === "Song" && <SongPanel />}
        {tab === "Help" && <Guide />}
        {tab === "Lab" && <Lab />}
      </main>
    </div>
  );
}

/** The browser only starts audio after a click or key press on the page; the window listeners in the engine resume it. */
function AudioBanner() {
  const ready = useApp((s) => s.audioReady);
  if (ready) return null;
  return <button className="audio-banner">Audio is paused by the browser. Click anywhere to start it.</button>;
}

/** Short windows (e.g. a 14" laptop) get the compact layout; keep in sync with the media query in index.css. */
const COMPACT_QUERY = "(max-height: 950px)";

function useCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const on = () => setCompact(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return compact;
}

function TopBar({ onGuide }: { onGuide: () => void }) {
  const s = useApp((s) => s);
  const compact = useCompact();
  const p = s.project;
  return (
    <header className="topbar">
      <div className="brand">
        <strong>LaunchKit</strong>
        <span className={`dot ${s.connected ? "ok" : ""}`} title={s.connected ? "Launchkey connected" : "Launchkey not found"} />
        <button className="guide-btn" onClick={onGuide} title="Controls, modes and shortcuts (?)">? Guide</button>
        <button className="theme-btn" onClick={toggleTheme} title={s.theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"} aria-label="Toggle light / dark theme">
          {s.theme === "light" ? "☾" : "☀"}
        </button>
      </div>
      <div className="screen-slot"><ScreenPreview source={currentFrame} scale={compact ? 2 : 3} /></div>
      <div className="transport">
        <button className={s.playing ? "on" : ""} onClick={togglePlay}>{s.playing ? "■ Stop" : "▶ Play"}</button>
        <button className={`rec ${s.recording ? "on" : ""}`} onClick={toggleRecord}>{s.countIn ? "Count-in…" : "● Rec"}</button>
        <button className={s.metronome ? "on" : ""} onClick={() => set({ metronome: !s.metronome })}>Click</button>
        <label className="field inline">
          <span>BPM</span>
          <input type="number" min={40} max={240} step={0.1} value={p.bpm} onChange={(e) => updateProject((pr) => ({ ...pr, bpm: Math.max(40, Math.min(240, Number(e.target.value))) }), false)} />
        </label>
        <label className="field inline">
          <span>Swing</span>
          <input type="number" min={50} max={75} value={p.swing} onChange={(e) => updateProject((pr) => ({ ...pr, swing: Math.max(50, Math.min(75, Number(e.target.value))) }), false)} />
        </label>
        <label className="field inline">
          <span>Quantize</span>
          <select value={s.quantize} onChange={(e) => set({ quantize: Number(e.target.value) })}>
            {QUANTIZE_OPTIONS.map((q) => <option key={q.label} value={q.ticks}>{q.label}</option>)}
          </select>
        </label>
        <button onClick={undo} disabled={!s.undo.length}>Undo</button>
      </div>
      <div className="patterns">
        {p.patterns.map((pat, i) => (
          <button
            key={i}
            className={`pat ${i === s.currentPattern ? "on" : ""} ${i === s.queuedPattern ? "queued" : ""} ${patternHasNotes(pat) ? "used" : ""}`}
            onClick={() => sequencer.selectPattern(i)}
          >{i + 1}</button>
        ))}
      </div>
      <TrackStrip />
      <div className="hw">
        {(["play", "step", "track", "mixer", "pattern", "browse"] as HwMode[]).map((m) => (
          <button key={m} className={s.hwMode === m ? "on" : ""} onClick={() => setHwMode(m)}>{m}</button>
        ))}
        <EncoderStrip />
      </div>
      <div className="status"><b>MSG</b><span>{s.status || "—"}</span></div>
    </header>
  );
}
