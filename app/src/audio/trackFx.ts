// Mixer channels: one strip per track (inserts, pan, fader, ducker, sends) and the shared reverb and delay
// returns. Built on any BaseAudioContext, so the WAV bounce has the same FX as live playback.
import { PAD_COUNT, type Returns, type Track, type TrackFx } from "../state/types";
import { cutoffHz } from "./dsp";
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

/** Seconds of a 16th note. */
const sixteenth = (bpm: number) => 60 / bpm / 4;

/** Shared send effects: A = reverb (generated impulse response), B = tempo-synced delay. */
export class ReturnFx {
  readonly reverbIn: GainNode;
  readonly delayIn: GainNode;
  private convolver: ConvolverNode;
  private reverbOut: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private tone: BiquadFilterNode;
  private delayOut: GainNode;
  private irKey = "";
  private irTimer = 0;
  private ctx: BaseAudioContext;
  private live: boolean;

  constructor(ctx: BaseAudioContext, master: AudioNode, live: boolean) {
    this.ctx = ctx;
    this.live = live;
    this.reverbIn = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.reverbOut = ctx.createGain();
    this.reverbIn.connect(this.convolver).connect(this.reverbOut).connect(master);

    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(8);
    this.feedback = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.delayOut = ctx.createGain();
    // Each repeat runs through the tone filter, so they darken as they fade.
    this.delayIn.connect(this.delay).connect(this.tone).connect(this.delayOut).connect(master);
    this.tone.connect(this.feedback).connect(this.delay);
  }

  update(r: Returns, bpm: number) {
    const now = this.ctx.currentTime;
    this.reverbOut.gain.setTargetAtTime(r.reverb.level, now, TC);
    this.delayOut.gain.setTargetAtTime(r.delay.level, now, TC);
    this.delay.delayTime.setTargetAtTime(Math.min(8, r.delay.time * sixteenth(bpm)), now, 0.05);
    this.feedback.gain.setTargetAtTime(r.delay.feedback, now, TC);
    this.tone.frequency.setTargetAtTime(400 * Math.pow(2, r.delay.tone * 5.5), now, TC);

    const key = `${r.reverb.size.toFixed(3)}:${r.reverb.decay.toFixed(3)}`;
    if (key === this.irKey) return;
    this.irKey = key;
    // Live: wait for the knob to settle, building a long IR on every step is wasteful. Offline: build it now.
    clearTimeout(this.irTimer);
    const build = () => (this.convolver.buffer = reverbImpulse(this.ctx, r.reverb.size, r.reverb.decay));
    if (this.live && this.convolver.buffer) this.irTimer = window.setTimeout(build, 150);
    else build();
  }
}

/** Stereo noise burst with an exponential tail: `size` sets the length, `decay` how fast it dies. */
export function reverbImpulse(ctx: BaseAudioContext, size: number, decay: number) {
  const seconds = 0.3 + size * 3.7;
  const len = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const curve = 1.5 + (1 - decay) * 5; // higher = dies sooner
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, curve);
  }
  return buf;
}
