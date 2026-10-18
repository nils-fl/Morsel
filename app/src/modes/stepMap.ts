// Step mode reads like a 16-step sequencer: top row = steps 1-8, bottom row = 9-16.
export const stepForPad = (pad: number) => (pad >= 8 ? pad - 8 : pad + 8);
export const padForStep = (step: number) => (step < 8 ? step + 8 : step - 8);

/** On a keys track the pads are notes: pad 1 (bottom left) = C3, one semitone per pad, top row continues. */
export const KEYS_PAD_BASE = 48;
export const noteForKeysPad = (pad: number) => KEYS_PAD_BASE + pad;
