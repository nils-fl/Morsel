// Lab: pick the voice engine, and compare the two by bouncing the same notes on both (a null test).
import { useState } from "react";
import { engine, type VoiceEngine } from "../audio/engine";
import { FACTORY_PRESETS } from "../audio/synthPresets";
import { renderToBuffer } from "../seq/render";
import { defaultKeys, drumTrack, get, keysTrack } from "../state/store";
import type { NoteEvent, Project, Track } from "../state/types";
import { Section } from "./controls";

interface Row {
  name: string;
  /** RMS level of the node bounce, dB. */
  level: number;
  /** Worklet level minus node level, dB. */
  diff: number;
  /** Level of the difference between the bounces, relative to the node bounce, dB (lower = closer). */
  residual: number;
  /** Samples the node bounce runs behind the worklet one (they are compared lined up). */
  lag: number;
  note?: string;
}

const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "−∞");

/**
 * The node engine's drive runs 2x oversampled, which delays the sound by 128 samples; the worklet's doesn't. The
 * bounces are compared lined up both ways, and the closer one counts.
 */
const LAGS = [0, 128];

function compare(a: AudioBuffer, b: AudioBuffer) {
  let best = { level: 0, diff: 0, residual: Infinity, lag: 0 };
  for (const lag of LAGS) {
    let pa = 0;
    let pb = 0;
    let pd = 0;
    for (let c = 0; c < a.numberOfChannels; c++) {
      const x = a.getChannelData(c);
      const y = b.getChannelData(c);
      for (let i = lag; i < x.length; i++) {
        pa += x[i] * x[i];
        pb += y[i - lag] * y[i - lag];
        pd += (x[i] - y[i - lag]) ** 2;
      }
    }
    const n = a.length * a.numberOfChannels;
    const r = { level: db(pa / n), diff: db(pb / n) - db(pa / n), residual: db(pd / n) - db(pa / n), lag };
    if (r.residual < best.residual) best = r;
  }
  return best;
}

/** The project with just this track and one pattern of `events`, dry (the reverb's impulse is random) and unducked. */
function solo(p: Project, track: Track, events: Omit<NoteEvent, "id">[]): Project {
  return {
    ...p,
    tracks: [{ ...track, sendA: 0, sendB: 0, mute: false, solo: false }],
    patterns: [{ bars: 1, clips: { [track.id]: { events: events.map((e, i) => ({ ...e, id: `n${i}` })) } } }],
    song: [],
    sidechain: [],
  };
}

async function both(name: string, p: Project, order: number[], note?: string): Promise<Row> {
  const [a, b] = await Promise.all([renderToBuffer(p, order, "nodes"), renderToBuffer(p, order, "worklet")]);
  return { name, ...compare(a, b), note };
}

export function EngineCompare() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState("");
  const [picked, setPicked] = useState<VoiceEngine>(engine.voiceEngine);
  const playing = engine.voices.worklet ? "worklet" : "nodes";

  const run = async () => {
    const out: Row[] = [];
    const show = () => setRows([...out].sort((x, y) => y.residual - x.residual));
    const p = get().project;
    const drums = drumTrack();
    for (const [i, pad] of drums.pads.entries()) {
      if (!pad.sampleId || !engine.buffer(pad.sampleId)) continue;
      setBusy(`Pad ${i + 1}…`);
      out.push(await both(`${drums.name} · ${i + 1} ${pad.name}`, solo(p, drums, [{ tick: 0, note: i, vel: 100, len: 48 }]), [0]));
      show();
    }
    const keys = p.tracks.some((t) => t.kind === "keys") ? keysTrack() : null;
    const base: Track = keys ?? { ...drums, id: "keys", kind: "keys", pads: [], keys: defaultKeys() };
    for (const preset of FACTORY_PRESETS) {
      setBusy(`${preset.name}…`);
      const track = { ...base, keys: { ...(base.keys ?? defaultKeys()), type: "synth" as const, synth: preset.params } };
      const notes = [48, 60, 67].map((note, i) => ({ tick: i * 96, note, vel: 100, len: 72 }));
      out.push(await both(`Keys · ${preset.folder} / ${preset.name}`, solo(p, track, notes), [0], preset.params.noise > 0 ? "noise is random" : undefined));
      show();
    }
    setBusy("Current pattern…");
    const dry = { ...p, returns: { ...p.returns, reverb: { ...p.returns.reverb, level: 0 } } };
    out.push(await both("Current pattern (no reverb)", dry, [get().currentPattern], "duck, delay and noise included"));
    show();
    setBusy("");
  };

  return (
    <Section title="Voice engine">
      <p className="hint">
        Worklet: voices play in the audio thread, sample-accurately. Nodes: the Web Audio node graphs Morsel used before.
        Playing now: <b>{playing}</b>{picked !== playing && " (the choice applies after a reload)"}.
      </p>
      <div className="row">
        {(["worklet", "nodes"] as const).map((e) => (
          <button key={e} className={e === picked ? "on" : ""} onClick={() => { engine.setVoiceEngine(e); setPicked(e); }}>{e}</button>
        ))}
        {picked !== playing && <button onClick={() => location.reload()}>Reload</button>}
      </div>
      <p className="hint">
        Compare bounces every pad of the drum track, every factory synth preset (three notes) and the current pattern on
        both engines. Residual = how loud the difference is next to the sound, with the two lined up (Lag: how many samples
        the node bounce runs behind): below −40 dB they are close to identical.
      </p>
      <div className="row">
        <button disabled={!!busy} onClick={() => void run()}>Compare engines</button>
        <span className="hint">{busy}</span>
      </div>
      {rows.length > 0 && (
        <table className="compare mono">
          <thead>
            <tr><th>Sound</th><th>Level dB</th><th>Worklet − nodes dB</th><th>Residual dB</th><th>Lag</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td><td>{fmt(r.level)}</td><td>{fmt(r.diff)}</td><td>{fmt(r.residual)}</td><td>{r.lag}</td><td className="hint">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
