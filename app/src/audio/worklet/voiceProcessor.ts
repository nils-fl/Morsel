// The worklet engine's processors. The voice processor, one per mixer strip, plays the voices the main thread sends,
// each into its own output (a drum pad's bus, or the keys input), sample-accurately in the audio thread. The master
// processor limits the mix.
import { MASTER_PROCESSOR_NAME, MasterCore } from "./masterCore";
import { PROCESSOR_NAME, SampleVoice, SynthVoice, type FromProcessor, type SampleData, type ToProcessor, type Voice } from "./voiceCore";

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
    for (const [id, { voice, out }] of this.voices) {
      const o = outputs[out];
      if (!voice.render(o, currentFrame, o[0].length)) {
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
