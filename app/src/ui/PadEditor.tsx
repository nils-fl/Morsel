import { useEffect, useRef, useState } from "react";
import {
  chopSelected, confirmDeleteSample, deleteSavedKit, stepKit, renameSavedKit, importToLibrary, loadFilesToPads, loadFolderToPads, loadNamedKit, openInChop, saveCurrentKit, samplingLevel, shareTab,
  toggleSampling, unshareTab,
} from "../actions";
import { DECAY_MAX } from "../audio/dsp";
import { DUCK_PAGE, duckSourceLabel, duckTargetLabel, duckTargets, hz, padLabel, setDuck } from "../params";
import { engine } from "../audio/engine";
import { exportKit, importKit } from "../state/projectFile";
import { download } from "../seq/render";
import { drumPads, drumTrack, get, set, updatePad, useApp } from "../state/store";
import { DUCK_ALL, FACTORY_KIT, PAD_COUNT, type SampleSource, type SampleTarget } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { PALETTE_CHOICES, paletteCss } from "./palette";
import { Waveform } from "./Waveform";
import { SamplePicker } from "./SamplePicker";
import { connectFolder, diskSupported } from "../browse/disk";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

export function PadEditor() {
  const i = useApp((s) => s.selectedPad);
  const pad = useApp((s) => drumPads(s)[s.selectedPad]);
  const trackName = useApp((s) => drumTrack(s).name);
  useApp((s) => s.bufferTick); // the waveform appears once the sample's audio has loaded
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const kitFolderInput = useRef<HTMLInputElement>(null);
  const buffer = pad.sampleId ? engine.buffer(pad.sampleId) : undefined;
  // Other pads cut from the same sample, drawn as thin markers.
  const slices = useApp(drumPads)
    .filter((p, j) => j !== i && p.sampleId && p.sampleId === pad.sampleId)
    .flatMap((p) => [p.start, p.end]);
  const up = (patch: Parameters<typeof updatePad>[1]) => updatePad(i, patch);

  return (
    <div className="pad-editor">
      <KitBar />
      <Section
        title={`${trackName} · Pad ${i + 1} · ${pad.name}`}
        color={paletteCss(pad.color)}
        actions={
          <>
            <button onClick={() => fileInput.current?.click()} title="Load files onto this pad and the ones after it">Load file…</button>
            <input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={(e) => e.target.files && loadFilesToPads([...e.target.files], i)} />
            <button onClick={() => kitFolderInput.current?.click()} title="Import a folder and put its first 16 samples (by name) on pads 1–16 as a kit">Folder → pads…</button>
            <input ref={kitFolderInput} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void loadFolderToPads(files);
            }} />
            <button onClick={() => folderInput.current?.click()} title="Copies a folder of samples into this browser's library. For big sample packs, use Connect folder">Import folder…</button>
            <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void importToLibrary(files);
            }} />
            {diskSupported() && <button onClick={() => void connectFolder()} title="Browse a folder on this computer in place (Sample ▾ or Browse on the Launchkey); a sample is copied in only when you use it">Connect folder…</button>}
            <button onClick={() => updatePad(i, { sampleId: null, name: `Pad ${i + 1}` }, true)} title="Empty this pad (the sample stays in the library)">Clear</button>
            <button disabled={!pad.sampleId} onClick={() => pad.sampleId && confirmDeleteSample(pad.sampleId)} title="Delete this pad's sample from the library and every pad using it">Delete sample</button>
          </>
        }
      >
        <Waveform color={paletteCss(pad.color)} buffer={buffer} start={pad.start} end={pad.end} slices={slices} onChange={(start, end) => up({ start, end })} />
        <div className="row wrap">
          <Field label="Name">
            <input value={pad.name} maxLength={12} onChange={(e) => up({ name: e.target.value })} />
          </Field>
          <Field label="Sample">
            <SamplePicker value={pad.sampleId} onPick={(id) => up({ sampleId: id, start: 0, end: 1 })} />
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
        <KitPanel />
        <SamplingPanel />
        <ChopPanel />
        <SidechainPanel />
      </div>
    </div>
  );
}

function SamplingPanel() {
  const sampling = useApp((s) => s.sampling);
  const source = useApp((s) => s.sampleSource);
  const pad = useApp((s) => s.selectedPad);
  const tabShared = useApp((s) => s.tabShared);
  const target = useApp((s) => s.sampleTarget);
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
        {source === "tab" && !tabShared
          ? "Share the YouTube tab once (tick “Share tab audio” in Chrome's picker). After that the Launchkey runs the takes."
          : `Shift + Record (or ● Sample) arms a take; it starts with the sound${source === "tab" ? " (press play in the tab), up to 2 min" : ", up to 30 s"}. ` +
            (target === "chop" ? "The take opens in Chop with its hits marked; Function on the Launchkey makes a new drum rack." : `The take goes on pad ${pad + 1}.`)}
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
        <select value={target} onChange={(e) => set({ sampleTarget: e.target.value as SampleTarget })} title="Where a take lands">
          <option value="chop">Take → Chop</option>
          <option value="pad">Take → pad {pad + 1}</option>
        </select>
      </div>
      {source === "tab" && (
        <div className="row">
          {tabShared
            ? <button disabled={sampling !== "idle"} onClick={unshareTab}>Stop sharing</button>
            : <button disabled={sampling !== "idle"} onClick={() => void shareTab()}>Share tab…</button>}
          <span className={`hint tab-state ${tabShared ? "on" : ""}`}>{tabShared ? "● Shared" : "Not shared"}</span>
        </div>
      )}
      <div className="meter"><div style={{ width: `${Math.min(100, level * 100)}%` }} /></div>
    </Section>
  );
}

function SidechainPanel() {
  const duck = useApp((s) => s.project.duck);
  useApp((s) => s.project.tracks); // track and pad names in the labels
  const onDuckPage = useApp((s) => s.encPage === DUCK_PAGE);
  const [level, setLevel] = useState(1);
  useEffect(() => {
    if (!duck.on) return;
    let raf = 0;
    const tick = () => {
      setLevel(engine.voices.duckLevel(duck.target));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duck.on, duck.target]);

  return (
    <Section title="Sidechain" actions={
      <button className={duck.on ? "on" : ""} onClick={() => setDuck({ on: !duck.on })}>{duck.on ? "On" : "Off"}</button>
    }>
      <p className="hint" title="Launchkey: on the Duck encoder page, hitting a pad makes it the input">
        Input hits dip the target. Launchkey: <b>Duck</b> page{onDuckPage ? " (open)" : ""}, hit a pad = input.
      </p>
      <div className="row wrap">
        <Field label="Input">
          <select value={`${duck.sourceTrack}:${duck.sourcePad}`} title={duckSourceLabel()} onChange={(e) => {
            const [track, pad] = e.target.value.split(":");
            setDuck({ sourceTrack: track, sourcePad: Number(pad) });
          }}>
            {get().project.tracks.filter((t) => t.kind === "drum").map((t) => (
              <optgroup key={t.id} label={t.name}>
                {Array.from({ length: PAD_COUNT }, (_, i) => <option key={i} value={`${t.id}:${i}`}>{padLabel(t.id, i)}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Target">
          <select value={duck.target} onChange={(e) => setDuck({ target: e.target.value })}>
            {duckTargets().map((t) => <option key={t} value={t}>{t === DUCK_ALL ? "All others" : duckTargetLabel(t)}</option>)}
          </select>
        </Field>
      </div>
      <Slider label="Depth" value={duck.depth} min={0} max={1} format={pct} onChange={(v) => setDuck({ depth: v })} />
      <Slider label="Attack" value={duck.attack} min={0} max={0.05} step={0.001} format={ms} onChange={(v) => setDuck({ attack: v })} />
      <Slider label="Hold" value={duck.hold} min={0} max={0.5} step={0.01} format={ms} onChange={(v) => setDuck({ hold: v })} />
      <Slider label="Release" value={duck.release} min={0.02} max={1} step={0.01} format={ms} onChange={(v) => setDuck({ release: v })} />
      <div className="meter duck-meter" title="Gain reduction on the target"><div style={{ width: `${Math.round((1 - (duck.on ? level : 1)) * 100)}%` }} /></div>
    </Section>
  );
}

function ChopPanel() {
  const [count, setCount] = useState(8);
  const pad = useApp((s) => s.selectedPad);
  return (
    <Section title="Chop">
      <p className="hint">Slices the pad's region across pads {pad + 1}–{Math.min(16, pad + count)}.</p>
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

/** Pick and step through kits for this drum track, like the Keys presets. Launchkey: encoder page Kit, encoder 1. */
function KitBar() {
  const kit = useApp((s) => drumTrack(s).kit);
  const kits = useApp((s) => s.kits);
  const list = [FACTORY_KIT, ...kits];
  const i = list.indexOf(kit);
  return (
    <Section title={`Kit · ${kit || "none"}`} actions={
      <>
        <button onClick={() => stepKit(-1)} disabled={i === 0} aria-label="Previous kit">◀</button>
        <select value={i >= 0 ? kit : ""} title="Load a kit onto this drum track (Undo brings the pads back)" onChange={(e) => e.target.value && void loadNamedKit(e.target.value)}>
          {i < 0 && <option value="">{kit || "—"}</option>}
          <option value={FACTORY_KIT}>{FACTORY_KIT}</option>
          {kits.length > 0 && <optgroup label="Saved">{kits.map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>}
        </select>
        <button onClick={() => stepKit(1)} disabled={i >= list.length - 1} aria-label="Next kit">▶</button>
      </>
    }>
      <p className="hint">◀ ▶ load the previous / next kit. Launchkey: encoder page <b>Kit</b>, encoder 1 scrolls the kits.</p>
    </Section>
  );
}

function KitPanel() {
  const kits = useApp((s) => s.kits);
  const [name, setName] = useState("");
  // The saved kit last picked here: the one Rename renames.
  const [picked, setPicked] = useState<string | null>(null);
  const canRename = !!picked && kits.includes(picked) && !!name.trim() && name.trim() !== picked;
  const kitInput = useRef<HTMLInputElement>(null);
  return (
    <Section title="Kits" actions={
      <>
        <button onClick={() => kitInput.current?.click()} title="Import one or more .morsel-kit.json files">Import kits…</button>
        <button disabled={!name.trim()} title="Save the pads as a kit file with their samples, to share or keep" onClick={() => {
          void exportKit(name.trim(), drumPads()).then((blob) => download(blob, `${name.trim()}.morsel-kit.json`));
        }}>Export kit…</button>
      </>
    }>
      <input ref={kitInput} type="file" accept=".json" multiple hidden onChange={async (e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        const failed: string[] = [];
        let last = "";
        for (const f of files) {
          try {
            last = await importKit(f, engine);
          } catch (err) {
            failed.push(`${f.name}: ${(err as Error).message}`);
          }
        }
        const ok = files.length - failed.length;
        if (files.length > 1 || failed.length) {
          set({ status: `Imported ${ok} kit${ok === 1 ? "" : "s"}${ok ? ` (${last} is on the pads)` : ""}${failed.length ? ` · failed: ${failed.join("; ")}` : ""}` });
        }
      }} />
      <div className="row">
        <input placeholder="Kit name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => void saveCurrentKit(name)}>Save</button>
        <button disabled={!canRename} title={picked ? `Rename “${picked}” to the name typed here` : "Pick a saved kit below first"} onClick={async () => {
          if (picked && (await renameSavedKit(picked, name))) setPicked(name.trim());
        }}>Rename</button>
      </div>
      <div className="row wrap">
        <button onClick={() => void loadNamedKit(FACTORY_KIT)} title="The built-in synthesized kit">{FACTORY_KIT}</button>
        {kits.map((k) => (
          <span key={k} className="kit-chip">
            <button className={k === picked ? "on" : ""} onClick={() => { setName(k); setPicked(k); void loadNamedKit(k); }}>{k}</button>
            <button onClick={() => void deleteSavedKit(k)} aria-label={`Delete kit ${k}`} title="Delete this kit">✕</button>
          </span>
        ))}
      </div>
      <p className="hint">Launchkey: Shift + Encoder ⌃ → Kits. On a sample folder, Shift + Function puts it on the pads.</p>
    </Section>
  );
}
