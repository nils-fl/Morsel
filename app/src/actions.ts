// Actions shared by the on-screen UI and the Launchkey controller.
import { engine } from "./audio/engine";
import { normalize, startRecording, type Recording } from "./audio/recorder";
import { equalSlices, detectOnsets, slicesFromOnsets, type Slice } from "./audio/chop";
import { sequencer } from "./seq/sequencer";
import { get, set, updatePad, updateProject } from "./state/store";

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
let levelTimer = 0;

export async function toggleSampling() {
  const s = get();
  if (s.sampling !== "idle") return finishSampling();
  try {
    rec = await startRecording(s.sampleSource, { threshold: s.sampleSource === "master" ? 0.001 : 0.02 });
  } catch (err) {
    set({ status: `Audio input failed: ${(err as Error).message}` });
    return;
  }
  set({ sampling: "waiting", status: "Waiting for sound…" });
  levelTimer = window.setInterval(() => {
    if (rec?.armed() && get().sampling === "waiting") set({ sampling: "recording", status: "Recording…" });
  }, 50);
}

async function finishSampling() {
  clearInterval(levelTimer);
  const r = rec;
  rec = null;
  set({ sampling: "idle" });
  const buf = await r?.stop();
  if (!buf) return set({ status: "Nothing recorded" });
  const pad = get().selectedPad;
  const id = await engine.addBuffer(`Rec ${new Date().toLocaleTimeString()}`, normalize(buf));
  updatePad(pad, { sampleId: id, name: "Rec", start: 0, end: 1, decay: 2, pitch: 0, reverse: false }, true);
  set({ status: `Sampled ${buf.duration.toFixed(1)} s to pad ${pad + 1}` });
}

export function samplingLevel() {
  return rec?.level() ?? 0;
}

// ---------- chop ----------

/** Chop the selected pad's sample across pads starting at the selected pad. */
export function chopSelected(mode: "equal" | "transient", count: number) {
  const s = get();
  const src = s.project.pads[s.selectedPad];
  if (!src.sampleId) return;
  const buf = engine.buffer(src.sampleId);
  if (!buf) return;
  let slices: Slice[];
  if (mode === "equal") slices = equalSlices(count);
  else slices = slicesFromOnsets(detectOnsets(buf.getChannelData(0), buf.sampleRate, count));
  // Map slices into the source region.
  const a = src.start, b = src.end;
  const start = s.selectedPad;
  updateProject((p) => ({
    ...p,
    pads: p.pads.map((pad, i) => {
      const k = i - start;
      if (k < 0 || k >= slices.length) return pad;
      const [s0, s1] = slices[k];
      return { ...src, color: pad.color, name: `${src.name} ${k + 1}`, start: a + (b - a) * s0, end: a + (b - a) * s1, decay: 2 };
    }),
  }));
  set({ status: `Chopped into ${slices.length} slices` });
}

export async function loadFilesToPads(files: File[], firstPad: number) {
  const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name));
  for (let k = 0; k < audio.length && firstPad + k < 16; k++) {
    const id = await engine.addFile(audio[k]);
    updatePad(firstPad + k, { sampleId: id, name: audio[k].name.replace(/\.[^.]+$/, "").slice(0, 12), start: 0, end: 1 }, true);
  }
}
