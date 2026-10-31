// Mixer channels: one strip per track (its FX rack, pan, fader, ducker, sends) and the shared reverb and delay
// returns. Built on any BaseAudioContext, so the WAV bounce has the same FX as live playback.
import { DEFAULT_MASTER_LEVEL, FX_KINDS, PAD_COUNT, type FxKind, type Returns, type Track } from "../state/types";
import { MOD_VIB_CENTS } from "./dsp";
import { Echo, Room, TC, fxChain, makeUnit, type FxUnit } from "./fxUnits";
import { PerformNode } from "./perform/performNode";
import { MASTER_PROCESSOR_NAME, type MasterMeter } from "./worklet/masterCore";
import { KEYS_MONO_OUT, KEYS_STEREO_OUT, VoiceNode } from "./worklet/voiceNode";

const EXPRESSION_TC = 0.01; // the strips: as the worklet engine's Expression
/** Seconds the strip's output dips for while its FX chain is rewired (a reorder, an effect on or off). */
const REWIRE_S = 0.01;

export class TrackStrip {
  /** Instruments that aren't pads (keys voices) connect here. */
  readonly input: GainNode;
  /** Drum tracks: per pad, mute/solo gain, then the pad's sidechain ducker gain, into `input`. */
  readonly padBus: GainNode[] = [];
  readonly padDuck: GainNode[] = [];
  /** The track's sidechain ducker gain, after the fader (keys tracks). */
  readonly duck: GainNode;
  /** The FX rack's effects, every kind; those on are wired between `input` and `wire` in the track's chain order. */
  private units = new Map<FxKind, FxUnit>();
  /** The chain as wired ("" before the first wiring). */
  private wired = "";
  private rewireTimer = 0;
  /** After the FX chain: dips while it is rewired. */
  private wire: GainNode;
  private live: boolean;
  private pan: StereoPannerNode;
  private fader: GainNode;
  private sendA: GainNode;
  private sendB: GainNode;
  /** The strip's way to the master: straight (`toMix`) or through the Knob FX (`toKnob`), crossfaded when it changes. */
  private toMix: GainNode;
  private toKnob: GainNode;
  private knobTarget = false;
  private nodes: AudioNode[];
  private ctx: BaseAudioContext;
  /** Worklet engine: the voice processor feeding this strip (null on the node engine). */
  readonly voices: VoiceNode | null;
  /** Which keys output of the voice processor feeds `input`: mono for the synth, stereo for samples. */
  private keysOut = -1;
  /**
   * Node engine, keys tracks: the Launchkey's pitch bend and mod-wheel vibrato in cents, which every keys voice adds
   * to its detune (the worklet engine does this in its processor).
   */
  readonly pitchIn: GainNode | null = null;
  private bend: ConstantSourceNode | null = null;
  private vibrato: OscillatorNode | null = null;
  private modDepth: GainNode | null = null;

  constructor(ctx: BaseAudioContext, kind: Track["kind"], master: AudioNode, knobIn: AudioNode, reverbIn: AudioNode, delayIn: AudioNode, worklet = false, live = false) {
    this.ctx = ctx;
    this.live = live;
    const g = () => ctx.createGain();
    this.input = g();
    for (const k of FX_KINDS) this.units.set(k, makeUnit(k, ctx, live, worklet));
    this.wire = g();
    this.pan = ctx.createStereoPanner();
    this.fader = g();
    this.duck = g();
    this.sendA = g();
    this.sendB = g();
    this.sendA.gain.value = this.sendB.gain.value = 0;

    let chain: AudioNode = this.wire;
    for (const n of [this.pan, this.fader, this.duck]) chain = chain.connect(n);
    this.toMix = g();
    this.toKnob = g();
    this.toKnob.gain.value = 0;
    this.duck.connect(this.toMix).connect(master);
    this.duck.connect(this.toKnob).connect(knobIn);
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
    if (!worklet && kind === "keys") {
      this.pitchIn = g();
      this.bend = ctx.createConstantSource();
      this.bend.offset.value = 0;
      this.vibrato = ctx.createOscillator();
      this.modDepth = g();
      this.modDepth.gain.value = 0;
      this.bend.connect(this.pitchIn);
      this.vibrato.connect(this.modDepth).connect(this.pitchIn);
      this.bend.start();
      this.vibrato.start();
    }
    if (this.voices && kind === "drum") this.padBus.forEach((bus, i) => this.voices!.node.connect(bus, i));
    this.nodes = [this.input, this.wire, this.pan, this.fader, this.duck, this.sendA, this.sendB, this.toMix, this.toKnob, ...this.padBus, ...this.padDuck];
    if (this.pitchIn) this.nodes.push(this.pitchIn, this.bend!, this.vibrato!, this.modDepth!);
    this.rewire([]);
  }

  /** Apply the track's settings. `audible` = after track mute/solo; `padOn` = per pad, after pad mute/solo. */
  update(t: Track, audible: boolean, padOn: (pad: number) => boolean, bpm = 120) {
    const now = this.ctx.currentTime;
    this.fader.gain.setTargetAtTime(audible ? t.level : 0, now, 0.01);
    this.pan.pan.setTargetAtTime(t.pan, now, TC);
    this.sendA.gain.setTargetAtTime(t.sendA, now, TC);
    this.sendB.gain.setTargetAtTime(t.sendB, now, TC);
    this.padBus.forEach((b, i) => b.gain.setTargetAtTime(padOn(i) ? 1 : 0, now, 0.01));
    this.applyFx(t, bpm);
    if (this.vibrato && t.keys) this.vibrato.frequency.setTargetAtTime(t.keys.lfo.vibRate, now, TC);
    // Only the output in use is connected: a synth alone stays mono up to the pan, as on the node engine.
    // A chop track's key chops come in on the keys input too.
    const keysOut = t.keys ? (t.keys.type === "synth" ? KEYS_MONO_OUT : KEYS_STEREO_OUT) : t.chops ? KEYS_STEREO_OUT : -1;
    if (this.voices && keysOut !== this.keysOut) {
      if (this.keysOut >= 0) this.voices.node.disconnect(this.keysOut);
      if (keysOut >= 0) this.voices.node.connect(this.input, keysOut);
      this.keysOut = keysOut;
    }
  }

  /** The effects on get their settings; a changed chain is rewired. */
  private applyFx(t: Track, bpm: number) {
    const now = this.ctx.currentTime;
    const chain = fxChain(t.fx);
    for (const k of chain) this.units.get(k)!.update(t.fx, bpm, now);
    if (chain.join(">") === this.wired) return;
    if (!this.live || !this.wired) return this.rewire(chain);
    // Live: dip the output, rewire under it, bring it back.
    const g = this.wire.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now, REWIRE_S / 4);
    this.wired = chain.join(">");
    clearTimeout(this.rewireTimer);
    this.rewireTimer = window.setTimeout(() => {
      this.rewire(chain);
      const at = this.ctx.currentTime;
      g.cancelScheduledValues(at);
      g.setTargetAtTime(1, at, REWIRE_S / 4);
    }, REWIRE_S * 1000);
  }

  /** input -> the effects in `chain` -> wire. Effects off are left out, so they take no processing. */
  private rewire(chain: FxKind[]) {
    this.input.disconnect();
    for (const u of this.units.values()) u.output.disconnect();
    let at: AudioNode = this.input;
    for (const k of chain) {
      const u = this.units.get(k)!;
      at.connect(u.input);
      at = u.output;
    }
    at.connect(this.wire);
    this.wired = chain.join(">");
  }

  /** The Launchkey's strips from `when`: pitch bend in cents, mod wheel 0..1. Held notes follow. */
  setExpression(when: number, bend: number, mod: number) {
    if (this.voices) return this.voices.expression(when, bend, mod);
    this.bend?.offset.setTargetAtTime(bend, when, EXPRESSION_TC);
    this.modDepth?.gain.setTargetAtTime(mod * MOD_VIB_CENTS, when, EXPRESSION_TC);
  }

  /** Send the strip through the Knob FX (true) or straight to the mix; crossfaded over a few ms, no click. */
  setKnobTarget(on: boolean) {
    if (on === this.knobTarget) return;
    this.knobTarget = on;
    const now = this.ctx.currentTime;
    const tc = this.live ? 0.004 : 0;
    this.toMix.gain.setTargetAtTime(on ? 0 : 1, now, tc);
    this.toKnob.gain.setTargetAtTime(on ? 1 : 0, now, tc);
  }

  dispose() {
    clearTimeout(this.rewireTimer);
    this.units.forEach((u) => u.dispose());
    this.bend?.stop();
    this.vibrato?.stop();
    this.nodes.forEach((n) => n.disconnect());
    this.voices?.dispose();
  }
}

/** The glue compressor's own makeup gain: Web Audio's DynamicsCompressor raises its output by (its gain at 0 dBFS)
 *  ^ -0.6, here 0 dBFS → −7 dB (threshold −14, ratio 2), so +4.2 dB. Cancelled, so switching Glue on doesn't make
 *  the mix louder (and hotter into the limiter). */
const GLUE_MAKEUP_DB = 4.2;

/**
 * The master bus: level, the Perform effects (live engine only), an optional glue compressor (off by default: it
 * pumps), then a look-ahead peak limiter at −0.3 dBFS that leaves everything below it untouched. The limiter runs in
 * the master worklet when the context has it, else on a hard-set DynamicsCompressor (which can let a peak through in
 * its first millisecond).
 */
export class MasterBus {
  /** Tracks and returns connect here. */
  readonly input: GainNode;
  /** Tracks (and returns) the Knob FX plays on connect here instead of `input`. */
  readonly knobIn: GainNode;
  /** After the level and the Perform effects: what a take from the master records. */
  readonly post: GainNode;
  /** Auditions (browser previews, chop auditions): at the master level, past the Perform effects and the glue. */
  readonly previewIn: GainNode;
  /** After the glue: sounds that shouldn't pump with the mix (the metronome) join here. */
  readonly limiterIn: AudioNode;
  /** The live effects on the mix (Pad FX, Flex Beat, Knob FX); null in bounces and on the node engine. */
  readonly perform: PerformNode | null;
  /** Output peak and deepest limiter gain since the last report (live worklet engine; else stays at rest). */
  meter: MasterMeter = { peak: 0, gain: 1 };
  private ctx: BaseAudioContext;
  private glue: DynamicsCompressorNode;
  private glueOut: GainNode;
  private glueOn: boolean | null = null;

  constructor(ctx: BaseAudioContext, out: AudioNode, worklet: boolean, live: boolean) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.input.gain.value = DEFAULT_MASTER_LEVEL;
    this.knobIn = ctx.createGain();
    this.knobIn.gain.value = DEFAULT_MASTER_LEVEL;
    this.post = ctx.createGain();
    this.previewIn = ctx.createGain();
    this.previewIn.gain.value = DEFAULT_MASTER_LEVEL;
    // Live moves aren't recorded, so a bounce has no Perform engine: the mix goes straight on.
    this.perform = worklet && live ? new PerformNode(ctx) : null;
    if (this.perform) {
      // Input 0: the mix the Knob FX leaves alone; input 1: what it plays on.
      this.input.connect(this.perform.node, 0, 0);
      this.knobIn.connect(this.perform.node, 0, 1);
      this.perform.node.connect(this.post);
    } else {
      this.input.connect(this.post);
      this.knobIn.connect(this.post);
    }
    const glue = (this.glue = ctx.createDynamicsCompressor());
    glue.threshold.value = -14;
    glue.knee.value = 6;
    glue.ratio.value = 2;
    glue.attack.value = 0.01;
    glue.release.value = 0.1;
    this.glueOut = ctx.createGain();
    this.glueOut.gain.value = Math.pow(10, -GLUE_MAKEUP_DB / 20);
    glue.connect(this.glueOut);
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
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -1;
      limit.knee.value = 0;
      limit.ratio.value = 20;
      limit.attack.value = 0.001;
      limit.release.value = 0.25;
      limit.connect(out);
      this.limiterIn = limit;
    }
    this.glueOut.connect(this.limiterIn);
    this.previewIn.connect(this.limiterIn);
    this.setGlue(false);
  }

  /** Glue on: the mix goes through the compressor; off: straight to the limiter. */
  private setGlue(on: boolean) {
    if (on === this.glueOn) return;
    this.glueOn = on;
    this.post.disconnect();
    this.post.connect(on ? this.glue : this.limiterIn);
  }

  update(level: number, glue = false) {
    this.input.gain.setTargetAtTime(level, this.ctx.currentTime, TC);
    this.knobIn.gain.setTargetAtTime(level, this.ctx.currentTime, TC);
    this.previewIn.gain.setTargetAtTime(level, this.ctx.currentTime, TC);
    this.setGlue(glue);
  }
}

/**
 * Shared send effects: A = reverb (generated impulse response), B = tempo-synced delay (fxUnits.ts Echo: stereo echo
 * or ping-pong).
 */
export class ReturnFx {
  readonly reverbIn: GainNode;
  readonly delayIn: GainNode;
  private room: Room;
  private reverbOut: GainNode;
  private echo: Echo;
  private delayOut: GainNode;
  /** The returns' way to the master: straight, or through the Knob FX when it plays on the whole mix. */
  private toMix: GainNode;
  private toKnob: GainNode;
  private knobTarget = false;
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, master: AudioNode, knobIn: AudioNode, live: boolean) {
    this.ctx = ctx;
    this.room = new Room(ctx, live);
    this.reverbIn = ctx.createGain();
    this.reverbOut = ctx.createGain();
    this.toMix = ctx.createGain();
    this.toKnob = ctx.createGain();
    this.toKnob.gain.value = 0;
    this.toMix.connect(master);
    this.toKnob.connect(knobIn);
    this.reverbIn.connect(this.room.input);
    this.room.output.connect(this.reverbOut);
    this.echo = new Echo(ctx);
    this.delayIn = this.echo.input;
    this.delayOut = ctx.createGain();
    this.echo.output.connect(this.delayOut);
    for (const out of [this.reverbOut, this.delayOut]) {
      out.connect(this.toMix);
      out.connect(this.toKnob);
    }
  }

  /** Through the Knob FX (true) or straight to the mix, crossfaded. */
  setKnobTarget(on: boolean) {
    if (on === this.knobTarget) return;
    this.knobTarget = on;
    const now = this.ctx.currentTime;
    this.toMix.gain.setTargetAtTime(on ? 0 : 1, now, 0.004);
    this.toKnob.gain.setTargetAtTime(on ? 1 : 0, now, 0.004);
  }

  update(r: Returns, bpm: number) {
    const now = this.ctx.currentTime;
    this.reverbOut.gain.setTargetAtTime(r.reverb.level, now, TC);
    this.delayOut.gain.setTargetAtTime(r.delay.level, now, TC);
    this.echo.update(r.delay, bpm, now);
    this.room.update(r.reverb);
  }
}
