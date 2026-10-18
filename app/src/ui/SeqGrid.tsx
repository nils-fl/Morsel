import { useEffect, useState } from "react";
import { sequencer } from "../seq/sequencer";
import { STEP_TICKS } from "../seq/timing";
import { clearTrack, clipOf, copyClip, copyPattern, newId, patternHasNotes, selectedTrack, set, setPatternBars, togglePadFlag, toggleStep, toggleTrackFlag, trimClips, updatePattern, useApp } from "../state/store";
import { PAD_COUNT, type Pattern } from "../state/types";
import { noteName } from "./notes";
import { Section } from "./controls";
import { mute, paletteCss } from "./palette";

function usePlayheadStep() {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const pos = sequencer.tickAt();
      setStep(pos && pos.tick >= 0 ? Math.floor(pos.tick / STEP_TICKS) : -1);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
  return step;
}

/** Double a pattern: every clip's notes repeat after the current length (up to 4 bars). */
function doublePattern(p: Pattern): Pattern {
  if (p.bars >= 4) return p;
  const bars = Math.min(4, p.bars * 2);
  const shift = p.bars * 16 * STEP_TICKS;
  const clips = Object.fromEntries(Object.entries(p.clips).map(([id, c]) => [id, { events: [...c.events, ...c.events.map((e) => ({ ...e, id: newId(), tick: e.tick + shift }))] }]));
  return { bars, clips: trimClips({ bars, clips }, bars) };
}

export function SeqGrid() {
  const patIndex = useApp((s) => s.currentPattern);
  const pat = useApp((s) => s.project.patterns[s.currentPattern]);
  const patterns = useApp((s) => s.project.patterns);
  const track = useApp(selectedTrack);
  const selectedPad = useApp((s) => s.selectedPad);
  const playStep = usePlayheadStep();
  const steps = pat.bars * 16;
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
          <select value={pat.bars} title="Pattern length (every track). Launchkey: Step mode, encoder 1" onChange={(e) => setPatternBars(patIndex, Number(e.target.value))}>
            {[1, 2, 3, 4].map((b) => <option key={b} value={b}>{b} bar{b > 1 ? "s" : ""}</option>)}
          </select>
        <button onClick={() => updatePattern(patIndex, (p) => ({ ...p, clips: {} }))} title="Clear every track in this pattern">Clear pattern</button>
        <button onClick={() => clearTrack(patIndex, track.id)} title={`Clear ${track.name}'s clip in this pattern`}>Clear clip</button>
        <button onClick={() => updatePattern(patIndex, doublePattern)}>Double</button>
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
      <p className="hint">{drum ? "Click a cell to toggle a step." : "Click a cell to add a note; record on the keyboard for melodies."} Pick another track above to edit it.</p>
      <div className="seq-grid" style={{ "--steps": steps } as React.CSSProperties}>
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
                return (
                  <button
                    key={s}
                    className={`cell ${s % 4 === 0 ? "beat" : ""} ${s === playStep ? "now" : ""} ${vel ? "lit" : ""}`}
                    style={vel ? { background: row.color, opacity: 0.35 + (vel / 127) * 0.65 } : undefined}
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
