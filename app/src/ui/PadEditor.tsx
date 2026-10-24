import { useEffect, useRef, useState } from "react";
import {
  chopSelected, confirmDeleteSample, deleteSavedKit, folderToPads, kitNames, stepKit, renameSavedKit, loadNamedKit, openInChop, saveCurrentKit, samplingLevel, shareTab,
  toggleSampling, unshareTab,
} from "../actions";
import { DECAY_MAX } from "../audio/dsp";
import { hz } from "../params";
import { engine } from "../audio/engine";
import { TAB_WORDS } from "../audio/recorder";
import { KIT_ACCEPT, KIT_EXT } from "../state/fileFormat";
import { exportKit, importKit } from "../state/projectFile";
import { download } from "../seq/render";
import { drumPads, drumTrack, set, updatePad, useApp } from "../state/store";
import { STOCK_KITS, type SampleSource, type SampleTarget } from "../state/types";
import { Field, Section, Slider } from "./controls";
import { paletteCss } from "./palette";
import { ColorPicker } from "./ColorPicker";
import { Waveform } from "./Waveform";
import { SamplePicker } from "./SamplePicker";
import { SidechainPanel } from "./Sidechain";
import { connectFolder, diskSupported } from "../browse/disk";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);

export function PadEditor() {
  const i = useApp((s) => s.selectedPad);
  const pad = useApp((s) => drumPads(s)[s.selectedPad]);
  const trackName = useApp((s) => drumTrack(s).name);
  useApp((s) => s.bufferTick); // the waveform appears once the sample's audio has loaded
  const buffer = pad.sampleId ? engine.buffer(pad.sampleId) : undefined;
  // Other pads cut from the same sample, drawn as thin markers.
  const slices = useApp(drumPads)
    .filter((p, j) => j !== i && p.sampleId && p.sampleId === pad.sampleId)
    .flatMap((p) => [p.start, p.end]);
  const up = (patch: Parameters<typeof updatePad>[1]) => updatePad(i, patch);

  return (
    <div className="pad-editor">
      <Section
        title={`${trackName} · Pad ${i + 1} · ${pad.name}`}
        actions={
          <>
            {!diskSupported() && <span className="hint" title="Samples come from connected folders (File System Access)">Connect folder needs Chrome or Edge</span>}
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
            <SamplePicker value={pad.sampleId} onPick={(id) => up({ sampleId: id, start: 0, end: 1 })} folderAction={{
              label: "Folder → pads",
              title: "Put this folder's first 16 samples on pads 1–16 as a kit",
              run: folderToPads,
            }} />
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
          <Field label="Colour">
            <ColorPicker value={pad.color} onPick={(c) => up({ color: c })} label="Pad colour" />
          </Field>
        </div>
        {/* One column per stage of the sound: what plays, its envelope, its filter, where it goes. */}
        <div className="slider-groups">
          <div className="slider-group">
            <h4 className="sub-head">Sample</h4>
            <Slider label="Start" value={pad.start} min={0} max={1} step={0.001} format={pct} onChange={(v) => up({ start: v })} />
            <Slider label="End" value={pad.end} min={0} max={1} step={0.001} format={pct} onChange={(v) => up({ end: v })} />
            <Slider label="Pitch" value={pad.pitch} min={-24} max={24} step={0.1} format={(v) => `${v.toFixed(1)} st`} onChange={(v) => up({ pitch: v })} />
          </div>
          <div className="slider-group">
            <h4 className="sub-head">Envelope</h4>
            <Slider label="Attack" value={pad.attack} min={0} max={1} step={0.001} format={ms} onChange={(v) => up({ attack: v })} />
            <Slider label="Decay" value={pad.decay} min={0.02} max={DECAY_MAX} step={0.01} format={(v) => (v >= DECAY_MAX ? "Full" : ms(v))} onChange={(v) => up({ decay: v })} />
          </div>
          <div className="slider-group">
            <h4 className="sub-head">Filter</h4>
            <Slider label="High-pass" value={pad.hpCutoff} min={0} max={1} format={(v) => (v <= 0 ? "Off" : hz(v))} onChange={(v) => up({ hpCutoff: v })} />
            <Slider label="Low-pass" value={pad.cutoff} min={0} max={1} format={(v) => (v >= 1 ? "Open" : hz(v))} onChange={(v) => up({ cutoff: v })} />
            <Slider label="Resonance" value={pad.resonance} min={0} max={1} format={pct} onChange={(v) => up({ resonance: v })} />
          </div>
          <div className="slider-group">
            <h4 className="sub-head">Output</h4>
            <Slider label="Pan" value={pad.pan} min={-1} max={1} format={(v) => v.toFixed(2)} onChange={(v) => up({ pan: v })} />
            <Slider label="Volume" value={pad.volume} min={0} max={1} format={pct} onChange={(v) => up({ volume: v })} />
          </div>
        </div>
      </Section>
      <div className="panels">
        <KitPanel />
        <SampleChopPanel />
        <SidechainPanel />
      </div>
    </div>
  );
}

/** Getting sounds onto pads: record a take, or slice the selected pad's sample across the next pads. */
function SampleChopPanel() {
  const [count, setCount] = useState(8);
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
    <Section title="Sample & chop">
      <h4 className="sub-head first">Record</h4>
      <p className="hint">
        {source === "tab" && !tabShared
          ? TAB_WORDS.hint
          : `Shift + Record (or ● Sample) arms a take; it starts with the sound${source === "tab" ? " (press play in the tab), up to 2 min" : ", up to 30 s"}. ` +
            (target === "chop" ? "The take opens in Chop with its hits marked; Function on the Launchkey makes a new drum rack." : `The take goes on pad ${pad + 1}.`)}
      </p>
      <div className="row">
        <select value={source} disabled={sampling !== "idle"} onChange={(e) => set({ sampleSource: e.target.value as SampleSource })}>
          <option value="input">Audio input</option>
          <option value="master">Resample (master out)</option>
          <option value="tab">{TAB_WORDS.source}</option>
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
            : <button disabled={sampling !== "idle"} onClick={() => void shareTab()}>{TAB_WORDS.share}</button>}
          <span className={`hint tab-state ${tabShared ? "on" : ""}`}>{tabShared ? "● Shared" : "Not shared"}</span>
        </div>
      )}
      <div className="meter"><div style={{ width: `${Math.min(100, level * 100)}%` }} /></div>
      <h4 className="sub-head">Chop pad {pad + 1}</h4>
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

/** This drum track's kit: pick or step through kits (like the Keys presets; Launchkey: encoder page Kit, encoder 1),
 *  and save, rename, import, export and delete your own. */
function KitPanel() {
  const kit = useApp((s) => drumTrack(s).kit);
  const kits = useApp((s) => s.kits); // re-render when kits are saved or deleted
  const list = kitNames();
  const saved = list.slice(STOCK_KITS.length);
  const at = list.indexOf(kit);
  const [name, setName] = useState("");
  // The saved kit last picked here: the one Rename renames.
  const [picked, setPicked] = useState<string | null>(null);
  const canRename = !!picked && kits.includes(picked) && !!name.trim() && name.trim() !== picked;
  const kitInput = useRef<HTMLInputElement>(null);
  return (
    <Section title="Kit" actions={
      <>
        <button onClick={() => stepKit(-1)} disabled={at === 0} aria-label="Previous kit">◀</button>
        <select value={at >= 0 ? kit : ""} title="Load a kit onto this drum track (Undo brings the pads back)" onChange={(e) => e.target.value && void loadNamedKit(e.target.value)}>
          {at < 0 && <option value="">{kit || "—"}</option>}
          <optgroup label="Built-in">{STOCK_KITS.map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>
          {saved.length > 0 && <optgroup label="Saved">{saved.map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>}
        </select>
        <button onClick={() => stepKit(1)} disabled={at >= list.length - 1} aria-label="Next kit">▶</button>
      </>
    }>
      <p className="hint tip">Built-in kits are synthesized; your saved kits follow them in the list. ◀ ▶ load the previous / next kit. Launchkey: encoder page <b>Kit</b>, encoder 1 scrolls the kits.</p>
      <input ref={kitInput} type="file" accept={KIT_ACCEPT} multiple hidden onChange={async (e) => {
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
        <input placeholder="Save the pads as…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Kit name" />
        {/* Save and Rename show once they can do something: a name typed, and for Rename a saved kit picked below. */}
        {name.trim() && <button onClick={() => void saveCurrentKit(name)}>Save</button>}
        {canRename && <button title={`Rename “${picked}” to the name typed here`} onClick={async () => {
          if (picked && (await renameSavedKit(picked, name))) setPicked(name.trim());
        }}>Rename</button>}
      </div>
      <div className="row">
        <button onClick={() => kitInput.current?.click()} title="Import one or more .morsel-kit files">Import…</button>
        <button title="Save the pads as a kit file with their samples, to share or keep (named as typed above, or after the kit)" onClick={() => {
          const file = name.trim() || kit || "Kit";
          void exportKit(file, drumPads()).then((blob) => download(blob, `${file}${KIT_EXT}`));
        }}>Export…</button>
      </div>
      {kits.length > 0 && <h4 className="sub-head">Saved kits</h4>}
      <div className="row wrap">
        {kits.map((k) => (
          <span key={k} className="kit-chip">
            <button className={k === picked ? "on" : ""} onClick={() => { setName(k); setPicked(k); void loadNamedKit(k); }}>{k}</button>
            <button onClick={() => void deleteSavedKit(k)} aria-label={`Delete kit ${k}`} title="Delete this kit">✕</button>
          </span>
        ))}
      </div>
      <p className="hint tip">Launchkey: Shift + Encoder ⌃ → Kits. On a sample folder, Shift + Function puts it on the pads.</p>
    </Section>
  );
}
