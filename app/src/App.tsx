import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { shareTab, togglePlay, toggleRecord, unshareTab } from "./actions";
import { TAB_WORDS } from "./audio/recorder";
import { currentFrame, setHwMode } from "./modes/controller";
import { ScreenPreview } from "./ui/ScreenPreview";
import { toggleTheme } from "./ui/theme";
import { accentFor, paletteCss } from "./ui/palette";
import { toggleTips } from "./ui/tips";
import { toggleLibrary } from "./ui/drawer";
import { sequencer } from "./seq/sequencer";
import { QUANTIZE_OPTIONS } from "./seq/timing";
import { get, patternHasNotes, redo, selectedTrack, set, undo, updateProject, useApp } from "./state/store";
import { PATTERN_COUNT, TABS, type HwMode, type Tab } from "./state/types";
import { ChopEditor } from "./ui/ChopEditor";
import { EncoderStrip } from "./ui/EncoderStrip";
import { GuideOverlay } from "./ui/Guide";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Preferences } from "./ui/Preferences";
import { native } from "./platform/native";
import { newProject } from "./state/projectFile";
import { KeysPanel } from "./ui/KeysPanel";
import { Mixer } from "./ui/Mixer";
import { LabOverlay } from "./ui/Lab";
import { Library } from "./ui/Library";
import { ProjectMenu } from "./ui/ProjectMenu";
import { PadEditor } from "./ui/PadEditor";
import { PadGrid } from "./ui/PadGrid";
import { SeqGrid } from "./ui/SeqGrid";
import { SongPanel } from "./ui/SongPanel";
import { TrackStrip } from "./ui/TrackStrip";

// Each page has its own colour, like the page LEDs on an Elektron box.
const TAB_COLOR: Record<Tab, string> = {
  Track: "var(--magenta)", Chop: "var(--orange)", Sequencer: "var(--cyan)", Mixer: "var(--blue)", Song: "var(--lime)",
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
  const [prefs, setPrefs] = useState(false);
  const [lab, setLab] = useState(false);
  // The tabs keep their own colours; everything they open (and the Launchkey row) takes the selected track's colour.
  const theme = useApp((s) => s.theme);
  const accent = accentFor(paletteCss(track.color), theme);
  useEffect(() => { document.documentElement.style.setProperty("--page", accent); }, [accent]);
  // Switching tabs keeps the page where it is: the tab area holds the height that fills the window at the current
  // scroll, so a short tab (an empty Chop) doesn't shorten the page under you. Scrolling back up lets it go, so a
  // short tab ends where its content does rather than a screen further down.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const hold = () => {
      const main = mainRef.current;
      if (!main) return;
      const r = main.getBoundingClientRect();
      const below = document.documentElement.scrollHeight - (r.bottom + window.scrollY);
      const need = window.scrollY > 0 ? Math.floor(window.innerHeight - r.top - below) : 0;
      main.style.minHeight = `${Math.max(0, need)}px`;
    };
    hold();
    window.addEventListener("scroll", hold, { passive: true });
    window.addEventListener("resize", hold);
    return () => {
      window.removeEventListener("scroll", hold);
      window.removeEventListener("resize", hold);
    };
  }, []);
  const closePrefs = useCallback(() => setPrefs(false), []);
  const openLab = useCallback(() => { setPrefs(false); setLab(true); }, []);
  const closeLab = useCallback(() => setLab(false), []);
  useEffect(() => {
    // Computer-keyboard shortcuts, unless you're typing in a field. The Chop tab has its own Space.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // In the desktop app the Edit menu has undo and redo.
      if (mod && !native && (key === "z" || (key === "y" && e.ctrlKey))) {
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
      else if (key === "b" && !e.repeat) toggleLibrary();
      else if (e.key === "[" || e.key === "]") {
        // As the Launchkey's pad arrows: while playing, step on from the pattern already queued.
        const s = get();
        sequencer.selectPattern(Math.max(0, Math.min(PATTERN_COUNT - 1, (s.queuedPattern ?? s.currentPattern) + (e.key === "[" ? -1 : 1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);
  // The desktop app's menu.
  useEffect(() => native?.onMenu((cmd) => {
    if (cmd === "preferences") setPrefs(true);
    else if (cmd === "guide") setGuide(true);
    else if (cmd === "newProject") void newProject();
    else if (cmd === "toggleTheme") toggleTheme();
    else if (cmd === "toggleTips") toggleTips();
    else if (cmd === "toggleLibrary") toggleLibrary();
    else {
      // In a text field undo and redo edit the text, as anywhere else on a Mac.
      const t = document.activeElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) document.execCommand(cmd);
      else if (cmd === "undo") undo();
      else redo();
    }
  }), []);
  return (
    <div className="app">
      <AudioBanner />
      <TopBar onGuide={() => setGuide(true)} onPrefs={() => setPrefs(true)} />
      {guide && <GuideOverlay onClose={() => setGuide(false)} />}
      {prefs && <Preferences onClose={closePrefs} onLab={openLab} />}
      {lab && <LabOverlay onClose={closeLab} />}
      <ConfirmDialog />
      <Library />
      <PadGrid />
      <nav className="tabs">
        {TABS.filter((t) => t !== "Chop" || showChop).map((t) => (
          <button key={t} className={t === tab ? "on" : ""} style={{ "--tab": color(t) } as React.CSSProperties} onClick={() => setTab(t)}>
            {t === "Track" ? `${track.kind === "drum" ? "▦" : "♪"} ${track.name}` : t}
          </button>
        ))}
      </nav>
      <main ref={mainRef}>
        {tab === "Track" && (track.kind === "drum" ? <PadEditor /> : <KeysPanel />)}
        {tab === "Chop" && <ChopEditor />}
        {tab === "Sequencer" && <SeqGrid />}
        {tab === "Mixer" && <Mixer />}
        {tab === "Song" && <SongPanel />}
      </main>
    </div>
  );
}

/** The browser only starts audio after a click or key press on the page; the window listeners in the engine resume it.
 *  The same click asks for the connected folders the browser forgot (browse/disk.ts). */
function AudioBanner() {
  const ready = useApp((s) => s.audioReady);
  const folders = useApp((s) => s.folders.filter((f) => f.access === "prompt").length);
  if (ready) return null;
  return (
    <button className="audio-banner">
      {folders
        ? `Audio is paused and ${folders === 1 ? "a sample folder needs" : `${folders} sample folders need`} the browser's permission again. Click anywhere to start both.`
        : "Audio is paused by the browser. Click anywhere to start it."}
    </button>
  );
}

/** Wide windows draw the screen preview at 3x (192 px tall: the Pattern, Track and Launchkey rows plus the encoders);
 *  narrower ones at 2x beside the rows. Keep in sync with the 1180px media query in index.css. */
const WIDE_QUERY = "(min-width: 1181px)";

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
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

/** Sharing a tab (or the Mac's sound) needs a click on the page; after that the Launchkey samples from it. */
function ShareButton() {
  const shared = useApp((s) => s.tabShared);
  const busy = useApp((s) => s.sampling !== "idle");
  return (
    <button
      className={`share ${shared ? "on" : "primary"}`} disabled={busy} onClick={() => (shared ? unshareTab() : void shareTab())}
      title={shared ? `${TAB_WORDS.shared}: Shift + Record on the Launchkey samples from it. Click to stop.` : TAB_WORDS.hint}
    >{shared ? `● ${TAB_WORDS.button}` : TAB_WORDS.button}</button>
  );
}

function TopBar({ onGuide, onPrefs }: { onGuide: () => void; onPrefs: () => void }) {
  // Only what the bar shows: the whole store would redraw it on every recorded note and knob move.
  const s = useApp(useShallow((s) => ({
    connected: s.connected, theme: s.theme, tips: s.tips, library: s.library, playing: s.playing, recording: s.recording, countIn: s.countIn, metronome: s.metronome,
    quantize: s.quantize, undoLength: s.undo.length, redoLength: s.redo.length, currentPattern: s.currentPattern, queuedPattern: s.queuedPattern,
    bpm: s.project.bpm, swing: s.project.swing, patterns: s.project.patterns, hwMode: s.hwMode, status: s.status,
  })));
  const wide = useWide();
  const p = { bpm: s.bpm, swing: s.swing, patterns: s.patterns };
  // A header strip (brand, transport, last message, app buttons) over the deck: labelled rows for patterns, tracks and
  // the Launchkey's mode and encoders, beside the screen preview.
  return (
    <>
      {/* The header line stays at the top while the page scrolls: play, record and the rest of the transport. */}
      <div className="bar-sticky">
        <div className="bar-head">
          <div className="brand">
            <strong>Morsel</strong>
            <span className={`dot ${s.connected ? "ok" : ""}`} title={s.connected ? "Launchkey connected" : "Launchkey not found"} />
          </div>
          <div className="transport">
            <button className={s.playing ? "on" : ""} onClick={togglePlay} title="Play / stop (Space)">{s.playing ? "■ Stop" : "▶ Play"}</button>
            <button className={`rec ${s.recording ? "on" : ""}`} onClick={toggleRecord} title="Record (R)">{s.countIn ? "Count-in…" : "● Rec"}</button>
            <button className={s.metronome ? "on" : ""} onClick={() => set({ metronome: !s.metronome })} title="Metronome">Click</button>
            <ShareButton />
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
              <span>Quant</span>
              <select value={s.quantize} onChange={(e) => set({ quantize: Number(e.target.value) })} title="Quantize recorded notes to">
                {QUANTIZE_OPTIONS.map((q) => <option key={q.label} value={q.ticks}>{q.label}</option>)}
              </select>
            </label>
            <span className="bar-sep" />
            <button className="icon-btn" onClick={undo} disabled={!s.undoLength} title="Undo (⌘Z)" aria-label="Undo">↶</button>
            <button className="icon-btn" onClick={redo} disabled={!s.redoLength} title="Redo (⇧⌘Z)" aria-label="Redo">↷</button>
          </div>
          <div className="status" role="status" title={s.status}>{s.status}</div>
          <div className="utils">
            <ProjectMenu />
            <button className={s.library ? "on" : ""} onClick={toggleLibrary} title={native ? "Connected folders and the sample library (B, ⌘L)" : "Connected folders and the sample library (B)"}>Library</button>
            <button className={s.tips ? "on" : ""} onClick={toggleTips} title={s.tips ? "Hide the explanations in the panels" : "Show explanations in the panels"}>Tips</button>
            <button onClick={onGuide} title="Controls, modes and shortcuts (?)">Guide</button>
            <button className="icon-btn" onClick={toggleTheme} title={s.theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"} aria-label="Toggle light / dark theme">
              {s.theme === "light" ? "☾" : "☀"}
            </button>
            <button className="icon-btn" onClick={onPrefs} title={native ? "Preferences (⌘,)" : "Preferences"} aria-label="Preferences">⚙</button>
          </div>
        </div>
      </div>
      <header className="topbar">
        <div className="bar-deck">
          <div className="bar-rows">
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
            <div className="bar-row hw">
              <span className="bar-label" title="What the Launchkey's pads and encoders do right now">Launchkey</span>
              <div className="hw-modes">
                {(["play", "step", "track", "mute", "pattern", "browse"] as HwMode[]).map((m) => (
                  <button key={m} className={s.hwMode === m ? "on" : ""} title={m === "step" ? "Step: the pads are 16 steps of the selected track (marked on the Sequencer tab, which opens)" : undefined} onClick={() => setHwMode(m)}>{m}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="bar-enc"><EncoderStrip /></div>
        </div>
        <div className="screen-slot"><ScreenPreview source={currentFrame} scale={wide ? 3 : 2} /></div>
      </header>
    </>
  );
}
