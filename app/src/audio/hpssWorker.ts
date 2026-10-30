// Runs hpss() off the main thread (audio/hpss.ts hpssAsync).
import { hpss } from "./hpss";

self.onmessage = (e: MessageEvent<Float32Array[]>) => {
  const out = hpss(e.data);
  self.postMessage(out, { transfer: [...out.drums, ...out.harmonic].map((c) => c.buffer) });
};
