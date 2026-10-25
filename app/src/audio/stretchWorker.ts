// Runs stretch() off the main thread (audio/stretch.ts stretchAsync).
import { stretch } from "./stretch";

self.onmessage = (e: MessageEvent<{ channels: Float32Array[]; sampleRate: number; outLength: number; anchors: number[] }>) => {
  const { channels, sampleRate, outLength, anchors } = e.data;
  const out = stretch(channels, sampleRate, outLength, anchors);
  self.postMessage(out, { transfer: out.map((c) => c.buffer) });
};
