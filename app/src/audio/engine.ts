import { get, newId, set } from "../state/store";
import { deleteSample, deleteSamples, listSampleIds, loadSample, loadSampleIndex, saveSample, saveSampleIndex, type StoredSample } from "../state/persist";
import { Voices } from "./voices";
import { encodeChannels, toFloat } from "./pcm";
import { buildClick } from "./dsp";
import { loadVoiceWorklet } from "./worklet/voiceNode";
import type { SampleInfo } from "../state/types";
import { inRange, isString, oneOf, pref } from "../state/prefs";

/** Default jitter budget for live notes, ms (see Engine.liveTime). */
export const LIVE_BUDGET_MS = 8;
/** The budgets to pick from (Lab, Preferences). */
export const LIVE_BUDGETS = [0, 4, 8, 12, 20];
const liveBudgetPref = pref("morsel.liveBudget", LIVE_BUDGET_MS, inRange(0, 50));

/** Where voices play: in an AudioWorklet (sample-accurate, off the main thread) or as Web Audio node graphs. */
export type VoiceEngine = "worklet" | "nodes";
const voiceEnginePref = pref<VoiceEngine>("morsel.voiceEngine", "worklet", oneOf(["worklet", "nodes"]));

/** The audio output's device id ("" = the system's default output). */
const outputDevicePref = pref("morsel.outputDevice", "", isString);

// AudioContext.setSinkId: Chromium only, not in TypeScript's DOM types yet.
type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void>; sinkId?: string };

const encode = (b: AudioBuffer) => encodeChannels(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
const baseName = (f: File) => f.name.replace(/\.[^.]+$/, "");
/** The folder a file was picked from with a folder input. */
const fileDir = (f: File) => (f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(0, -1).join("/") : undefined);

class Engine {
  ctx!: AudioContext;
  voices!: Voices;
  private buffers = new Map<string, AudioBuffer>();
  private clickOut!: GainNode;

  /** The voice engine this session plays on; picked in Preferences or the Lab, used from the next load. */
  readonly voiceEngine = voiceEnginePref.get();

  /** The voice engine the next load plays on. */
  get nextVoiceEngine() {
    return voiceEnginePref.get();
  }

  setVoiceEngine(e: VoiceEngine) {
    voiceEnginePref.set(e);
  }

  async init() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const device = outputDevicePref.get();
    if (device) await this.useOutput(device);
    const worklet = this.voiceEngine === "worklet" && (await loadVoiceWorklet(this.ctx).then(() => true, (err) => {
      console.warn("The voice worklet couldn't be loaded; playing on Web Audio nodes", err);
      return false;
    }));
    this.voices = new Voices(this.ctx, this.ctx.destination, () => get().project, (id) => this.buffers.get(id), true, worklet);
    this.clickOut = this.ctx.createGain();
    // Into the limiter, but not through the glue: the click shouldn't make the mix pump.
    this.clickOut.connect(this.voices.masterBus.limiterIn);
    // Browsers start audio suspended until a user gesture. MIDI input doesn't count as one.
    this.ctx.onstatechange = () => set({ audioReady: this.ctx.state === "running" });
    set({ audioReady: this.ctx.state === "running" });
    const resume = () => this.ctx.state !== "running" && this.ctx.resume();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }

  get now() {
    return this.ctx.currentTime;
  }

  /** Jitter budget for live notes, ms; picked in Preferences or the Lab. 0 = play at once. */
  liveBudget = liveBudgetPref.get();

  setLiveBudget(ms: number) {
    this.liveBudget = ms;
    liveBudgetPref.set(ms);
  }

  /** Whether the output device can be picked (Chromium). */
  get canPickOutput() {
    return typeof (this.ctx as SinkContext).setSinkId === "function";
  }

  /** The picked output device's id ("" = the system's default). */
  get outputDevice() {
    return outputDevicePref.get();
  }

  /** Play through another output device and remember it. */
  async setOutputDevice(id: string) {
    outputDevicePref.set(id);
    await this.useOutput(id);
  }

  /** A device that's gone (unplugged) leaves the default output playing; the choice is kept for when it's back. */
  private async useOutput(id: string) {
    const ctx = this.ctx as SinkContext;
    if (!ctx.setSinkId || (ctx.sinkId ?? "") === id) return;
    try {
      await ctx.setSinkId(id);
    } catch (err) {
      console.warn("Output device unavailable", err);
      set({ status: "The chosen audio output isn't available; playing through the default output" });
    }
  }

  /** The audio outputs the system has (names need a microphone permission in browsers). */
  async outputDevices(): Promise<{ id: string; label: string }[]> {
    const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
    return all
      .filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
  }

  /**
   * When a live note starts: `liveBudget` ms after its input arrived (`stamp`, performance.now() time; now if
   * unknown). However long the main thread took to get here, every hit sounds the same short delay after it was
   * played, instead of a random one, and it never starts in the past (where its envelope would start late too).
   * A hit that waited longer than the budget plays at once.
   */
  liveTime(stamp?: number) {
    const age = stamp === undefined ? 0 : Math.max(0, performance.now() - stamp);
    return this.ctx.currentTime + Math.max(0, this.liveBudget - age) / 1000;
  }

  buffer(id: string) {
    return this.buffers.get(id);
  }

  bufferLookup = (id: string) => this.buffers.get(id);

  /**
   * List the library from its index; the audio stays on disk until a sample is used (ensure).
   * Samples the index doesn't know (an older library, or added just before the tab closed) are read once, one at a
   * time so a big library can't fill the memory, and indexed.
   */
  async loadLibrary() {
    const [ids, index = {}] = await Promise.all([listSampleIds(), loadSampleIndex()]);
    const samples: Record<string, SampleInfo> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const s = index[id];
      if (s) samples[id] = { ...s, id };
      else missing.push(id);
    }
    let broken = 0;
    for (const [i, id] of missing.entries()) {
      if (i % 25 === 0) set({ status: `Indexing the sample library… ${i}/${missing.length}` });
      try {
        const s = await loadSample(id);
        if (s) samples[id] = { id, name: s.name, folder: s.folder, src: s.src, ...(s.channels[0] instanceof Int16Array && { pcm16: true as const }) };
      } catch (err) {
        console.warn(`Sample ${id} couldn't be read`, err);
        broken++;
      }
    }
    set({ samples, status: broken ? `${broken} stored sample${broken === 1 ? "" : "s"} couldn't be read and ${broken === 1 ? "was" : "were"} skipped` : missing.length ? `Indexed ${missing.length} samples` : "" });
    if (missing.length || ids.length !== Object.keys(index).length) await saveSampleIndex(samples);
  }

  private loading = new Map<string, Promise<AudioBuffer | undefined>>();
  /** Samples that failed to load: not retried (and reported) on every edit. */
  private broken = new Set<string>();

  /** The sample's audio, read from storage the first time. Undefined when it's gone or damaged. */
  ensure(id: string): Promise<AudioBuffer | undefined> {
    const have = this.buffers.get(id);
    if (have || this.broken.has(id)) return Promise.resolve(have);
    let p = this.loading.get(id);
    if (!p) {
      p = this.read(id)
        .then((buf) => {
          // Deleted while it loaded: don't bring it back.
          if (!buf) this.broken.add(id);
          else if (get().samples[id]) {
            this.buffers.set(id, buf);
            set({ bufferTick: get().bufferTick + 1 });
          }
          return buf;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  async ensureAll(ids: Iterable<string>) {
    await Promise.all([...ids].filter((id) => !this.buffers.has(id)).map((id) => this.ensure(id)));
  }

  /** Read a sample without keeping it (browsing previews). */
  private async read(id: string) {
    try {
      const s = await loadSample(id);
      return s ? this.fromStored(s) : undefined;
    } catch (err) {
      console.warn(`Sample ${id} couldn't be loaded`, err);
      set({ status: `Sample “${get().samples[id]?.name ?? id}” couldn't be loaded` });
      return undefined;
    }
  }

  private fromStored(s: StoredSample) {
    if (!Array.isArray(s.channels) || !s.channels.length || !s.channels[0]?.length) throw new Error("no audio data");
    const b = new AudioBuffer({ length: s.channels[0].length, numberOfChannels: s.channels.length, sampleRate: s.sampleRate });
    s.channels.forEach((d, c) => b.copyToChannel(toFloat(d), c));
    return b;
  }

  /** Register a buffer as a sample, persist it, return its id. */
  async addBuffer(name: string, buffer: AudioBuffer, folder?: string, src?: string): Promise<string> {
    const id = newId();
    this.buffers.set(id, buffer);
    set({ samples: { ...get().samples, [id]: { id, name, folder, ...(src && { src }), pcm16: true } } });
    await saveSample(id, { name, folder, src, sampleRate: buffer.sampleRate, channels: encode(buffer) });
    return id;
  }

  /** Drop many samples at once (one library update). Callers make sure nothing uses them. */
  async removeSamples(ids: string[]) {
    const gone = new Set(ids);
    for (const id of ids) this.buffers.delete(id);
    this.voices.dropSamples(ids);
    set({ samples: Object.fromEntries(Object.entries(get().samples).filter(([id]) => !gone.has(id))) });
    await deleteSamples(ids);
  }

  private compacting = false;

  /**
   * Rewrite samples stored as 32-bit float (before 16-bit storage) as 16-bit, halving their size. Runs in the
   * background one sample at a time; a tab closed half way just continues at the next start.
   */
  async compactLibrary() {
    if (this.compacting) return;
    this.compacting = true;
    try {
      const todo = Object.values(get().samples).filter((s) => !s.pcm16).map((s) => s.id);
      const done: string[] = [];
      const mark = () => {
        const samples = { ...get().samples };
        for (const d of done) if (samples[d]) samples[d] = { ...samples[d], pcm16: true };
        set({ samples });
        done.length = 0;
      };
      for (const [i, id] of todo.entries()) {
        if (i % 25 === 0) set({ status: `Shrinking the sample library to 16-bit… ${i}/${todo.length}` });
        // Removed meanwhile (Remove unused samples): skip it, and never write it back.
        if (!get().samples[id]) continue;
        try {
          const s = await loadSample(id);
          if (!s || !get().samples[id]) continue;
          if (!(s.channels[0] instanceof Int16Array)) await saveSample(id, { ...s, channels: encodeChannels(s.channels.map(toFloat)) });
          done.push(id);
        } catch (err) {
          console.warn(`Sample ${id} couldn't be compacted`, err);
        }
        await new Promise((r) => setTimeout(r)); // let playback and the UI breathe
        if (done.length >= 100) mark();
      }
      mark();
      if (todo.length) set({ status: `Sample library shrunk to 16-bit (${todo.length} samples)` });
    } finally {
      this.compacting = false;
    }
  }

  /** Drop a sample from memory, the library and storage. Callers clear references to it first. */
  async removeSample(id: string) {
    this.buffers.delete(id);
    this.voices.dropSamples([id]);
    const { [id]: _gone, ...rest } = get().samples;
    set({ samples: rest });
    await deleteSample(id);
  }

  /** Decode and store a file. Folder defaults to the file's directory when picked via a folder input. */
  async addFile(file: File, folder?: string, src?: string): Promise<string> {
    return this.addBuffer(baseName(file), await this.decode(file), folder ?? fileDir(file), src);
  }

  async decode(file: File) {
    return this.ctx.decodeAudioData(await file.arrayBuffer());
  }

  private previewSrc: AudioBufferSourceNode | null = null;

  /**
   * Monophonic raw audition (browser, chop editor): a new preview cuts the last one.
   * Plays `duration` seconds from `offset`; returns the context time it starts at.
   */
  preview(id: string, offset = 0, duration?: number, gain = 0.8): number | undefined {
    this.stopPreview();
    const buf = this.buffers.get(id);
    if (!buf) {
      // Not loaded (browsing the library): read it for this one preview, unless another preview came first.
      const token = this.previewToken;
      void this.read(id).then((b) => b && token === this.previewToken && this.previewBuffer(b, offset, duration, gain));
      return;
    }
    return this.previewBuffer(buf, offset, duration, gain);
  }

  private previewToken = 0;

  /** Audition decoded audio that isn't in the library (a file in a connected folder). */
  previewBuffer(buf: AudioBuffer, offset = 0, duration?: number, gain = 0.8): number {
    this.stopPreview();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.voices.master);
    const when = this.ctx.currentTime;
    src.start(when, offset, duration);
    this.previewSrc = src;
    return when;
  }

  private stream: { el: HTMLAudioElement; gain: GainNode } | null = null;
  private streamUrl = "";

  /**
   * Audition a file by streaming it through an audio element: it starts at once whatever the file's length or format,
   * where decoding it first would wait for the whole file (connected folders).
   */
  previewFile(file: File, gain = 0.8) {
    this.stopPreview();
    if (!this.stream) {
      const el = new Audio();
      const g = this.ctx.createGain();
      this.ctx.createMediaElementSource(el).connect(g).connect(this.voices.master);
      this.stream = { el, gain: g };
    }
    this.stream.gain.gain.value = gain;
    this.streamUrl = URL.createObjectURL(file);
    this.stream.el.src = this.streamUrl;
    this.stream.el.play().catch(() => undefined); // a newer preview cut it off, or the format can't be played
  }

  private chopVoices: { src: AudioBufferSourceNode; gain: GainNode; choke: boolean }[] = [];

  /**
   * Chop audition (the Chop tab, the Launchkey's keys): `duration` seconds of buffer from `offset` at `rate`. A choking
   * one cuts the other choking ones; the rest ring out. `loop` repeats the region until stopped. Returns its start time.
   */
  chopVoice(id: string, offset: number, duration: number, opts: { rate?: number; gain?: number; choke?: boolean; loop?: boolean } = {}): number | undefined {
    const buf = this.buffers.get(id);
    if (!buf) return;
    const { rate = 1, gain = 0.8, choke = true, loop = false } = opts;
    const when = this.ctx.currentTime;
    if (choke) for (const v of this.chopVoices.filter((x) => x.choke)) this.cutChopVoice(v, when);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.voices.master);
    if (loop) {
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = offset + duration;
      src.start(when, offset);
    } else src.start(when, offset, duration);
    const v = { src, gain: g, choke };
    this.chopVoices.push(v);
    src.onended = () => {
      this.chopVoices = this.chopVoices.filter((x) => x !== v);
      g.disconnect();
    };
    return when;
  }

  /** Move the loop of a looping chop audition (the region was trimmed while it plays). */
  setChopLoop(offset: number, duration: number) {
    for (const { src } of this.chopVoices) {
      if (!src.loop) continue;
      src.loopStart = offset;
      src.loopEnd = offset + duration;
    }
  }

  /** 5 ms fade, like a choke. */
  private cutChopVoice(v: { src: AudioBufferSourceNode; gain: GainNode }, when: number) {
    this.chopVoices = this.chopVoices.filter((x) => x !== v);
    v.gain.gain.setTargetAtTime(0, when, 0.0015);
    try {
      v.src.stop(when + 0.01);
    } catch { /* already stopped */ }
  }

  stopPreview() {
    for (const v of this.chopVoices) this.cutChopVoice(v, this.ctx.currentTime);
    this.previewToken++;
    if (this.stream && this.streamUrl) {
      this.stream.el.pause();
      this.stream.el.removeAttribute("src");
      URL.revokeObjectURL(this.streamUrl);
      this.streamUrl = "";
    }
    try {
      this.previewSrc?.stop();
    } catch { /* not started */ }
    this.previewSrc = null;
  }

  click(when: number, accent: boolean) {
    buildClick(this.ctx, this.clickOut, when, accent);
  }
}

export const engine = new Engine();
