import { get, newId, set } from "../state/store";
import { listSampleIds, loadSample, saveSample, type StoredSample } from "../state/persist";
import { Voices } from "./voices";
import { buildClick } from "./dsp";
import type { SampleInfo } from "../state/types";

class Engine {
  ctx!: AudioContext;
  voices!: Voices;
  /** Tap of the master output, for resampling. */
  masterTap!: MediaStreamAudioDestinationNode;
  private buffers = new Map<string, AudioBuffer>();
  private clickOut!: GainNode;

  init() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.voices = new Voices(this.ctx, this.ctx.destination, () => get().project, (id) => this.buffers.get(id));
    this.masterTap = this.ctx.createMediaStreamDestination();
    this.voices.master.connect(this.masterTap);
    this.clickOut = this.ctx.createGain();
    this.clickOut.connect(this.ctx.destination);
    // Browsers start audio suspended until a user gesture.
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

  async loadAllSamples() {
    const ids = await listSampleIds();
    const samples: Record<string, SampleInfo> = {};
    await Promise.all(
      ids.map(async (id) => {
        const s = await loadSample(id);
        if (!s) return;
        this.buffers.set(id, this.fromStored(s));
        samples[id] = { id, name: s.name, folder: s.folder };
      }),
    );
    set({ samples });
  }

  private fromStored(s: StoredSample) {
    const b = new AudioBuffer({ length: s.channels[0].length, numberOfChannels: s.channels.length, sampleRate: s.sampleRate });
    s.channels.forEach((d, c) => b.copyToChannel(new Float32Array(d), c));
    return b;
  }

  /** Register a buffer as a sample, persist it, return its id. */
  async addBuffer(name: string, buffer: AudioBuffer, folder?: string): Promise<string> {
    const id = newId();
    this.buffers.set(id, buffer);
    set({ samples: { ...get().samples, [id]: { id, name, folder } } });
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
    await saveSample(id, { name, folder, sampleRate: buffer.sampleRate, channels });
    return id;
  }

  /** Decode and store a file. Folder defaults to the file's directory when picked via a folder input. */
  async addFile(file: File, folder?: string): Promise<string> {
    const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const dir = file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(0, -1).join("/") : undefined;
    return this.addBuffer(file.name.replace(/\.[^.]+$/, ""), buffer, folder ?? dir);
  }

  private previewSrc: AudioBufferSourceNode | null = null;

  /** Monophonic raw audition (used by the browser): a new preview cuts the last one. */
  preview(id: string) {
    this.stopPreview();
    const buf = this.buffers.get(id);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(this.voices.master);
    src.start();
    this.previewSrc = src;
  }

  stopPreview() {
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
