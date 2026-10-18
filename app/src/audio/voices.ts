// Instrument layer: turns "pad i / key note on track t" into voices on a context, through that track's
// mixer strip. Used by the live engine and by the offline renderer.
import { defaultPad, padAudible, parseDuckTarget, trackAudible, trackById } from "../state/store";
import type { DuckTarget, NoteEvent, Project, Track } from "../state/types";
import { DUCK_ALL, PAD_COUNT } from "../state/types";
import { applyDuck, duckRamp } from "./duck";
import { buildSampleVoice, buildSynthVoice, reverseBuffer, type Voice } from "./dsp";
import { ReturnFx, TrackStrip } from "./trackFx";

export type BufferLookup = (id: string) => AudioBuffer | undefined;

// Multisample zones play the whole sample, unfiltered, with a short release.
const ZONE_VOICE = { ...defaultPad(0), start: 0, end: 1, pitch: 0, attack: 0.002, decay: 0.4, cutoff: 1, hpCutoff: 0, resonance: 0, pan: 0, reverse: false };

export class Voices {
  readonly master: GainNode;
  readonly returns: ReturnFx;
  private strips = new Map<string, TrackStrip>();
  private padVoices = new Map<string, Voice[]>();
  private keyVoices = new Map<string, Voice>();
  /** Sequenced keys notes (given a length up front), so Stop can cut them too. */
  private seqKeyVoices = new Map<string, Voice[]>();
  private reversed = new WeakMap<AudioBuffer, AudioBuffer>();
  /** Aftertouch of the Launchkey pads (they play the drum track). */
  pressure: number[] = Array(PAD_COUNT).fill(0);
  readonly ctx: BaseAudioContext;
  private getProject: () => Project;
  private buffer: BufferLookup;

  constructor(ctx: BaseAudioContext, out: AudioNode, getProject: () => Project, buffer: BufferLookup, live = false) {
    this.ctx = ctx;
    this.getProject = getProject;
    this.buffer = buffer;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(out);
    this.returns = new ReturnFx(ctx, this.master, live);
    this.updateMix();
  }

  /** Build strips for new tracks, drop removed ones, and apply every mixer and FX setting. */
  updateMix() {
    const p = this.getProject();
    for (const [id, strip] of this.strips) {
      if (!trackById(p, id)) {
        strip.dispose();
        this.strips.delete(id);
      }
    }
    for (const t of p.tracks) this.strip(t).update(t, trackAudible(p, t.id), (i) => padAudible(t, i));
    this.returns.update(p.returns, p.bpm);
  }

  private strip(t: Track): TrackStrip {
    let s = this.strips.get(t.id);
    if (!s) {
      s = new TrackStrip(this.ctx, t.kind, this.master, this.returns.reverbIn, this.returns.delayIn);
      s.update(t, trackAudible(this.getProject(), t.id), (i) => padAudible(t, i));
      this.strips.set(t.id, s);
    }
    return s;
  }

  private sampleFor(id: string | null, reverse: boolean) {
    if (!id) return undefined;
    const buf = this.buffer(id);
    if (!buf || !reverse) return buf;
    let r = this.reversed.get(buf);
    if (!r) this.reversed.set(buf, (r = reverseBuffer(this.ctx, buf)));
    return r;
  }

  private track(map: Map<string, Voice[]>, key: string, v: Voice) {
    const list = map.get(key) ?? [];
    list.push(v);
    map.set(key, list);
    v.ended.then(() => {
      const l = map.get(key);
      if (l) map.set(key, l.filter((x) => x !== v));
    });
  }

  /** Trigger pad i of a drum track. `pressure`: apply the hardware pads' aftertouch. Returns the voice (or null if the pad is empty). */
  pad(trackId: string, i: number, vel: number, when: number, lenSec?: number, pressure = false): Voice | null {
    const p = this.getProject();
    const t = trackById(p, trackId);
    const pad = t?.pads[i];
    if (!t || !pad) return null;
    const buf = this.sampleFor(pad.sampleId, pad.reverse);
    if (!buf) return null;
    // Choke: same group cuts others in this rack (and itself, like an MPC mono pad).
    if (pad.choke > 0) {
      t.pads.forEach((other, j) => {
        if (other.choke === pad.choke) this.padVoices.get(`${trackId}:${j}`)?.forEach((v) => v.stop(when, true));
      });
    }
    // Pressure opens both filters: LP up towards 1, HP down towards 0.
    const press = pressure ? this.pressure[i] / 127 : 0;
    const effective = { ...pad, cutoff: Math.min(1, pad.cutoff + press * (1 - pad.cutoff)), hpCutoff: Math.max(0, pad.hpCutoff * (1 - press)) };
    const v = buildSampleVoice(this.ctx, this.strip(t).padBus[i], buf, effective, vel, when);
    this.track(this.padVoices, `${trackId}:${i}`, v);
    if (p.duck.on && p.duck.sourceTrack === trackId && p.duck.sourcePad === i) this.duck(when);
    if (pad.mode === "gate" && lenSec !== undefined) v.stop(when + lenSec);
    return v;
  }

  /** The gain nodes a duck target dips. */
  private duckNodes(target: DuckTarget): GainNode[] {
    const p = this.getProject();
    const d = p.duck;
    if (target === DUCK_ALL) {
      return p.tracks.flatMap((t) => {
        const s = this.strip(t);
        // The source's own rack: every pad but the source. Every other track: the whole track.
        return t.id === d.sourceTrack ? s.padDuck.filter((_, i) => i !== d.sourcePad) : [s.duck];
      });
    }
    const parsed = parseDuckTarget(target)!;
    const t = trackById(p, parsed.track);
    if (!t) return [];
    const s = this.strip(t);
    return parsed.pad === null ? [s.duck] : [s.padDuck[parsed.pad]].filter(Boolean);
  }

  /** Dip the duck target(s). Same depth for every hit, like a ducker keyed from the trigger. */
  private duck(when: number) {
    const d = this.getProject().duck;
    const points = duckRamp(Math.max(when, this.ctx.currentTime), d);
    for (const g of this.duckNodes(d.target)) applyDuck(g.gain, points);
  }

  /** Current ducker gain of a target (1 = not ducked), or of the deepest-ducked one for DUCK_ALL. */
  duckLevel(target: DuckTarget): number {
    const nodes = this.duckNodes(target);
    return nodes.length ? Math.min(...nodes.map((g) => g.gain.value)) : 1;
  }

  releasePad(trackId: string, i: number, when: number) {
    const t = trackById(this.getProject(), trackId);
    if (t?.pads[i]?.mode !== "gate") return;
    this.padVoices.get(`${trackId}:${i}`)?.forEach((v) => v.stop(when));
  }

  /** Start a note on a keys track; returns a voice you must stop (unless lenSec given). */
  key(trackId: string, note: number, vel: number, when: number, lenSec?: number): Voice | null {
    const p = this.getProject();
    const t = trackById(p, trackId);
    const k = t?.keys;
    if (!t || !k) return null;
    const out = this.strip(t).input;
    let v: Voice | null = null;
    if (k.type === "synth") {
      v = buildSynthVoice(this.ctx, out, { ...k.synth, volume: k.synth.volume * k.volume / 0.7 }, note, vel, when, k.lfo);
    } else if (k.type === "chromatic") {
      const pad = trackById(p, k.sourceTrack)?.pads[k.sourcePad];
      const buf = pad && this.sampleFor(pad.sampleId, pad.reverse);
      if (pad && buf) v = buildSampleVoice(this.ctx, out, buf, { ...pad, volume: pad.volume * k.volume / 0.7 }, vel, when, note - 60, true, k.lfo);
    } else if (k.type === "sample") {
      const s = k.sample;
      const buf = s.sampleId ? this.buffer(s.sampleId) : undefined;
      const voice = { ...ZONE_VOICE, attack: s.attack, decay: s.release, cutoff: s.cutoff, resonance: s.resonance, volume: k.volume };
      if (buf) v = buildSampleVoice(this.ctx, out, buf, voice, vel, when, note - s.root, true, k.lfo);
    } else if (k.zones.length) {
      const zone = k.zones.reduce((best, z) => (Math.abs(z.root - note) < Math.abs(best.root - note) ? z : best));
      const buf = this.buffer(zone.sampleId);
      if (buf) v = buildSampleVoice(this.ctx, out, buf, { ...ZONE_VOICE, volume: k.volume }, vel, when, note - zone.root, true, k.lfo);
    }
    if (v && lenSec !== undefined) {
      v.stop(when + lenSec);
      this.track(this.seqKeyVoices, trackId, v);
    }
    return v;
  }

  keyOn(trackId: string, note: number, vel: number, when: number) {
    const id = `${trackId}:${note}`;
    this.keyVoices.get(id)?.stop(when, true);
    const v = this.key(trackId, note, vel, when);
    if (v) this.keyVoices.set(id, v);
  }

  keyOff(trackId: string, note: number, when: number) {
    const id = `${trackId}:${note}`;
    this.keyVoices.get(id)?.stop(when);
    this.keyVoices.delete(id);
  }

  allOff(when: number) {
    this.keyVoices.forEach((v) => v.stop(when, true));
    this.keyVoices.clear();
    this.padVoices.forEach((l) => l.forEach((v) => v.stop(when, true)));
    this.seqKeyVoices.forEach((l) => l.forEach((v) => v.stop(when, true)));
  }
}

/** Play a sequenced note on its track's instrument. */
export function scheduleNote(voices: Voices, track: Track, e: NoteEvent, when: number, lenSec: number) {
  if (track.kind === "drum") voices.pad(track.id, e.note, e.vel, when, lenSec);
  else voices.key(track.id, e.note, e.vel, when, lenSec);
}
