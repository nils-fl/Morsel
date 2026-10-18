import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { ConfirmDialog } from "./ui/ConfirmDialog";
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
      <ConfirmDialog />
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

/** A number field that applies its value when you leave it (or press Enter), so typing "12" doesn't clamp "1" first. */
function NumberField({ value, min, max, step, onCommit }: { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)));
    setDraft(null);
  };
  return (
    <input
      type="number" min={min} max={max} step={step} value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function TopBar({ onGuide }: { onGuide: () => void }) {
  // Only what the bar shows: the whole store would redraw it on every recorded note and knob move.
  const s = useApp(useShallow((s) => ({
    connected: s.connected, theme: s.theme, playing: s.playing, recording: s.recording, countIn: s.countIn, metronome: s.metronome,
    quantize: s.quantize, undoLength: s.undo.length, currentPattern: s.currentPattern, queuedPattern: s.queuedPattern,
    bpm: s.project.bpm, swing: s.project.swing, patterns: s.project.patterns, hwMode: s.hwMode, status: s.status,
  })));
  const compact = useCompact();
  const p = { bpm: s.bpm, swing: s.swing, patterns: s.patterns };
  return (
    <header className="topbar">
      <div className="brand">
        <strong>Morsel</strong>
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
          <NumberField min={40} max={240} step={0.1} value={p.bpm} onCommit={(bpm) => updateProject((pr) => ({ ...pr, bpm: Math.round(bpm * 10) / 10 }), false)} />
        </label>
        <label className="field inline">
          <span>Swing</span>
          <NumberField min={50} max={75} value={p.swing} onCommit={(swing) => updateProject((pr) => ({ ...pr, swing: Math.round(swing) }), false)} />
        </label>
        <label className="field inline">
          <span>Quantize</span>
          <select value={s.quantize} onChange={(e) => set({ quantize: Number(e.target.value) })}>
            {QUANTIZE_OPTIONS.map((q) => <option key={q.label} value={q.ticks}>{q.label}</option>)}
          </select>
        </label>
        <button onClick={undo} disabled={!s.undoLength}>Undo</button>
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
