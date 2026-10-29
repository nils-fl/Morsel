// Dragging an effect of a track's FX rack onto another slot moves it there in the chain (the encoder strip's FX page,
// the Mixer's rack chips). Only within the same track.
import type { DragEvent } from "react";
import { moveFx } from "../state/store";

const MIME = "application/x-morsel-fx";

/** What to spread on the thing grabbed: the effect at chain position `i` of `trackId`. */
export const fxDragSource = (trackId: string, i: number) => ({
  draggable: true,
  onDragStart: (e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(MIME, `${trackId}:${i}`);
    e.dataTransfer.effectAllowed = "move";
  },
});

/** What to spread on a slot an effect can be dropped on; `setOver` marks the slot under the pointer (null: none). */
export const fxDropTarget = (trackId: string, i: number, setOver: (i: number | null) => void) => ({
  onDragOver: (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(i);
  },
  onDragLeave: () => setOver(null),
  onDrop: (e: DragEvent) => {
    setOver(null);
    const [track, from] = e.dataTransfer.getData(MIME).split(":");
    if (track !== trackId || from === undefined) return;
    e.preventDefault();
    moveFx(Number(from), i, trackId);
  },
});
