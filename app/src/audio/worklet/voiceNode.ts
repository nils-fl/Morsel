// Main-thread side of the worklet engine: a mixer strip's voice processor, and the Voice handles it hands out.
import processorUrl from "./voiceProcessor.ts?worker&url";
import { PAD_COUNT } from "../../state/types";
import type { Voice } from "../dsp";
import { PROCESSOR_NAME, type FromProcessor, type ToProcessor, type VoiceSpec } from "./voiceCore";

/** Outputs of a voice processor: one per drum pad, then the keys input in stereo (sample voices) and mono (synth). */
export const KEYS_STEREO_OUT = PAD_COUNT;
export const KEYS_MONO_OUT = PAD_COUNT + 1;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the processor into a context (once). Voice nodes can only be made after this. */
export function loadVoiceWorklet(ctx: BaseAudioContext) {
  let p = loaded.get(ctx);
  if (!p) loaded.set(ctx, (p = ctx.audioWorklet.addModule(processorUrl)));
  return p;
}

let nextId = 1;

export class VoiceNode {
  readonly node: AudioWorkletNode;
  /** Samples already sent through this node's port (the processors of a context share them). */
  private sent = new Set<string>();
  private waiting = new Map<number, () => void>();

  constructor(ctx: BaseAudioContext) {
    this.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: PAD_COUNT + 2,
      outputChannelCount: [...Array(PAD_COUNT + 1).fill(2), 1],
    });
    this.node.port.onmessage = (e: MessageEvent<FromProcessor>) => {
      const m = e.data;
      for (const id of m.type === "ended" ? m.ids : [m.id]) {
        this.waiting.get(id)?.();
        this.waiting.delete(id);
      }
    };
  }

  private post(m: ToProcessor, transfer: Transferable[] = []) {
    this.node.port.postMessage(m, transfer);
  }

  /** Send a sample's audio unless this port already did; it then arrives before any voice that plays it. */
  private ensureSample(id: string, buf: AudioBuffer) {
    if (this.sent.has(id)) return;
    this.sent.add(id);
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
    this.post({ type: "sample", id, sampleRate: buf.sampleRate, channels }, channels.map((c) => c.buffer));
  }

  dropSamples(ids: string[]) {
    for (const id of ids) this.sent.delete(id);
    this.post({ type: "drop", ids });
  }

  /** Start a voice on output `out` at `when`. Sample voices pass the sample's audio. */
  play(out: number, spec: VoiceSpec, when: number, buf?: AudioBuffer): Voice {
    if (spec.kind === "sample" && buf) this.ensureSample(spec.sample, buf);
    const id = nextId++;
    const ended = new Promise<void>((res) => this.waiting.set(id, res));
    this.post({ type: "voice", id, out, when, spec });
    return {
      ended,
      stop: (t, fast) => this.post({ type: "stop", id, t, fast: !!fast }),
    };
  }

  /** Resolves once the processor has taken every message sent so far (offline renders wait for it). */
  sync() {
    const id = nextId++;
    const done = new Promise<void>((res) => this.waiting.set(id, res));
    this.post({ type: "sync", id });
    return done;
  }

  dispose() {
    this.post({ type: "close" });
    this.node.disconnect();
    this.node.port.onmessage = null;
    for (const res of this.waiting.values()) res();
    this.waiting.clear();
  }
}
