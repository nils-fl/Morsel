import { useRef, useState } from "react";
import { engine } from "../audio/engine";
import { arrangement, download, encodeWav, renderToBuffer } from "../seq/render";
import { exportProject, importProject } from "../state/projectFile";
import { get, set, updateProject, useApp } from "../state/store";
import { Section } from "./controls";

export function SongPanel() {
  const song = useApp((s) => s.project.song);
  const songMode = useApp((s) => s.songMode);
  const patterns = useApp((s) => s.project.patterns);
  const [loops, setLoops] = useState(4);
  const [busy, setBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const setSong = (fn: (s: typeof song) => typeof song) => updateProject((p) => ({ ...p, song: fn(p.song) }));

  async function bounce(useSong: boolean) {
    setBusy(true);
    try {
      const s = get();
      const buf = await renderToBuffer(s.project, arrangement(s.project, useSong, s.currentPattern, loops));
      const name = `${s.project.name}-${useSong ? "song" : `pattern${s.currentPattern + 1}`}.wav`;
      download(encodeWav(buf), name);
      set({ status: `Exported ${name} (${buf.duration.toFixed(1)} s)` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="song-panel">
      <Section
        title="Song"
        actions={
          <>
            <label className="field inline">
              <input type="checkbox" checked={songMode} onChange={(e) => set({ songMode: e.target.checked })} />
              <span>Play as song</span>
            </label>
            <button onClick={() => setSong((s) => [...s, { pattern: get().currentPattern, repeats: 1 }])}>+ Add current pattern</button>
          </>
        }
      >
        <p className="hint">Hardware: Function → Pattern mode, then hold Scene and tap a pad to add that pattern to the song.</p>
        <ol className="song-list">
          {song.map((step, i) => (
            <li key={i}>
              <select value={step.pattern} onChange={(e) => setSong((s) => s.map((x, j) => (j === i ? { ...x, pattern: Number(e.target.value) } : x)))}>
                {patterns.map((p, j) => <option key={j} value={j}>Pattern {j + 1}{p.events.length ? "" : " (empty)"}</option>)}
              </select>
              <span>×</span>
              <input type="number" min={1} max={64} value={step.repeats} onChange={(e) => setSong((s) => s.map((x, j) => (j === i ? { ...x, repeats: Math.max(1, Number(e.target.value)) } : x)))} />
              <button disabled={i === 0} onClick={() => setSong((s) => { const n = [...s]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>
              <button onClick={() => setSong((s) => s.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Export audio">
        <div className="row">
          <button disabled={busy} onClick={() => bounce(true)}>Bounce song to WAV</button>
          <span className="hint">or</span>
          <button disabled={busy} onClick={() => bounce(false)}>Bounce current pattern</button>
          <span>×</span>
          <input type="number" min={1} max={64} value={loops} onChange={(e) => setLoops(Math.max(1, Number(e.target.value)))} />
          <span className="hint">loops</span>
        </div>
      </Section>

      <Section title="Project">
        <div className="row">
          <input value={useApp((s) => s.project.name)} onChange={(e) => updateProject((p) => ({ ...p, name: e.target.value }), false)} />
          <button onClick={async () => download(await exportProject(), `${get().project.name}.launchkit.json`)}>Export project</button>
          <button onClick={() => importInput.current?.click()}>Import project…</button>
          <input ref={importInput} type="file" accept=".json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await importProject(f, engine);
          }} />
        </div>
        <p className="hint">Projects autosave in this browser. Export saves the patterns and every sample in one file.</p>
      </Section>
    </div>
  );
}
