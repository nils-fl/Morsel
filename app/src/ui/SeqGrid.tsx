import { useEffect, useState } from "react";
import { sequencer } from "../seq/sequencer";
import { MAX_NUDGE, STEP_TICKS } from "../seq/timing";
import { clearTrack, clipOf, copyClip, copyPattern, doubleClip, patternHasNotes, selectedTrack, set, setTrackBars, togglePadFlag, toggleStep, toggleTrackFlag, trackBars, updatePattern, useApp } from "../state/store";
import { PAD_COUNT } from "../state/types";
import { noteName } from "./notes";
import { Section } from "./controls";
import { mute, paletteCss } from "./palette";

/** The step a track's own loop is on (it loops at its own length). */
function usePlayheadStep(trackId: string) {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const pos = sequencer.trackTickAt(trackId);
      setStep(pos && pos.tick >= 0 ? Math.floor(pos.tick / STEP_TICKS) : -1);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [trackId]);
  return step;
}

export function SeqGrid() {
  const patIndex = useApp((s) => s.currentPattern);
  const pat = useApp((s) => s.project.patterns[s.currentPattern]);
  const patterns = useApp((s) => s.project.patterns);
  const track = useApp(selectedTrack);
  const selectedPad = useApp((s) => s.selectedPad);
  const playStep = usePlayheadStep(track.id);
  const bars = trackBars(pat, track.id);
  const steps = bars * 16;
  const clip = clipOf(pat, track.id);
  const drum = track.kind === "drum";
  const keyNote = track.keys?.type === "synth" ? 48 : track.keys?.type === "sample" ? track.keys.sample.root : 60;

  // Drum track: one row per pad. Keys track: one row with every note.
  const rows = drum
    ? Array.from({ length: PAD_COUNT }, (_, i) => ({ key: i, name: track.pads[i].name, color: paletteCss(track.pads[i].color), note: i, events: clip.events.filter((e) => e.note === i) }))
    : [{ key: -1, name: track.name, color: mute("#a46bff"), note: keyNote, events: clip.events }];

  return (
    <div className="seq">
      <Section title={`Pattern ${patIndex + 1} · ${track.name}`} actions={<>
          <select value={bars} title={`${track.name}'s loop length; each track loops on its own, the pattern runs as long as its longest (${pat.bars} bar${pat.bars > 1 ? "s" : ""}). Launchkey: Step mode, encoder 1`} onChange={(e) => setTrackBars(patIndex, track.id, Number(e.target.value))}>
            {[1, 2, 3, 4].map((b) => <option key={b} value={b}>{b} bar{b > 1 ? "s" : ""}</option>)}
          </select>
        <button onClick={() => updatePattern(patIndex, (p) => ({ ...p, clips: {} }))} title="Clear every track in this pattern">Clear pattern</button>
        <button onClick={() => clearTrack(patIndex, track.id)} title={`Clear ${track.name}'s clip in this pattern`}>Clear clip</button>
        <button disabled={bars > 2} onClick={() => doubleClip(patIndex, track.id)} title={`Repeat ${track.name}'s notes after its end, doubling its length (up to 4 bars)`}>Double</button>
        <select value="" title="Copy this pattern over another one (Undo reverts it)" onChange={(e) => {
          const to = Number(e.target.value);
          copyPattern(patIndex, to);
          set({ status: `Copied pattern ${patIndex + 1} → ${to + 1}` });
        }}>
          <option value="" disabled>Copy to…</option>
          {patterns.map((p, i) => i !== patIndex && <option key={i} value={i}>Pattern {i + 1}{patternHasNotes(p) ? " (overwrite)" : ""}</option>)}
        </select>
        <select value="" title={`Copy only ${track.name}'s clip into another pattern`} onChange={(e) => {
          const to = Number(e.target.value);
          copyClip(patIndex, to, track.id);
          set({ status: `Copied ${track.name} clip ${patIndex + 1} → ${to + 1}` });
        }}>
          <option value="" disabled>Copy clip to…</option>
          {patterns.map((p, i) => i !== patIndex && <option key={i} value={i}>Pattern {i + 1}{clipOf(p, track.id).events.length ? " (overwrite)" : ""}</option>)}
        </select>
      </>}>
      <p className="hint tip">{drum ? "Click a cell to toggle a step." : "Click a cell to add a note; record on the keyboard for melodies."} Pick another track above to edit it.</p>
      <div className="seq-grid" style={{ "--steps": steps } as React.CSSProperties}>
        {/* Bar.beat over every beat; the step playing is lit. */}
        <div className="seq-row seq-ruler" aria-hidden>
          <span />
          <span />
          <span />
          <div className="seq-cells">
            {Array.from({ length: steps }, (_, s) => (
              <span key={s} className={`${s % 4 === 0 ? "beat" : ""} ${s % 16 === 0 ? "bar" : ""} ${s === playStep ? "now" : ""}`}>
                {s % 4 === 0 ? `${Math.floor(s / 16) + 1}.${(s % 16) / 4 + 1}` : ""}
              </span>
            ))}
          </div>
        </div>
        {rows.map((row) => (
          <div key={row.key} className={`seq-row ${drum && selectedPad === row.note ? "selected" : ""}`} style={{ "--row": row.color } as React.CSSProperties}>
            <button className="seq-name" onClick={() => drum && set({ selectedPad: row.note })}>{row.name}</button>
            {drum ? <>
              <button className={`ms ${track.padMutes[row.note] ? "on" : ""}`} onClick={() => togglePadFlag(track.id, row.note, "padMutes")}>M</button>
              <button className={`ms solo ${track.padSolos[row.note] ? "on" : ""}`} onClick={() => togglePadFlag(track.id, row.note, "padSolos")}>S</button>
            </> : <>
              <button className={`ms ${track.mute ? "on" : ""}`} onClick={() => toggleTrackFlag(track.id, "mute")}>M</button>
              <button className={`ms solo ${track.solo ? "on" : ""}`} onClick={() => toggleTrackFlag(track.id, "solo")}>S</button>
            </>}
            <div className="seq-cells">
              {Array.from({ length: steps }, (_, s) => {
                const inStep = row.events.filter((e) => e.tick >= s * STEP_TICKS && e.tick < (s + 1) * STEP_TICKS);
                const vel = inStep.length ? Math.max(...inStep.map((e) => e.vel)) : 0;
                const nudge = inStep[0]?.nudge ?? 0;
                return (
                  <button
                    key={s}
                    className={`cell ${s % 4 === 0 ? "beat" : ""} ${s % 16 === 0 ? "bar" : ""} ${s === playStep ? "now" : ""} ${vel ? "lit" : ""} ${nudge ? "nudged" : ""}`}
                    // Softer notes are paler; mixed into the colour rather than faded, so the playhead ring stays solid.
                    style={vel ? { background: `color-mix(in srgb, ${row.color} ${Math.round(35 + (vel / 127) * 65)}%, transparent)`, "--nudge": nudge / MAX_NUDGE } as React.CSSProperties : undefined}
                    title={inStep.length && !drum ? inStep.map((e) => noteName(e.note)).join(" ") : undefined}
                    onClick={() => toggleStep(patIndex, track.id, s * STEP_TICKS, STEP_TICKS, row.note)}
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
