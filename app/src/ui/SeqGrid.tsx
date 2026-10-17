import { useEffect, useState } from "react";
import { sequencer } from "../seq/sequencer";
import { STEP_TICKS } from "../seq/timing";
import { KEYS_TRACK, clearTrack, newId, set, toggleArray, toggleStep, updatePattern, useApp } from "../state/store";
import { noteName } from "./notes";
import { paletteCss } from "./palette";

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

export function SeqGrid() {
  const patIndex = useApp((s) => s.currentPattern);
  const pat = useApp((s) => s.project.patterns[s.currentPattern]);
  const pads = useApp((s) => s.project.pads);
  const mutes = useApp((s) => s.project.mutes);
  const solos = useApp((s) => s.project.solos);
  const selectedTrack = useApp((s) => s.selectedTrack);
  const keyNote = useApp((s) => s.project.keys.type === "synth" ? 48 : 60);
  const playStep = usePlayheadStep();
  const steps = pat.bars * 16;

  const tracks = [...Array(16).keys(), KEYS_TRACK];
  return (
    <div className="seq">
      <div className="row">
        <label className="field">
          <span>Length</span>
          <select value={pat.bars} onChange={(e) => updatePattern(patIndex, (p) => ({ ...p, bars: Number(e.target.value), events: p.events.filter((ev) => ev.tick < Number(e.target.value) * 16 * STEP_TICKS) }))}>
            {[1, 2, 3, 4].map((b) => <option key={b} value={b}>{b} bar{b > 1 ? "s" : ""}</option>)}
          </select>
        </label>
        <button onClick={() => updatePattern(patIndex, (p) => ({ ...p, events: [] }))}>Clear pattern</button>
        <button onClick={() => clearTrack(patIndex, selectedTrack)}>Clear track</button>
        <button onClick={() => updatePattern(patIndex, (p) => p.bars >= 4 ? p : ({
          bars: p.bars * 2 > 4 ? 4 : p.bars * 2,
          events: [...p.events, ...p.events.map((e) => ({ ...e, id: newId(), tick: e.tick + p.bars * 16 * STEP_TICKS }))].filter((e) => e.tick < Math.min(4, p.bars * 2) * 16 * STEP_TICKS),
        }))}>Double</button>
        <span className="hint">Click a cell to toggle. Keys notes come from recording on the keyboard.</span>
      </div>
      <div className="seq-grid" style={{ "--steps": steps } as React.CSSProperties}>
        {tracks.map((t) => {
          const isKeys = t === KEYS_TRACK;
          const color = isKeys ? "#a46bff" : paletteCss(pads[t].color);
          const evs = pat.events.filter((e) => e.track === t);
          return (
            <div key={t} className={`seq-row ${selectedTrack === t ? "selected" : ""}`} style={{ "--row": color } as React.CSSProperties}>
              <button className="seq-name" onClick={() => set({ selectedTrack: t, ...(isKeys ? {} : { selectedPad: t }) })}>
                {isKeys ? "Keys" : pads[t].name}
              </button>
              <button className={`ms ${mutes[t] ? "on" : ""}`} onClick={() => toggleArray("mutes", t)}>M</button>
              <button className={`ms solo ${solos[t] ? "on" : ""}`} onClick={() => toggleArray("solos", t)}>S</button>
              <div className="seq-cells">
                {Array.from({ length: steps }, (_, s) => {
                  const inStep = evs.filter((e) => e.tick >= s * STEP_TICKS && e.tick < (s + 1) * STEP_TICKS);
                  const vel = inStep.length ? Math.max(...inStep.map((e) => e.vel)) : 0;
                  return (
                    <button
                      key={s}
                      className={`cell ${s % 4 === 0 ? "beat" : ""} ${s === playStep ? "now" : ""} ${vel ? "lit" : ""}`}
                      style={vel ? { background: color, opacity: 0.35 + (vel / 127) * 0.65 } : undefined}
                      title={inStep.length && isKeys ? inStep.map((e) => noteName(e.note)).join(" ") : undefined}
                      onClick={() => toggleStep(patIndex, t, s * STEP_TICKS, STEP_TICKS, isKeys ? keyNote : 60)}
                    >
                      {isKeys && inStep.length ? noteName(inStep[0].note) : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
