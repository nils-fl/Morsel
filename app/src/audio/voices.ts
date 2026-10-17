// Instrument layer: turns "pad i / key note" into voices on a context.
// Used by the live engine and by the offline renderer.
import { trackAudible } from "../state/store";
import type { Project } from "../state/types";
import { KEYS_TRACK, TRACK_COUNT } from "../state/types";
import { buildSampleVoice, buildSynthVoice, reverseBuffer, type Voice } from "./dsp";

export type BufferLookup = (id: string) => AudioBuffer | undefined;

export class Voices {
  readonly buses: GainNode[];
  readonly master: GainNode;
  private padVoices = new Map<number, Voice[]>();
  private keyVoices = new Map<number, Voice>();
  private reversed = new WeakMap<AudioBuffer, AudioBuffer>();
  pressure: number[] = Array(16).fill(0);
  readonly ctx: BaseAudioContext;
  private getProject: () => Project;
  private buffer: BufferLookup;

  constructor(ctx: BaseAudioContext, out: AudioNode, getProject: () => Project, buffer: BufferLookup) {
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
    this.buses = Array.from({ length: TRACK_COUNT }, () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    });
    this.updateMix();
  }

  updateMix() {
    const p = this.getProject();
    const t = this.ctx.currentTime;
    this.buses.forEach((b, i) => b.gain.setTargetAtTime(trackAudible(p, i) ? p.levels[i] : 0, t, 0.01));
  }

  private sampleFor(id: string | null, reverse: boolean) {
    if (!id) return undefined;
    const buf = this.buffer(id);
    if (!buf || !reverse) return buf;
    let r = this.reversed.get(buf);
    if (!r) this.reversed.set(buf, (r = reverseBuffer(this.ctx, buf)));
    return r;
  }

  private track(map: Map<number, Voice[]>, key: number, v: Voice) {
    const list = map.get(key) ?? [];
    list.push(v);
    map.set(key, list);
    v.ended.then(() => {
      const l = map.get(key);
      if (l) map.set(key, l.filter((x) => x !== v));
    });
  }

  /** Trigger pad i. Returns the voice (or null if the pad is empty). */
  pad(i: number, vel: number, when: number, lenSec?: number): Voice | null {
    const p = this.getProject();
    const pad = p.pads[i];
    const buf = this.sampleFor(pad.sampleId, pad.reverse);
    if (!buf) return null;
    // Choke: same group cuts others (and itself, like an MPC mono pad).
    if (pad.choke > 0) {
      p.pads.forEach((other, j) => {
        if (other.choke === pad.choke) this.padVoices.get(j)?.forEach((v) => v.stop(when, true));
      });
    }
    // Pressure opens both filters: LP up towards 1, HP down towards 0.
    const press = this.pressure[i] / 127;
    const effective = { ...pad, cutoff: Math.min(1, pad.cutoff + press * (1 - pad.cutoff)), hpCutoff: Math.max(0, pad.hpCutoff * (1 - press)) };
    const v = buildSampleVoice(this.ctx, this.buses[i], buf, effective, vel, when);
    this.track(this.padVoices, i, v);
    if (pad.mode === "gate" && lenSec !== undefined) v.stop(when + lenSec);
    return v;
  }

  releasePad(i: number, when: number) {
    const p = this.getProject();
    if (p.pads[i].mode !== "gate") return;
    this.padVoices.get(i)?.forEach((v) => v.stop(when));
  }

  /** Start a keys note; returns a voice you must stop (unless lenSec given). */
  key(note: number, vel: number, when: number, lenSec?: number): Voice | null {
    const p = this.getProject();
    const k = p.keys;
    const out = this.buses[KEYS_TRACK];
    let v: Voice | null = null;
    if (k.type === "synth") {
      v = buildSynthVoice(this.ctx, out, { ...k.synth, volume: k.synth.volume * k.volume / 0.7 }, note, vel, when);
    } else if (k.type === "chromatic") {
      const pad = p.pads[k.sourcePad];
      const buf = this.sampleFor(pad.sampleId, pad.reverse);
      if (buf) v = buildSampleVoice(this.ctx, out, buf, { ...pad, volume: pad.volume * k.volume / 0.7 }, vel, when, note - 60, true);
    } else if (k.zones.length) {
      const zone = k.zones.reduce((best, z) => (Math.abs(z.root - note) < Math.abs(best.root - note) ? z : best));
      const buf = this.buffer(zone.sampleId);
      if (buf) {
        const pad = { ...p.pads[0], start: 0, end: 1, pitch: 0, attack: 0.002, decay: 0.4, cutoff: 1, hpCutoff: 0, resonance: 0, pan: 0, volume: k.volume, reverse: false };
        v = buildSampleVoice(this.ctx, out, buf, pad, vel, when, note - zone.root, true);
      }
    }
    if (v && lenSec !== undefined) v.stop(when + lenSec);
    return v;
  }

  keyOn(note: number, vel: number, when: number) {
    this.keyVoices.get(note)?.stop(when, true);
    const v = this.key(note, vel, when);
    if (v) this.keyVoices.set(note, v);
  }

  keyOff(note: number, when: number) {
    this.keyVoices.get(note)?.stop(when);
    this.keyVoices.delete(note);
  }

  allOff(when: number) {
    this.keyVoices.forEach((v) => v.stop(when, true));
    this.keyVoices.clear();
    this.padVoices.forEach((l) => l.forEach((v) => v.stop(when, true)));
  }
}
