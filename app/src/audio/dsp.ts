// Graph builders that work on any BaseAudioContext, so live playback and
// offline WAV rendering share exactly the same sound.
import type { KeysLfo, Pad, SynthParams } from "../state/types";

export interface Voice {
  /** Release (gate) or cut (choke). `fast` = 5 ms fade for chokes. */
  stop(when: number, fast?: boolean): void;
  ended: Promise<void>;
}

export const DECAY_MAX = 2;

/**
 * Freeze an automated param at time t, keeping the value its envelope has *at t*.
 * Reading param.value instead is wrong for releases scheduled ahead of time (sequencer playback,
 * offline export): it returns the current value (often the default 1), not the value at t.
 */
function holdAt(p: AudioParam, t: number) {
  if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(t);
  else {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
  }
} // decay at max = play the full region

/** BiquadFilter Q is in dB for lowpass. Pads use the Web Audio default; the synth maps resonance. */
export const PAD_FILTER_Q_DB = 1;
export const padQDb = (resonance: number) => PAD_FILTER_Q_DB + resonance * 18;
export const synthQDb = (resonance: number) => 0.7 + resonance * 18;

export const cutoffHz = (c: number) => 20 * Math.pow(2, Math.max(0, Math.min(1, c)) * 10);
export const velGain = (vel: number) => Math.pow(vel / 127, 1.5);

/** Vibrato depth 1 = ±100 cents; filter depth 1 = ±2 octaves. */
export const VIB_CENTS = 100;
export const FILTER_LFO_CENTS = 2400;

/** A sine LFO from `when` into `targets` (cent params), or null when it is off. Stop it with the voice. */
function lfo(ctx: BaseAudioContext, rate: number, cents: number, when: number, targets: AudioParam[]): OscillatorNode | null {
  if (cents <= 0 || !targets.length) return null;
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = cents;
  o.connect(g);
  for (const t of targets) g.connect(t);
  o.start(when);
  return o;
}

/** Vibrato on `pitch` params and a filter LFO on `filter` params; returns a function that stops both. */
function noteLfos(ctx: BaseAudioContext, mod: KeysLfo | undefined, when: number, pitch: AudioParam[], filter: AudioParam[]) {
  if (!mod) return () => {};
  const oscs = [
    lfo(ctx, mod.vibRate, mod.vibDepth * VIB_CENTS, when, pitch),
    lfo(ctx, mod.filterRate, mod.filterDepth * FILTER_LFO_CENTS, when, filter),
  ].filter((o): o is OscillatorNode => o !== null);
  return () => oscs.forEach((o) => o.stop());
}

export function buildSampleVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  buffer: AudioBuffer,
  pad: Pad,
  vel: number,
  when: number,
  pitchOffset = 0,
  gate = pad.mode === "gate",
  mod?: KeysLfo,
): Voice {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const rate = Math.pow(2, (pad.pitch + pitchOffset) / 12);
  src.playbackRate.value = rate;

  const a = Math.min(pad.start, pad.end);
  const b = Math.max(pad.start, pad.end);
  const offset = a * buffer.duration;
  const regionDur = Math.max(0.001, (b - a) * buffer.duration) / rate;

  // HP and LP mirror each other: same cutoff curve and resonance, each left out at its open end
  // (HP at 0, LP at 1) so neither colours the sound when it is off.
  const q = padQDb(pad.resonance);
  const amp = ctx.createGain();
  const pan = ctx.createStereoPanner();
  pan.pan.value = pad.pan;
  let chain: AudioNode = src;
  // A filter LFO needs the lowpass even when it is open (it then sweeps down from the top).
  const filterLfo = !!mod && mod.filterDepth > 0;
  let lowpass: BiquadFilterNode | null = null;
  for (const [type, c, open] of [["highpass", pad.hpCutoff, pad.hpCutoff <= 0], ["lowpass", pad.cutoff, pad.cutoff >= 1 && !filterLfo]] as const) {
    if (open) continue;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoffHz(c);
    f.Q.value = q;
    if (type === "lowpass") lowpass = f;
    chain = chain.connect(f);
  }
  chain.connect(amp).connect(pan).connect(out);
  const stopLfos = noteLfos(ctx, mod, when, [src.detune], lowpass ? [lowpass.detune] : []);

  const peak = velGain(vel) * pad.volume;
  const g = amp.gain;
  const attack = Math.max(0.001, pad.attack);
  g.setValueAtTime(0, when);
  g.linearRampToValueAtTime(peak, when + attack);

  let end = when + regionDur;
  if (!gate && pad.decay < DECAY_MAX) {
    const fadeEnd = Math.min(end, when + attack + Math.max(0.01, pad.decay));
    g.setValueAtTime(peak, when + attack);
    g.linearRampToValueAtTime(0, fadeEnd);
    end = fadeEnd;
  }
  src.start(when, offset, (b - a) * buffer.duration);
  src.stop(end + 0.01);

  // The earliest stop wins: a sequenced note gets its length at schedule time, and a choke or Stop
  // can still cut it earlier.
  let stopAt = Infinity;
  const ended = new Promise<void>((res) => (src.onended = () => {
    stopLfos();
    res();
  }));
  return {
    ended,
    stop(t, fast) {
      if (t >= stopAt) return;
      stopAt = t;
      const rel = fast ? 0.005 : Math.max(0.01, Math.min(pad.decay, DECAY_MAX));
      holdAt(g, t);
      g.linearRampToValueAtTime(0, t + rel);
      try {
        src.stop(t + rel + 0.01);
      } catch { /* already stopped */ }
    },
  };
}

// One second of white noise per context, looped by the synth's noise source.
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext) {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

// tanh saturation curves by drive amount (shared: building one is a 1024-point loop).
const driveCurves = new Map<number, Float32Array<ArrayBuffer>>();
function driveCurve(drive: number) {
  const key = Math.round(drive * 100);
  let c = driveCurves.get(key);
  if (!c) {
    const k = 1 + (key / 100) * 8;
    c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) c[i] = Math.tanh(k * ((i / (c.length - 1)) * 2 - 1)) / Math.tanh(k);
    driveCurves.set(key, c);
  }
  return c;
}

/** Key tracking pivots around C4: notes above open the filter, notes below close it. */
const KEY_TRACK_PIVOT = 261.63;

export function buildSynthVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  s: SynthParams,
  note: number,
  vel: number,
  when: number,
  mod?: KeysLfo,
): Voice {
  const freq = 440 * Math.pow(2, (note - 69) / 12);
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o1.type = s.wave;
  o2.type = s.wave2;
  o1.frequency.value = freq;
  o2.frequency.value = freq;
  o2.detune.value = s.detune;
  const mix2 = ctx.createGain();
  mix2.gain.value = s.osc2Level;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = synthQDb(s.resonance);
  // 24 dB: a second, unresonant lowpass in series.
  const filter2 = s.slope === 24 ? ctx.createBiquadFilter() : null;
  if (filter2) {
    filter2.type = "lowpass";
    filter2.Q.value = 0;
    filter.connect(filter2);
  }
  const amp = ctx.createGain();
  o1.connect(filter);
  o2.connect(mix2).connect(filter);
  const sources: AudioScheduledSourceNode[] = [o1, o2];
  if (s.sub > 0) {
    const sub = ctx.createOscillator();
    sub.frequency.value = freq / 2;
    const g = ctx.createGain();
    g.gain.value = s.sub * 0.8;
    sub.connect(g).connect(filter);
    sources.push(sub);
  }
  if (s.noise > 0) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    n.loopStart = Math.random() * 0.5; // voices don't all start on the same noise
    const g = ctx.createGain();
    g.gain.value = s.noise * 0.5;
    n.connect(g).connect(filter);
    sources.push(n);
  }
  let last: AudioNode = filter2 ?? filter;
  if (s.drive > 0) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(s.drive);
    shaper.oversample = "2x";
    last.connect(shaper);
    last = shaper;
  }
  last.connect(amp).connect(out);

  const track = s.keyTrack > 0 ? Math.pow(freq / KEY_TRACK_PIVOT, s.keyTrack) : 1;
  const base = Math.max(20, Math.min(18000, cutoffHz(s.cutoff) * track));
  const env = s.envAmount * (1 - s.velFilter + (s.velFilter * vel) / 127);
  const top = Math.min(18000, base * Math.pow(2, env * 6));
  const a = Math.max(0.002, s.attack);
  const filterParams = filter2 ? [filter.frequency, filter2.frequency] : [filter.frequency];
  for (const f of filterParams) {
    f.setValueAtTime(base, when);
    f.linearRampToValueAtTime(top, when + a);
    // Own filter decay: it closes fully; otherwise it follows the amp's decay and sustain.
    if (s.filterDecay > 0) f.setTargetAtTime(base, when + a, s.filterDecay / 3);
    else f.setTargetAtTime(base + (top - base) * s.sustain, when + a, Math.max(0.01, s.decay) / 3);
  }

  const peak = velGain(vel) * s.volume * 0.5;
  const g = amp.gain;
  g.setValueAtTime(0, when);
  g.linearRampToValueAtTime(peak, when + a);
  g.setTargetAtTime(peak * s.sustain, when + a, Math.max(0.01, s.decay) / 3);
  for (const src of sources) src.start(when);
  const pitched = sources.filter((x): x is OscillatorNode => x instanceof OscillatorNode);
  const stopLfos = noteLfos(ctx, mod, when, pitched.map((o) => o.detune), filter2 ? [filter.detune, filter2.detune] : [filter.detune]);

  let stopAt = Infinity;
  const ended = new Promise<void>((res) => (o1.onended = () => {
    stopLfos();
    res();
  }));
  return {
    ended,
    stop(t, fast) {
      if (t >= stopAt) return;
      stopAt = t;
      const rel = fast ? 0.005 : Math.max(0.01, s.release);
      holdAt(g, t);
      g.setTargetAtTime(0, t, rel / 4);
      for (const f of filterParams) holdAt(f, t);
      for (const src of sources) {
        try {
          src.stop(t + rel + 0.05);
        } catch { /* already stopped */ }
      }
    },
  };
}

export function buildClick(ctx: BaseAudioContext, out: AudioNode, when: number, accent: boolean) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(0.3, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
  o.connect(g).connect(out);
  o.start(when);
  o.stop(when + 0.06);
}

export function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = r.getChannelData(c);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return r;
}
