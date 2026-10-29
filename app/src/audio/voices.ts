// Instrument layer: turns "pad i / key note on track t" into voices on a context, through that track's
// mixer strip. Used by the live engine and by the offline renderer.
import { defaultPad, inputOf, padAudible, padDucks, trackAudible, trackById } from "../state/store";
import type { KeysInstrument, KeysLfo, NoteEvent, Pad, Project, SidechainInput, SynthParams, Track } from "../state/types";
import { PAD_COUNT } from "../state/types";
import { applyDuck, duckRamp } from "./duck";
import { buildSampleVoice, buildSynthVoice, reverseBuffer, type Voice } from "./dsp";
import { MasterBus, ReturnFx, TrackStrip } from "./trackFx";
import { KEYS_MONO_OUT, KEYS_STEREO_OUT } from "./worklet/voiceNode";

export type BufferLookup = (id: string) => AudioBuffer | undefined;

// Multisample zones play the whole sample, unfiltered, with a short release.
const ZONE_VOICE = { ...defaultPad(0), start: 0, end: 1, pitch: 0, attack: 0.002, decay: 0.4, cutoff: 1, hpCutoff: 0, resonance: 0, pan: 0, reverse: false };

/** The zone a note plays: the one whose keys hold it (an Ableton Live instrument's ranges), else the nearest root. */
export function zoneFor<Z extends { root: number; lo?: number; hi?: number }>(zones: Z[], note: number): Z {
  const inRange = zones.find((z) => z.lo !== undefined && z.hi !== undefined && z.lo <= note && note <= z.hi);
  return inRange ?? zones.reduce((best, z) => (Math.abs(z.root - note) < Math.abs(best.root - note) ? z : best));
}

export class Voices {
  readonly master: GainNode;
  readonly masterBus: MasterBus;
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
  /** Voices play in the strips' voice processors (the worklet engine) instead of as node graphs. */
  readonly worklet: boolean;
  /** Live playback (not a bounce): settings changes are smoothed over time. */
  private live: boolean;

  /** `worklet`: the context must have the voice worklet loaded (loadVoiceWorklet). */
  constructor(ctx: BaseAudioContext, out: AudioNode, getProject: () => Project, buffer: BufferLookup, live = false, worklet = false) {
    this.ctx = ctx;
    this.worklet = worklet;
    this.live = live;
    this.getProject = getProject;
    this.buffer = buffer;
    this.masterBus = new MasterBus(ctx, out, worklet, live);
    this.master = this.masterBus.input;
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
    for (const t of p.tracks) this.strip(t).update(t, trackAudible(p, t.id), (i) => padAudible(t, i), p.bpm);
    this.returns.update(p.returns, p.bpm);
    this.masterBus.update(p.masterLevel, p.masterGlue);
  }

  private strip(t: Track): TrackStrip {
    let s = this.strips.get(t.id);
    if (!s) {
      s = new TrackStrip(this.ctx, t.kind, this.master, this.returns.reverbIn, this.returns.delayIn, this.worklet, this.live);
      const p = this.getProject();
      s.update(t, trackAudible(p, t.id), (i) => padAudible(t, i), p.bpm);
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

  /**
   * A sample voice on output `out` of track t's strip: pad `out`'s bus, or the keys input. `pad` holds the sound
   * settings (a drum pad's, or a keys instrument's dressed as one).
   */
  private sampleVoice(t: Track, out: number, sampleId: string | null, pad: Pad, vel: number, when: number, pitchOffset = 0, gate = pad.mode === "gate", mod?: KeysLfo): Voice | null {
    const strip = this.strip(t);
    if (strip.voices) {
      const buf = sampleId ? this.buffer(sampleId) : undefined;
      if (!buf || !sampleId) return null;
      return strip.voices.play(out, { kind: "sample", sample: sampleId, pad, vel, pitchOffset, gate, lfo: mod }, when, buf);
    }
    const buf = this.sampleFor(sampleId, pad.reverse);
    if (!buf) return null;
    const keys = out === KEYS_STEREO_OUT;
    return buildSampleVoice(this.ctx, keys ? strip.input : strip.padBus[out], buf, pad, vel, when, pitchOffset, gate, mod, keys ? strip.pitchIn ?? undefined : undefined);
  }

  private synthVoice(t: Track, s: SynthParams, note: number, vel: number, when: number, mod: KeysLfo): Voice {
    const strip = this.strip(t);
    if (strip.voices) return strip.voices.play(KEYS_MONO_OUT, { kind: "synth", synth: s, note, vel, lfo: mod }, when);
    return buildSynthVoice(this.ctx, strip.input, s, note, vel, when, mod, strip.pitchIn ?? undefined);
  }

  /** Samples deleted from the library: free the voice processors' copies. */
  dropSamples(ids: string[]) {
    for (const s of this.strips.values()) s.voices?.dropSamples(ids);
  }

  /** Resolves once every voice processor has taken the voices sent so far (an offline render waits for it). */
  async sync() {
    await Promise.all([...this.strips.values()].map((s) => s.voices?.sync()));
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
    if (!t || !pad || !this.buffer(pad.sampleId ?? "")) return null;
    // Choke: same group cuts others in this rack (and itself, like an MPC mono pad).
    if (pad.choke > 0) {
      t.pads.forEach((other, j) => {
        if (other.choke === pad.choke) this.padVoices.get(`${trackId}:${j}`)?.forEach((v) => v.stop(when, true));
      });
    }
    // Pressure opens both filters: LP up towards 1, HP down towards 0.
    const press = pressure ? this.pressure[i] / 127 : 0;
    const effective = { ...pad, cutoff: Math.min(1, pad.cutoff + press * (1 - pad.cutoff)), hpCutoff: Math.max(0, pad.hpCutoff * (1 - press)) };
    const v = this.sampleVoice(t, i, pad.sampleId, effective, vel, when);
    if (!v) return null;
    this.track(this.padVoices, `${trackId}:${i}`, v);
    if (p.sidechain.length) this.duck(inputOf(trackId, i), when);
    if (pad.mode === "gate" && lenSec !== undefined) v.stop(when + lenSec);
    return v;
  }

  /** A hit on a sidechain input dips every track listening to it, each with its own envelope: a keys track as a
   *  whole, a drum track the pads it ducks (never the input pad). Same depth for every hit, like a ducker keyed
   *  from the trigger. */
  private duck(input: SidechainInput, when: number) {
    const p = this.getProject();
    if (!p.sidechain.includes(input)) return;
    const at = Math.max(when, this.ctx.currentTime);
    for (const t of p.tracks) {
      if (!t.duck.on || t.duck.input !== input) continue;
      const points = duckRamp(at, t.duck);
      for (const g of this.duckGains(t)) applyDuck(g.gain, points);
    }
  }

  /** The gain nodes a track's ducker moves. */
  private duckGains(t: Track): GainNode[] {
    const s = this.strip(t);
    return t.kind === "keys" ? [s.duck] : s.padDuck.filter((_, i) => padDucks(t, i));
  }

  /** Current ducker gain of a track (1 = not ducked; on a drum track, its deepest-ducked pad). */
  duckLevel(trackId: string): number {
    const t = trackById(this.getProject(), trackId);
    const gains = t ? this.duckGains(t) : [];
    return gains.length ? Math.min(...gains.map((g) => g.gain.value)) : 1;
  }

  releasePad(trackId: string, i: number, when: number) {
    const t = trackById(this.getProject(), trackId);
    if (t?.pads[i]?.mode !== "gate") return;
    this.padVoices.get(`${trackId}:${i}`)?.forEach((v) => v.stop(when));
  }

  /** Start a note on a keys track (on `keys` instead of its own instrument, when given: auditioning); returns a voice
   *  you must stop (unless lenSec given). */
  key(trackId: string, note: number, vel: number, when: number, lenSec?: number, keys?: KeysInstrument): Voice | null {
    const p = this.getProject();
    const t = trackById(p, trackId);
    const k = keys ?? t?.keys;
    if (!t || !k) return null;
    const out = KEYS_STEREO_OUT;
    let v: Voice | null = null;
    if (k.type === "synth") {
      v = this.synthVoice(t, { ...k.synth, volume: k.synth.volume * k.volume / 0.7 }, note, vel, when, k.lfo);
    } else if (k.type === "chromatic") {
      const pad = trackById(p, k.sourceTrack)?.pads[k.sourcePad];
      if (pad) v = this.sampleVoice(t, out, pad.sampleId, { ...pad, volume: pad.volume * k.volume / 0.7 }, vel, when, note - 60, true, k.lfo);
    } else if (k.type === "sample") {
      const s = k.sample;
      const voice = { ...ZONE_VOICE, attack: s.attack, decay: s.release, cutoff: s.cutoff, resonance: s.resonance, volume: k.volume };
      v = this.sampleVoice(t, out, s.sampleId, voice, vel, when, note - s.root, true, k.lfo);
    } else if (k.zones.length) {
      const zone = zoneFor(k.zones, note);
      v = this.sampleVoice(t, out, zone.sampleId, { ...ZONE_VOICE, volume: k.volume }, vel, when, note - zone.root, true, k.lfo);
    }
    if (v && lenSec !== undefined) {
      v.stop(when + lenSec);
      this.track(this.seqKeyVoices, trackId, v);
    }
    return v;
  }

  /** The Launchkey's strips on a keys track from `when`: pitch bend in cents, mod wheel 0..1. */
  expression(trackId: string, bend: number, mod: number, when: number) {
    const t = trackById(this.getProject(), trackId);
    if (t?.kind === "keys") this.strip(t).setExpression(when, bend, mod);
  }

  keyOn(trackId: string, note: number, vel: number, when: number, keys?: KeysInstrument) {
    const id = `${trackId}:${note}`;
    this.keyVoices.get(id)?.stop(when, true);
    const v = this.key(trackId, note, vel, when, undefined, keys);
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
