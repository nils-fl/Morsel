// The effects of a track's FX rack (state/types.ts TrackFx), one small class each: an input and an output node, the
// settings applied by update(). TrackStrip (trackFx.ts) wires the ones switched on, in the track's chain order. The
// echo and the reverb impulse are shared with the send returns.
import type { FxKind, Returns, TrackFx } from "../state/types";
import { cutoffHz } from "./dsp";
import { reverbImpulseData } from "./reverb";
import { CRUSH_PROCESSOR_NAME, crushHold } from "./worklet/crushCore";
import { softClip } from "./worklet/masterCore";

export const TC = 0.02; // smoothing time constant for knob moves

/** The effects switched on, in chain order. */
export const fxChain = (fx: TrackFx): FxKind[] => fx.order.filter((k) => fx.on[k]);

/** Seconds of a 16th note. */
export const sixteenth = (bpm: number) => 60 / bpm / 4;
/** A delay of `time` 16ths, at most the 8 s a DelayNode holds here. */
export const delaySeconds = (time: number, bpm: number) => Math.min(8, time * sixteenth(bpm));

/** How the filter's cutoff knob maps to Hz (kept here so the mixer UI can show the same numbers). */
export const fxFilterHz = (c: number) => cutoffHz(c);
/** The EQ's mid band: 200 Hz..5 kHz. */
export const eqMidHz = (f: number) => 200 * Math.pow(25, f);

export interface FxUnit {
  readonly input: AudioNode;
  readonly output: AudioNode;
  update(fx: TrackFx, bpm: number, now: number): void;
  dispose(): void;
}

/** Dry and wet into one output: `wet` is where the effect's sound joins. */
class Blend {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly wet: GainNode;
  private dry: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
  }

  /** Equal-ish power: at 50 % both sides are at 0.71. */
  mix(m: number, now: number) {
    this.dry.gain.setTargetAtTime(Math.cos((m * Math.PI) / 2), now, TC);
    this.wet.gain.setTargetAtTime(Math.sin((m * Math.PI) / 2), now, TC);
  }

  dispose() {
    for (const n of [this.input, this.output, this.dry, this.wet]) n.disconnect();
  }
}

class FilterUnit implements FxUnit {
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;

  constructor(ctx: BaseAudioContext) {
    this.input = this.output = ctx.createBiquadFilter();
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { type, cutoff, resonance } = fx.filter;
    const f = this.input;
    f.type = type === "lp" ? "lowpass" : type === "hp" ? "highpass" : "bandpass";
    f.frequency.setTargetAtTime(fxFilterHz(cutoff), now, TC);
    f.Q.setTargetAtTime(type === "bp" ? 0.5 + resonance * 12 : resonance * 18, now, TC);
  }

  dispose() {
    this.input.disconnect();
  }
}

class EqUnit implements FxUnit {
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;
  private bands: BiquadFilterNode[];

  constructor(ctx: BaseAudioContext) {
    this.bands = (["lowshelf", "peaking", "highshelf"] as const).map((type, i) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = [200, 1000, 5000][i];
      if (type === "peaking") f.Q.value = 0.8;
      f.gain.value = 0;
      return f;
    });
    this.bands[0].connect(this.bands[1]).connect(this.bands[2]);
    this.input = this.bands[0];
    this.output = this.bands[2];
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { low, mid, high, midFreq } = fx.eq;
    [low, mid, high].forEach((g, i) => this.bands[i].gain.setTargetAtTime(g, now, TC));
    this.bands[1].frequency.setTargetAtTime(eqMidHz(midFreq), now, TC);
  }

  dispose() {
    this.bands.forEach((b) => b.disconnect());
  }
}

const DRIVE_CURVES = new Map<number, Float32Array<ArrayBuffer>>();
/** The drive's input range: its gain goes up to 4x, and a WaveShaper only shapes -1..1 (beyond, it clips flat). So the
 *  input is scaled down by this first and the curve covers ±4, where tanh keeps bending smoothly. */
const DRIVE_RANGE = 4;
function driveCurve(drive: number) {
  const k = Math.round(drive * 50) / 50;
  let c = DRIVE_CURVES.get(k);
  if (!c) {
    const amount = 1 + k * 12;
    c = new Float32Array(4096);
    for (let i = 0; i < c.length; i++) {
      const x = ((i / (c.length - 1)) * 2 - 1) * DRIVE_RANGE;
      c[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    DRIVE_CURVES.set(k, c);
  }
  return c;
}

class DriveUnit implements FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private blend: Blend;
  private driveIn: GainNode;
  private shaper: WaveShaperNode;
  private tone: BiquadFilterNode;
  private driveOut: GainNode;
  private last = -1;

  constructor(ctx: BaseAudioContext) {
    this.blend = new Blend(ctx);
    this.input = this.blend.input;
    this.output = this.blend.output;
    this.driveIn = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "4x"; // less aliasing from the harmonics the curve adds
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.Q.value = 0.5;
    this.driveOut = ctx.createGain();
    this.input.connect(this.driveIn).connect(this.shaper).connect(this.tone).connect(this.driveOut).connect(this.blend.wet);
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { amount, tone, mix } = fx.drive;
    // Scaled into the curve's -1..1 (see DRIVE_RANGE); with no curve the shaper passes it as is, so unscaled.
    const gain = (1 + amount * 3) / (amount > 0 ? DRIVE_RANGE : 1);
    if (amount !== this.last) {
      const switching = (amount > 0) !== (this.last > 0);
      this.last = amount;
      this.shaper.curve = amount > 0 ? driveCurve(amount) : null;
      if (switching) {
        // The scale jumps with the curve: at once, not gliding (it would drive the curve 4x too hard for a moment).
        this.driveIn.gain.cancelScheduledValues(now);
        this.driveIn.gain.setValueAtTime(gain, now);
      }
    }
    this.driveIn.gain.setTargetAtTime(gain, now, TC);
    this.driveOut.gain.setTargetAtTime(1 / (1 + amount * 1.5), now, TC);
    this.tone.frequency.setTargetAtTime(500 * Math.pow(40, tone), now, TC); // 500 Hz..20 kHz
    this.blend.mix(mix, now);
  }

  dispose() {
    this.blend.dispose();
    for (const n of [this.driveIn, this.shaper, this.tone, this.driveOut]) n.disconnect();
  }
}

class CompUnit implements FxUnit {
  readonly input: DynamicsCompressorNode;
  readonly output: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createDynamicsCompressor();
    this.input.knee.value = 6;
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const c = fx.comp;
    this.input.threshold.setTargetAtTime(c.threshold, now, TC);
    this.input.ratio.setTargetAtTime(c.ratio, now, TC);
    this.input.attack.setTargetAtTime(c.attack, now, TC);
    this.input.release.setTargetAtTime(c.release, now, TC);
    this.output.gain.setTargetAtTime(Math.pow(10, c.makeup / 20), now, TC);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Two short delays swept by one LFO in opposite directions, one per side: width and movement. */
class ChorusUnit implements FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private blend: Blend;
  private lfo: OscillatorNode;
  private depth: GainNode[];
  private nodes: AudioNode[];

  constructor(ctx: BaseAudioContext) {
    this.blend = new Blend(ctx);
    this.input = this.blend.input;
    this.output = this.blend.output;
    this.lfo = ctx.createOscillator();
    const merge = ctx.createChannelMerger(2);
    this.depth = [ctx.createGain(), ctx.createGain()];
    const lines = [0, 1].map((side) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.012;
      this.input.connect(d);
      d.connect(merge, 0, side);
      this.lfo.connect(this.depth[side]).connect(d.delayTime);
      return d;
    });
    merge.connect(this.blend.wet);
    this.lfo.start();
    this.nodes = [this.lfo, merge, ...this.depth, ...lines];
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { rate, depth, mix } = fx.chorus;
    this.lfo.frequency.setTargetAtTime(rate, now, TC);
    // Up to ±7 ms around 12 ms; the sides move against each other.
    this.depth.forEach((g, side) => g.gain.setTargetAtTime((side ? -1 : 1) * depth * 0.007, now, TC));
    this.blend.mix(mix, now);
  }

  dispose() {
    this.lfo.stop();
    this.blend.dispose();
    this.nodes.forEach((n) => n.disconnect());
  }
}

/** One repeat of a delay: the tone lowpass, a highpass so the low end doesn't pile up, and a soft saturation so
 *  high feedback thickens the repeats instead of running away. */
class DelayLine {
  readonly delay: DelayNode;
  readonly out: AudioNode;
  readonly tone: BiquadFilterNode;
  readonly nodes: AudioNode[];

  constructor(ctx: BaseAudioContext) {
    this.delay = ctx.createDelay(8);
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 150;
    hp.Q.value = 0;
    const sat = ctx.createWaveShaper();
    sat.curve = delaySaturation();
    this.out = this.delay.connect(this.tone).connect(hp).connect(sat);
    this.nodes = [this.delay, this.tone, hp, sat];
  }

  update(time: number, tone: number, now: number) {
    this.delay.delayTime.setTargetAtTime(time, now, 0.05);
    this.tone.frequency.setTargetAtTime(400 * Math.pow(2, tone * 5.5), now, TC);
  }
}

let delayCurve: Float32Array<ArrayBuffer> | undefined;
/** Unity for quiet repeats, rounding off towards ±1. */
const delaySaturation = () => (delayCurve ??= Float32Array.from({ length: 1025 }, (_, i) => softClip((i / 1024) * 2 - 1)));

/**
 * A tempo-synced echo, as a stereo echo (each side repeats itself) and as a ping-pong (the sum bounces left, right,
 * left…); `pingpong` fades between the two. The repeats only: no dry signal.
 */
export class Echo {
  readonly input: GainNode;
  readonly output: GainNode;
  private stereo: DelayLine;
  private stereoIn: GainNode;
  private stereoFb: GainNode;
  private left: DelayLine;
  private right: DelayLine;
  private pingIn: GainNode;
  private pingFb: GainNode[];
  private nodes: AudioNode[];

  constructor(ctx: BaseAudioContext) {
    const g = () => ctx.createGain();
    this.input = g();
    this.output = g();
    // Stereo echo: each repeat feeds back into the same line.
    this.stereoIn = g();
    this.stereoFb = g();
    this.stereo = new DelayLine(ctx);
    this.input.connect(this.stereoIn).connect(this.stereo.delay);
    this.stereo.out.connect(this.output);
    this.stereo.out.connect(this.stereoFb).connect(this.stereo.delay);
    // Ping-pong: the mono sum starts on the left, and each repeat crosses to the other side.
    this.pingIn = g();
    this.pingIn.channelCount = 1;
    this.pingIn.channelCountMode = "explicit";
    this.left = new DelayLine(ctx);
    this.right = new DelayLine(ctx);
    const merge = ctx.createChannelMerger(2);
    this.pingFb = [g(), g()];
    this.input.connect(this.pingIn).connect(this.left.delay);
    this.left.out.connect(merge, 0, 0);
    this.right.out.connect(merge, 0, 1);
    this.left.out.connect(this.pingFb[0]).connect(this.right.delay);
    this.right.out.connect(this.pingFb[1]).connect(this.left.delay);
    merge.connect(this.output);
    this.nodes = [this.input, this.output, this.stereoIn, this.stereoFb, this.pingIn, merge, ...this.pingFb,
      ...this.stereo.nodes, ...this.left.nodes, ...this.right.nodes];
  }

  update(d: { time: number; feedback: number; tone: number; pingpong: boolean }, bpm: number, now: number) {
    const time = delaySeconds(d.time, bpm);
    for (const line of [this.stereo, this.left, this.right]) line.update(time, d.tone, now);
    const ping = d.pingpong ? 1 : 0;
    this.stereoIn.gain.setTargetAtTime(1 - ping, now, TC);
    this.pingIn.gain.setTargetAtTime(ping, now, TC);
    this.stereoFb.gain.setTargetAtTime(d.feedback, now, TC);
    for (const fb of this.pingFb) fb.gain.setTargetAtTime(d.feedback, now, TC);
  }

  dispose() {
    this.nodes.forEach((n) => n.disconnect());
  }
}

class DelayUnit implements FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private blend: Blend;
  private echo: Echo;

  constructor(ctx: BaseAudioContext) {
    this.blend = new Blend(ctx);
    this.input = this.blend.input;
    this.output = this.blend.output;
    this.echo = new Echo(ctx);
    this.input.connect(this.echo.input);
    this.echo.output.connect(this.blend.wet);
  }

  update(fx: TrackFx, bpm: number, now: number) {
    this.echo.update(fx.delay, bpm, now);
    this.blend.mix(fx.delay.mix, now);
  }

  dispose() {
    this.echo.dispose();
    this.blend.dispose();
  }
}

export function reverbImpulse(ctx: BaseAudioContext, r: Returns["reverb"]) {
  const data = reverbImpulseData(ctx.sampleRate, r);
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  data.forEach((d, c) => buf.copyToChannel(d, c));
  return buf;
}

/**
 * A convolver on a generated impulse, low cut at 200 Hz as on the send. Live, the impulse is rebuilt once a knob
 * settles (building a long one on every step is wasteful); offline (a bounce), at once.
 */
export class Room {
  readonly input: ConvolverNode;
  readonly output: BiquadFilterNode;
  private ctx: BaseAudioContext;
  private live: boolean;
  private key = "";
  private timer = 0;

  constructor(ctx: BaseAudioContext, live: boolean) {
    this.ctx = ctx;
    this.live = live;
    this.input = ctx.createConvolver();
    // reverbImpulse sets the level itself (the convolver's own normalising makes longer rooms louder).
    this.input.normalize = false;
    this.output = ctx.createBiquadFilter();
    this.output.type = "highpass";
    this.output.frequency.value = 200;
    this.output.Q.value = 0.5;
    this.input.connect(this.output);
  }

  update(r: Returns["reverb"]) {
    const key = [r.size, r.decay, r.predelay, r.tone].map((v) => v.toFixed(3)).join(":");
    if (key === this.key) return;
    this.key = key;
    clearTimeout(this.timer);
    const build = () => (this.input.buffer = reverbImpulse(this.ctx, r));
    if (this.live && this.input.buffer) this.timer = window.setTimeout(build, 150);
    else build();
  }

  dispose() {
    clearTimeout(this.timer);
    this.input.disconnect();
    this.output.disconnect();
  }
}

class ReverbUnit implements FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private blend: Blend;
  private room: Room;

  constructor(ctx: BaseAudioContext, live: boolean) {
    this.blend = new Blend(ctx);
    this.input = this.blend.input;
    this.output = this.blend.output;
    this.room = new Room(ctx, live);
    this.input.connect(this.room.input);
    this.room.output.connect(this.blend.wet);
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { size, decay, tone, mix } = fx.reverb;
    this.room.update({ size, decay, tone, predelay: 0, level: 1 });
    this.blend.mix(mix, now);
  }

  dispose() {
    this.room.dispose();
    this.blend.dispose();
  }
}

const CRUSH_CURVES = new Map<number, Float32Array<ArrayBuffer>>();
/** A staircase over -1..1 with 2^(bits-1) steps a side: fewer bits, coarser steps. */
export function crushCurve(bits: number) {
  let c = CRUSH_CURVES.get(bits);
  if (!c) {
    const steps = Math.pow(2, bits - 1);
    c = Float32Array.from({ length: 4097 }, (_, i) => Math.round(((i / 4096) * 2 - 1) * steps) / steps);
    CRUSH_CURVES.set(bits, c);
  }
  return c;
}

/** Fewer bits (a staircase) and, on the worklet engine, a lower sample rate (each sample held a while). */
class CrushUnit implements FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private blend: Blend;
  private hold: AudioWorkletNode | null;
  private shaper: WaveShaperNode;
  private bits = -1;

  constructor(ctx: BaseAudioContext, worklet: boolean) {
    this.blend = new Blend(ctx);
    this.input = this.blend.input;
    this.output = this.blend.output;
    this.shaper = ctx.createWaveShaper();
    this.hold = worklet ? new AudioWorkletNode(ctx, CRUSH_PROCESSOR_NAME, { outputChannelCount: [2] }) : null;
    (this.hold ? this.input.connect(this.hold) : this.input).connect(this.shaper).connect(this.blend.wet);
  }

  update(fx: TrackFx, _bpm: number, now: number) {
    const { bits, rate, mix } = fx.crush;
    if (bits !== this.bits) {
      this.bits = bits;
      this.shaper.curve = crushCurve(bits);
    }
    this.hold?.parameters.get("hold")?.setValueAtTime(crushHold(rate), now);
    this.blend.mix(mix, now);
  }

  dispose() {
    this.blend.dispose();
    this.hold?.disconnect();
    this.hold?.port.postMessage("stop");
    this.shaper.disconnect();
  }
}

export function makeUnit(kind: FxKind, ctx: BaseAudioContext, live: boolean, worklet: boolean): FxUnit {
  switch (kind) {
    case "filter": return new FilterUnit(ctx);
    case "eq": return new EqUnit(ctx);
    case "drive": return new DriveUnit(ctx);
    case "comp": return new CompUnit(ctx);
    case "chorus": return new ChorusUnit(ctx);
    case "delay": return new DelayUnit(ctx);
    case "reverb": return new ReverbUnit(ctx, live);
    case "crush": return new CrushUnit(ctx, worklet);
  }
}
