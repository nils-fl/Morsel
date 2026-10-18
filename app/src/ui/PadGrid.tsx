import { useState } from "react";
import { keyOff, keyOn, loadFilesToPads, playPad, releasePad } from "../actions";
import { noteForKeysPad } from "../modes/stepMap";
import { drumPads, selectedTrack, useApp } from "../state/store";
import type { Track } from "../state/types";
import { noteName } from "./notes";
import { paletteCss } from "./palette";

const ROWS = [
  [8, 9, 10, 11, 12, 13, 14, 15],
  [0, 1, 2, 3, 4, 5, 6, 7],
];

/** Lower on the pad = softer, like a velocity-sensitive pad. */
const velocityAt = (e: React.PointerEvent<HTMLElement>) => {
  const rect = e.currentTarget.getBoundingClientRect();
  return Math.round(40 + 87 * (1 - (e.clientY - rect.top) / rect.height));
};

/** The 16 pads of the selected track: its drum rack, or notes of its keys instrument (as on the Launchkey). */
export function PadGrid() {
  const track = useApp(selectedTrack);
  return track.kind === "drum" ? <DrumPads /> : <NotePads track={track} />;
}

function DrumPads() {
  const pads = useApp(drumPads);
  const selected = useApp((s) => s.selectedPad);
  const [hit, setHit] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<number | null>(null);

  return (
    <div className="pad-grid">
      {ROWS.map((row, r) => (
        <div className="pad-row" key={r}>
          {row.map((i) => {
            const pad = pads[i];
            return (
              <button
                key={i}
                className={`pad ${i === selected ? "selected" : ""} ${hit === i ? "hit" : ""} ${dropOn === i ? "drop" : ""} ${pad.sampleId ? "" : "empty"}`}
                style={{ "--pad": paletteCss(pad.color) } as React.CSSProperties}
                onPointerDown={(e) => {
                  setHit(i);
                  playPad(i, velocityAt(e));
                }}
                onPointerUp={() => { setHit(null); releasePad(i); }}
                onPointerLeave={() => hit === i && (setHit(null), releasePad(i))}
                onDragOver={(e) => { e.preventDefault(); setDropOn(i); }}
                onDragLeave={() => setDropOn(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropOn(null);
                  loadFilesToPads([...e.dataTransfer.files], i);
                }}
              >
                <span className="pad-num">{i + 1}</span>
                <span className="pad-name">{pad.name}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function NotePads({ track }: { track: Track }) {
  const [hit, setHit] = useState<number | null>(null);
  const release = (i: number) => {
    setHit(null);
    keyOff(noteForKeysPad(i), track.id);
  };

  return (
    <div className="pad-grid">
      {ROWS.map((row, r) => (
        <div className="pad-row" key={r}>
          {row.map((i) => {
            const note = noteForKeysPad(i);
            return (
              <button
                key={i}
                className={`pad ${hit === i ? "hit" : ""} ${note % 12 === 0 ? "selected" : ""}`}
                style={{ "--pad": paletteCss(track.color) } as React.CSSProperties}
                onPointerDown={(e) => {
                  setHit(i);
                  keyOn(note, velocityAt(e), track.id);
                }}
                onPointerUp={() => release(i)}
                onPointerLeave={() => hit === i && release(i)}
              >
                <span className="pad-num">{i + 1}</span>
                <span className="pad-name">{noteName(note)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
