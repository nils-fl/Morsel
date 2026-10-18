import { useState } from "react";
import { allPresets, applyPreset, deleteUserPreset, keyOff, keyOn, saveUserPreset } from "../actions";
import { FACTORY_PRESETS } from "../audio/synthPresets";
import { hz, presetLabel } from "../params";
import { engine } from "../audio/engine";
import { get, keysTrack, set, updateKeys, useApp } from "../state/store";
import { folderLabel, folderSamples } from "../browse/source";
import type { KeysLfo, KeysSample, SynthParams, Wave, Zone } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { SamplePicker } from "./SamplePicker";
import { noteName, rootFromName } from "./notes";

const WAVES: Wave[] = ["sawtooth", "square", "triangle", "sine"];
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

export function KeysPanel() {
  const keys = useApp((s) => keysTrack(s).keys!);
  const trackName = useApp((s) => keysTrack(s).name);
  const drumTracks = useApp((s) => s.project.tracks).filter((t) => t.kind === "drum");
  const synth = keys.synth;
  const upSynth = (patch: Partial<SynthParams>) => updateKeys({ synth: { ...synth, ...patch } });
  const upSample = (patch: Partial<KeysSample>) => updateKeys({ sample: { ...keys.sample, ...patch } });
  const upLfo = (patch: Partial<KeysLfo>) => updateKeys({ lfo: { ...keys.lfo, ...patch } });

  /** One file as the keys sound; a note in its name ("Bass_C2.wav") becomes the root. */
  async function loadSample(f: File) {
    const sampleId = await engine.addFile(f);
    upSample({ sampleId, root: rootFromName(f.name) ?? keys.sample.root });
  }

  /** A folder of note-named samples as the multisample; only those files are copied into the library. */
  async function loadMulti(path: string) {
    const named = await folderSamples(path, Infinity, (name) => rootFromName(name) !== null);
    if (!named.length) return set({ status: "No samples named with a note in that folder" });
    const zones: Zone[] = named.map((s) => ({ sampleId: s.id, root: rootFromName(s.name)! })).sort((a, b) => a.root - b.root);
    updateKeys({ type: "multi", zones, multiName: folderLabel(path) });
  }

  return (
    <div className="keys-panel">
      <Section title={`${trackName} · Keys instrument`}>
        <div className="row">
          {(["synth", "sample", "chromatic", "multi"] as const).map((t) => (
            <button key={t} className={keys.type === t ? "on" : ""} onClick={() => updateKeys({ type: t })}>
              {t === "synth" ? "Synth" : t === "sample" ? "Sample" : t === "chromatic" ? "Pad sample" : "Multisample"}
            </button>
          ))}
          <Slider label="Volume" value={keys.volume} min={0} max={1} format={pct} onChange={(v) => updateKeys({ volume: v })} />
        </div>
      </Section>

      {keys.type === "synth" && <PresetBar />}

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
            <Slider label="Detune" value={synth.detune} min={-2400} max={2400} step={1} format={(v) => `${v} ct`} onChange={(v) => upSynth({ detune: v })} />
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

      {keys.type === "sample" && (
        <Section title="Sample on keys">
          <p className="hint" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
            e.preventDefault();
            const f = [...e.dataTransfer.files][0];
            if (f) void loadSample(f);
          }}>
            One sound played across the keys and pads, at its own pitch on the root note. Pick it below, or drop a file here.
          </p>
          <div className="row wrap">
            <Field label="Sample">
              <SamplePicker value={keys.sample.sampleId} allowNone onPick={(id) => {
                // A note in the name ("Bass_C2") becomes the root, as when dropping a file.
                const root = id ? rootFromName(get().samples[id]?.name ?? "") : null;
                upSample({ sampleId: id, root: root ?? keys.sample.root });
              }} />
            </Field>
            <Field label="Root note">
              <select value={keys.sample.root} onChange={(e) => upSample({ root: Number(e.target.value) })} title="The key that plays the sample at its original pitch">
                {Array.from({ length: 97 }, (_, i) => i + 12).map((n) => <option key={n} value={n}>{noteName(n)}</option>)}
              </select>
            </Field>
          </div>
          <div className="sliders">
            <Slider label="Attack" value={keys.sample.attack} min={0} max={2} step={0.001} format={ms} onChange={(v) => upSample({ attack: v })} />
            <Slider label="Release" value={keys.sample.release} min={0.01} max={2} format={ms} onChange={(v) => upSample({ release: v })} />
            <Slider label="Cutoff" value={keys.sample.cutoff} min={0} max={1} format={(v) => (v >= 1 ? "Open" : hz(v))} onChange={(v) => upSample({ cutoff: v })} />
            <Slider label="Resonance" value={keys.sample.resonance} min={0} max={1} format={pct} onChange={(v) => upSample({ resonance: v })} />
          </div>
        </Section>
      )}

      {keys.type === "chromatic" && (
        <Section title="Pad sample on keys">
          <p className="hint">Plays a pad's sample across the keyboard. C4 = original pitch. Uses that pad's start, end, filter and envelope.</p>
          <Field label="Source pad">
            <select value={`${keys.sourceTrack}:${keys.sourcePad}`} onChange={(e) => {
              const [track, pad] = e.target.value.split(":");
              updateKeys({ sourceTrack: track, sourcePad: Number(pad) });
            }}>
              {drumTracks.map((t) => (
                <optgroup key={t.id} label={t.name}>
                  {t.pads.map((p, i) => <option key={i} value={`${t.id}:${i}`}>{i + 1}: {p.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
        </Section>
      )}

      {keys.type === "multi" && (
        <Section title={`Multisample${keys.multiName ? ` · ${keys.multiName}` : ""}`} actions={
          <SamplePicker value={null} placeholder={keys.multiName || "Pick a folder…"} folderAction={{ label: "Use this folder", only: true, run: loadMulti }} />
        }>
          <p className="hint">Pick a folder of samples named with their note (e.g. <code>Piano_C4.wav</code>, <code>Rhodes A#2.wav</code>, or a MIDI number like <code>060</code>). Each key uses the nearest sample.</p>
          <div className="row wrap">
            {keys.zones.map((z) => <span className="chip" key={z.sampleId}>{noteName(z.root)}</span>)}
            {!keys.zones.length && <span className="hint">No zones loaded.</span>}
          </div>
        </Section>
      )}

      <Section title="LFO">
        <p className="hint">
          Vibrato wobbles the pitch, the filter LFO sweeps the cutoff (set Cutoff below open for a full sweep). Depth 0 = off.
          Launchkey: encoder page <b>LFO</b>.
        </p>
        <div className="sliders">
          <Slider label="Vib rate" value={keys.lfo.vibRate} min={0.1} max={20} step={0.1} format={(v) => `${v.toFixed(1)} Hz`} onChange={(v) => upLfo({ vibRate: v })} />
          <Slider label="Vib depth" value={keys.lfo.vibDepth} min={0} max={1} step={0.01} format={(v) => (v ? `±${Math.round(v * 100)} ct` : "Off")} onChange={(v) => upLfo({ vibDepth: v })} />
          <Slider label="Filter rate" value={keys.lfo.filterRate} min={0.1} max={20} step={0.1} format={(v) => `${v.toFixed(1)} Hz`} onChange={(v) => upLfo({ filterRate: v })} />
          <Slider label="Filter depth" value={keys.lfo.filterDepth} min={0} max={1} step={0.01} format={(v) => (v ? `±${(v * 2).toFixed(1)} oct` : "Off")} onChange={(v) => upLfo({ filterDepth: v })} />
        </div>
      </Section>

      <Section title="Try it">
        <MiniKeyboard />
      </Section>
    </div>
  );
}

/** Pick, step through, save and delete Keys synth presets. Launchkey: encoder page Keys, encoder 1. */
function PresetBar() {
  const current = useApp((s) => keysTrack(s).keys!.preset);
  const userPresets = useApp((s) => s.userPresets);
  useApp((s) => keysTrack(s).keys); // re-render the "*" when the synth is edited
  const [name, setName] = useState("");
  const list = allPresets();
  const i = list.findIndex((p) => p.name === current);
  const step = (d: number) => applyPreset(list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + d))]);
  const isUser = userPresets.some((p) => p.name === current);

  return (
    <Section title={`Preset · ${presetLabel()}`} actions={
      <>
        <button onClick={() => step(-1)} disabled={i <= 0} aria-label="Previous preset">◀</button>
        <select value={i >= 0 ? current : ""} onChange={(e) => { const p = list.find((x) => x.name === e.target.value); if (p) applyPreset(p); }}>
          {i < 0 && <option value="">{current}</option>}
          <optgroup label="Factory">{FACTORY_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</optgroup>
          {userPresets.length > 0 && <optgroup label="Mine">{userPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</optgroup>}
        </select>
        <button onClick={() => step(1)} disabled={i >= list.length - 1} aria-label="Next preset">▶</button>
      </>
    }>
      <p className="hint">A * means the sound was edited since the preset was loaded. Launchkey: encoder page <b>Keys</b>, encoder 1 scrolls presets.</p>
      <div className="row">
        <input placeholder="Preset name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={async () => { await saveUserPreset(name); setName(""); }}>Save as preset</button>
        {isUser && <button onClick={() => deleteUserPreset(current)} title="Delete this saved preset (the current sound stays)">Delete “{current}”</button>}
      </div>
    </Section>
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
