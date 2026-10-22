import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { togglePlay, toggleRecord } from "./actions";
import { currentFrame, setHwMode } from "./modes/controller";
import { ScreenPreview } from "./ui/ScreenPreview";
import { toggleTheme } from "./ui/theme";
import { toggleTips } from "./ui/tips";
import { sequencer } from "./seq/sequencer";
import { QUANTIZE_OPTIONS } from "./seq/timing";
import { get, patternHasNotes, redo, selectedTrack, set, undo, updateProject, useApp } from "./state/store";
import { PATTERN_COUNT, TABS, type HwMode, type Tab } from "./state/types";
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
    // Computer-keyboard shortcuts, unless you're typing in a field. The Chop tab has its own Space.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || (key === "y" && e.ctrlKey))) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "?") setGuide(true);
      else if (e.key === " " && tab !== "Chop") {
        // Don't let Space also click the button that was pressed last.
        e.preventDefault();
        if (t instanceof HTMLButtonElement) t.blur();
        togglePlay();
      } else if (key === "r" && !e.repeat) toggleRecord();
      else if (e.key === "[" || e.key === "]") {
        // As the Launchkey's pad arrows: while playing, step on from the pattern already queued.
        const s = get();
        sequencer.selectPattern(Math.max(0, Math.min(PATTERN_COUNT - 1, (s.queuedPattern ?? s.currentPattern) + (e.key === "[" ? -1 : 1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);
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

/** Narrow windows (an iPad held upright) get the smaller screen preview, so it fits beside the transport. */
const COMPACT_QUERY = "(max-width: 900px)";

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
    connected: s.connected, theme: s.theme, tips: s.tips, playing: s.playing, recording: s.recording, countIn: s.countIn, metronome: s.metronome,
    quantize: s.quantize, undoLength: s.undo.length, redoLength: s.redo.length, currentPattern: s.currentPattern, queuedPattern: s.queuedPattern,
    bpm: s.project.bpm, swing: s.project.swing, patterns: s.project.patterns, hwMode: s.hwMode, status: s.status,
  })));
  const compact = useCompact();
  const p = { bpm: s.bpm, swing: s.swing, patterns: s.patterns };
  // One labelled row per job: transport, patterns, tracks, then the Launchkey's own mode and encoders.
  return (
    <header className="topbar">
      <div className="bar-main">
        <div className="bar-row">
          <div className="brand">
            <strong>Morsel</strong>
            <span className={`dot ${s.connected ? "ok" : ""}`} title={s.connected ? "Launchkey connected" : "Launchkey not found"} />
          </div>
          <div className="transport">
            <button className={s.playing ? "on" : ""} onClick={togglePlay} title="Play / stop (Space)">{s.playing ? "■ Stop" : "▶ Play"}</button>
            <button className={`rec ${s.recording ? "on" : ""}`} onClick={toggleRecord} title="Record (R)">{s.countIn ? "Count-in…" : "● Rec"}</button>
            <button className={s.metronome ? "on" : ""} onClick={() => set({ metronome: !s.metronome })}>Click</button>
            <span className="bar-sep" />
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
            <span className="bar-sep" />
            <button className="icon-btn" onClick={undo} disabled={!s.undoLength} title="Undo (⌘Z)" aria-label="Undo">↶</button>
            <button className="icon-btn" onClick={redo} disabled={!s.redoLength} title="Redo (⇧⌘Z)" aria-label="Redo">↷</button>
          </div>
          <div className="utils">
            <button className={s.tips ? "on" : ""} onClick={toggleTips} title={s.tips ? "Hide the explanations in the panels" : "Show explanations in the panels"}>Tips</button>
            <button onClick={onGuide} title="Controls, modes and shortcuts (?)">Guide</button>
            <button className="theme-btn" onClick={toggleTheme} title={s.theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"} aria-label="Toggle light / dark theme">
              {s.theme === "light" ? "☾" : "☀"}
            </button>
          </div>
        </div>
        <div className="bar-row">
          <span className="bar-label">Pattern</span>
          <div className="patterns">
            {p.patterns.map((pat, i) => (
              <button
                key={i}
                className={`pat ${i === s.currentPattern ? "on" : ""} ${i === s.queuedPattern ? "queued" : ""} ${patternHasNotes(pat) ? "used" : ""}`}
                onClick={() => sequencer.selectPattern(i)}
              >{i + 1}</button>
            ))}
          </div>
        </div>
        <div className="bar-row">
          <span className="bar-label">Track</span>
          <TrackStrip />
        </div>
      </div>
      <div className="screen-slot"><ScreenPreview source={currentFrame} scale={compact ? 2 : 3} /></div>
      <div className="bar-row hw">
        <span className="bar-label" title="What the Launchkey's pads and encoders do right now">Launchkey</span>
        <div className="hw-modes">
          {(["play", "step", "track", "mute", "pattern", "browse"] as HwMode[]).map((m) => (
            <button key={m} className={s.hwMode === m ? "on" : ""} onClick={() => setHwMode(m)}>{m}</button>
          ))}
        </div>
        <EncoderStrip />
      </div>
      <div className="status" role="status">{s.status}</div>
    </header>
  );
}
