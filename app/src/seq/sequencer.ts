import { engine } from "../audio/engine";
import { scheduleNote } from "../audio/voices";
import { addEvent, clipOf, get, markUndo, patternLength, set, setEventLength, trackLength } from "../state/store";
import type { Clip, NoteEvent } from "../state/types";
import { BAR_TICKS, PPQN, quantizeTick, secondsPerTick, soundTick, swingOffsetTicks } from "./timing";

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TIMER_MS = 20;

const indexCache = new WeakMap<Clip, Map<number, Map<number, NoteEvent[]>>>();
/** A clip's notes by the tick they sound on (nudge included) in a loop of `length` ticks. */
export function eventsByTick(clip: Clip, length: number) {
  let byLength = indexCache.get(clip);
  if (!byLength) indexCache.set(clip, (byLength = new Map()));
  let m = byLength.get(length);
  if (!m) {
    m = new Map();
    for (const e of clip.events) {
      const at = soundTick(e, length);
      const list = m.get(at) ?? [];
      list.push(e);
      m.set(at, list);
    }
    byLength.set(length, m);
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
  /** Note repeat while stopped runs on its own clock (like an MPC); playback takes over from it. */
  private repeatTicker = makeTicker(() => this.pumpRepeat());
  private repeatClock = false;
  private repeatNext = 0;
  /**
   * Ticks since the current pattern started. It keeps counting while the pattern repeats, so each track loops at
   * its own length (a 3-bar track drifts against a 4-bar one), and starts again from 0 when the pattern changes.
   */
  private nextTick = 0;
  private nextTime = 0;
  private pattern = 0;
  private songIndex = 0;
  private songRepeat = 0;
  /** Recorded notes that already sounded live: event id → the tick (as `nextTick`) the scheduler must not play it at. */
  private skip = new Map<string, number>();
  private anchors: Anchor[] = [];
  /** Keys held while recording, by `${track}:${note}`. */
  private openKeys = new Map<string, { id: string; track: string; tick: number; pattern: number }>();
  /** Pads held for note repeat, by `${track}:${pad}`. */
  repeatPads = new Map<string, RepeatPad>();
  repeatOn = false;
  /** Whether this take already has its undo step (made on its first recorded note, so Undo removes the whole take). */
  private takeOpen = false;

  /** Recording (re)starts: the next recorded note opens a new undo step. */
  newTake() {
    this.takeOpen = false;
  }

  private beginTake() {
    if (this.takeOpen) return;
    markUndo();
    this.takeOpen = true;
  }

  start(opts: { countIn?: boolean } = {}) {
    const s = get();
    if (s.playing) return;
    if (engine.ctx.state !== "running") engine.ctx.resume();
    this.stopRepeatClock();
    this.newTake();
    this.pattern = s.songMode ? s.project.song[0]?.pattern ?? 0 : s.currentPattern;
    this.songIndex = 0;
    this.songRepeat = 0;
    this.nextTick = opts.countIn ? -BAR_TICKS : 0;
    this.nextTime = engine.now + 0.05;
    this.anchors = [];
    this.skip.clear();
    set({ playing: true, countIn: !!opts.countIn, currentPattern: this.pattern, queuedPattern: null });
    this.pump();
    this.ticker(TIMER_MS);
  }

  stop() {
    this.ticker(0);
    engine.voices.allOff(engine.now);
    this.openKeys.clear();
    set({ playing: false, recording: false, countIn: false });
    this.ensureRepeatClock(); // pads still held for note repeat keep going
  }

  /** Ticks (fractional) since the playing pattern started, at audio time `at`. Negative during count-in. */
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

  /** Where a track is in its own loop at audio time `at` (ticks, fractional). Negative during count-in. */
  trackTickAt(trackId: string, at = engine.now): { tick: number; pattern: number } | null {
    const pos = this.tickAt(at);
    if (!pos || pos.tick < 0) return pos;
    return { tick: pos.tick % trackLength(get().project.patterns[pos.pattern], trackId), pattern: pos.pattern };
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
          const trackLen = trackLength(pat, track.id);
          const evs = eventsByTick(clipOf(pat, track.id), trackLen).get(tick % trackLen);
          if (!evs) continue;
          for (const e of evs) {
            if (this.skip.get(e.id) === tick) {
              this.skip.delete(e.id);
              continue;
            }
            // Swing goes by the note's step, so a nudged note keeps its swing.
            scheduleNote(engine.voices, track, e, t + swingOffsetTicks(e.tick, p.swing) * spt, e.len * spt);
          }
        }
        if (this.repeatOn && this.repeatPads.size && tick % s.repeatRate === 0) {
          const recording = s.recording && !s.countIn;
          for (const { track, pad, vel } of this.repeatPads.values()) {
            const trackLen = trackLength(pat, track);
            const local = tick % trackLen;
            // Held across the loop while recording: the note from the last pass is already there and has just played.
            if (recording && eventsByTick(clipOf(pat, track), trackLen).get(local)?.some((e) => e.note === pad)) continue;
            engine.voices.pad(track, pad, vel, when, s.repeatRate * spt, true);
            if (recording) {
              this.beginTake();
              addEvent(this.pattern, track, { tick: local, note: pad, vel, len: s.repeatRate });
            }
          }
        }
      }

      this.nextTick++;
      this.nextTime += spt;
      if (this.nextTick === 0 && s.countIn) set({ countIn: false });
      if (this.nextTick > 0 && this.nextTick % len === 0) this.passEnd();
    }
    const cutoff = now - 1;
    while (this.anchors.length > 2 && this.anchors[1].time < cutoff) this.anchors.shift();
  }

  /** Start the stopped-transport repeat clock if pads are held for note repeat; the first hit sounds now. */
  ensureRepeatClock() {
    if (this.repeatClock || get().playing || !this.repeatOn || !this.repeatPads.size) return;
    this.repeatClock = true;
    this.repeatNext = engine.now;
    this.pumpRepeat();
    this.repeatTicker(TIMER_MS);
  }

  private stopRepeatClock() {
    if (!this.repeatClock) return;
    this.repeatClock = false;
    this.repeatTicker(0);
  }

  /** Free-running note repeat at the project tempo and repeat rate. Nothing is recorded while stopped. */
  private pumpRepeat() {
    const s = get();
    if (!this.repeatClock || s.playing || !this.repeatOn || !this.repeatPads.size) return this.stopRepeatClock();
    const now = engine.now;
    if (this.repeatNext < now - 0.2) this.repeatNext = now; // recover after a stall
    const step = s.repeatRate * secondsPerTick(s.project.bpm);
    while (this.repeatNext < now + LOOKAHEAD) {
      for (const { track, pad, vel } of this.repeatPads.values()) engine.voices.pad(track, pad, vel, this.repeatNext, step, true);
      this.repeatNext += step;
    }
  }

  /** The end of a pass of the pattern (its longest clip): count song repeats, switch to a queued pattern. */
  private passEnd() {
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
    if (next !== this.pattern) {
      this.nextTick = 0;
      this.skip.clear();
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

  /**
   * Where a live hit on `track` is recorded: `tick` in the track's clip, and `at`, the pattern tick it lands on (the
   * next pass of the clip when quantised forward past its end).
   */
  private recordTick(track: string, at: number): { tick: number; pattern: number; at: number } | null {
    const s = get();
    if (!s.recording || s.countIn) return null;
    const pos = this.tickAt(at);
    if (!pos || pos.tick < 0) return null;
    const len = trackLength(s.project.patterns[pos.pattern], track);
    const local = pos.tick % len;
    const tick = quantizeTick(local, s.quantize, len);
    const wrapped = tick < local - len / 2;
    return { tick, pattern: pos.pattern, at: Math.round(pos.tick - local) + tick + (wrapped ? len : 0) };
  }

  private skipIfAhead(ev: NoteEvent, r: { pattern: number; at: number }) {
    // The note already sounded live; don't play it again when the scheduler reaches it.
    if (r.pattern === this.pattern && r.at >= this.nextTick) this.skip.set(ev.id, r.at);
  }

  /** `at`: the audio time the note sounds (engine.liveTime). */
  recordPad(track: string, pad: number, vel: number, at: number) {
    const r = this.recordTick(track, at);
    if (!r) return;
    this.beginTake();
    const ev = addEvent(r.pattern, track, { tick: r.tick, note: pad, vel, len: get().quantize || 24 });
    this.skipIfAhead(ev, r);
  }

  recordKeyOn(track: string, note: number, vel: number, at: number) {
    const r = this.recordTick(track, at);
    if (!r) return;
    this.beginTake();
    const ev = addEvent(r.pattern, track, { tick: r.tick, note, vel, len: 24 });
    this.skipIfAhead(ev, r);
    const pos = this.tickAt(at);
    this.openKeys.set(`${track}:${note}`, { id: ev.id, track, tick: pos ? pos.tick : r.tick, pattern: r.pattern });
  }

  recordKeyOff(track: string, note: number, at: number) {
    const key = `${track}:${note}`;
    const open = this.openKeys.get(key);
    if (!open) return;
    this.openKeys.delete(key);
    const pos = this.tickAt(at);
    if (!pos) return;
    // Both are pattern ticks; the pattern may have started again in between.
    const len = trackLength(get().project.patterns[open.pattern], open.track);
    let dur = pos.tick - open.tick;
    if (dur < 0) dur += len;
    setEventLength(open.pattern, open.track, open.id, Math.round(dur));
  }
}

export const sequencer = new Sequencer();
