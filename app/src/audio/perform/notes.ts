// Note values for the Perform effects' tempo-synced settings (speeds, divisions, delay times), in beats (quarter notes).

export interface NoteValue {
  label: string;
  beats: number;
}

const n = (label: string, beats: number): NoteValue => ({ label, beats });

/** LFO speeds of the sweeping Pad FX (phaser, comb, the three filters): one cycle per value. */
export const SPEEDS: NoteValue[] = [
  n("2 bars", 8), n("1 bar", 4), n("1/2", 2), n("1/4", 1), n("1/4t", 2 / 3), n("1/8", 0.5), n("1/8t", 1 / 3),
  n("1/16", 0.25), n("1/16t", 1 / 6), n("1/32", 0.125), n("1/64", 0.0625),
];

/** Slice lengths of Beat Repeat and Rev Stepper. */
export const DIVISIONS: NoteValue[] = [
  n("1/4", 1), n("1/4t", 2 / 3), n("1/8", 0.5), n("1/8t", 1 / 3), n("1/16", 0.25), n("1/16t", 1 / 6), n("1/32", 0.125),
  n("1/64", 0.0625),
];

/** Delay times (d = dotted, t = triplet). */
export const DELAY_TIMES: NoteValue[] = [
  n("1/1", 4), n("1/2", 2), n("1/4d", 1.5), n("1/4", 1), n("1/4t", 2 / 3), n("1/8d", 0.75), n("1/8", 0.5), n("1/8t", 1 / 3),
  n("1/16d", 0.375), n("1/16", 0.25), n("1/16t", 1 / 6), n("1/32d", 0.1875), n("1/32", 0.125), n("1/32t", 1 / 12),
  n("1/64d", 0.09375), n("1/64", 0.0625), n("1/64t", 1 / 24),
];

/** Rates of the tempo-synced Knob FX (the Pumper, the tape delay). */
export const RATES: NoteValue[] = [
  n("1 bar", 4), n("1/2", 2), n("1/2t", 4 / 3), n("1/4", 1), n("1/4t", 2 / 3), n("1/8", 0.5), n("1/8t", 1 / 3),
  n("1/16", 0.25), n("1/16t", 1 / 6), n("1/32", 0.125), n("1/32t", 1 / 12),
];

/** Frames in `beats` beats at `bpm`. */
export const beatFrames = (beats: number, bpm: number, sampleRate: number) => (beats * 60 * sampleRate) / bpm;
