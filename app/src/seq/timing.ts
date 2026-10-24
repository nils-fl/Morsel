export const PPQN = 96;
export const STEP_TICKS = PPQN / 4; // a 16th note
export const BAR_TICKS = PPQN * 4;
/** The longest a track's loop can be. */
export const MAX_BARS = 16;
/** How far a note can be nudged off a step of `step` ticks: just under half a step. */
export const maxNudge = (step: number) => step / 2 - 1;
/** How far a note can be nudged off a 16th step. */
export const MAX_NUDGE = maxNudge(STEP_TICKS);

/** The step grids a clip can be edited on (Clip.step), in ticks per step. */
export const GRID_OPTIONS = [
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/32", ticks: STEP_TICKS / 2 },
  { label: "1/8T", ticks: PPQN / 3 },
  { label: "1/16T", ticks: PPQN / 6 },
];
export const gridLabel = (step: number) => GRID_OPTIONS.find((g) => g.ticks === step)?.label ?? "1/16";
/** Triplet grids: three or six steps a beat. */
export const isTriplet = (step: number) => (PPQN / step) % 3 === 0;

// The Launchkey shows a page of steps on its 16 pads, two rows that each hold whole beats: a bar of 16ths (two
// rows of 8), half a bar of 32nds (a beat per row), a bar of 8th triplets or half a bar of 16th triplets (rows of 6).
/** Steps in a pad row. */
export const rowSteps = (step: number) => (isTriplet(step) ? 6 : 8);
/** Steps on the pads at once. */
export const pageSteps = (step: number) => rowSteps(step) * 2;

export const secondsPerTick = (bpm: number) => 60 / bpm / PPQN;

// MPC-style swing: 50 = straight, 75 = the off-beat 16th lands halfway to the next one.
export function swingOffsetTicks(tick: number, swing: number): number {
  if (swing <= 50 || tick % STEP_TICKS !== 0) return 0;
  const step = tick / STEP_TICKS;
  if (step % 2 === 0) return 0;
  return ((Math.min(swing, 75) - 50) / 25) * (STEP_TICKS / 2);
}

// Snap to the nearest grid line, wrapping around the pattern length.
export function quantizeTick(tick: number, grid: number, length: number): number {
  if (grid <= 0) return Math.round(tick) % length;
  return (Math.round(tick / grid) * grid) % length;
}

export const QUANTIZE_OPTIONS = [
  { label: "Off", ticks: 0 },
  { label: "1/32", ticks: STEP_TICKS / 2 },
  { label: "1/16T", ticks: PPQN / 6 },
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/8T", ticks: PPQN / 3 },
  { label: "1/8", ticks: STEP_TICKS * 2 },
  { label: "1/4", ticks: PPQN },
];

export const REPEAT_OPTIONS = [
  { label: "1/8", ticks: STEP_TICKS * 2 },
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/16T", ticks: PPQN / 6 },
  { label: "1/32", ticks: STEP_TICKS / 2 },
];

/** The tick a note sounds on in a loop of `length` ticks: its own tick plus its nudge, wrapped. */
export function soundTick(e: { tick: number; nudge?: number }, length: number): number {
  return (((e.tick + (e.nudge ?? 0)) % length) + length) % length;
}

/**
 * Move notes towards the nearest line of a `grid`-tick grid by `strength` (1 = onto it), as they sound (nudge
 * included, which is folded into the tick). Notes stay inside the clip; two hits of the same note landing together
 * become one, the louder.
 */
export function quantizeEvents<E extends { tick: number; note: number; vel: number; nudge?: number }>(events: E[], grid: number, strength: number, clipTicks: number): E[] {
  const out = new Map<string, E>();
  for (const e of events) {
    const at = e.tick + (e.nudge ?? 0);
    const tick = ((Math.round(at + (Math.round(at / grid) * grid - at) * strength) % clipTicks) + clipTicks) % clipTicks;
    const { nudge: _, ...rest } = e;
    const q = { ...rest, tick } as E;
    const key = `${tick}:${e.note}`;
    const had = out.get(key);
    if (!had || had.vel < e.vel) out.set(key, q);
  }
  return [...out.values()];
}

/**
 * Loosen notes up a little: velocity ±10 and timing ±2 ticks, times `amount` (0..1), nudges staying within `limit`.
 * `rand` returns 0..1.
 */
export function humanizeEvents<E extends { vel: number; nudge?: number }>(events: E[], amount: number, rand = Math.random, limit = MAX_NUDGE): E[] {
  return events.map((e) => {
    const vel = Math.max(1, Math.min(127, Math.round(e.vel + (rand() * 2 - 1) * 10 * amount)));
    const nudge = Math.max(-limit, Math.min(limit, Math.round((e.nudge ?? 0) + (rand() * 2 - 1) * 2 * amount)));
    const { nudge: _, ...rest } = e;
    return (nudge ? { ...rest, vel, nudge } : { ...rest, vel }) as E;
  });
}

