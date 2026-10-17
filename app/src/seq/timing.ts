export const PPQN = 96;
export const STEP_TICKS = PPQN / 4; // a 16th note
export const BAR_TICKS = PPQN * 4;

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
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/8", ticks: STEP_TICKS * 2 },
  { label: "1/4", ticks: PPQN },
];

export const REPEAT_OPTIONS = [
  { label: "1/8", ticks: STEP_TICKS * 2 },
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/16T", ticks: PPQN / 6 },
  { label: "1/32", ticks: STEP_TICKS / 2 },
];
