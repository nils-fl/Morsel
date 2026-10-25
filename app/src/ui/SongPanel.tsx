import { useState } from "react";
import { arrangement, download, encodeWav, renderToBuffer } from "../seq/render";
import { get, patternHasNotes, set, updateProject, useApp } from "../state/store";
import { Section } from "./controls";
import { Matrix } from "./Matrix";

export function SongPanel() {
  const song = useApp((s) => s.project.song);
  const songMode = useApp((s) => s.songMode);
  const patterns = useApp((s) => s.project.patterns);
  const [loops, setLoops] = useState(4);
  const bits = useApp((s) => s.bounceBits);
  const [busy, setBusy] = useState(false);

  const setSong = (fn: (s: typeof song) => typeof song) => updateProject((p) => ({ ...p, song: fn(p.song) }));

  async function bounce(useSong: boolean) {
    setBusy(true);
    try {
      const s = get();
      const buf = await renderToBuffer(s.project, arrangement(s.project, useSong, s.currentPattern, loops));
      const name = `${s.project.name}-${useSong ? "song" : `pattern${s.currentPattern + 1}`}.wav`;
      download(encodeWav(buf, bits), name);
      set({ status: `Exported ${name} (${buf.duration.toFixed(1)} s)` });
    } catch (err) {
      set({ status: `Bounce failed: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="song-panel">
      <Matrix />
      <div className="panels">
        <Section
          title="Song"
          actions={
            <>
              <label className="field inline">
                <input type="checkbox" checked={songMode} onChange={(e) => set({ songMode: e.target.checked })} />
                <span>Play as song</span>
              </label>
              <button onClick={() => setSong((s) => [...s, { pattern: get().currentPattern, repeats: 1 }])}>+ Add current sequence</button>
            </>
          }
        >
          <p className="hint tip">Each step plays a sequence (a row of the matrix) with every track's clip. Hardware: Function → Pattern mode, then hold Scene and tap a pad to add that sequence to the song.</p>
          <ol className="song-list">
            {song.map((step, i) => (
              <li key={i}>
                <select value={step.pattern} onChange={(e) => setSong((s) => s.map((x, j) => (j === i ? { ...x, pattern: Number(e.target.value) } : x)))}>
                  {patterns.map((p, j) => <option key={j} value={j}>Sequence {j + 1}{patternHasNotes(p) ? "" : " (empty)"}</option>)}
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
          {/* Two lines across the panel: what to bounce, then how (the pattern's loops, the bit depth). */}
          <div className="row even">
            <button disabled={busy} onClick={() => bounce(true)}>Bounce song to WAV</button>
            <button disabled={busy} onClick={() => bounce(false)}>Bounce current pattern</button>
          </div>
          <div className="row">
            <span className="hint">Pattern</span>
            <span>×</span>
            <input type="number" min={1} max={64} value={loops} onChange={(e) => setLoops(Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1))))} aria-label="Pattern loops" />
            <span className="hint">loops</span>
            <select className="push-end" value={bits} onChange={(e) => set({ bounceBits: Number(e.target.value) as 16 | 24 })} aria-label="Bit depth">
              <option value={24}>24-bit WAV</option>
              <option value={16}>16-bit WAV</option>
            </select>
          </div>
        </Section>
      </div>
    </div>
  );
}
