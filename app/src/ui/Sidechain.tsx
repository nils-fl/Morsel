// Sidechain: drum pads are the inputs (Input 1, 2, …); each track ducks from one of them with its own envelope.
import { useEffect, useState } from "react";
import { engine } from "../audio/engine";
import { DUCK_PAGE, SIDECHAIN_PAGE, inputLabel, padLabel } from "../params";
import { drumTrack, inputOf, padDucks, parseInput, selectedTrack, setDuckPad, setTrackDuck, toggleSidechainInput, useApp } from "../state/store";
import { Field, Section, Slider } from "./controls";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

/** Drum track: the inputs (made from this rack's pads) and how this track ducks, in one panel. */
export function SidechainPanel() {
  const track = useApp(selectedTrack);
  return (
    <Section title="Sidechain" actions={<DuckSwitch />}>
      <h4 className="sub-head first">Inputs</h4>
      <InputsBody />
      <h4 className="sub-head">Duck {track.name}</h4>
      <DuckBody inputsAbove />
    </Section>
  );
}

/** Make the selected pad an input, and list the inputs. */
function InputsBody() {
  const track = useApp(drumTrack);
  const pad = useApp((s) => s.selectedPad);
  const inputs = useApp((s) => s.project.sidechain);
  const onPage = useApp((s) => s.encPage === SIDECHAIN_PAGE);
  const n = inputs.indexOf(inputOf(track.id, pad)) + 1;

  return (
    <>
      <p className="hint tip">
        Each input's hits duck the tracks listening to it (set in each track's Duck panel). Launchkey: <b>Sidechain</b> page
        {onPage ? " (open)" : ""}, hit a pad, encoder 1.
      </p>
      {inputs.length ? (
        <ul className="inputs">
          {inputs.map((x) => {
            const { track: t, pad: p } = parseInput(x);
            return (
              <li key={x}>
                {inputLabel(x)}
                <button onClick={() => toggleSidechainInput(t, p)} aria-label={`Remove ${inputLabel(x)}`} title="No longer an input">✕</button>
              </li>
            );
          })}
        </ul>
      ) : <p className="hint">No inputs yet.</p>}
      <div className="row">
        <button className={n ? "on" : ""} onClick={() => toggleSidechainInput(track.id, pad)} title="Any track can duck from an input">
          {n ? `${padLabel(track.id, pad)}: Input ${n}` : `Make ${padLabel(track.id, pad)} an input`}
        </button>
      </div>
    </>
  );
}

/** Keys track: how it ducks. */
export function DuckPanel() {
  return (
    <Section title="Duck" actions={<DuckSwitch />}>
      <DuckBody />
    </Section>
  );
}

/** The selected track's duck, on or off. */
function DuckSwitch() {
  const track = useApp(selectedTrack);
  const on = track.duck.on;
  return <button className={on ? "on" : ""} onClick={() => setTrackDuck(track.id, { on: !on })} title={`${track.name} ducks from its input`}>{on ? "Duck on" : "Duck off"}</button>;
}

/** The selected track ducks from an input: a keys track as a whole, a drum track the pads ticked below.
 *  `inputsAbove`: the inputs are listed just above (drum track), so no "make an input first" note. */
function DuckBody({ inputsAbove = false }: { inputsAbove?: boolean }) {
  const track = useApp(selectedTrack);
  const inputs = useApp((s) => s.project.sidechain);
  useApp((s) => s.project.tracks); // pad names in the labels
  const onPage = useApp((s) => s.encPage === DUCK_PAGE);
  const duck = track.duck;
  const drum = track.kind === "drum";
  const active = duck.on && duck.input !== null;
  const [level, setLevel] = useState(1);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setLevel(engine.voices.duckLevel(track.id));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, track.id]);
  const set = (patch: Parameters<typeof setTrackDuck>[1]) => setTrackDuck(track.id, patch);

  return (
    <>
      <p className="hint tip">
        {drum
          ? <>Hits on the input dip the pads ticked below (never the input itself). Launchkey: <b>Duck</b> page{onPage ? " (open)" : ""}, hit a pad, encoder 7.</>
          : <>Hits on the input dip this track. Inputs are drum pads, made on a drum track's Track tab. Launchkey: <b>Duck</b> page{onPage ? " (open)" : ""}.</>}
      </p>
      <Field label="Input">
        <select value={duck.input ?? ""} onChange={(e) => set({ input: e.target.value || null })}>
          <option value="">None</option>
          {inputs.map((x) => <option key={x} value={x}>{inputLabel(x)}</option>)}
        </select>
      </Field>
      {!inputs.length && !inputsAbove && <p className="hint">No inputs yet: make a drum pad an input first.</p>}
      <Slider label="Depth" value={duck.depth} min={0} max={1} format={pct} onChange={(v) => set({ depth: v })} />
      <Slider label="Attack" value={duck.attack} min={0} max={0.05} step={0.001} format={ms} onChange={(v) => set({ attack: v })} />
      <Slider label="Hold" value={duck.hold} min={0} max={0.5} step={0.01} format={ms} onChange={(v) => set({ hold: v })} />
      <Slider label="Release" value={duck.release} min={0.02} max={1} step={0.01} format={ms} onChange={(v) => set({ release: v })} />
      {drum && (
        <div className="duck-pads" role="group" aria-label="Pads that duck">
          {track.pads.map((_, i) => {
            const isInput = duck.input === inputOf(track.id, i);
            const on = padDucks(track, i);
            return (
              <button key={i} className={on ? "on" : ""} disabled={isInput} aria-pressed={on}
                title={isInput ? `${padLabel(track.id, i)} is the input` : `${padLabel(track.id, i)}: ${on ? "ducks" : "doesn't duck"}`}
                onClick={() => setDuckPad(track.id, i, !on)}>
                {isInput ? "in" : i + 1}
              </button>
            );
          })}
        </div>
      )}
      <div className="meter duck-meter" title="Gain reduction"><div style={{ width: `${Math.round((1 - (active ? level : 1)) * 100)}%` }} /></div>
    </>
  );
}
