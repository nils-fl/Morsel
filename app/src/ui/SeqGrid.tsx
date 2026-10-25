import { useEffect, useState } from "react";
import { sequencer } from "../seq/sequencer";
import { BAR_TICKS, GRID_OPTIONS, MAX_BARS, PPQN, QUANTIZE_OPTIONS, gridLabel, humanizeEvents, maxNudge, quantizeEvents } from "../seq/timing";
import { clearTrack, clipOf, clipStep, copyClip, copyPattern, doubleClip, patternHasNotes, selectedTrack, set, setClipGrid, setTrackBars, togglePadFlag, toggleStep, toggleTrackFlag, trackBars, updateClip, updatePattern, useApp } from "../state/store";
import { PAD_COUNT } from "../state/types";
import { noteName } from "./notes";
import { Section } from "./controls";
import { inkOn, mute, paletteCss } from "./palette";

/** The step (of `span` ticks) a track's own loop is on (it loops at its own length). */
function usePlayheadStep(trackId: string, span: number) {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const pos = sequencer.trackTickAt(trackId);
      setStep(pos && pos.tick >= 0 ? Math.floor(pos.tick / span) : -1);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [trackId, span]);
  return step;
}

/** How many bars the grid shows at once: 4, or 2 when a bar has more than 16 steps. */
const viewBars = (span: number) => (BAR_TICKS / span > 16 ? 2 : 4);

export function SeqGrid() {
  const patIndex = useApp((s) => s.currentPattern);
  const pat = useApp((s) => s.project.patterns[s.currentPattern]);
  const patterns = useApp((s) => s.project.patterns);
  const track = useApp(selectedTrack);
  const selectedPad = useApp((s) => s.selectedPad);
  const span = clipStep(pat, track.id);
  const playStep = usePlayheadStep(track.id, span);
  const bars = trackBars(pat, track.id);
  const clip = clipOf(pat, track.id);
  // A long loop is shown a few bars at a time; while playing the view follows the playhead into the next window.
  const windowSteps = (viewBars(span) * BAR_TICKS) / span;
  const windows = Math.ceil(bars / viewBars(span));
  const [view, setView] = useState(0);
  const [followed, setFollowed] = useState(-1);
  const playWindow = playStep < 0 ? -1 : Math.floor(playStep / windowSteps);
  if (playWindow !== followed) {
    setFollowed(playWindow);
    if (playWindow >= 0) setView(playWindow);
  }
  const shown = Math.min(view, windows - 1);
  const first = shown * windowSteps;
  const cells = Math.min(windowSteps, (bars * BAR_TICKS) / span - first);
  const stepsShown = Array.from({ length: cells }, (_, i) => first + i);
  const mark = (s: number) => `${(s * span) % PPQN === 0 ? "beat" : ""} ${(s * span) % BAR_TICKS === 0 ? "bar" : ""} ${s === playStep ? "now" : ""}`;
  const firstBar = shown * viewBars(span) + 1;
  const lastBar = Math.min(bars, firstBar + viewBars(span) - 1);
  const drum = track.kind === "drum";
  const keyNote = track.keys?.type === "synth" ? 48 : track.keys?.type === "sample" ? track.keys.sample.root : 60;
  // Quantize goes to the top bar's grid (the clip's step grid when that is Off).
  const grid = useApp((s) => s.quantize) || span;
  const gridName = QUANTIZE_OPTIONS.find((q) => q.ticks === grid)?.label ?? gridLabel(grid);
  const [strength, setStrength] = useState(1);
  const empty = !clip.events.length;

  // Drum track: one row per pad. Keys track: one row with every note.
  const rows = drum
    ? Array.from({ length: PAD_COUNT }, (_, i) => ({ key: i, name: track.pads[i].name, color: paletteCss(track.pads[i].color), note: i, events: clip.events.filter((e) => e.note === i) }))
    : [{ key: -1, name: track.name, color: mute("#a46bff", 0.12), note: keyNote, events: clip.events }];

  return (
    <div className="seq">
      <Section title={`Pattern ${patIndex + 1} · ${track.name}`}>
      {/* The clip's tools in labelled groups. Timing is last and only there once the clip has notes, so nothing moves when it appears. */}
      <div className="seq-toolbar">
        {/* Two lines, each ending on the grid's right edge: the clip (length, grid, view, edit), then copying and timing. */}
        <div className="tool-line">
          <div className="tool-group">
            <span className="tool-label">Length</span>
            <select value={bars} title={`${track.name}'s loop length; each track loops on its own, the pattern runs as long as its longest (${pat.bars} bar${pat.bars > 1 ? "s" : ""}). Launchkey: Step mode, encoder 1`} onChange={(e) => setTrackBars(patIndex, track.id, Number(e.target.value))}>
              {Array.from({ length: MAX_BARS }, (_, i) => i + 1).map((b) => <option key={b} value={b}>{b} bar{b > 1 ? "s" : ""}</option>)}
            </select>
          </div>
          <div className="tool-group">
            <span className="tool-label">Grid</span>
            <select value={span} aria-label="Step grid" title={`The steps ${track.name}'s clip is edited on: 16ths, 32nds for rolls, or triplets. Notes stay where they are when it changes. Launchkey: Step mode, encoder 5`} onChange={(e) => setClipGrid(patIndex, track.id, Number(e.target.value))}>
              {GRID_OPTIONS.map((g) => <option key={g.ticks} value={g.ticks}>{g.label}</option>)}
            </select>
          </div>
          {windows > 1 && (
            <div className="tool-group">
              <span className="tool-label">View</span>
              <button disabled={shown === 0} onClick={() => setView(shown - 1)} aria-label="Earlier bars">‹</button>
              <span className="seq-view">Bars {firstBar}–{lastBar}</span>
              <button disabled={shown >= windows - 1} onClick={() => setView(shown + 1)} aria-label="Later bars">›</button>
            </div>
          )}
          <div className="tool-group end">
            <span className="tool-label">Edit</span>
            <button disabled={bars * 2 > MAX_BARS} onClick={() => doubleClip(patIndex, track.id)} title={`Repeat ${track.name}'s notes after its end, doubling its length (up to ${MAX_BARS} bars)`}>Double</button>
            <button onClick={() => clearTrack(patIndex, track.id)} title={`Clear ${track.name}'s clip in this pattern`}>Clear clip</button>
            <button onClick={() => updatePattern(patIndex, (p) => ({ ...p, clips: {} }))} title="Clear every track in this pattern">Clear pattern</button>
          </div>
        </div>
        <div className="tool-line">
          <div className="tool-group">
            <span className="tool-label">Copy</span>
            <select value="" title={`Copy only ${track.name}'s clip into another pattern`} onChange={(e) => {
              const to = Number(e.target.value);
              copyClip(patIndex, to, track.id);
              set({ status: `Copied ${track.name} clip ${patIndex + 1} → ${to + 1}` });
            }}>
              <option value="" disabled>Clip to…</option>
              {patterns.map((p, i) => i !== patIndex && <option key={i} value={i}>Pattern {i + 1}{clipOf(p, track.id).events.length ? " (overwrite)" : ""}</option>)}
            </select>
            <select value="" title="Copy this pattern over another one (Undo reverts it)" onChange={(e) => {
              const to = Number(e.target.value);
              copyPattern(patIndex, to);
              set({ status: `Copied pattern ${patIndex + 1} → ${to + 1}` });
            }}>
              <option value="" disabled>Pattern to…</option>
              {patterns.map((p, i) => i !== patIndex && <option key={i} value={i}>Pattern {i + 1}{patternHasNotes(p) ? " (overwrite)" : ""}</option>)}
            </select>
          </div>
          {!empty && (
            <div className="tool-group end">
              <span className="tool-label">Timing</span>
              <button onClick={() => updateClip(patIndex, track.id, (evs) => quantizeEvents(evs, grid, strength, bars * BAR_TICKS))} title={`Move ${track.name}'s notes towards the ${gridName} grid (the Quantize setting above)`}>Quantize</button>
              <select value={strength} onChange={(e) => setStrength(Number(e.target.value))} aria-label="Quantize strength" title="How far notes move towards the grid">
                {[1, 0.75, 0.5].map((v) => <option key={v} value={v}>{v * 100}%</option>)}
              </select>
              <button onClick={() => updateClip(patIndex, track.id, (evs) => humanizeEvents(evs, 1, Math.random, maxNudge(span)))} title={`Loosen ${track.name}'s notes a little: small changes to velocity and timing`}>Humanize</button>
            </div>
          )}
        </div>
      </div>
      <p className="hint tip">{drum ? "Click a cell to toggle a step." : "Click a cell to add a note; record on the keyboard for melodies."} Pick another track above to edit it.</p>
      <div className="seq-grid" style={{ "--steps": cells } as React.CSSProperties}>
        {/* Bar.beat over every beat; the step playing is lit. */}
        <div className="seq-row seq-ruler" aria-hidden>
          <span />
          <span />
          <span />
          <div className="seq-cells">
            {stepsShown.map((s) => (
              <span key={s} className={mark(s)}>
                {(s * span) % PPQN === 0 ? `${Math.floor((s * span) / BAR_TICKS) + 1}.${((s * span) % BAR_TICKS) / PPQN + 1}` : ""}
              </span>
            ))}
          </div>
        </div>
        {rows.map((row) => (
          <div key={row.key} className={`seq-row ${drum && selectedPad === row.note ? "selected" : ""}`} style={{ "--row": row.color, "--on-pad": inkOn(row.color) } as React.CSSProperties}>
            <button className="seq-name" onClick={() => drum && set({ selectedPad: row.note })}>{row.name}</button>
            {drum ? <>
              <button className={`ms ${track.padMutes[row.note] ? "on" : ""}`} onClick={() => togglePadFlag(track.id, row.note, "padMutes")}>M</button>
              <button className={`ms solo ${track.padSolos[row.note] ? "on" : ""}`} onClick={() => togglePadFlag(track.id, row.note, "padSolos")}>S</button>
            </> : <>
              <button className={`ms ${track.mute ? "on" : ""}`} onClick={() => toggleTrackFlag(track.id, "mute")}>M</button>
              <button className={`ms solo ${track.solo ? "on" : ""}`} onClick={() => toggleTrackFlag(track.id, "solo")}>S</button>
            </>}
            <div className="seq-cells">
              {stepsShown.map((s) => {
                const inStep = row.events.filter((e) => e.tick >= s * span && e.tick < (s + 1) * span);
                const vel = inStep.length ? Math.max(...inStep.map((e) => e.vel)) : 0;
                const nudge = inStep[0]?.nudge ?? 0;
                return (
                  <button
                    key={s}
                    className={`cell ${mark(s)} ${vel ? "lit" : ""} ${nudge ? "nudged" : ""}`}
                    // Softer notes are paler; mixed into the colour rather than faded, so the playhead ring stays solid.
                    style={vel ? { background: `color-mix(in srgb, ${row.color} ${Math.round(35 + (vel / 127) * 65)}%, transparent)`, "--nudge": nudge / maxNudge(span) } as React.CSSProperties : undefined}
                    title={inStep.length && !drum ? inStep.map((e) => noteName(e.note)).join(" ") : undefined}
                    onClick={() => toggleStep(patIndex, track.id, s * span, span, row.note)}
                  >
                    {!drum && inStep.length ? noteName(inStep[0].note) : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      </Section>
    </div>
  );
}
