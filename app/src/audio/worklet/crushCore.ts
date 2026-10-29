// The bitcrusher's lower sample rate: each sample held for a few frames. Pure code shared by the worklet and the tests.

export const CRUSH_PROCESSOR_NAME = "morsel-crush";

/** Frames each sample is held for: rate 1 = every frame (the full rate), 0 = 32 frames (a 32nd of it). */
export const crushHold = (rate: number) => Math.max(1, Math.round(Math.pow(32, 1 - Math.max(0, Math.min(1, rate)))));

/** Sample-and-hold over blocks, keeping its place across them so the steps stay even. */
export class CrushCore {
  private n = 0;
  private held: number[] = [];

  process(input: Float32Array[], output: Float32Array[], frames: number, hold: number) {
    for (let i = 0; i < frames; i++) {
      const take = this.n % hold === 0;
      for (let c = 0; c < output.length; c++) {
        const x = (input[c] ?? input[0])?.[i] ?? 0;
        if (take || this.held[c] === undefined) this.held[c] = x;
        output[c][i] = this.held[c];
      }
      this.n = (this.n + 1) % hold;
    }
  }
}
