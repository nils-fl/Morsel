// Step mode reads like a 16-step sequencer: top row = steps 1-8, bottom row = 9-16. On a triplet grid the rows hold
// 6 steps (two beats), from the left; the last two pads of each row are unused.
/** The step (on the page) a pad edits, or -1 for a pad past the row's `perRow` steps. */
export const stepForPad = (pad: number, perRow = 8) => {
  const col = pad % 8;
  if (col >= perRow) return -1;
  return pad >= 8 ? col : col + perRow;
};
export const padForStep = (step: number, perRow = 8) => (step < perRow ? step + 8 : step - perRow);

/** On a keys track the pads are notes: pad 1 (bottom left) = C3, one semitone per pad, top row continues. */
export const KEYS_PAD_BASE = 48;
export const noteForKeysPad = (pad: number) => KEYS_PAD_BASE + pad;
