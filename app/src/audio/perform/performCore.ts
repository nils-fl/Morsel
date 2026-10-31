// The Perform engine: live effects on the whole mix, played from the pads (Pad FX, Flex Beat) and the encoders
// (Knob FX). Pure code shared by the master's perform worklet and the tests. It sits on the master bus before the
// glue and the limiter; with nothing engaged the mix passes through untouched.
import { MAX_PAD_FX, PAD_FX_COUNT, type PerformSettings } from "./catalog";
import { History, Ramp, Smooth } from "./dsp";
import { FLEX_PROGRAMS, FlexBeat } from "./flexBeat";
import { makeKnobFx } from "./knobFx";
import { makePadFx } from "./padFx";
import type { PerformCtx, Unit } from "./unit";

export const PERFORM_PROCESSOR_NAME = "morsel-perform";

/** Messages from the app to the engine. Times are in seconds of the audio clock. */
export type ToPerform =
  /** The grid: tempo and the audio time of a bar start (the transport's, or a free one while stopped). */
  | { t: "grid"; bpm: number; origin: number }
  /**
   * The Pad FX sounding now (at most MAX_PAD_FX) with their amounts (pressure, 0..1), and every one engaged
   * (`held`: held or latched, the bypassed ones too). One that goes from held to bypassed fades out and keeps its
   * place; when it comes back it carries on where it was. Only a Pad FX newly held starts afresh.
   */
  | { t: "pads"; active: { fx: number; amount: number }[]; held?: number[] }
  /** One Pad FX's amount changed (pad pressure). */
  | { t: "amount"; fx: number; amount: number }
  /** Settings changed. */
  | { t: "settings"; settings: PerformSettings }
  /** Flex Beat: play program `program` (0 = Empty: back to the plain mix). */
  | { t: "flex"; program: number };

/** Messages from the engine: a one-shot Flex Beat pass ended (the pads show Empty again). */
export type FromPerform = { t: "flexEnd" };

/** Seconds of the mix kept for the time effects (Beat Repeat, Half Speed, Flex Beat...). */
const HISTORY_SECONDS = 12;
/** A Pad FX's amount follows the pad's pressure with a linear ramp this long (seconds, full scale), as the MPC
 *  Sample's pad effects do. */
const AMOUNT_TIME = 0.025;
/** Switching a Pad FX on or off (or bypassing it) crossfades with the dry mix over this long. */
const SWITCH_TIME = 0.01;
/** A tail (delay, reverb) let go rings on for at most this long, then the effect stops being processed. */
const TAIL_SECONDS = 8;

interface PadSlot {
  unit: Unit;
  /** The pad's pressure, ramped. */
  amount: Ramp;
  /** In the chain (1) or not (0), ramped: the crossfade between the dry mix and the effect. */
  gain: Ramp;
  /** Engaged (held or latched), sounding or bypassed. */
  held: boolean;
  /** Frames a tail (delay, reverb) still rings for after the pad was let go. */
  ringing: number;
}

export class PerformCore {
  readonly sampleRate: number;
  private history: History;
  private ctx: PerformCtx;
  private pads: PadSlot[];
  /** The Pad FX being processed (sounding, fading or ringing out), in pad order: the chain runs pad 1 to 16. */
  private chain: number[] = [];
  private flex: FlexBeat;
  private knobs: Unit[];
  private knob = 0;
  private knobOn = false;
  private knobMix = 1;
  private knobWet: Smooth;
  private bpm = 120;
  private origin = 0;
  private flexQuantize = true;
  private flexOneShot = false;
  private io: [number, number] = [0, 0];
  private out: [number, number] = [0, 0];
  /** Called when a one-shot Flex Beat pass ends. */
  onFlexEnd: (() => void) | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.history = new History(HISTORY_SECONDS, sampleRate);
    this.ctx = { sampleRate, beatLen: (60 / this.bpm) * sampleRate, beat: 0, frame: 0, history: this.history };
    this.pads = makePadFx(sampleRate).map((unit) => ({
      unit, amount: new Ramp(AMOUNT_TIME, sampleRate), gain: new Ramp(SWITCH_TIME, sampleRate), held: false, ringing: 0,
    }));
    this.flex = new FlexBeat(sampleRate);
    this.flex.onEnd = () => this.onFlexEnd?.();
    this.knobs = makeKnobFx(sampleRate);
    this.knobWet = new Smooth(0.01, sampleRate);
  }

  message(m: ToPerform) {
    switch (m.t) {
      case "grid":
        this.bpm = Math.max(20, Math.min(400, m.bpm));
        this.origin = m.origin * this.sampleRate;
        this.ctx.beatLen = (60 / this.bpm) * this.sampleRate;
        break;
      case "pads": {
        const active = m.active.slice(0, MAX_PAD_FX).filter((a) => a.fx >= 0 && a.fx < PAD_FX_COUNT);
        const on = new Map(active.map((a) => [a.fx, Math.max(0, Math.min(1, a.amount))]));
        const held = new Set([...(m.held ?? []), ...on.keys()]);
        for (const [i, p] of this.pads.entries()) {
          const amount = on.get(i);
          if (amount !== undefined) {
            // Newly pressed: start afresh (a delay still ringing keeps its tail). Back from bypass: carry on.
            if (!p.held && !p.gain.value && p.ringing <= 0) p.unit.start(this.ctx);
            p.amount.target = amount;
            p.gain.target = 1;
            p.ringing = 0;
          } else if (p.unit.tails && p.gain.target) {
            // A tail effect let go (or bypassed) stops taking in the mix but rings on.
            p.amount.target = 0;
            p.ringing = TAIL_SECONDS * this.sampleRate;
          } else {
            p.gain.target = 0;
          }
          p.held = held.has(i);
        }
        this.chain = this.pads.flatMap((p, i) => (p.gain.target || p.gain.value || p.ringing > 0 ? [i] : []));
        break;
      }
      case "amount": {
        const p = this.pads[m.fx];
        if (p?.gain.target) p.amount.target = Math.max(0, Math.min(1, m.amount));
        break;
      }
      case "settings": {
        const s = m.settings;
        s.pad.forEach((v, i) => this.pads[i]?.unit.set(v));
        s.knob.params.forEach((v, i) => this.knobs[i]?.set(v));
        if (s.knob.kind !== this.knob) {
          this.knobs[s.knob.kind]?.start(this.ctx);
          this.knob = s.knob.kind;
        }
        this.knobOn = s.knob.on;
        this.knobMix = s.knob.mix;
        this.flex.setMix(s.flex.mix);
        this.flexQuantize = s.flex.quantize;
        this.flexOneShot = s.flex.oneShot;
        break;
      }
      case "flex": {
        const program = FLEX_PROGRAMS[m.program] ?? null;
        // Quantized, the change waits for the next bar line (the playing effect goes on until then).
        let start = this.ctx.frame;
        if (this.flexQuantize) {
          const next = Math.ceil(this.ctx.beat / 4 - 1e-9) * 4;
          start = Math.round(this.ctx.frame + (next - this.ctx.beat) * this.ctx.beatLen);
        }
        this.flex.set(program, start, this.flexOneShot);
        break;
      }
    }
  }

  /** Process `frames` frames from `input` (stereo; may be missing when nothing is connected) into `output`.
   *  `frame0` is the audio clock's frame at the block's start (AudioWorklet currentFrame). */
  process(input: Float32Array[], output: Float32Array[], frames: number, frame0: number) {
    const inL = input[0], inR = input[1] ?? input[0];
    const outL = output[0], outR = output[1] ?? output[0];
    const ctx = this.ctx;
    const io = this.io, out = this.out;
    const knobUnit = this.knobs[this.knob];
    for (let i = 0; i < frames; i++) {
      const l = inL?.[i] ?? 0, r = inR?.[i] ?? 0;
      ctx.beat = (frame0 + i - this.origin) / ctx.beatLen;
      ctx.frame = this.history.written;
      this.history.write(l, r);
      io[0] = l;
      io[1] = r;
      if (this.flex.active) {
        this.flex.tick(ctx.frame, ctx.beat, l, r, ctx.beatLen, this.history, out);
        io[0] = out[0];
        io[1] = out[1];
      }
      for (let k = 0; k < this.chain.length; k++) {
        const p = this.pads[this.chain[k]];
        const g = p.gain.next();
        const a = p.amount.next();
        const dl = io[0], dr = io[1];
        p.unit.tick(io, a, ctx);
        if (g < 1) {
          io[0] = dl + (io[0] - dl) * g;
          io[1] = dr + (io[1] - dr) * g;
        }
        if (p.ringing > 0 && --p.ringing === 0) {
          p.gain.target = 0;
        }
        if (!g && !p.gain.target && p.ringing <= 0) {
          // Faded out. A bypassed one keeps its state for when it comes back; one let go is cleared.
          if (!p.held) p.unit.reset();
          this.chain.splice(k--, 1);
        }
      }
      const w = this.knobWet.next(this.knobOn ? this.knobMix : 0);
      if (w > 1e-4 && knobUnit) {
        const dl = io[0], dr = io[1];
        knobUnit.tick(io, 1, ctx);
        io[0] = dl + (io[0] - dl) * w;
        io[1] = dr + (io[1] - dr) * w;
      }
      outL[i] = io[0];
      if (outR !== outL) outR[i] = io[1];
    }
  }
}
