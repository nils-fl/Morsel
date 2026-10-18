import { useEffect, useRef, useState } from "react";
import { chopSelected, loadFilesToPads, openInChop, samplingLevel, shareTab, toggleSampling, unshareTab } from "../actions";
import { DECAY_MAX } from "../audio/dsp";
import { hz } from "../params";
import { engine } from "../audio/engine";
import { listKits, loadKit, saveKit } from "../state/persist";
import { importKit } from "../state/projectFile";
import { get, set, updatePad, updateProject, useApp } from "../state/store";
import type { SampleSource, TabTarget } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { PALETTE_CHOICES, paletteCss } from "./palette";
import { Waveform } from "./Waveform";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

export function PadEditor() {
  const i = useApp((s) => s.selectedPad);
  const pad = useApp((s) => s.project.pads[s.selectedPad]);
  const samples = useApp((s) => s.samples);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const buffer = pad.sampleId ? engine.buffer(pad.sampleId) : undefined;
  // Other pads cut from the same sample, drawn as thin markers.
  const slices = useApp((s) => s.project.pads)
    .filter((p, j) => j !== i && p.sampleId && p.sampleId === pad.sampleId)
    .flatMap((p) => [p.start, p.end]);
  const up = (patch: Parameters<typeof updatePad>[1]) => updatePad(i, patch);

  return (
    <div className="pad-editor">
      <Section
        title={`Pad ${i + 1} · ${pad.name}`}
        color={paletteCss(pad.color)}
        actions={
          <>
            <button onClick={() => fileInput.current?.click()}>Load file…</button>
            <input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={(e) => e.target.files && loadFilesToPads([...e.target.files], i)} />
            <button onClick={() => folderInput.current?.click()} title="Adds a folder of samples to the library (browse it on the Launchkey with Shift + Pad up)">Import folder…</button>
            <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={async (e) => {
              const files = [...(e.target.files ?? [])].filter((f) => /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name));
              for (const f of files) await engine.addFile(f).catch(() => undefined);
              set({ status: `Imported ${files.length} samples into the library` });
            }} />
            <button onClick={() => updatePad(i, { sampleId: null, name: `Pad ${i + 1}` }, true)}>Clear</button>
          </>
        }
      >
        <Waveform color={paletteCss(pad.color)} buffer={buffer} start={pad.start} end={pad.end} slices={slices} onChange={(start, end) => up({ start, end })} />
        <div className="row wrap">
          <Field label="Name">
            <input value={pad.name} maxLength={12} onChange={(e) => up({ name: e.target.value })} />
          </Field>
          <Field label="Sample">
            <select value={pad.sampleId ?? ""} onChange={(e) => up({ sampleId: e.target.value || null, start: 0, end: 1 })}>
              <option value="">—</option>
              {Object.values(samples).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Mode">
            <select value={pad.mode} onChange={(e) => up({ mode: e.target.value as "oneshot" | "gate" })}>
              <option value="oneshot">One-shot</option>
              <option value="gate">Note on (gate)</option>
            </select>
          </Field>
          <Field label="Choke">
            <select value={pad.choke} onChange={(e) => up({ choke: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4].map((c) => <option key={c} value={c}>{c ? `Group ${c}` : "Off"}</option>)}
            </select>
          </Field>
          <Field label="Reverse">
            <input type="checkbox" checked={pad.reverse} onChange={(e) => up({ reverse: e.target.checked })} />
          </Field>
          <div className="swatches">
            {PALETTE_CHOICES.map((c) => (
              <button key={c} className={`swatch ${c === pad.color ? "on" : ""}`} style={{ background: paletteCss(c) }} onClick={() => up({ color: c })} aria-label={`colour ${c}`} />
            ))}
          </div>
        </div>
        <div className="sliders">
          <Slider label="Start" value={pad.start} min={0} max={1} step={0.001} format={pct} onChange={(v) => up({ start: v })} />
          <Slider label="End" value={pad.end} min={0} max={1} step={0.001} format={pct} onChange={(v) => up({ end: v })} />
          <Slider label="Pitch" value={pad.pitch} min={-24} max={24} step={0.1} format={(v) => `${v.toFixed(1)} st`} onChange={(v) => up({ pitch: v })} />
          <Slider label="Attack" value={pad.attack} min={0} max={1} step={0.001} format={ms} onChange={(v) => up({ attack: v })} />
          <Slider label="Decay" value={pad.decay} min={0.02} max={DECAY_MAX} step={0.01} format={(v) => (v >= DECAY_MAX ? "Full" : ms(v))} onChange={(v) => up({ decay: v })} />
          <Slider label="HP Filter" value={pad.hpCutoff} min={0} max={1} format={(v) => (v <= 0 ? "Off" : hz(v))} onChange={(v) => up({ hpCutoff: v })} />
          <Slider label="LP Filter" value={pad.cutoff} min={0} max={1} format={(v) => (v >= 1 ? "Open" : hz(v))} onChange={(v) => up({ cutoff: v })} />
          <Slider label="Resonance" value={pad.resonance} min={0} max={1} format={pct} onChange={(v) => up({ resonance: v })} />
          <Slider label="Pan" value={pad.pan} min={-1} max={1} format={(v) => v.toFixed(2)} onChange={(v) => up({ pan: v })} />
          <Slider label="Volume" value={pad.volume} min={0} max={1} format={pct} onChange={(v) => up({ volume: v })} />
        </div>
      </Section>
      <div className="row wrap">
        <SamplingPanel />
        <ChopPanel />
        <KitPanel />
      </div>
    </div>
  );
}

function SamplingPanel() {
  const sampling = useApp((s) => s.sampling);
  const source = useApp((s) => s.sampleSource);
  const pad = useApp((s) => s.selectedPad);
  const tabShared = useApp((s) => s.tabShared);
  const tabTarget = useApp((s) => s.tabTarget);
  const [polled, setLevel] = useState(0);
  useEffect(() => {
    if (sampling === "idle") return;
    const id = setInterval(() => setLevel(samplingLevel()), 50);
    return () => clearInterval(id);
  }, [sampling]);
  // Idle: show an empty meter instead of the last polled level.
  const level = sampling === "idle" ? 0 : polled;

  return (
    <Section title="Sample">
      <p className="hint">
        {source !== "tab"
          ? `Records onto pad ${pad + 1}. Starts when the sound crosses the threshold. Hardware: Shift + Record.`
          : tabShared
            ? `Tab shared. Shift + Record (or ● Sample) arms a take; it starts when the tab plays. Up to 2 min → ${tabTarget === "pad" ? `pad ${pad + 1}` : "Chop"}.`
            : "Share the YouTube tab once (tick “Share tab audio” in Chrome's picker). After that the Launchkey runs the takes."}
      </p>
      <div className="row">
        <select value={source} disabled={sampling !== "idle"} onChange={(e) => set({ sampleSource: e.target.value as SampleSource })}>
          <option value="input">Audio input</option>
          <option value="master">Resample (master out)</option>
          <option value="tab">Browser tab (YouTube…)</option>
        </select>
        <button className={sampling !== "idle" ? "rec on" : "rec"} onClick={() => toggleSampling()}>
          {sampling === "idle" ? "● Sample" : sampling === "waiting" ? "Waiting… (stop)" : "■ Stop"}
        </button>
      </div>
      {source === "tab" && (
        <div className="row">
          {tabShared
            ? <button disabled={sampling !== "idle"} onClick={unshareTab}>Stop sharing</button>
            : <button disabled={sampling !== "idle"} onClick={() => void shareTab()}>Share tab…</button>}
          <span className={`hint tab-state ${tabShared ? "on" : ""}`}>{tabShared ? "● Shared" : "Not shared"}</span>
          <select value={tabTarget} onChange={(e) => set({ tabTarget: e.target.value as TabTarget })} title="Where a take lands">
            <option value="pad">Take → selected pad</option>
            <option value="chop">Take → Chop editor</option>
          </select>
        </div>
      )}
      <div className="meter"><div style={{ width: `${Math.min(100, level * 100)}%` }} /></div>
    </Section>
  );
}

function ChopPanel() {
  const [count, setCount] = useState(8);
  const pad = useApp((s) => s.selectedPad);
  return (
    <Section title="Chop">
      <p className="hint">Slices the selected pad's region across pads {pad + 1}–{Math.min(16, pad + count)}.</p>
      <div className="row">
        <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[2, 4, 8, 16].map((n) => <option key={n} value={n}>{n} slices</option>)}
        </select>
        <button onClick={() => chopSelected("equal", Math.min(count, 16 - pad))}>Equal</button>
        <button onClick={() => chopSelected("transient", Math.min(count, 16 - pad))}>Transients</button>
        <button onClick={openInChop} title="Place, move and audition slices by hand">Editor…</button>
      </div>
    </Section>
  );
}

function KitPanel() {
  const [kits, setKits] = useState<string[]>([]);
  const [name, setName] = useState("");
  const kitInput = useRef<HTMLInputElement>(null);
  useEffect(() => { listKits().then(setKits); }, []);
  return (
    <Section title="Kits" actions={<button onClick={() => kitInput.current?.click()}>Import kit…</button>}>
      <input ref={kitInput} type="file" accept=".json" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        try {
          await importKit(f, engine);
          setKits(await listKits());
        } catch (err) {
          set({ status: `Kit import failed: ${(err as Error).message}` });
        }
      }} />
      <div className="row">
        <input placeholder="Kit name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name} onClick={async () => { await saveKit(name, get().project.pads); setKits(await listKits()); }}>Save</button>
      </div>
      <div className="row wrap">
        {kits.map((k) => (
          <button key={k} onClick={async () => {
            const pads = await loadKit(k);
            if (pads) updateProject((p) => ({ ...p, pads }));
          }}>{k}</button>
        ))}
        {!kits.length && <span className="hint">No saved kits yet.</span>}
      </div>
    </Section>
  );
}
