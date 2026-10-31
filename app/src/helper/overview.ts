// The helper screen's extras beyond the Launchkey's screen, worked out from the project: the selected track's whole clip
// as steps (Step mode) and every track's clip at a glance (Track mode). Plain data in and out.
import { BAR_TICKS } from "../seq/timing";
import { clipOf, trackAudible, trackBars } from "../state/store";
import type { NoteEvent, Project } from "../state/types";

export interface StepOverview {
  bars: number;
  /** Steps in a bar (16 on a 1/16 grid, 12 on a triplet one). */
  perBar: number;
  /** Per step of the clip: the loudest note's velocity (0..1), or null for an empty step. */
  vel: (number | null)[];
  /** The page on the pads: its first step and how many steps it has. */
  pageFirst: number;
  pageLen: number;
  /** The step playing, or -1. */
  playhead: number;
  /** Steps held down on the pads. */
  held: number[];
}

export function stepOverview(events: readonly NoteEvent[], o: {
  bars: number; span: number; drum: boolean; note: number; pageFirst: number; pageLen: number; playTick: number | null; heldTicks: number[];
}): StepOverview {
  const perBar = Math.max(1, Math.round(BAR_TICKS / o.span));
  const total = o.bars * perBar;
  const vel: (number | null)[] = Array.from({ length: total }, () => null);
  for (const e of events) {
    if (o.drum && e.note !== o.note) continue;
    const i = Math.floor(e.tick / o.span);
    if (i >= 0 && i < total) vel[i] = Math.max(vel[i] ?? 0, e.vel / 127);
  }
  return {
    bars: o.bars, perBar, vel, pageFirst: o.pageFirst, pageLen: o.pageLen,
    playhead: o.playTick === null || o.playTick < 0 ? -1 : Math.floor(o.playTick / o.span),
    held: o.heldTicks.map((t) => Math.floor(t / o.span)),
  };
}

export interface TrackRow {
  number: number;
  name: string;
  kind: "drum" | "keys";
  selected: boolean;
  mute: boolean;
  solo: boolean;
  /** Heard right now (not muted, and no other track soloed). */
  audible: boolean;
  level: number;
  /** The clip's length in the current pattern. */
  bars: number;
  /** Where its notes are, as fractions of the clip (one per distinct 1/32). */
  notes: number[];
  /** Where it is playing, as a fraction of the clip, or null. */
  playhead: number | null;
}

export function trackRows(p: Project, pattern: number, selected: string, playTick: (trackId: string) => number | null): TrackRow[] {
  const pat = p.patterns[pattern];
  return p.tracks.map((t, i) => {
    const bars = trackBars(pat, t.id), len = bars * BAR_TICKS;
    const slots = new Set(clipOf(pat, t.id).events.filter((e) => e.tick < len).map((e) => Math.floor(e.tick / (BAR_TICKS / 32))));
    const tick = playTick(t.id);
    return {
      number: i + 1, name: t.name, kind: t.kind, selected: t.id === selected, mute: t.mute, solo: t.solo,
      audible: trackAudible(p, t.id), level: t.level, bars,
      notes: [...slots].sort((a, b) => a - b).map((k) => (k * (BAR_TICKS / 32)) / len),
      playhead: tick === null || tick < 0 ? null : (tick % len) / len,
    };
  });
}
