import { useState } from "react";
import { loadFilesToPads, playPad, releasePad } from "../actions";
import { useApp } from "../state/store";
import { paletteCss } from "./controls";

const ROWS = [
  [8, 9, 10, 11, 12, 13, 14, 15],
  [0, 1, 2, 3, 4, 5, 6, 7],
];

export function PadGrid() {
  const pads = useApp((s) => s.project.pads);
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
                  // Lower on the pad = softer, like a velocity-sensitive pad.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const vel = Math.round(40 + 87 * (1 - (e.clientY - rect.top) / rect.height));
                  playPad(i, vel);
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
