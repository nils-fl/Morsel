// Step mode reads like a 16-step sequencer: top row = steps 1-8, bottom row = 9-16.
export const stepForPad = (pad: number) => (pad >= 8 ? pad - 8 : pad + 8);
export const padForStep = (step: number) => (step < 8 ? step + 8 : step - 8);
