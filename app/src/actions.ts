// Actions shared by the on-screen UI and the Launchkey controller.
import { engine } from "./audio/engine";
import { connectTab, disconnectTab, normalize, startRecording, tabConnected, type Recording } from "./audio/recorder";
import { equalSlices, detectOnsets, slicesFromMarkers } from "./audio/chop";
import { DECAY_MAX } from "./audio/dsp";
import { chopStop, newChop } from "./modes/chop";
import { sequencer } from "./seq/sequencer";
import { get, set, updateKeys, updatePad, updateProject } from "./state/store";
import { deleteSynthPreset, saveSynthPreset } from "./state/persist";
import { FACTORY_PRESETS, type SynthPreset } from "./audio/synthPresets";
import { PAD_COUNT, type Project, type SampleSource } from "./state/types";

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

// ---------- keys presets ----------

/** Factory presets, then the user's own. */
export const allPresets = (): SynthPreset[] => [...FACTORY_PRESETS, ...get().userPresets];

/** Load a preset onto the Keys synth (switching Keys to the synth if it was playing samples). */
export function applyPreset(p: SynthPreset) {
  updateKeys({ type: "synth", preset: p.name, synth: { ...p.params } });
}

/** Save the current synth as a user preset (overwrites one with the same name). */
export async function saveUserPreset(name: string) {
  name = name.trim().slice(0, 24);
  if (!name) return;
  if (FACTORY_PRESETS.some((p) => p.name === name)) return set({ status: `“${name}” is a factory preset – pick another name` });
  const params = { ...get().project.keys.synth };
  await saveSynthPreset(name, params);
  const others = get().userPresets.filter((p) => p.name !== name);
  set({ userPresets: [...others, { name, params, user: true }].sort((a, b) => a.name.localeCompare(b.name)), status: `Saved preset ${name}` });
  updateKeys({ preset: name });
}

export async function deleteUserPreset(name: string) {
  await deleteSynthPreset(name);
  set({ userPresets: get().userPresets.filter((p) => p.name !== name), status: `Deleted preset ${name}` });
}

// ---------- sampling ----------

let rec: Recording | null = null;
let starting = false;
let levelTimer = 0;

const THRESHOLD: Record<SampleSource, number> = { input: 0.02, master: 0.001, tab: 0.002 };

/** Share a browser tab (Chrome's picker; needs a click on the page). It stays shared for later takes. */
export async function shareTab() {
  try {
    await connectTab(() => {
      set({ tabShared: false, status: "Tab sharing stopped" });
      void finishSampling();
    });
  } catch (err) {
    set({ tabShared: false, status: `Tab share failed: ${(err as Error).message}` });
    return false;
  }
  set({ tabShared: true, status: "Tab shared – Shift + Record on the Launchkey starts and stops takes" });
  return true;
}

export function unshareTab() {
  if (get().sampling !== "idle") void finishSampling();
  disconnectTab();
  set({ tabShared: false, status: "Tab sharing stopped" });
}

/** Start or stop sampling. Sharing a tab needs a click on the page; once shared, the hardware can run takes. */
export async function toggleSampling(fromHardware = false) {
  const s = get();
  if (s.sampling !== "idle") return finishSampling();
  if (starting) return;
  const tab = s.sampleSource === "tab";
  if (tab && !tabConnected()) {
    if (fromHardware) return set({ status: "Share the tab on screen first (Sample → Share tab…)" });
    // The click that got us here opens the picker, then the take starts right away.
    if (!(await shareTab())) return;
  }
  starting = true;
  try {
    // Tab takes can be long enough to grab a whole phrase off a video; chop it down afterwards.
    rec = await startRecording(s.sampleSource, { threshold: THRESHOLD[s.sampleSource], maxSeconds: tab ? 120 : 30 });
  } catch (err) {
    set({ status: `Audio input failed: ${(err as Error).message}` });
    return;
  } finally {
    starting = false;
  }
  set({ sampling: "waiting", status: tab ? "Waiting for sound… press play in the shared tab" : "Waiting for sound…" });
  levelTimer = window.setInterval(() => {
    if (rec?.armed() && get().sampling === "waiting") set({ sampling: "recording", status: "Recording…" });
  }, 50);
}

async function finishSampling() {
  const r = rec;
  if (!r) return;
  clearInterval(levelTimer);
  rec = null;
  const { sampleSource: source, tabTarget } = get();
  set({ sampling: "idle" });
  const buf = await r.stop();
  if (!buf) return set({ status: "Nothing recorded" });
  const tab = source === "tab";
  const id = await engine.addBuffer(`${tab ? "Tab" : "Rec"} ${new Date().toLocaleTimeString()}`, normalize(buf));
  if (tab && tabTarget === "chop") {
    set({ chop: newChop(id), tab: "Chop", status: `Captured ${buf.duration.toFixed(1)} s – chop it up` });
    return;
  }
  const pad = get().selectedPad;
  updatePad(pad, { sampleId: id, name: tab ? "Tab" : "Rec", start: 0, end: 1, decay: 2, pitch: 0, reverse: false }, true);
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

/** Pads and Keys zones using a sample. */
export function sampleUsers(id: string) {
  const p = get().project;
  return { pads: p.pads.filter((pad) => pad.sampleId === id).length, zones: p.keys.zones.filter((z) => z.sampleId === id).length };
}

/**
 * Delete a sample for good: clears the pads and Keys zones that use it and closes it in the chop editor.
 * Not undoable (the audio is gone), so the pad changes skip the undo stack.
 */
export async function deleteSampleEverywhere(id: string) {
  const name = get().samples[id]?.name ?? "sample";
  if (get().chop?.sampleId === id) {
    chopStop();
    set({ chop: null });
  }
  const strip = (p: Project): Project => ({
    ...p,
    pads: p.pads.map((pad, i) => (pad.sampleId === id ? { ...pad, sampleId: null, name: `Pad ${i + 1}`, start: 0, end: 1 } : pad)),
    keys: { ...p.keys, zones: p.keys.zones.filter((z) => z.sampleId !== id) },
  });
  updateProject(strip, false);
  // Undo must not bring back pads pointing at audio that no longer exists.
  set({ undo: get().undo.map(strip) });
  await engine.removeSample(id);
  set({ status: `Deleted ${name}` });
}

/** Ask, then delete. Says how many pads / Keys zones lose the sample. */
export function confirmDeleteSample(id: string) {
  const name = get().samples[id]?.name ?? "this sample";
  const { pads, zones } = sampleUsers(id);
  const used = [pads && `${pads} pad${pads === 1 ? "" : "s"}`, zones && `${zones} Keys zone${zones === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  if (!window.confirm(`Delete “${name}”?${used ? ` It is used by ${used}, which will be cleared.` : ""} This can't be undone.`)) return;
  void deleteSampleEverywhere(id);
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
