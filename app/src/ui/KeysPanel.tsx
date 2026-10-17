import { useRef } from "react";
import { keyOff, keyOn } from "../actions";
import { engine } from "../audio/engine";
import { updateKeys, useApp } from "../state/store";
import type { SynthParams, Wave, Zone } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { noteName, rootFromName } from "./notes";

const WAVES: Wave[] = ["sawtooth", "square", "triangle", "sine"];
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

export function KeysPanel() {
  const keys = useApp((s) => s.project.keys);
  const pads = useApp((s) => s.project.pads);
  const dirInput = useRef<HTMLInputElement>(null);
  const synth = keys.synth;
  const upSynth = (patch: Partial<SynthParams>) => updateKeys({ synth: { ...synth, ...patch } });

  async function loadMulti(files: File[]) {
    const zones: Zone[] = [];
    for (const f of files.filter((f) => /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name))) {
      const root = rootFromName(f.name);
      if (root === null) continue;
      zones.push({ sampleId: await engine.addFile(f), root });
    }
    zones.sort((a, b) => a.root - b.root);
    const folder = files[0]?.webkitRelativePath.split("/")[0] ?? "Multisample";
    updateKeys({ type: "multi", zones, multiName: folder });
  }

  return (
    <div className="keys-panel">
      <Section title="Keys instrument">
        <div className="row">
          {(["synth", "chromatic", "multi"] as const).map((t) => (
            <button key={t} className={keys.type === t ? "on" : ""} onClick={() => updateKeys({ type: t })}>
              {t === "synth" ? "Synth" : t === "chromatic" ? "Pad sample" : "Multisample"}
            </button>
          ))}
          <Slider label="Volume" value={keys.volume} min={0} max={1} format={pct} onChange={(v) => updateKeys({ volume: v })} />
        </div>
      </Section>

      {keys.type === "synth" && (
        <Section title="Synth">
          <div className="row wrap">
            <Field label="Osc 1">
              <select value={synth.wave} onChange={(e) => upSynth({ wave: e.target.value as Wave })}>{WAVES.map((w) => <option key={w}>{w}</option>)}</select>
            </Field>
            <Field label="Osc 2">
              <select value={synth.wave2} onChange={(e) => upSynth({ wave2: e.target.value as Wave })}>{WAVES.map((w) => <option key={w}>{w}</option>)}</select>
            </Field>
          </div>
          <div className="sliders">
            <Slider label="Osc 2 lvl" value={synth.osc2Level} min={0} max={1} format={pct} onChange={(v) => upSynth({ osc2Level: v })} />
            <Slider label="Detune" value={synth.detune} min={-1200} max={1200} step={1} format={(v) => `${v} ct`} onChange={(v) => upSynth({ detune: v })} />
            <Slider label="Cutoff" value={synth.cutoff} min={0} max={1} format={pct} onChange={(v) => upSynth({ cutoff: v })} />
            <Slider label="Resonance" value={synth.resonance} min={0} max={1} format={pct} onChange={(v) => upSynth({ resonance: v })} />
            <Slider label="Env amt" value={synth.envAmount} min={0} max={1} format={pct} onChange={(v) => upSynth({ envAmount: v })} />
            <Slider label="Attack" value={synth.attack} min={0.001} max={2} step={0.001} format={ms} onChange={(v) => upSynth({ attack: v })} />
            <Slider label="Decay" value={synth.decay} min={0.01} max={2} format={ms} onChange={(v) => upSynth({ decay: v })} />
            <Slider label="Sustain" value={synth.sustain} min={0} max={1} format={pct} onChange={(v) => upSynth({ sustain: v })} />
            <Slider label="Release" value={synth.release} min={0.01} max={3} format={ms} onChange={(v) => upSynth({ release: v })} />
          </div>
        </Section>
      )}

      {keys.type === "chromatic" && (
        <Section title="Pad sample on keys">
          <p className="hint">Plays a pad's sample across the keyboard. C4 = original pitch. Uses that pad's start, end, filter and envelope.</p>
          <Field label="Source pad">
            <select value={keys.sourcePad} onChange={(e) => updateKeys({ sourcePad: Number(e.target.value) })}>
              {pads.map((p, i) => <option key={i} value={i}>{i + 1}: {p.name}</option>)}
            </select>
          </Field>
        </Section>
      )}

      {keys.type === "multi" && (
        <Section title={`Multisample${keys.multiName ? ` · ${keys.multiName}` : ""}`} actions={<button onClick={() => dirInput.current?.click()}>Load folder…</button>}>
          <input ref={dirInput} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={(e) => e.target.files && loadMulti([...e.target.files])} />
          <p className="hint">Pick a folder of samples named with their note (e.g. <code>Piano_C4.wav</code>, <code>Rhodes A#2.wav</code>, or a MIDI number like <code>060</code>). Each key uses the nearest sample.</p>
          <div className="row wrap">
            {keys.zones.map((z) => <span className="chip" key={z.sampleId}>{noteName(z.root)}</span>)}
            {!keys.zones.length && <span className="hint">No zones loaded.</span>}
          </div>
        </Section>
      )}

      <Section title="Try it">
        <MiniKeyboard />
      </Section>
    </div>
  );
}

function MiniKeyboard() {
  const notes = Array.from({ length: 25 }, (_, i) => 48 + i);
  const black = (n: number) => [1, 3, 6, 8, 10].includes(n % 12);
  return (
    <div className="mini-kb">
      {notes.map((n) => (
        <button
          key={n}
          className={black(n) ? "black" : "white"}
          onPointerDown={() => keyOn(n, 100)}
          onPointerUp={() => keyOff(n)}
          onPointerLeave={(e) => e.buttons && keyOff(n)}
        >
          {n % 12 === 0 ? noteName(n) : ""}
        </button>
      ))}
    </div>
  );
}
