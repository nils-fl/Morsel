import { Voices } from "../audio/voices";
import { engine } from "../audio/engine";
import { patternLength } from "../state/store";
import type { Project } from "../state/types";
import { KEYS_TRACK } from "../state/types";
import { secondsPerTick, swingOffsetTicks } from "./timing";

const SR = 44100;
const TAIL = 2; // seconds of release tail

/** Pattern indices to play, in order. */
export function arrangement(p: Project, song: boolean, pattern: number, loops = 1): number[] {
  if (!song) return Array(loops).fill(pattern);
  return p.song.flatMap((s) => Array(Math.max(1, s.repeats)).fill(s.pattern));
}

export async function renderToBuffer(p: Project, order: number[]): Promise<AudioBuffer> {
  const spt = secondsPerTick(p.bpm);
  const totalTicks = order.reduce((n, i) => n + patternLength(p.patterns[i]), 0);
  const ctx = new OfflineAudioContext(2, Math.ceil((totalTicks * spt + TAIL) * SR), SR);
  const voices = new Voices(ctx, ctx.destination, () => p, engine.bufferLookup);
  let offset = 0;
  for (const i of order) {
    const pat = p.patterns[i];
    for (const e of pat.events) {
      const when = (offset + e.tick + swingOffsetTicks(e.tick, p.swing)) * spt;
      if (e.track === KEYS_TRACK) voices.key(e.note, e.vel, when, e.len * spt);
      else voices.pad(e.track, e.vel, when, e.len * spt);
    }
    offset += patternLength(pat);
  }
  return ctx.startRendering();
}

export function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
