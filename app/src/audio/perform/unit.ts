// What every Perform effect sees, and what it is to the engine.
import type { History } from "./dsp";

/** The engine's clock and the mix's recent past, updated every frame before the effects run. */
export interface PerformCtx {
  readonly sampleRate: number;
  /** Frames per beat at the current tempo. */
  beatLen: number;
  /** Beats since the grid's origin (a bar start), fractional; the tempo-synced LFOs and gates follow it. */
  beat: number;
  /** Absolute frame (History positions). */
  frame: number;
  /** Every frame that came into the engine, before any effect. */
  history: History;
}

/** One effect: works on one stereo frame at a time, in place. */
export interface Unit {
  /** Settings changed (raw values, as in catalog.ts). */
  set(values: readonly number[]): void;
  /** The pad went down (or the effect was picked): time effects start capturing here. */
  start(ctx: PerformCtx): void;
  /** Process `io` (left, right) with `amount` 0..1 (pad pressure; Knob FX: 1). */
  tick(io: [number, number], amount: number, ctx: PerformCtx): void;
  /** Still sounding with amount 0 (a delay or reverb tail after the pad is let go). */
  readonly tails?: boolean;
  /** Clear state (tails, buffers). */
  reset(): void;
}

/** A stereo pair of `T`, one per channel. */
export const pair = <T>(make: () => T): [T, T] => [make(), make()];
