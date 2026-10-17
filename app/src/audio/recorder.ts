import { engine } from "./engine";

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) this.port.postMessage(ch.map((c) => c.slice()));
    return true;
  }
}
registerProcessor("tap", Tap);`;

let workletReady: Promise<void> | null = null;
function ensureWorklet() {
  workletReady ??= engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  return workletReady;
}

export type RecordSource = "input" | "master";

export interface Recording {
  /** Resolves with the captured audio once stop() is called. */
  stop(): Promise<AudioBuffer | null>;
  /** 0..1 peak level of the most recent block. */
  level(): number;
  /** True once the threshold was crossed and audio is being captured. */
  armed(): boolean;
}

export async function startRecording(source: RecordSource, opts: { threshold?: number; maxSeconds?: number; deviceId?: string } = {}): Promise<Recording> {
  await ensureWorklet();
  const ctx = engine.ctx;
  const threshold = opts.threshold ?? 0.02;
  const maxFrames = (opts.maxSeconds ?? 30) * ctx.sampleRate;

  let stream: MediaStream | null = null;
  let src: AudioNode;
  if (source === "input") {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: opts.deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    src = ctx.createMediaStreamSource(stream);
  } else {
    src = engine.voices.master;
  }

  const node = new AudioWorkletNode(ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit" });
  src.connect(node);

  const chunks: Float32Array[][] = [];
  let frames = 0;
  let capturing = threshold <= 0;
  let peak = 0;
  // Keep a little pre-roll so the attack isn't cut.
  const preRoll: Float32Array[][] = [];

  node.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
    const block = e.data;
    let p = 0;
    for (const c of block) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
    peak = p;
    if (!capturing) {
      preRoll.push(block);
      if (preRoll.length > 8) preRoll.shift();
      if (p >= threshold) {
        capturing = true;
        for (const b of preRoll) { chunks.push(b); frames += b[0].length; }
      }
      return;
    }
    if (frames < maxFrames) {
      chunks.push(block);
      frames += block[0].length;
    }
  };

  return {
    level: () => peak,
    armed: () => capturing,
    async stop() {
      src.disconnect(node);
      node.port.onmessage = null;
      stream?.getTracks().forEach((t) => t.stop());
      if (!frames) return null;
      const chCount = Math.max(...chunks.map((c) => c.length));
      const buf = ctx.createBuffer(chCount, frames, ctx.sampleRate);
      for (let c = 0; c < chCount; c++) {
        const out = buf.getChannelData(c);
        let o = 0;
        for (const blk of chunks) {
          const d = blk[Math.min(c, blk.length - 1)];
          out.set(d.subarray(0, Math.min(d.length, frames - o)), o);
          o += d.length;
        }
      }
      return trimSilence(buf, threshold / 2);
    },
  };
}

export function trimSilence(buf: AudioBuffer, threshold: number): AudioBuffer {
  const d = buf.getChannelData(0);
  let end = d.length;
  while (end > 1 && Math.abs(d[end - 1]) < threshold) end--;
  end = Math.min(d.length, end + Math.floor(buf.sampleRate * 0.02));
  if (end === d.length) return buf;
  const out = new AudioBuffer({ length: end, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(0, end), c);
  return out;
}

export function normalize(buf: AudioBuffer, target = 0.95): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-4) return buf;
  const k = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buf;
}
