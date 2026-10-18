import { engine } from "../audio/engine";
import { scheduleNote } from "../audio/voices";
import { addEvent, clipOf, get, patternLength, set, setEventLength } from "../state/store";
import type { Clip, NoteEvent } from "../state/types";
import { BAR_TICKS, PPQN, quantizeTick, secondsPerTick, swingOffsetTicks } from "./timing";

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TIMER_MS = 20;

const indexCache = new WeakMap<Clip, Map<number, NoteEvent[]>>();
export function eventsByTick(clip: Clip) {
  let m = indexCache.get(clip);
  if (!m) {
    m = new Map();
    for (const e of clip.events) {
      const list = m.get(e.tick) ?? [];
      list.push(e);
      m.set(e.tick, list);
    }
    indexCache.set(clip, m);
  }
  return m;
}

/** A pad held for note repeat. */
export interface RepeatPad { track: string; pad: number; vel: number }

// Timer in a worker: not throttled when the tab is hidden.
export function makeTicker(cb: () => void) {
  const src = `let id;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  w.onmessage = cb;
  return (ms: number) => w.postMessage(ms);
}

interface Anchor { tick: number; time: number; pattern: number }

class Sequencer {
  private ticker = makeTicker(() => this.pump());
  private nextTick = 0;
  private nextTime = 0;
  private pattern = 0;
  private songIndex = 0;
  private songRepeat = 0;
  private skip = new Set<string>();
  /** Recorded notes that sounded live just before the loop end but were quantised to the next pass. */
  private skipNextPass = new Set<string>();
  private anchors: Anchor[] = [];
  /** Keys held while recording, by `${track}:${note}`. */
  private openKeys = new Map<string, { id: string; track: string; tick: number; pattern: number }>();
  /** Pads held for note repeat, by `${track}:${pad}`. */
  repeatPads = new Map<string, RepeatPad>();
  repeatOn = false;

  start(opts: { countIn?: boolean } = {}) {
    const s = get();
    if (s.playing) return;
    if (engine.ctx.state !== "running") engine.ctx.resume();
    this.pattern = s.songMode ? s.project.song[0]?.pattern ?? 0 : s.currentPattern;
    this.songIndex = 0;
    this.songRepeat = 0;
    this.nextTick = opts.countIn ? -BAR_TICKS : 0;
    this.nextTime = engine.now + 0.05;
    this.anchors = [];
    this.skip.clear();
    this.skipNextPass.clear();
    set({ playing: true, countIn: !!opts.countIn, currentPattern: this.pattern, queuedPattern: null });
    this.pump();
    this.ticker(TIMER_MS);
  }

  stop() {
    this.ticker(0);
    engine.voices.allOff(engine.now);
    this.openKeys.clear();
    set({ playing: false, recording: false, countIn: false });
  }

  /** Song position (ticks, fractional) at audio time `at`. Negative during count-in. */
  tickAt(at = engine.now): { tick: number; pattern: number } | null {
    if (!get().playing) return null;
    const spt = secondsPerTick(get().project.bpm);
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const a = this.anchors[i];
      if (a.time <= at) return { tick: a.tick + (at - a.time) / spt, pattern: a.pattern };
    }
    const a = this.anchors[0];
    return a ? { tick: a.tick, pattern: a.pattern } : null;
  }

  private pump() {
    const now = engine.now;
    const horizon = now + LOOKAHEAD;
    if (this.nextTime < now - 0.2) this.nextTime = now; // recover after a stall
    while (this.nextTime < horizon) {
      const s = get();
      const p = s.project;
      const spt = secondsPerTick(p.bpm);
      const pat = p.patterns[this.pattern];
      const len = patternLength(pat);
      const tick = this.nextTick;
      const t = this.nextTime;

      if (tick % 12 === 0) this.anchors.push({ tick, time: t, pattern: this.pattern });

      if (tick < 0) {
        if (tick % PPQN === 0) engine.click(t, tick % BAR_TICKS === 0);
      } else {
        if (s.metronome && tick % PPQN === 0) engine.click(t, tick % BAR_TICKS === 0);
        const when = t + swingOffsetTicks(tick, p.swing) * spt;
        for (const track of p.tracks) {
          const evs = eventsByTick(clipOf(pat, track.id)).get(tick);
          if (!evs) continue;
          for (const e of evs) {
            if (this.skip.delete(e.id)) continue;
            scheduleNote(engine.voices, track, e, when, e.len * spt);
          }
        }
        if (this.repeatOn && this.repeatPads.size && tick % s.repeatRate === 0) {
          const recording = s.recording && !s.countIn;
          for (const { track, pad, vel } of this.repeatPads.values()) {
            // Held across the loop while recording: the note from the last pass is already there and has just played.
            if (recording && eventsByTick(clipOf(pat, track)).get(tick)?.some((e) => e.note === pad)) continue;
            engine.voices.pad(track, pad, vel, when, s.repeatRate * spt, true);
            if (recording) addEvent(this.pattern, track, { tick, note: pad, vel, len: s.repeatRate });
          }
        }
      }

      this.nextTick++;
      this.nextTime += spt;
      if (this.nextTick === 0 && s.countIn) set({ countIn: false });
      if (this.nextTick >= len) this.wrap();
    }
    const cutoff = now - 1;
    while (this.anchors.length > 2 && this.anchors[1].time < cutoff) this.anchors.shift();
  }

  private wrap() {
    this.nextTick = 0;
    this.skip = this.skipNextPass;
    this.skipNextPass = new Set();
    const s = get();
    let next = this.pattern;
    if (s.songMode && s.project.song.length) {
      const step = s.project.song[this.songIndex];
      if (++this.songRepeat >= (step?.repeats ?? 1)) {
        this.songRepeat = 0;
        this.songIndex = (this.songIndex + 1) % s.project.song.length;
      }
      next = s.project.song[this.songIndex].pattern;
    } else if (s.queuedPattern !== null) {
      next = s.queuedPattern;
    }
    this.pattern = next;
    if (next !== s.currentPattern || s.queuedPattern !== null) set({ currentPattern: next, queuedPattern: null });
  }

  /** Called by the pattern selector: switch now when stopped, at the loop end when playing. */
  selectPattern(i: number) {
    if (!get().playing) {
      this.pattern = i;
      set({ currentPattern: i, queuedPattern: null });
    } else set({ queuedPattern: i });
  }

  // ---------- live recording ----------

  /** Where a live hit is recorded. `wrapped`: quantised forward past the loop end, onto the next pass. */
  private recordTick(): { tick: number; pattern: number; len: number; wrapped: boolean } | null {
    const s = get();
    if (!s.recording || s.countIn) return null;
    const pos = this.tickAt();
    if (!pos || pos.tick < 0) return null;
    const len = patternLength(s.project.patterns[pos.pattern]);
    const tick = quantizeTick(pos.tick, s.quantize, len);
    return { tick, pattern: pos.pattern, len, wrapped: tick < pos.tick - len / 2 };
  }

  private skipIfAhead(ev: NoteEvent, r: { pattern: number; len: number; wrapped: boolean }) {
    // The note already sounded live; don't play it again when the scheduler reaches it.
    if (r.pattern !== this.pattern) return;
    if (r.wrapped && this.nextTick > r.len / 2) this.skipNextPass.add(ev.id); // scheduler hasn't wrapped yet
    else if (ev.tick >= this.nextTick) this.skip.add(ev.id);
  }

  recordPad(track: string, pad: number, vel: number) {
    const r = this.recordTick();
    if (!r) return;
    const ev = addEvent(r.pattern, track, { tick: r.tick, note: pad, vel, len: get().quantize || 24 });
    this.skipIfAhead(ev, r);
  }

  recordKeyOn(track: string, note: number, vel: number) {
    const r = this.recordTick();
    if (!r) return;
    const ev = addEvent(r.pattern, track, { tick: r.tick, note, vel, len: 24 });
    this.skipIfAhead(ev, r);
    const pos = this.tickAt();
    this.openKeys.set(`${track}:${note}`, { id: ev.id, track, tick: pos ? pos.tick : r.tick, pattern: r.pattern });
  }

  recordKeyOff(track: string, note: number) {
    const key = `${track}:${note}`;
    const open = this.openKeys.get(key);
    if (!open) return;
    this.openKeys.delete(key);
    const pos = this.tickAt();
    if (!pos) return;
    const len = patternLength(get().project.patterns[open.pattern]);
    let dur = pos.tick - open.tick;
    if (dur < 0) dur += len;
    setEventLength(open.pattern, open.track, open.id, Math.round(dur));
  }
}

export const sequencer = new Sequencer();
