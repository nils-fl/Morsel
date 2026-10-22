// Mixer channels: one strip per track (inserts, pan, fader, ducker, sends) and the shared reverb and delay
// returns. Built on any BaseAudioContext, so the WAV bounce has the same FX as live playback.
import { DEFAULT_MASTER_LEVEL, PAD_COUNT, type Returns, type Track, type TrackFx } from "../state/types";
import { cutoffHz } from "./dsp";
import { reverbImpulseData } from "./reverb";
import { MASTER_PROCESSOR_NAME, softClip, type MasterMeter } from "./worklet/masterCore";
import { KEYS_MONO_OUT, KEYS_STEREO_OUT, VoiceNode } from "./worklet/voiceNode";

const TC = 0.02; // smoothing time constant for knob moves

/** How the insert FX knobs map to node settings (kept here so the mixer UI can show the same numbers). */
export const fxFilterHz = (c: number) => cutoffHz(c);
const DRIVE_CURVES = new Map<number, Float32Array<ArrayBuffer>>();
function driveCurve(drive: number) {
  const k = Math.round(drive * 50) / 50;
  let c = DRIVE_CURVES.get(k);
  if (!c) {
    const amount = 1 + k * 12;
    c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    DRIVE_CURVES.set(k, c);
  }
  return c;
}

export class TrackStrip {
  /** Instruments that aren't pads (keys voices) connect here. */
  readonly input: GainNode;
  /** Drum tracks: per pad, mute/solo gain, then the pad's sidechain ducker gain, into `input`. */
  readonly padBus: GainNode[] = [];
  readonly padDuck: GainNode[] = [];
  /** The track's sidechain ducker gain, after the fader (keys tracks). */
  readonly duck: GainNode;
  private filter: BiquadFilterNode;
  private eq: BiquadFilterNode[];
  private driveIn: GainNode;
  private shaper: WaveShaperNode;
  private driveOut: GainNode;
  private comp: DynamicsCompressorNode;
  private pan: StereoPannerNode;
  private fader: GainNode;
  private sendA: GainNode;
  private sendB: GainNode;
  private nodes: AudioNode[];
  private lastDrive = -1;
  private ctx: BaseAudioContext;
  /** Worklet engine: the voice processor feeding this strip (null on the node engine). */
  readonly voices: VoiceNode | null;
  /** Which keys output of the voice processor feeds `input`: mono for the synth, stereo for samples. */
  private keysOut = -1;

  constructor(ctx: BaseAudioContext, kind: Track["kind"], master: AudioNode, reverbIn: AudioNode, delayIn: AudioNode, worklet = false) {
    this.ctx = ctx;
    const g = () => ctx.createGain();
    this.input = g();
    this.filter = ctx.createBiquadFilter();
    this.eq = (["lowshelf", "peaking", "highshelf"] as const).map((type, i) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = [200, 1000, 5000][i];
      if (type === "peaking") f.Q.value = 0.8;
      f.gain.value = 0;
      return f;
    });
    this.driveIn = g();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "2x";
    this.driveOut = g();
    this.comp = ctx.createDynamicsCompressor();
    this.pan = ctx.createStereoPanner();
    this.fader = g();
    this.duck = g();
    this.sendA = g();
    this.sendB = g();
    this.sendA.gain.value = this.sendB.gain.value = 0;

    let chain: AudioNode = this.input;
    for (const n of [this.filter, ...this.eq, this.driveIn, this.shaper, this.driveOut, this.comp, this.pan, this.fader, this.duck]) chain = chain.connect(n);
    this.duck.connect(master);
    this.duck.connect(this.sendA).connect(reverbIn);
    this.duck.connect(this.sendB).connect(delayIn);

    if (kind === "drum") {
      for (let i = 0; i < PAD_COUNT; i++) {
        const bus = g(), duck = g();
        bus.connect(duck).connect(this.input);
        this.padBus.push(bus);
        this.padDuck.push(duck);
      }
    }
    this.voices = worklet ? new VoiceNode(ctx) : null;
    if (this.voices && kind === "drum") this.padBus.forEach((bus, i) => this.voices!.node.connect(bus, i));
    this.nodes = [this.input, this.filter, ...this.eq, this.driveIn, this.shaper, this.driveOut, this.comp, this.pan, this.fader, this.duck, this.sendA, this.sendB, ...this.padBus, ...this.padDuck];
    this.applyFx(undefined);
  }

  /** Apply the track's settings. `audible` = after track mute/solo; `padOn` = per pad, after pad mute/solo. */
  update(t: Track, audible: boolean, padOn: (pad: number) => boolean) {
    const now = this.ctx.currentTime;
    this.fader.gain.setTargetAtTime(audible ? t.level : 0, now, 0.01);
    this.pan.pan.setTargetAtTime(t.pan, now, TC);
    this.sendA.gain.setTargetAtTime(t.sendA, now, TC);
    this.sendB.gain.setTargetAtTime(t.sendB, now, TC);
    this.padBus.forEach((b, i) => b.gain.setTargetAtTime(padOn(i) ? 1 : 0, now, 0.01));
    this.applyFx(t.fx);
    // Only the output in use is connected: a synth alone stays mono up to the pan, as on the node engine.
    const keysOut = t.keys ? (t.keys.type === "synth" ? KEYS_MONO_OUT : KEYS_STEREO_OUT) : -1;
    if (this.voices && keysOut !== this.keysOut) {
      if (this.keysOut >= 0) this.voices.node.disconnect(this.keysOut);
      if (keysOut >= 0) this.voices.node.connect(this.input, keysOut);
      this.keysOut = keysOut;
    }
  }

  private applyFx(fx: TrackFx | undefined) {
    const now = this.ctx.currentTime;
    const f = this.filter;
    if (!fx || fx.filter === "off") {
      // Wide open lowpass: inaudible, and keeps the graph fixed.
      f.type = "lowpass";
      f.frequency.setTargetAtTime(this.ctx.sampleRate / 2, now, TC);
      f.Q.setTargetAtTime(0, now, TC);
    } else {
      f.type = fx.filter === "lp" ? "lowpass" : fx.filter === "hp" ? "highpass" : "bandpass";
      f.frequency.setTargetAtTime(fxFilterHz(fx.cutoff), now, TC);
      f.Q.setTargetAtTime(fx.filter === "bp" ? 0.5 + fx.resonance * 12 : fx.resonance * 18, now, TC);
    }
    const gains = fx ? [fx.eqLow, fx.eqMid, fx.eqHigh] : [0, 0, 0];
    this.eq.forEach((e, i) => e.gain.setTargetAtTime(gains[i], now, TC));
    const drive = fx?.drive ?? 0;
    if (drive !== this.lastDrive) {
      this.lastDrive = drive;
      this.shaper.curve = drive > 0 ? driveCurve(drive) : null;
    }
    this.driveIn.gain.setTargetAtTime(1 + drive * 3, now, TC);
    this.driveOut.gain.setTargetAtTime(1 / (1 + drive * 1.5), now, TC);
    const comp = fx?.comp ?? 0;
    this.comp.threshold.setTargetAtTime(-comp * 40, now, TC);
    this.comp.ratio.setTargetAtTime(1 + comp * 11, now, TC);
    this.comp.knee.value = 6;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.12;
  }

  dispose() {
    this.nodes.forEach((n) => n.disconnect());
    this.voices?.dispose();
  }
}

let softClipCurve: Float32Array<ArrayBuffer> | undefined;

/**
 * The master bus: level, a gentle glue compressor, then the limiter (a soft clip and a look-ahead peak limiter at
 * −0.3 dBFS). The limiter runs in the master worklet when the context has it, else on nodes (a WaveShaper and a
 * hard-set DynamicsCompressor, which can let a peak through in its first millisecond).
 */
export class MasterBus {
  /** Tracks and returns connect here. */
  readonly input: GainNode;
  /** After the glue: sounds that shouldn't pump with the mix (the metronome) join here. */
  readonly limiterIn: AudioNode;
  /** Output peak and deepest limiter gain since the last report (live worklet engine; else stays at rest). */
  meter: MasterMeter = { peak: 0, gain: 1 };
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, out: AudioNode, worklet: boolean, live: boolean) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.input.gain.value = DEFAULT_MASTER_LEVEL;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.knee.value = 6;
    glue.ratio.value = 2;
    glue.attack.value = 0.01;
    glue.release.value = 0.1;
    if (worklet) {
      const node = new AudioWorkletNode(ctx, MASTER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
      });
      if (live) node.port.onmessage = (e: MessageEvent<MasterMeter>) => (this.meter = e.data);
      this.limiterIn = node;
      node.connect(out);
    } else {
      // A WaveShaper only shapes −1..1: halve the signal first, so the curve covers ±2 (+6 dBFS).
      const half = ctx.createGain();
      half.gain.value = 0.5;
      const shaper = ctx.createWaveShaper();
      softClipCurve ??= Float32Array.from({ length: 2049 }, (_, i) => softClip(((i / 2048) * 2 - 1) * 2));
      shaper.curve = softClipCurve;
      half.connect(shaper);
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -1;
      limit.knee.value = 0;
      limit.ratio.value = 20;
      limit.attack.value = 0.001;
      limit.release.value = 0.08;
      shaper.connect(limit).connect(out);
      this.limiterIn = half;
    }
    this.input.connect(glue).connect(this.limiterIn);
  }

  update(level: number) {
    this.input.gain.setTargetAtTime(level, this.ctx.currentTime, TC);
  }
}

/** Seconds of a 16th note. */
const sixteenth = (bpm: number) => 60 / bpm / 4;

/** One repeat of the delay: the tone lowpass, a highpass so the low end doesn't pile up, and a soft saturation so
 *  high feedback thickens the repeats instead of running away. */
class DelayLine {
  readonly delay: DelayNode;
  readonly out: AudioNode;
  readonly tone: BiquadFilterNode;

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
 * Shared send effects: A = reverb (generated impulse response), B = tempo-synced delay. The delay runs as a stereo
 * echo (each side repeats itself) and as a ping-pong (the sum bounces left, right, left…); `pingpong` fades
 * between the two.
 */
export class ReturnFx {
  readonly reverbIn: GainNode;
  readonly delayIn: GainNode;
  private convolver: ConvolverNode;
  private reverbOut: GainNode;
  private stereo: DelayLine;
  private stereoIn: GainNode;
  private stereoFb: GainNode;
  private left: DelayLine;
  private right: DelayLine;
  private pingIn: GainNode;
  private pingFb: GainNode[];
  private delayOut: GainNode;
  private irKey = "";
  private irTimer = 0;
  private ctx: BaseAudioContext;
  private live: boolean;

  constructor(ctx: BaseAudioContext, master: AudioNode, live: boolean) {
    this.ctx = ctx;
    this.live = live;
    const g = () => ctx.createGain();
    this.reverbIn = g();
    this.convolver = ctx.createConvolver();
    // reverbImpulse sets the level itself (the convolver's own normalising makes longer rooms louder).
    this.convolver.normalize = false;
    this.reverbOut = g();
    this.reverbIn.connect(this.convolver).connect(this.reverbOut).connect(master);

    this.delayIn = g();
    this.delayOut = g();
    this.delayOut.connect(master);
    // Stereo echo: each repeat feeds back into the same line.
    this.stereoIn = g();
    this.stereoFb = g();
    this.stereo = new DelayLine(ctx);
    this.delayIn.connect(this.stereoIn).connect(this.stereo.delay);
    this.stereo.out.connect(this.delayOut);
    this.stereo.out.connect(this.stereoFb).connect(this.stereo.delay);
    // Ping-pong: the mono sum starts on the left, and each repeat crosses to the other side.
    this.pingIn = ctx.createGain();
    this.pingIn.channelCount = 1;
    this.pingIn.channelCountMode = "explicit";
    this.left = new DelayLine(ctx);
    this.right = new DelayLine(ctx);
    const merge = ctx.createChannelMerger(2);
    this.pingFb = [g(), g()];
    this.delayIn.connect(this.pingIn).connect(this.left.delay);
    this.left.out.connect(merge, 0, 0);
    this.right.out.connect(merge, 0, 1);
    this.left.out.connect(this.pingFb[0]).connect(this.right.delay);
    this.right.out.connect(this.pingFb[1]).connect(this.left.delay);
    merge.connect(this.delayOut);
  }

  update(r: Returns, bpm: number) {
    const now = this.ctx.currentTime;
    this.reverbOut.gain.setTargetAtTime(r.reverb.level, now, TC);
    this.delayOut.gain.setTargetAtTime(r.delay.level, now, TC);
    const time = Math.min(8, r.delay.time * sixteenth(bpm));
    for (const line of [this.stereo, this.left, this.right]) line.update(time, r.delay.tone, now);
    const ping = r.delay.pingpong ? 1 : 0;
    this.stereoIn.gain.setTargetAtTime(1 - ping, now, TC);
    this.pingIn.gain.setTargetAtTime(ping, now, TC);
    this.stereoFb.gain.setTargetAtTime(r.delay.feedback, now, TC);
    for (const fb of this.pingFb) fb.gain.setTargetAtTime(r.delay.feedback, now, TC);

    const { size, decay, predelay, tone } = r.reverb;
    const key = [size, decay, predelay, tone].map((v) => v.toFixed(3)).join(":");
    if (key === this.irKey) return;
    this.irKey = key;
    // Live: wait for the knob to settle, building a long IR on every step is wasteful. Offline: build it now.
    clearTimeout(this.irTimer);
    const build = () => (this.convolver.buffer = reverbImpulse(this.ctx, r.reverb));
    if (this.live && this.convolver.buffer) this.irTimer = window.setTimeout(build, 150);
    else build();
  }
}

export function reverbImpulse(ctx: BaseAudioContext, r: Returns["reverb"]) {
  const data = reverbImpulseData(ctx.sampleRate, r);
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  data.forEach((d, c) => buf.copyToChannel(d, c));
  return buf;
}
