import { useState } from "react";
import { sequencer } from "../seq/sequencer";
import { clearTrack, clipOf, copyClip, patternHasNotes, selectTrack, set, trackBars, trackLength, useApp } from "../state/store";
import { Section } from "./controls";
import { inkOn, paletteCss } from "./palette";

/** Sequences (rows) by tracks (columns). A cell is that track's clip in that sequence. */
export function Matrix() {
  const tracks = useApp((s) => s.project.tracks);
  const patterns = useApp((s) => s.project.patterns);
  const p = { tracks, patterns };
  const current = useApp((s) => s.currentPattern);
  const queued = useApp((s) => s.queuedPattern);
  const selected = useApp((s) => s.selectedTrack);
  const playing = useApp((s) => s.playing);
  const [copied, setCopied] = useState<{ pattern: number; track: string } | null>(null);
  const track = p.tracks.find((t) => t.id === selected);
  const song = useApp((s) => s.project.song);
  const [all, setAll] = useState(false);
  // Rows down to the last one in use (notes, selected, queued or in the song), then one empty row to start the next.
  const last = Math.max(
    p.patterns.reduce((n, pat, i) => (patternHasNotes(pat) ? i : n), -1),
    current, queued ?? -1, ...song.map((st) => st.pattern),
  );
  const shown = all ? p.patterns.length : Math.min(p.patterns.length, last + 2);

  return (
    <Section title="Matrix" actions={<>
      <button onClick={() => setCopied({ pattern: current, track: selected })} title="Copy the selected cell's clip">Copy clip</button>
      <button
        disabled={!copied || copied.track !== selected || copied.pattern === current}
        title={copied ? `Paste ${p.tracks.find((t) => t.id === copied.track)?.name ?? ""} clip from sequence ${copied.pattern + 1} (same track only)` : "Copy a clip first"}
        onClick={() => {
          if (!copied) return;
          copyClip(copied.pattern, current, copied.track);
          set({ status: `Pasted clip ${copied.pattern + 1} → ${current + 1}` });
        }}
      >Paste clip</button>
      <button onClick={() => clearTrack(current, selected)}>Clear clip</button>
      {(all || shown < p.patterns.length) && (
        <button className={all ? "on" : ""} onClick={() => setAll(!all)} title="Show every sequence, or only those in use and the next empty one">
          {all ? "Show used" : `Show all ${p.patterns.length}`}
        </button>
      )}
    </>}>
      <p className="hint tip">
        Click a row number to {playing ? "queue" : "play"} that sequence, a cell to edit that track's clip. The selected cell is {track?.name ?? "—"} in sequence {current + 1}.
      </p>
      <div className="matrix" style={{ "--cols": p.tracks.length } as React.CSSProperties}>
        <span />
        {p.tracks.map((t) => (
          <button key={t.id} className={`mx-head ${t.id === selected ? "on" : ""}`} style={{ "--trk": paletteCss(t.color), "--on-pad": inkOn(paletteCss(t.color)) } as React.CSSProperties} onClick={() => selectTrack(t.id)}>
            {t.name}
          </button>
        ))}
        {p.patterns.slice(0, shown).map((pat, i) => (
          <div key={i} className={`mx-row ${i === current ? "now" : ""} ${i === queued ? "queued" : ""}`}>
            <button className="mx-num" onClick={() => sequencer.selectPattern(i)}>{i + 1}</button>
            {p.tracks.map((t) => {
              const clip = clipOf(pat, t.id);
              const bars = trackBars(pat, t.id);
              const steps = Math.min(64, bars * 16);
              // Density strip: one tick per 16th that has a note (a longer clip in up to 64 columns), over its own length.
              const lit = new Set(clip.events.map((e) => Math.floor((e.tick / trackLength(pat, t.id)) * steps)));
              return (
                <button
                  key={t.id}
                  className={`mx-cell ${clip.events.length ? "used" : ""} ${i === current && t.id === selected ? "sel" : ""}`}
                  style={{ "--trk": paletteCss(t.color), "--steps": steps } as React.CSSProperties}
                  title={`${t.name} · sequence ${i + 1}: ${clip.events.length} note${clip.events.length === 1 ? "" : "s"}, ${bars} bar${bars === 1 ? "" : "s"}`}
                  onClick={() => {
                    selectTrack(t.id);
                    if (i !== current) sequencer.selectPattern(i);
                  }}
                >
                  {clip.events.length > 0 && <span className="mx-dens">{Array.from({ length: steps }, (_, k) => <i key={k} className={lit.has(k) ? "on" : ""} />)}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Section>
  );
}
