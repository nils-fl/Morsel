// Main-thread side of the Perform engine: the master's perform processor and the messages to it.
import type { PerformSettings } from "./catalog";
import { PERFORM_PROCESSOR_NAME, type FromPerform, type ToPerform } from "./performCore";

export class PerformNode {
  readonly node: AudioWorkletNode;
  /** A one-shot Flex Beat pass ended in the audio thread. */
  onFlexEnd: (() => void) | null = null;
  private settings: PerformSettings | null = null;

  /** The context must have the voice worklet module loaded (loadVoiceWorklet registers this processor too). */
  constructor(ctx: BaseAudioContext) {
    this.node = new AudioWorkletNode(ctx, PERFORM_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    this.node.port.onmessage = (e: MessageEvent<FromPerform>) => {
      if (e.data.t === "flexEnd") this.onFlexEnd?.();
    };
  }

  send(m: ToPerform) {
    this.node.port.postMessage(m);
  }

  /** Settings from the project (sent only when they changed). */
  setSettings(s: PerformSettings) {
    if (s === this.settings) return;
    this.settings = s;
    this.send({ t: "settings", settings: s });
  }
}
