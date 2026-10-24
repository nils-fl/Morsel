import { addDrumTrack } from "../actions";
import { addTrack, canAddTrack, canRemoveTrack, moveTrack, removeTrack, selectTrack, set, useApp } from "../state/store";
import { MAX_TRACKS, type TrackKind } from "../state/types";
import { inkOn, paletteCss } from "./palette";

const KIND_ICON: Record<TrackKind, string> = { drum: "▦", keys: "♪" };

/** Tracks 1-8: click to select. The pads play the last drum track picked, the keybed the last keys track. */
export function TrackStrip() {
  const tracks = useApp((s) => s.project.tracks);
  const selected = useApp((s) => s.selectedTrack);
  const drum = useApp((s) => s.drumTrack);
  const keys = useApp((s) => s.keysTrack);
  const canAdd = useApp((s) => canAddTrack(s.project));
  const canRemove = useApp((s) => canRemoveTrack(s.project, s.selectedTrack));
  const add = (kind: TrackKind) => {
    if (kind === "drum") void addDrumTrack();
    else if (!addTrack(kind)) set({ status: `Up to ${MAX_TRACKS} tracks` });
  };
  return (
    <div className="tracks">
      {tracks.map((t, i) => (
        <button
          key={t.id}
          className={`trk ${t.id === selected ? "on" : ""} ${t.mute ? "muted" : ""}`}
          style={{ "--trk": paletteCss(t.color), "--on-pad": inkOn(paletteCss(t.color)) } as React.CSSProperties}
          onClick={() => selectTrack(t.id)}
          title={`${t.name}: ${t.kind === "drum" ? "drum rack" : "keys"}${t.id === drum ? " · on the pads" : ""}${t.id === keys ? " · on the keybed" : ""}`}
        >
          <i>{i + 1}</i>
          <span>{KIND_ICON[t.kind]} {t.name}</span>
          {(t.id === drum || t.id === keys) && <em title={t.id === drum ? "Pads play this track" : "Keybed plays this track"}>{t.id === drum ? "PADS" : "KEYS"}</em>}
        </button>
      ))}
      <span className="trk-actions">
        <button disabled={!canAdd} onClick={() => add("drum")} title="Add a drum rack track with the factory kit">+ Drums</button>
        <button disabled={!canAdd} onClick={() => add("keys")} title="Add a keys track">+ Keys</button>
        <button onClick={() => moveTrack(selected, -1)} disabled={tracks[0]?.id === selected} aria-label="Move track left">◀</button>
        <button onClick={() => moveTrack(selected, 1)} disabled={tracks[tracks.length - 1]?.id === selected} aria-label="Move track right">▶</button>
        <button
          disabled={!canRemove}
          title={canRemove ? "Delete the selected track and its clips (Undo brings it back)" : "The last drum track and the last keys track stay"}
          onClick={() => removeTrack(selected)}
        >✕</button>
      </span>
    </div>
  );
}
