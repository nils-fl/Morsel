import { engine } from "../audio/engine";
import { addEvent, get, patternLength, set, setEventLength } from "../state/store";
import type { NoteEvent, Pattern } from "../state/types";
import { KEYS_TRACK } from "../state/types";
import { BAR_TICKS, PPQN, quantizeTick, secondsPerTick, swingOffsetTicks } from "./timing";

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TIMER_MS = 20;

const indexCache = new WeakMap<Pattern, Map<number, NoteEvent[]>>();
export function eventsByTick(pat: Pattern) {
  let m = indexCache.get(pat);
  if (!m) {
    m = new Map();
    for (const e of pat.events) {
      const list = m.get(e.tick) ?? [];
      list.push(e);
      m.set(e.tick, list);
    }
    indexCache.set(pat, m);
  }
  return m;
}

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
  private anchors: Anchor[] = [];
  private openKeys = new Map<number, { id: string; tick: number; pattern: number }>();
  /** Pads held for note repeat (pad -> velocity). */
  repeatPads = new Map<number, number>();
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
        const evs = eventsByTick(pat).get(tick);
        if (evs) {
          for (const e of evs) {
            if (this.skip.delete(e.id)) continue;
            const when = t + swingOffsetTicks(tick, p.swing) * spt;
            const lenSec = e.len * spt;
            if (e.track === KEYS_TRACK) engine.voices.key(e.note, e.vel, when, lenSec);
            else engine.voices.pad(e.track, e.vel, when, lenSec);
          }
        }
        if (this.repeatOn && this.repeatPads.size && tick % s.repeatRate === 0) {
          for (const [pad, vel] of this.repeatPads) {
            engine.voices.pad(pad, vel, t + swingOffsetTicks(tick, p.swing) * spt, s.repeatRate * spt);
            if (s.recording && !s.countIn) addEvent(this.pattern, { tick, track: pad, note: 60, vel, len: s.repeatRate });
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
    this.skip.clear();
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

  private recordTick(): { tick: number; pattern: number } | null {
    const s = get();
    if (!s.recording || s.countIn) return null;
    const pos = this.tickAt();
    if (!pos || pos.tick < 0) return null;
    const len = patternLength(s.project.patterns[pos.pattern]);
    const tick = quantizeTick(pos.tick, s.quantize, len);
    return { tick, pattern: pos.pattern };
  }

  private skipIfAhead(ev: NoteEvent, pattern: number) {
    // The note already sounded live; don't play it again later in this pass.
    if (pattern === this.pattern && ev.tick >= this.nextTick) this.skip.add(ev.id);
  }

  recordPad(pad: number, vel: number) {
    const r = this.recordTick();
    if (!r) return;
    const ev = addEvent(r.pattern, { tick: r.tick, track: pad, note: 60, vel, len: get().quantize || 24 });
    this.skipIfAhead(ev, r.pattern);
  }

  recordKeyOn(note: number, vel: number) {
    const r = this.recordTick();
    if (!r) return;
    const ev = addEvent(r.pattern, { tick: r.tick, track: KEYS_TRACK, note, vel, len: 24 });
    this.skipIfAhead(ev, r.pattern);
    const pos = this.tickAt();
    this.openKeys.set(note, { id: ev.id, tick: pos ? pos.tick : r.tick, pattern: r.pattern });
  }

  recordKeyOff(note: number) {
    const open = this.openKeys.get(note);
    if (!open) return;
    this.openKeys.delete(note);
    const pos = this.tickAt();
    if (!pos) return;
    const len = patternLength(get().project.patterns[open.pattern]);
    let dur = pos.tick - open.tick;
    if (dur < 0) dur += len;
    setEventLength(open.pattern, open.id, Math.round(dur));
  }
}

export const sequencer = new Sequencer();
