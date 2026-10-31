// The worklet engine's processors. The voice processor, one per mixer strip, plays the voices the main thread sends,
// each into its own output (a drum pad's bus, or the keys input), sample-accurately in the audio thread. The master
// processor limits the mix. The crush processor holds samples (a track's Bitcrush, its lower sample rate). The perform
// processor plays the live effects (Pad FX, Flex Beat, Knob FX) on the mix.
import { PERFORM_PROCESSOR_NAME, PerformCore, type FromPerform, type ToPerform } from "../perform/performCore";
import { CRUSH_PROCESSOR_NAME, CrushCore } from "./crushCore";
import { MASTER_PROCESSOR_NAME, MasterCore } from "./masterCore";
import { Expression, PROCESSOR_NAME, SampleVoice, SynthVoice, type FromProcessor, type SampleData, type ToProcessor, type Voice } from "./voiceCore";

// AudioWorkletGlobalScope (not in the DOM lib).
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Samples, shared by the processors of one context. The first copy of a sample to arrive is kept. */
const samples = new Map<string, SampleData>();

class VoiceProcessor extends AudioWorkletProcessor {
  private voices = new Map<number, { voice: Voice; out: number }>();
  /** The Launchkey's strips, when this strip is the keys track they play. */
  private expression = new Expression();
  private closed = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToProcessor>) => this.message(e.data);
  }

  private send(m: FromProcessor) {
    this.port.postMessage(m);
  }

  private message(m: ToProcessor) {
    // A time already gone (a message that came late) means now: a voice then starts with its whole envelope.
    const now = currentFrame / sampleRate;
    switch (m.type) {
      case "sample":
        if (!samples.has(m.id)) samples.set(m.id, { sampleRate: m.sampleRate, channels: m.channels });
        break;
      case "drop":
        for (const id of m.ids) samples.delete(id);
        break;
      case "voice": {
        const when = Math.max(m.when, now);
        const data = m.spec.kind === "sample" ? samples.get(m.spec.sample) : undefined;
        const voice = m.spec.kind === "synth" ? new SynthVoice(m.spec, when, sampleRate) : data ? new SampleVoice(m.spec, data, when, sampleRate) : null;
        if (voice) this.voices.set(m.id, { voice, out: m.out });
        else this.send({ type: "ended", ids: [m.id] });
        break;
      }
      case "stop":
        this.voices.get(m.id)?.voice.stop(Math.max(m.t, now), m.fast);
        break;
      case "expression":
        this.expression.set(Math.max(m.t, now), m.bend, m.mod);
        break;
      case "sync":
        this.send({ type: "synced", id: m.id });
        break;
      case "close":
        this.closed = true;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.closed) return false;
    const ended: number[] = [];
    const n = outputs[0]?.[0]?.length ?? 128;
    this.expression.fill(currentFrame, n, sampleRate);
    for (const [id, { voice, out }] of this.voices) {
      const o = outputs[out];
      if (!voice.render(o, currentFrame, o[0].length, this.expression)) {
        this.voices.delete(id);
        ended.push(id);
      }
    }
    if (ended.length) this.send({ type: "ended", ids: ended });
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, VoiceProcessor);

/** Meter reports per second (the live engine's mixer shows them). */
const METER_RATE = 30;

class MasterProcessor extends AudioWorkletProcessor {
  private core = new MasterCore(sampleRate);
  private sinceMeter = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    this.core.process(inputs[0], out, out[0].length);
    this.sinceMeter += out[0].length;
    if (this.sinceMeter >= sampleRate / METER_RATE) {
      this.sinceMeter = 0;
      this.port.postMessage(this.core.takeMeter());
    }
    return true;
  }
}

registerProcessor(MASTER_PROCESSOR_NAME, MasterProcessor);

class CrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "hold", defaultValue: 1, minValue: 1, maxValue: 64, automationRate: "k-rate" }];
  }
  private core = new CrushCore();
  private alive = true;

  constructor() {
    super();
    // Its track strip was taken down: let it go.
    this.port.onmessage = () => (this.alive = false);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const out = outputs[0];
    this.core.process(inputs[0], out, out[0].length, Math.max(1, Math.round(params.hold[0])));
    return this.alive;
  }
}

registerProcessor(CRUSH_PROCESSOR_NAME, CrushProcessor);

class PerformProcessor extends AudioWorkletProcessor {
  private core = new PerformCore(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToPerform>) => this.core.message(e.data);
    this.core.onFlexEnd = () => this.port.postMessage({ t: "flexEnd" } satisfies FromPerform);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    this.core.process(inputs[0] ?? [], out, out[0].length, currentFrame, inputs[1] ?? []);
    return true;
  }
}

registerProcessor(PERFORM_PROCESSOR_NAME, PerformProcessor);
