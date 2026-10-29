import { Fragment, useEffect, useState } from "react";
import { engine } from "../audio/engine";
import { MAX_PREDELAY, reverbSeconds } from "../audio/reverb";
import { fxChain } from "../audio/fxUnits";
import { DELAY_TIMES, FX_NAMES, FX_SETTINGS, delayName, duckText, fxText, fxValue, setFxValue } from "../params";
import { selectTrack, setFxOn, toggleTrackFlag, updateProject, updateTrack, useApp } from "../state/store";
import { type Returns, type Track } from "../state/types";
import { fxDragSource, fxDropTarget } from "./fxDrag";
import { MeterRow, Section, SelectRow, Slider, ToggleRow } from "./controls";
import { accentFor, paletteCss } from "./palette";
import { ColorPicker } from "./ColorPicker";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const panText = (v: number) => (Math.abs(v) < 0.01 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);

export function Mixer() {
  const tracks = useApp((s) => s.project.tracks);
  // Up to four strips (with Master), the returns sit beside them on the pad columns; more, and they go underneath.
  const strips = tracks.length + 1;
  const span = strips <= 3 ? 5 : strips === 4 ? 6 : 0;
  return (
    <div className={`mixer-panel ${span ? "panels side" : ""}`} style={{ "--mix-span": span, "--ret-span": 8 - span } as React.CSSProperties}>
      <Section title="Mixer">
        <p className="hint tip">Each track runs through its FX rack (the effects switched on, left to right: click one to switch it, drag it to move it in the chain), then the fader. Sends A and B feed the shared reverb and delay below.</p>
        <div className="mixer">
          {tracks.map((t, i) => <Channel key={t.id} track={t} index={i} />)}
          <MasterChannel />
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
  const gr = useDuckGr(t);
  // Each strip in its own track's colour, whichever track is selected.
  const theme = useApp((s) => s.theme);
  const color = paletteCss(t.color);
  return (
    <div className={`channel ${selected ? "on" : ""}`} style={{ "--trk": color, "--page": accentFor(color, theme) } as React.CSSProperties}>
      <header onClick={() => selectTrack(t.id)}>
        <i>{index + 1}</i>
        <input value={t.name} maxLength={16} onChange={(e) => up({ name: e.target.value })} onClick={(e) => e.stopPropagation()} aria-label="Track name" />
      </header>
      <div className="row">
        <ColorPicker value={t.color} onPick={(c) => up({ color: c })} label="Track colour" />
        <button className={`ms ${t.mute ? "on" : ""}`} onClick={() => toggleTrackFlag(t.id, "mute")}>M</button>
        <button className={`ms solo ${t.solo ? "on" : ""}`} onClick={() => toggleTrackFlag(t.id, "solo")}>S</button>
      </div>
      <h4>FX</h4>
      <FxRack track={t} />
      <h4>Sends</h4>
      <Slider label="Reverb" value={t.sendA} min={0} max={1} format={pct} onChange={(v) => up({ sendA: v })} />
      <Slider label="Delay" value={t.sendB} min={0} max={1} format={pct} onChange={(v) => up({ sendB: v })} />
      <h4>Out</h4>
      <Slider label="Pan" value={t.pan} min={-1} max={1} step={0.02} format={panText} onChange={(v) => up({ pan: v })} />
      <Slider label="Level" value={t.level} min={0} max={1} format={pct} onChange={(v) => up({ level: v })} />
      {gr !== null && <MeterRow className="duck-meter" label="Duck" level={gr} value={duckText(1 - gr)} title="Ducker gain reduction" />}
    </div>
  );
}

/** A track's FX rack: a chip per effect in chain order (click: on / off, drag: move), then the settings of those on. */
function FxRack({ track: t }: { track: Track }) {
  const [over, setOver] = useState<number | null>(null);
  return (
    <>
      <div className="fx-chips">
        {t.fx.order.map((k, i) => (
          <button key={k} className={`fx-chip ${t.fx.on[k] ? "on" : ""} ${over === i ? "drop" : ""}`} {...fxDragSource(t.id, i)} {...fxDropTarget(t.id, i, setOver)}
            onClick={() => setFxOn(k, !t.fx.on[k], t.id)} title={`${FX_NAMES[k]}: ${t.fx.on[k] ? "on" : "off"} (click to switch, drag to move it in the chain)`}>
            {FX_NAMES[k]}
          </button>
        ))}
      </div>
      {fxChain(t.fx).map((k) => (
        <Fragment key={k}>
          <h5>{FX_NAMES[k]}</h5>
          {FX_SETTINGS[k].map((s) => {
            const v = fxValue(t.fx, k, s.key);
            const put = (x: number | string | boolean) => setFxValue(k, s.key, x, t.id);
            if (s.type === "switch") return <ToggleRow key={s.key} label={s.name} checked={!!v} onChange={put} />;
            if (s.type === "pick") return <SelectRow key={s.key} label={s.name} value={v as string | number} options={s.options} format={(x) => fxText(s, x)} onPick={put} />;
            return <Slider key={s.key} label={s.name} value={v as number} min={s.lo} max={s.hi} step={s.whole ? 1 : s.step} format={(x) => fxText(s, x)} onChange={put} />;
          })}
        </Fragment>
      ))}
    </>
  );
}

/** dBFS of a level, for the meters (floored at −60). */
const dbfs = (v: number) => Math.max(-60, 20 * Math.log10(Math.max(v, 1e-6)));
/** Meter fill for a dBFS value: −48 dB empty, 0 dB full. */
const meterLevel = (db: number) => (db + 48) / 48;


/** The master output's peak (held briefly, then falling) and the limiter's gain reduction, both in dB. */
function useMasterMeter() {
  const [m, setM] = useState({ peak: -60, gr: 0 });
  useEffect(() => {
    let raf = 0;
    let held = { peak: -60, gr: 0, at: 0 };
    const tick = (now: number) => {
      const { peak, gain } = engine.voices.masterBus.meter;
      const p = dbfs(peak);
      const gr = -dbfs(gain);
      // Hold a new peak for half a second, then let it fall about 20 dB a second.
      const fall = (now - held.at) / 1000 > 0.5 ? 20 / 60 : 0;
      held = p >= held.peak - fall ? { peak: p, gr: Math.max(gr, held.gr - 0.5), at: now } : { ...held, peak: held.peak - fall, gr: Math.max(gr, held.gr - 0.5) };
      setM({ peak: held.peak, gr: held.gr });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return m;
}

function MasterChannel() {
  const level = useApp((s) => s.project.masterLevel);
  const glue = useApp((s) => s.project.masterGlue);
  const { peak, gr } = useMasterMeter();
  return (
    <div className="channel master">
      <header><strong>Master</strong></header>
      <p className="hint tip">A limiter keeps the mix from clipping, live and in bounces, and leaves it untouched below that. Glue adds a gentle compressor that holds the mix together.</p>
      <h4>Out</h4>
      <Slider label="Level" value={level} min={0} max={1} format={pct} onChange={(v) => updateProject((p) => ({ ...p, masterLevel: v }), false)} />
      <ToggleRow label="Glue" checked={glue} onChange={(on) => updateProject((p) => ({ ...p, masterGlue: on }), false)} />
      <MeterRow label="Peak" level={meterLevel(peak)} value={peak <= -60 ? "−∞" : peak.toFixed(1)} title="Output peak, dBFS" />
      <MeterRow className="gr-meter" label="Limit" level={gr / 12} value={gr < 0.05 ? "0.0" : `−${gr.toFixed(1)}`} title="Limiter gain reduction, dB" />
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
          <Slider label="Size" value={r.reverb.size} min={0} max={1} format={(v) => `${reverbSeconds(v).toFixed(1)} s`} onChange={(v) => setR("reverb", { size: v })} />
          <Slider label="Decay" value={r.reverb.decay} min={0} max={1} format={pct} onChange={(v) => setR("reverb", { decay: v })} />
          <Slider label="Pre-delay" value={r.reverb.predelay} min={0} max={1} format={(v) => `${Math.round(v * MAX_PREDELAY * 1000)} ms`} onChange={(v) => setR("reverb", { predelay: v })} />
          <Slider label="Tone" value={r.reverb.tone} min={0} max={1} format={(v) => (v < 0.34 ? "Dark" : v < 0.67 ? "Warm" : "Bright")} onChange={(v) => setR("reverb", { tone: v })} />
          <Slider label="Level" value={r.reverb.level} min={0} max={1} format={pct} onChange={(v) => setR("reverb", { level: v })} />
        </div>
        <div>
          <h4>B · Delay</h4>
          <SelectRow label="Time" value={r.delay.time} options={DELAY_TIMES} format={delayName} onPick={(time) => setR("delay", { time })} />
          <Slider label="Feedback" value={r.delay.feedback} min={0} max={0.95} format={pct} onChange={(v) => setR("delay", { feedback: v })} />
          <Slider label="Tone" value={r.delay.tone} min={0} max={1} format={pct} onChange={(v) => setR("delay", { tone: v })} />
          <ToggleRow label="Ping-pong" checked={r.delay.pingpong} onChange={(pingpong) => setR("delay", { pingpong })} />
          <Slider label="Level" value={r.delay.level} min={0} max={1} format={pct} onChange={(v) => setR("delay", { level: v })} />
        </div>
      </div>
    </Section>
  );
}
