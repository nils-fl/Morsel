import { scheduleNote, Voices } from "../audio/voices";
import { engine, type VoiceEngine } from "../audio/engine";
import { loadVoiceWorklet } from "../audio/worklet/voiceNode";
import { clipOf, patternLength, trackLength } from "../state/store";
import type { NoteEvent, Project, Track } from "../state/types";
import { secondsPerTick, swingOffsetTicks } from "./timing";

const SR = 44100;
const TAIL = 2; // seconds of release tail

/** Pattern indices to play, in order. */
export function arrangement(p: Project, song: boolean, pattern: number, loops = 1): number[] {
  if (!song) return Array(loops).fill(pattern);
  return p.song.flatMap((s) => Array(Math.max(1, s.repeats)).fill(s.pattern));
}

/**
 * Every note of the arrangement with its absolute tick, in time order. Choke groups cut the voices already
 * scheduled and the ducker cancels later ramps, so notes must be scheduled as they sound, not as they were entered.
 * Like the sequencer, each clip loops at its own length for as long as its pattern keeps playing.
 */
export function orderedEvents(p: Project, order: number[]): { track: Track; event: NoteEvent; tick: number }[] {
  const out: { track: Track; event: NoteEvent; tick: number }[] = [];
  let offset = 0;
  let start = 0; // where the playing pattern started (it keeps going while the same pattern repeats)
  order.forEach((i, k) => {
    const pat = p.patterns[i];
    if (k > 0 && i !== order[k - 1]) start = offset;
    const end = offset + patternLength(pat);
    for (const track of p.tracks) {
      const len = trackLength(pat, track.id);
      // The clip's passes that overlap this pass of the pattern.
      for (let from = start + Math.floor((offset - start) / len) * len; from < end; from += len) {
        for (const event of clipOf(pat, track.id).events) {
          const tick = from + event.tick;
          if (tick >= offset && tick < end) out.push({ track, event, tick });
        }
      }
    }
    offset = end;
  });
  return out.sort((a, b) => a.tick - b.tick);
}

/** `voiceEngine`: the engine to render on (the one playing, unless the Lab compares them). */
export async function renderToBuffer(p: Project, order: number[], voiceEngine: VoiceEngine = engine.voices.worklet ? "worklet" : "nodes"): Promise<AudioBuffer> {
  const spt = secondsPerTick(p.bpm);
  const totalTicks = order.reduce((n, i) => n + patternLength(p.patterns[i]), 0);
  const ctx = new OfflineAudioContext(2, Math.ceil((totalTicks * spt + TAIL) * SR), SR);
  const worklet = voiceEngine === "worklet";
  if (worklet) await loadVoiceWorklet(ctx);
  const voices = new Voices(ctx, ctx.destination, () => p, engine.bufferLookup, false, worklet);
  for (const { track, event, tick } of orderedEvents(p, order)) {
    scheduleNote(voices, track, event, (tick + swingOffsetTicks(event.tick, p.swing)) * spt, event.len * spt);
  }
  // Rendering doesn't wait for messages: the voice processors must have every note before it starts.
  await voices.sync();
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
