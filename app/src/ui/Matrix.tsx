import { useState } from "react";
import { sequencer } from "../seq/sequencer";
import { clearTrack, clipOf, copyClip, patternLength, selectTrack, set, useApp } from "../state/store";
import { Section } from "./controls";
import { paletteCss } from "./palette";

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
    </>}>
      <p className="hint">
        Click a row number to {playing ? "queue" : "play"} that sequence, a cell to edit that track's clip. The selected cell is {track?.name ?? "—"} in sequence {current + 1}.
      </p>
      <div className="matrix" style={{ "--cols": p.tracks.length } as React.CSSProperties}>
        <span />
        {p.tracks.map((t) => (
          <button key={t.id} className={`mx-head ${t.id === selected ? "on" : ""}`} style={{ "--trk": paletteCss(t.color) } as React.CSSProperties} onClick={() => selectTrack(t.id)}>
            {t.name}
          </button>
        ))}
        {p.patterns.map((pat, i) => (
          <div key={i} className={`mx-row ${i === current ? "now" : ""} ${i === queued ? "queued" : ""}`}>
            <button className="mx-num" onClick={() => sequencer.selectPattern(i)}>{i + 1}</button>
            {p.tracks.map((t) => {
              const clip = clipOf(pat, t.id);
              const steps = pat.bars * 16;
              // Density strip: one tick per 16th that has a note.
              const lit = new Set(clip.events.map((e) => Math.floor((e.tick / patternLength(pat)) * steps)));
              return (
                <button
                  key={t.id}
                  className={`mx-cell ${clip.events.length ? "used" : ""} ${i === current && t.id === selected ? "sel" : ""}`}
                  style={{ "--trk": paletteCss(t.color), "--steps": steps } as React.CSSProperties}
                  title={`${t.name} · sequence ${i + 1}: ${clip.events.length} note${clip.events.length === 1 ? "" : "s"}`}
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
