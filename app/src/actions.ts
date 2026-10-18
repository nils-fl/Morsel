// Actions shared by the on-screen UI and the Launchkey controller.
import { engine } from "./audio/engine";
import { connectTab, disconnectTab, normalize, startRecording, tabConnected, type Recording } from "./audio/recorder";
import { slicesFromMarkers } from "./audio/chop";
import { FACTORY_SOUNDS, renderFactoryKit } from "./audio/kit";
import { autoMarkers, chopStop, newChop, takeMarkers } from "./modes/chop";
import { showTemp } from "./modes/notify";
import { sequencer } from "./seq/sequencer";
import { addTrack, defaultPad, drumPads, drumTrack, get, keysTrack, set, updateKeys, updateProject, updateTrack } from "./state/store";
import { deleteKit, deleteSynthPreset, listKits, loadKit, renameKit, saveKit, saveSynthPreset } from "./state/persist";
import { padsFromSamples, slicePads } from "./state/pads";
import { FACTORY_PRESETS, type SynthPreset } from "./audio/synthPresets";
import { FACTORY_KIT, MAX_TRACKS, PAD_COUNT, type Pad, type Project, type SampleInfo, type SampleSource } from "./state/types";

/** Play a pad of the drum track (the pads always play it) and record it when recording. */
export function playPad(i: number, vel: number) {
  const track = drumTrack().id;
  engine.voices.pad(track, i, vel, engine.now, undefined, true);
  const s = get();
  if (s.selectedPad !== i || s.selectedTrack !== track) set({ selectedPad: i, selectedTrack: track });
  sequencer.recordPad(track, i, vel);
}

export function releasePad(i: number) {
  engine.voices.releasePad(drumTrack().id, i, engine.now);
}

/** A note on the keys track (the keybed always plays it). Returns the track, which keyOff needs. */
export function keyOn(note: number, vel: number, track = keysTrack().id) {
  engine.voices.keyOn(track, note, vel, engine.now);
  sequencer.recordKeyOn(track, note, vel);
  return track;
}

export function keyOff(note: number, track = keysTrack().id) {
  engine.voices.keyOff(track, note, engine.now);
  sequencer.recordKeyOff(track, note);
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
  } else if (s.countIn) sequencer.stop(); // the count-in was for this take: Record again calls it off
  else set({ recording: !s.recording });
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
  const params = { ...keysTrack().keys!.synth };
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
  showTemp("Sample", "Waiting for sound");
  levelTimer = window.setInterval(() => {
    if (!rec) return;
    if (rec.full()) {
      void finishSampling();
      return showTemp("Sample", "Max length");
    }
    if (rec.armed() && get().sampling === "waiting") {
      set({ sampling: "recording", status: "Recording… Shift + Record stops" });
      showTemp("Recording", "Shift+Rec stops");
    }
  }, 50);
}

async function finishSampling() {
  const r = rec;
  if (!r) return;
  clearInterval(levelTimer);
  rec = null;
  const { sampleSource: source, sampleTarget } = get();
  set({ sampling: "idle" });
  const buf = await r.stop();
  if (!buf) {
    showTemp("Sample", "Nothing recorded");
    return set({ status: "Nothing recorded" });
  }
  const tab = source === "tab";
  const id = await engine.addBuffer(`${tab ? "Tab" : "Rec"} ${new Date().toLocaleTimeString()}`, normalize(buf));
  if (sampleTarget === "chop") {
    // Straight into Chop with the transients marked: the hardware can audition, adjust and send right away.
    const markers = takeMarkers(engine.buffer(id)!);
    const n = markers.length - 1;
    set({ chop: { ...newChop(id, markers), firstPad: 0 }, tab: "Chop", status: `Captured ${buf.duration.toFixed(1)} s · ${n} slices · Func on the Launchkey (or → New drum rack) makes a drum track` });
    showTemp(`${n} slices`, "Func = new rack");
    return;
  }
  const pad = get().selectedPad;
  changePads((pads) => pads.map((p, i) => (i === pad ? { ...p, sampleId: id, name: tab ? "Tab" : "Rec", start: 0, end: 1, decay: 2, pitch: 0, reverse: false } : p)));
  set({ status: `Sampled ${buf.duration.toFixed(1)} s to pad ${pad + 1}` });
}

export function samplingLevel() {
  return rec?.level() ?? 0;
}

// ---------- chop ----------

/** Replace some of the pads' drum track's pads: they are no longer the kit that was loaded. One undo step. */
function changePads(fn: (pads: Pad[]) => Pad[], undoable = true) {
  updateTrack(drumTrack().id, (t) => ({ ...t, pads: fn(t.pads), kit: "" }), undoable);
}

/** Write slices to consecutive pads from `firstPad`, keeping each pad's colour. Returns how many fitted. */
export function slicesToPads(sampleId: string, markers: number[], firstPad: number, baseName: string): number {
  changePads((pads) => slicePads(pads, sampleId, markers, firstPad, baseName));
  return Math.min(markers.length - 1, PAD_COUNT - firstPad);
}

/** Name for the next drum track made from a chop: "Chop 1", "Chop 2"… */
function nextChopName() {
  const names = new Set(get().project.tracks.map((t) => t.name));
  let n = 1;
  while (names.has(`Chop ${n}`)) n++;
  return `Chop ${n}`;
}

/**
 * Send the open chop to a new drum track: crop to the region (when it isn't the whole sample), slices on pads 1-N,
 * select the track and go back to playing. With 8 tracks already, the slices go to pads 1-N of the current drum track.
 * Undoable in one step.
 */
let sendingChop = false;

export async function sendChopToNewTrack() {
  const c = get().chop;
  if (!c || sendingChop) return;
  sendingChop = true;
  chopStop();
  let { sampleId, markers } = c;
  const [a, b] = [markers[0], markers[markers.length - 1]];
  if (a > 0 || b < 1) {
    // A second press while the crop runs must not make a second rack.
    const id = await cropSample(sampleId, a, b).finally(() => (sendingChop = false));
    if (id) {
      sampleId = id;
      markers = markers.map((m) => (m - a) / (b - a));
    }
  }
  sendingChop = false;
  const n = Math.min(markers.length - 1, PAD_COUNT);
  const name = nextChopName();
  const empty = Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i));
  const id = addTrack("drum", { name, pads: slicePads(empty, sampleId, markers, 0, "Slice") });
  let msg: string;
  if (id) {
    msg = `${name}: ${n} slice${n === 1 ? "" : "s"} on pads 1–${n}`;
  } else {
    changePads((pads) => slicePads(pads, sampleId, markers, 0, "Slice"));
    msg = `${MAX_TRACKS} tracks already – ${n} slices sent to ${drumTrack().name} pads 1–${n}`;
  }
  // Leaving Chop (the controller follows the session) lands on Play, so the new rack is playable at once.
  set({ chop: null, selectedPad: 0, tab: "Track", status: msg, ...(get().hwMode === "chop" && { prevHwMode: "play" as const }) });
  showTemp(id ? "New rack" : `${MAX_TRACKS} tracks`, id ? `${name}, ${n} pads` : `Sent to ${drumTrack().name}`);
}

/** Chop the selected pad's sample across pads starting at the selected pad. */
export function chopSelected(mode: "equal" | "transient", count: number) {
  const s = get();
  const src = drumPads(s)[s.selectedPad];
  if (!src.sampleId) return;
  const buf = engine.buffer(src.sampleId);
  if (!buf) return;
  const markers = autoMarkers(buf, [src.start, src.end], mode, count);
  const start = s.selectedPad;
  const slices = slicesFromMarkers(markers);
  changePads((pads) => pads.map((pad, i) => {
    const k = i - start;
    if (k < 0 || k >= slices.length) return pad;
    const [s0, s1] = slices[k];
    return { ...src, color: pad.color, name: `${src.name} ${k + 1}`, start: s0, end: s1, decay: 2 };
  }));
  set({ status: `Chopped into ${slices.length} slices` });
}

/** Open the selected pad's sample in the chop editor, its region as the outer bounds. */
export function openInChop() {
  const s = get();
  const pad = drumPads(s)[s.selectedPad];
  if (!pad.sampleId) return set({ status: "Selected pad has no sample" });
  set({ chop: newChop(pad.sampleId, [Math.min(pad.start, pad.end), Math.max(pad.start, pad.end)]), tab: "Chop" });
}

/** Pads and Keys zones using a sample, on every track. */
export function sampleUsers(id: string) {
  const tracks = get().project.tracks;
  return {
    pads: tracks.reduce((n, t) => n + t.pads.filter((pad) => pad.sampleId === id).length, 0),
    zones: tracks.reduce((n, t) => n + (t.keys?.zones.filter((z) => z.sampleId === id).length ?? 0) + (t.keys?.sample.sampleId === id ? 1 : 0), 0),
  };
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
    tracks: p.tracks.map((t) => ({
      ...t,
      pads: t.pads.map((pad, i) => (pad.sampleId === id ? { ...pad, sampleId: null, name: `Pad ${i + 1}`, start: 0, end: 1 } : pad)),
      keys: t.keys && {
        ...t.keys,
        zones: t.keys.zones.filter((z) => z.sampleId !== id),
        sample: t.keys.sample.sampleId === id ? { ...t.keys.sample, sampleId: null } : t.keys.sample,
      },
    })),
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

// ---------- loading samples and kits ----------

export const isAudioFile = (f: File) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name);
const byPath = (a: File, b: File) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { sensitivity: "base", numeric: true });

/** Load files onto consecutive pads from `firstPad`, in name order. One undo step. */
export async function loadFilesToPads(files: File[], firstPad: number) {
  const audio = files.filter(isAudioFile).sort(byPath).slice(0, PAD_COUNT - firstPad);
  const loaded: SampleInfo[] = [];
  for (const f of audio) {
    const id = await engine.addFile(f).catch(() => undefined);
    if (id) loaded.push(get().samples[id]);
  }
  changePads((pads) => pads.map((pad, i) => {
    const s = loaded[i - firstPad];
    return s ? { ...pad, sampleId: s.id, name: s.name.slice(0, 12), start: 0, end: 1, reverse: false } : pad;
  }));
}

/** Put up to 16 library samples on the pads as a kit (in the given order, hats choked). One undo step. Returns how many. */
export function samplesToPads(samples: { id: string; name: string }[], kit = "") {
  updateTrack(drumTrack().id, (t) => ({ ...t, pads: padsFromSamples(samples), kit }), true);
  return Math.min(samples.length, PAD_COUNT);
}

/** Import a picked folder into the library and make its first 16 samples (by path) the current drum track's kit. */
export async function loadFolderToPads(files: File[]) {
  const audio = files.filter(isAudioFile).sort(byPath);
  const loaded: SampleInfo[] = [];
  for (const f of audio) {
    const id = await engine.addFile(f).catch(() => undefined);
    if (id) loaded.push(get().samples[id]);
  }
  if (!loaded.length) return set({ status: "No audio files in that folder" });
  const n = samplesToPads(loaded.slice(0, PAD_COUNT), audio[0].webkitRelativePath.split("/")[0] ?? "");
  set({ status: `Imported ${loaded.length} samples · ${n} on ${drumTrack().name} pads 1–${n}` });
}

/** The factory kit's pads. Reuses its samples in the library and renders any that were deleted. */
export async function factoryPads(): Promise<Pad[]> {
  const lib = Object.values(get().samples).filter((s) => s.folder === FACTORY_KIT && engine.buffer(s.id));
  const found = FACTORY_SOUNDS.map((name) => lib.find((s) => s.name === name)?.id);
  const ids = found.every(Boolean)
    ? (found as string[])
    : await renderFactoryKit().then((kit) => Promise.all(kit.map(({ name, buffer }, i) => found[i] ?? engine.addBuffer(name, buffer, FACTORY_KIT))));
  const pads = ids.map((sampleId, i) => ({ ...defaultPad(i), name: FACTORY_SOUNDS[i], sampleId }));
  pads[4].choke = pads[5].choke = 1; // closed hat chokes open hat
  pads[12].decay = 2; // let the 808 ring
  return pads;
}

/** Kits in browsing order: the Factory kit, then the saved ones. */
export const kitNames = () => [FACTORY_KIT, ...get().kits];

// Kits load asynchronously: only the latest request lands, and stepping counts from the kit on its way.
let kitRequest = 0;
let pendingKit: { name: string; track: string; undoable: boolean } | null = null;

/** The pads' drum track's kit, or the one being loaded onto it. */
export const currentKit = () => (pendingKit?.track === drumTrack().id ? pendingKit.name : drumTrack().kit);

/** Forget a kit load on its way (the project is being replaced). */
export function cancelKitLoad() {
  kitRequest++;
  pendingKit = null;
}

/** Load the factory kit or a saved kit onto the pads' drum track and remember it there. */
export async function loadNamedKit(name: string, undoable = true) {
  const req = ++kitRequest;
  const track = drumTrack().id;
  // A request that overtakes an undoable one inherits the undo step, so quick steps still leave one.
  pendingKit = { name, track, undoable: undoable || (pendingKit?.track === track && pendingKit.undoable) };
  let pads: Pad[] | undefined;
  try {
    pads = name === FACTORY_KIT ? await factoryPads() : await loadKit(name);
  } catch (err) {
    if (req === kitRequest) pendingKit = null;
    set({ status: `Kit ${name} couldn't be loaded: ${(err as Error).message}` });
    return false;
  }
  if (req !== kitRequest) return false;
  const { undoable: undo } = pendingKit;
  pendingKit = null;
  if (!pads) return false;
  updateTrack(track, (t) => ({ ...t, pads, kit: name }), undo);
  set({ status: `Loaded kit ${name} on ${drumTrack().name}` });
  return true;
}

let lastKitStep = -Infinity;

/** ◀ / ▶ and encoder 1 of the Kit page: the previous or next kit. Steps in quick succession share one undo step. */
export function stepKit(dir: number) {
  const list = kitNames();
  const i = list.indexOf(currentKit());
  const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + Math.sign(dir)))];
  const now = performance.now();
  const undoable = now - lastKitStep > 2000;
  lastKitStep = now;
  if (next !== currentKit()) void loadNamedKit(next, undoable);
  return next;
}

export async function refreshKits() {
  set({ kits: (await listKits()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })) });
}

/** Save the pads' drum track as a kit, asking before replacing one with the same name. */
export async function saveCurrentKit(name: string) {
  name = name.trim();
  if (!name) return;
  if (name === FACTORY_KIT) return set({ status: `“${FACTORY_KIT}” is the built-in kit – pick another name` });
  if (get().kits.includes(name) && !window.confirm(`Replace the kit “${name}”?`)) return;
  await saveKit(name, drumPads());
  await refreshKits();
  updateTrack(drumTrack().id, { kit: name });
  set({ status: `Saved kit ${name}` });
}

/** Rename a saved kit. Asks before replacing another kit with the new name. */
export async function renameSavedKit(from: string, to: string) {
  to = to.trim();
  if (!to || to === from) return false;
  if (to === FACTORY_KIT) {
    set({ status: `“${FACTORY_KIT}” is the built-in kit – pick another name` });
    return false;
  }
  if (get().kits.includes(to) && !window.confirm(`Replace the kit “${to}”?`)) return false;
  if (!(await renameKit(from, to))) return false;
  await refreshKits();
  // Tracks playing the kit keep showing it under its new name.
  updateProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.kit === from ? { ...t, kit: to } : t)) }), false);
  set({ status: `Renamed kit ${from} → ${to}` });
  return true;
}

export async function deleteSavedKit(name: string) {
  if (!window.confirm(`Delete the kit “${name}”? Its samples stay in the library.`)) return;
  await deleteKit(name);
  await refreshKits();
  // The pads keep playing, but they are no longer "the kit X".
  updateProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.kit === name ? { ...t, kit: "" } : t)) }), false);
  set({ status: `Deleted kit ${name}` });
}

/** "+ Drums": a new drum track, ready to play with the factory kit. */
export async function addDrumTrack() {
  const pads = await factoryPads();
  if (!addTrack("drum", { pads, kit: FACTORY_KIT })) set({ status: `Up to ${MAX_TRACKS} tracks` });
}
