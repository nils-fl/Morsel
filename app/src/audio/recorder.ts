import { engine } from "./engine";
import { isNative } from "../platform/native";

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

export type RecordSource = "input" | "master" | "tab";

export interface Recording {
  /** Resolves with the captured audio once stop() is called. */
  stop(): Promise<AudioBuffer | null>;
  /** 0..1 peak level of the most recent block. */
  level(): number;
  /** True once the threshold was crossed and audio is being captured. */
  armed(): boolean;
  /** True once the take reached its maximum length. */
  full(): boolean;
}

// ---------- tab share ----------
// Shared once (needs a click: Chrome's picker), then kept open so takes can start and stop from the Launchkey.

let tabStream: MediaStream | null = null;

/** The words for the "tab" source: a browser tab, or in the desktop app the Mac's sound output (electron/main.ts). */
export const TAB_WORDS = isNative()
  ? {
      source: "System audio", share: "Capture system audio…", button: "System audio", shared: "System audio captured", stopped: "System audio capture stopped",
      failed: "System audio capture failed", first: "Capture system audio first (System audio, at the top of the page)",
      hint: "Capture the Mac's sound once (macOS asks to allow Morsel under Screen & System Audio Recording). After that the Launchkey runs the takes.",
      noAudio: "No system audio – allow Morsel under Screen & System Audio Recording in System Settings",
    }
  : {
      source: "Browser tab (YouTube…)", share: "Share tab…", button: "Share tab", shared: "Tab shared", stopped: "Tab sharing stopped",
      failed: "Tab share failed", first: "Share the tab first (Share tab, at the top of the page)",
      hint: "Share the YouTube tab once (tick “Share tab audio” in Chrome's picker). After that the Launchkey runs the takes.",
      noAudio: "No audio shared – tick 'Share tab audio' in the picker",
    };

export const tabConnected = () => !!tabStream?.getAudioTracks().some((t) => t.readyState === "live");

/** Open Chrome's share picker for a tab with audio. `onEnded` fires when the share stops ("Stop sharing"). */
export async function connectTab(onEnded: () => void) {
  disconnectTab();
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // Video is required by the API; keep it tiny but alive, since stopping it can end the whole share.
    video: { frameRate: 1, width: 320, height: 180 },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    selfBrowserSurface: "exclude",
    systemAudio: "include",
  } as DisplayMediaStreamOptions);
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(TAB_WORDS.noAudio);
  }
  tabStream = stream;
  const ended = () => {
    if (tabStream !== stream) return;
    tabStream = null;
    stream.getTracks().forEach((t) => t.stop());
    onEnded();
  };
  stream.getTracks().forEach((t) => t.addEventListener("ended", ended, { once: true }));
}

export function disconnectTab() {
  const s = tabStream;
  tabStream = null;
  s?.getTracks().forEach((t) => t.stop());
}

export async function startRecording(source: RecordSource, opts: { threshold?: number; maxSeconds?: number; deviceId?: string } = {}): Promise<Recording> {
  await ensureWorklet();
  const ctx = engine.ctx;
  const threshold = opts.threshold ?? 0.02;
  const maxFrames = (opts.maxSeconds ?? 30) * ctx.sampleRate;

  // Only streams opened for this take are stopped with it; the tab share stays open.
  let stream: MediaStream | null = null;
  let src: AudioNode;
  if (source === "input") {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: opts.deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    src = ctx.createMediaStreamSource(stream);
  } else if (source === "tab") {
    if (!tabStream || !tabConnected()) throw new Error("No tab shared");
    src = ctx.createMediaStreamSource(tabStream);
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
    full: () => frames >= maxFrames,
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
