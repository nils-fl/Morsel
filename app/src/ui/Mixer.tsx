import { useEffect, useState } from "react";
import { engine } from "../audio/engine";
import { FX_FILTER_NAMES, hz, setFx } from "../params";
import { selectTrack, toggleTrackFlag, updateProject, updateTrack, useApp } from "../state/store";
import { type Returns, type Track, type TrackFx } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { PALETTE_CHOICES, paletteCss } from "./palette";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const panText = (v: number) => (Math.abs(v) < 0.01 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
const DELAY_TIMES = [1, 2, 3, 4, 6, 8, 12, 16];
const delayName = (n: number) => ({ 1: "1/16", 2: "1/8", 3: "1/8 dot", 4: "1/4", 6: "1/4 dot", 8: "1/2", 12: "1/2 dot", 16: "1 bar" })[n] ?? `${n}/16`;

export function Mixer() {
  const tracks = useApp((s) => s.project.tracks);
  return (
    <div className="mixer-panel">
      <Section title="Mixer">
        <p className="hint">Each track runs through its own filter, EQ, drive and compressor, then the fader. Sends A and B feed the shared reverb and delay below.</p>
        <div className="mixer">
          {tracks.map((t, i) => <Channel key={t.id} track={t} index={i} />)}
        </div>
      </Section>
      <ReturnsPanel />
    </div>
  );
}

/** Sidechain gain reduction on a keys track that ducks, 0..1; null when it doesn't. */
function useDuckGr(t: Track) {
  const hit = !!t.duck?.on && t.duck.input !== null;
  const [gr, setGr] = useState(0);
  useEffect(() => {
    if (!hit) return;
    let raf = 0;
    const tick = () => {
      setGr(1 - engine.voices.duckLevel(t.id));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hit, t.id]);
  return hit ? gr : null;
}

function Channel({ track: t, index }: { track: Track; index: number }) {
  const selected = useApp((s) => s.selectedTrack === t.id);
  const up = (patch: Partial<Track>) => updateTrack(t.id, patch);
  const fx = (patch: Partial<TrackFx>) => setFx(patch, t.id);
  const gr = useDuckGr(t);
  return (
    <div className={`channel ${selected ? "on" : ""}`} style={{ "--trk": paletteCss(t.color) } as React.CSSProperties}>
      <header onClick={() => selectTrack(t.id)}>
        <i>{index + 1}</i>
        <input value={t.name} maxLength={16} onChange={(e) => up({ name: e.target.value })} onClick={(e) => e.stopPropagation()} aria-label="Track name" />
      </header>
      <div className="row">
        <select value={t.color} onChange={(e) => up({ color: Number(e.target.value) })} aria-label="Track colour" style={{ color: paletteCss(t.color) }}>
          {PALETTE_CHOICES.map((c) => <option key={c} value={c} style={{ color: paletteCss(c) }}>■ {c}</option>)}
        </select>
        <button className={`ms ${t.mute ? "on" : ""}`} onClick={() => toggleTrackFlag(t.id, "mute")}>M</button>
        <button className={`ms solo ${t.solo ? "on" : ""}`} onClick={() => toggleTrackFlag(t.id, "solo")}>S</button>
      </div>
      <h4>Insert FX</h4>
      <Field label="Filter">
        <select value={t.fx.filter} onChange={(e) => fx({ filter: e.target.value as TrackFx["filter"] })}>
          {(Object.keys(FX_FILTER_NAMES) as TrackFx["filter"][]).map((f) => <option key={f} value={f}>{FX_FILTER_NAMES[f]}</option>)}
        </select>
      </Field>
      {t.fx.filter !== "off" && <>
        <Slider label="Cutoff" value={t.fx.cutoff} min={0} max={1} format={hz} onChange={(v) => fx({ cutoff: v })} />
        <Slider label="Reso" value={t.fx.resonance} min={0} max={1} format={pct} onChange={(v) => fx({ resonance: v })} />
      </>}
      <Slider label="Low" value={t.fx.eqLow} min={-15} max={15} step={0.5} format={db} onChange={(v) => fx({ eqLow: v })} />
      <Slider label="Mid" value={t.fx.eqMid} min={-15} max={15} step={0.5} format={db} onChange={(v) => fx({ eqMid: v })} />
      <Slider label="High" value={t.fx.eqHigh} min={-15} max={15} step={0.5} format={db} onChange={(v) => fx({ eqHigh: v })} />
      <Slider label="Drive" value={t.fx.drive} min={0} max={1} format={pct} onChange={(v) => fx({ drive: v })} />
      <Slider label="Comp" value={t.fx.comp} min={0} max={1} format={(v) => (v <= 0 ? "Off" : pct(v))} onChange={(v) => fx({ comp: v })} />
      <h4>Sends</h4>
      <Slider label="A Reverb" value={t.sendA} min={0} max={1} format={pct} onChange={(v) => up({ sendA: v })} />
      <Slider label="B Delay" value={t.sendB} min={0} max={1} format={pct} onChange={(v) => up({ sendB: v })} />
      <h4>Out</h4>
      <Slider label="Pan" value={t.pan} min={-1} max={1} step={0.02} format={panText} onChange={(v) => up({ pan: v })} />
      <Slider label="Level" value={t.level} min={0} max={1} format={pct} onChange={(v) => up({ level: v })} />
      {gr !== null && <div className="meter duck-meter" title="Ducker gain reduction"><div style={{ width: `${Math.round(gr * 100)}%` }} /></div>}
    </div>
  );
}

function ReturnsPanel() {
  const r = useApp((s) => s.project.returns);
  const setR = <K extends keyof Returns>(key: K, patch: Partial<Returns[K]>) =>
    updateProject((p) => ({ ...p, returns: { ...p.returns, [key]: { ...p.returns[key], ...patch } } }), false);
  return (
    <Section title="Returns">
      <div className="returns">
        <div>
          <h4>A · Reverb</h4>
          <Slider label="Size" value={r.reverb.size} min={0} max={1} format={(v) => `${(0.3 + v * 3.7).toFixed(1)} s`} onChange={(v) => setR("reverb", { size: v })} />
          <Slider label="Decay" value={r.reverb.decay} min={0} max={1} format={pct} onChange={(v) => setR("reverb", { decay: v })} />
          <Slider label="Level" value={r.reverb.level} min={0} max={1} format={pct} onChange={(v) => setR("reverb", { level: v })} />
        </div>
        <div>
          <h4>B · Delay</h4>
          <Field label="Time">
            <select value={r.delay.time} onChange={(e) => setR("delay", { time: Number(e.target.value) })}>
              {DELAY_TIMES.map((n) => <option key={n} value={n}>{delayName(n)}</option>)}
            </select>
          </Field>
          <Slider label="Feedback" value={r.delay.feedback} min={0} max={0.95} format={pct} onChange={(v) => setR("delay", { feedback: v })} />
          <Slider label="Tone" value={r.delay.tone} min={0} max={1} format={pct} onChange={(v) => setR("delay", { tone: v })} />
          <Slider label="Level" value={r.delay.level} min={0} max={1} format={pct} onChange={(v) => setR("delay", { level: v })} />
        </div>
      </div>
    </Section>
  );
}
