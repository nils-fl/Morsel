import { get, newId, set } from "../state/store";
import { deleteSample, deleteSamples, listSampleIds, loadSample, loadSampleIndex, saveSample, saveSampleIndex, type StoredSample } from "../state/persist";
import { Voices } from "./voices";
import { encodeChannels, toFloat } from "./pcm";
import { buildClick } from "./dsp";
import type { SampleInfo } from "../state/types";

const encode = (b: AudioBuffer) => encodeChannels(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
const baseName = (f: File) => f.name.replace(/\.[^.]+$/, "");
/** The folder a file was picked from with a folder input. */
const fileDir = (f: File) => (f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(0, -1).join("/") : undefined);

class Engine {
  ctx!: AudioContext;
  voices!: Voices;
  private buffers = new Map<string, AudioBuffer>();
  private clickOut!: GainNode;

  init() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.voices = new Voices(this.ctx, this.ctx.destination, () => get().project, (id) => this.buffers.get(id), true);
    this.clickOut = this.ctx.createGain();
    this.clickOut.connect(this.ctx.destination);
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

  /** Persist a buffer as a library sample without holding its audio or listing it yet. */
  private async store(name: string, buffer: AudioBuffer, folder?: string): Promise<SampleInfo> {
    const id = newId();
    await saveSample(id, { name, folder, sampleRate: buffer.sampleRate, channels: encode(buffer) });
    return { id, name, folder, pcm16: true };
  }

  /** Register a buffer as a sample, persist it, return its id. */
  async addBuffer(name: string, buffer: AudioBuffer, folder?: string, src?: string): Promise<string> {
    const id = newId();
    this.buffers.set(id, buffer);
    set({ samples: { ...get().samples, [id]: { id, name, folder, ...(src && { src }), pcm16: true } } });
    await saveSample(id, { name, folder, src, sampleRate: buffer.sampleRate, channels: encode(buffer) });
    return id;
  }

  /**
   * Add many files to the library: one at a time, their audio not kept in memory, and the library list updated once
   * at the end (per-file updates made big folders freeze the page). Unreadable files are skipped.
   */
  async importFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<SampleInfo[]> {
    const added: SampleInfo[] = [];
    for (const [i, f] of files.entries()) {
      try {
        const buffer = await this.ctx.decodeAudioData(await f.arrayBuffer());
        added.push(await this.store(baseName(f), buffer, fileDir(f)));
      } catch { /* not audio the browser can decode */ }
      onProgress?.(i + 1, files.length);
    }
    set({ samples: { ...get().samples, ...Object.fromEntries(added.map((s) => [s.id, s])) } });
    return added;
  }

  /** Drop many samples at once (one library update). Callers make sure nothing uses them. */
  async removeSamples(ids: string[]) {
    const gone = new Set(ids);
    for (const id of ids) this.buffers.delete(id);
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

  stopPreview() {
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
