// Actions shared by the on-screen UI and the Launchkey controller.
import { engine } from "./audio/engine";
import { normalize, startRecording, type Recording } from "./audio/recorder";
import { equalSlices, detectOnsets, slicesFromMarkers } from "./audio/chop";
import { DECAY_MAX } from "./audio/dsp";
import { newChop } from "./modes/chop";
import { sequencer } from "./seq/sequencer";
import { get, set, updatePad, updateProject } from "./state/store";
import { PAD_COUNT, type SampleSource } from "./state/types";

export function playPad(i: number, vel: number) {
  engine.voices.pad(i, vel, engine.now);
  if (get().selectedPad !== i) set({ selectedPad: i, selectedTrack: i });
  sequencer.recordPad(i, vel);
}

export function releasePad(i: number) {
  engine.voices.releasePad(i, engine.now);
}

export function keyOn(note: number, vel: number) {
  engine.voices.keyOn(note, vel, engine.now);
  sequencer.recordKeyOn(note, vel);
}

export function keyOff(note: number) {
  engine.voices.keyOff(note, engine.now);
  sequencer.recordKeyOff(note);
}

export function togglePlay() {
  if (get().playing) sequencer.stop();
  else sequencer.start();
}

export function toggleRecord() {
  const s = get();
  if (!s.playing) {
    set({ recording: true });
    sequencer.start({ countIn: true });
  } else set({ recording: !s.recording });
}

// ---------- sampling ----------

let rec: Recording | null = null;
let starting = false;
let levelTimer = 0;

const THRESHOLD: Record<SampleSource, number> = { input: 0.02, master: 0.001, tab: 0.002 };

/** Start or stop sampling. Tab capture needs a click on the page, so the hardware can only stop it. */
export async function toggleSampling(fromHardware = false) {
  const s = get();
  if (s.sampling !== "idle") return finishSampling();
  if (starting) return;
  if (s.sampleSource === "tab" && fromHardware) {
    set({ status: "Start tab capture with the Sample button on screen" });
    return;
  }
  starting = true;
  try {
    rec = await startRecording(s.sampleSource, {
      threshold: THRESHOLD[s.sampleSource],
      // Long enough to grab a whole phrase off a video; chop it down afterwards.
      maxSeconds: s.sampleSource === "tab" ? 120 : 30,
      onEnded: () => void finishSampling(),
    });
  } catch (err) {
    set({ status: `Audio input failed: ${(err as Error).message}` });
    return;
  } finally {
    starting = false;
  }
  set({ sampling: "waiting", status: s.sampleSource === "tab" ? "Waiting for sound… press play in the shared tab" : "Waiting for sound…" });
  levelTimer = window.setInterval(() => {
    if (rec?.armed() && get().sampling === "waiting") set({ sampling: "recording", status: "Recording…" });
  }, 50);
}

async function finishSampling() {
  const r = rec;
  if (!r) return;
  clearInterval(levelTimer);
  rec = null;
  const source = get().sampleSource;
  set({ sampling: "idle" });
  const buf = await r.stop();
  if (!buf) return set({ status: "Nothing recorded" });
  if (source === "tab") {
    // Long takes go to the chop editor instead of straight onto a pad.
    const id = await engine.addBuffer(`Tab ${new Date().toLocaleTimeString()}`, normalize(buf));
    set({ chop: newChop(id), tab: "Chop", status: `Captured ${buf.duration.toFixed(1)} s – chop it up` });
    return;
  }
  const pad = get().selectedPad;
  const id = await engine.addBuffer(`Rec ${new Date().toLocaleTimeString()}`, normalize(buf));
  updatePad(pad, { sampleId: id, name: "Rec", start: 0, end: 1, decay: 2, pitch: 0, reverse: false }, true);
  set({ status: `Sampled ${buf.duration.toFixed(1)} s to pad ${pad + 1}` });
}

export function samplingLevel() {
  return rec?.level() ?? 0;
}

// ---------- chop ----------

/** Slice boundaries inside `range` (N + 1 markers for N slices). */
export function autoMarkers(buf: AudioBuffer, range: [number, number], mode: "equal" | "transient", count: number, sensitivity = 0.5): number[] {
  const [a, b] = range;
  if (mode === "equal") return [...equalSlices(count).map(([s0]) => a + (b - a) * s0), b];
  return [...detectOnsets(buf.getChannelData(0), buf.sampleRate, count, sensitivity, range), b];
}

/** Write slices to consecutive pads from `firstPad`, keeping each pad's colour. Returns how many fitted. */
export function slicesToPads(sampleId: string, markers: number[], firstPad: number, baseName: string): number {
  const slices = slicesFromMarkers(markers).slice(0, PAD_COUNT - firstPad);
  const base = baseName.slice(0, 9);
  updateProject((p) => ({
    ...p,
    pads: p.pads.map((pad, i) => {
      const k = i - firstPad;
      if (k < 0 || k >= slices.length) return pad;
      const [start, end] = slices[k];
      return { ...pad, sampleId, name: `${base} ${k + 1}`, start, end, decay: DECAY_MAX, mode: "oneshot", reverse: false };
    }),
  }));
  return slices.length;
}

/** Chop the selected pad's sample across pads starting at the selected pad. */
export function chopSelected(mode: "equal" | "transient", count: number) {
  const s = get();
  const src = s.project.pads[s.selectedPad];
  if (!src.sampleId) return;
  const buf = engine.buffer(src.sampleId);
  if (!buf) return;
  const markers = autoMarkers(buf, [src.start, src.end], mode, count);
  const start = s.selectedPad;
  const slices = slicesFromMarkers(markers);
  updateProject((p) => ({
    ...p,
    pads: p.pads.map((pad, i) => {
      const k = i - start;
      if (k < 0 || k >= slices.length) return pad;
      const [s0, s1] = slices[k];
      return { ...src, color: pad.color, name: `${src.name} ${k + 1}`, start: s0, end: s1, decay: 2 };
    }),
  }));
  set({ status: `Chopped into ${slices.length} slices` });
}

/** Open the selected pad's sample in the chop editor, its region as the outer bounds. */
export function openInChop() {
  const s = get();
  const pad = s.project.pads[s.selectedPad];
  if (!pad.sampleId) return set({ status: "Selected pad has no sample" });
  set({ chop: newChop(pad.sampleId, [Math.min(pad.start, pad.end), Math.max(pad.start, pad.end)]), tab: "Chop" });
}

/** Copy a region of a sample into a new library sample; returns its id. */
export async function cropSample(id: string, start: number, end: number): Promise<string | undefined> {
  const buf = engine.buffer(id);
  if (!buf) return;
  const a = Math.floor(start * buf.length), b = Math.max(a + 1, Math.floor(end * buf.length));
  const out = new AudioBuffer({ length: b - a, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  const name = get().samples[id]?.name ?? "Sample";
  return engine.addBuffer(`${name} crop`.slice(0, 40), out);
}

export async function loadFilesToPads(files: File[], firstPad: number) {
  const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name));
  for (let k = 0; k < audio.length && firstPad + k < 16; k++) {
    const id = await engine.addFile(audio[k]);
    updatePad(firstPad + k, { sampleId: id, name: audio[k].name.replace(/\.[^.]+$/, "").slice(0, 12), start: 0, end: 1 }, true);
  }
}
