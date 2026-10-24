import { useState } from "react";
import { entryToPads, keyOff, keyOn, loadFilesToPads, playPad, releasePad, repeatPadDown, repeatPadUp, setRepeatLatch } from "../actions";
import { noteForKeysPad } from "../modes/stepMap";
import { REPEAT_OPTIONS } from "../seq/timing";
import { drumPads, drumTrack, selectedTrack, set, useApp } from "../state/store";
import type { Track } from "../state/types";
import { droppedEntry } from "./drawer";
import { noteName } from "./notes";
import { inkOn, paletteCss } from "./palette";

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

/** The bar over the pads: whose pads they are, and the pads' own controls on the right. */
function PadsBar({ track, detail, children }: { track: Track; detail: string; children?: React.ReactNode }) {
  return (
    <div className="pads-bar" style={{ "--trk": paletteCss(track.color) } as React.CSSProperties}>
      <span className="pads-track">{track.kind === "drum" ? "▦" : "♪"} {track.name}</span>
      <span className="pads-detail">{detail}</span>
      {children && <div className="pads-tools">{children}</div>}
    </div>
  );
}

function DrumPads() {
  const track = useApp(drumTrack);
  const pads = useApp(drumPads);
  const selected = useApp((s) => s.selectedPad);
  const [hit, setHit] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<number | null>(null);
  const latch = useApp((s) => s.repeatLatch);
  const rate = useApp((s) => s.repeatRate);
  const down = (i: number, vel: number) => (latch ? repeatPadDown(i, vel) : playPad(i, vel));
  const up = (i: number) => {
    setHit(null);
    if (latch) repeatPadUp(i);
    releasePad(i);
  };

  return (
    <div className="pad-grid">
      <PadsBar track={track} detail={`Kit · ${track.kit || "—"}`}>
        <button
          className={latch ? "on" : ""}
          onClick={() => setRepeatLatch(!latch)}
          title="Note repeat: a held pad repeats at this rate. On the Launchkey: hold Scene ›, or press it twice to latch."
        >Repeat</button>
        <select value={rate} onChange={(e) => set({ repeatRate: Number(e.target.value) })} aria-label="Repeat rate">
          {REPEAT_OPTIONS.map((o) => <option key={o.label} value={o.ticks}>{o.label}</option>)}
        </select>
      </PadsBar>
      {ROWS.map((row, r) => (
        <div className="pad-row" key={r}>
          {row.map((i) => {
            const pad = pads[i];
            return (
              <button
                key={i}
                className={`pad ${i === selected ? "selected" : ""} ${hit === i ? "hit" : ""} ${dropOn === i ? "drop" : ""} ${pad.sampleId ? "" : "empty"}`}
                style={{ "--pad": paletteCss(pad.color), "--on-pad": inkOn(paletteCss(pad.color)) } as React.CSSProperties}
                onPointerDown={(e) => {
                  setHit(i);
                  down(i, velocityAt(e));
                }}
                onPointerUp={() => up(i)}
                onPointerLeave={() => hit === i && up(i)}
                onDragOver={(e) => { e.preventDefault(); setDropOn(i); }}
                onDragLeave={() => setDropOn(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropOn(null);
                  const entry = droppedEntry(e.dataTransfer);
                  if (entry) void entryToPads(entry, i);
                  else void loadFilesToPads([...e.dataTransfer.files], i);
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
      <PadsBar track={track} detail={`Notes ${noteName(noteForKeysPad(0))}–${noteName(noteForKeysPad(15))}`} />
      {ROWS.map((row, r) => (
        <div className="pad-row" key={r}>
          {row.map((i) => {
            const note = noteForKeysPad(i);
            return (
              <button
                key={i}
                className={`pad ${hit === i ? "hit" : ""} ${note % 12 === 0 ? "selected" : ""}`}
                style={{ "--pad": paletteCss(track.color), "--on-pad": inkOn(paletteCss(track.color)) } as React.CSSProperties}
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
