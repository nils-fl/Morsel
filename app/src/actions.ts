// Actions shared by the on-screen UI and the Launchkey controller.
import { engine } from "./audio/engine";
import { TAB_WORDS, connectTab, disconnectTab, normalize, startRecording, tabConnected, type Recording } from "./audio/recorder";
import { slicesFromMarkers } from "./audio/chop";
import { STOCK_REV, renderStockKit, stockLengths, stockSounds } from "./audio/kit";
import { DECAY_MAX } from "./audio/dsp";
import { autoMarkers, bpmText, chopBuffer, chopRack, chopStop, chopTempo, newChop, nextChopName, takeMarkers } from "./modes/chop";
import { stretchAsync } from "./audio/stretch";
import { showTemp } from "./modes/notify";
import { launchkey } from "./midi/launchkey";
import { sequencer } from "./seq/sequencer";
import { addTrack, defaultPad, drumPads, drumTrack, get, keysTrack, selectTrack, set, updateKeys, updateProject, updateTrack, usedSampleIds } from "./state/store";
import { deleteKit, deleteSynthPreset, listKits, loadKit, loadSample, renameKit, saveKit, saveSample, saveSynthPreset } from "./state/persist";
import { dropSampleFavorites, moveFavorites } from "./browse/favorites";
import { entrySample, folderLabel, folderSamples } from "./browse/source";
import { SAMPLES, type Entry } from "./browse/tree";
import { freeChokeGroup, padsFromSamples, slicePads } from "./state/pads";
import { ask } from "./state/confirm";
import { oneOf, pref } from "./state/prefs";
import { FACTORY_PRESETS, USER_FOLDER, type SynthPreset } from "./audio/synthPresets";
import { FACTORY_KIT, MAX_TRACKS, PAD_COUNT, STOCK_KITS, stockFolder, type Pad, type Project, type SampleInfo, type SampleSource, type SliceOpts } from "./state/types";

/** When a note played now (by the Launchkey message being handled, or on screen) starts. */
export const liveWhen = () => engine.liveTime(launchkey.eventTime);

/** Play a pad of the drum track (the pads always play it) and record it when recording. */
export function playPad(i: number, vel: number) {
  const track = drumTrack().id;
  const when = liveWhen();
  engine.voices.pad(track, i, vel, when, undefined, true);
  const s = get();
  if (s.selectedPad !== i || s.selectedTrack !== track) set({ selectedPad: i, selectedTrack: track });
  sequencer.recordPad(track, i, vel, when);
}

export function releasePad(i: number) {
  engine.voices.releasePad(drumTrack().id, i, liveWhen());
}

/** A note on the keys track (the keybed always plays it). Returns the track, which keyOff needs. */
export function keyOn(note: number, vel: number, track = keysTrack().id) {
  const when = liveWhen();
  engine.voices.keyOn(track, note, vel, when);
  sequencer.recordKeyOn(track, note, vel, when);
  return track;
}

export function keyOff(note: number, track = keysTrack().id) {
  const when = liveWhen();
  engine.voices.keyOff(track, note, when);
  sequencer.recordKeyOff(track, note, when);
}

// ---------- the Launchkey's Pitch and Mod strips (live only, not recorded) ----------

export const BEND_RANGES = [2, 7, 12] as const;
/** How far the Pitch strip bends at either end, in semitones. */
export const bendRangePref = pref<number>("morsel.bendRange", 2, oneOf(BEND_RANGES));

const strips = { bend: 0, mod: 0, track: "" };

/** Bend and mod onto the keys track the keybed plays; a track left behind goes back to straight. */
export function applyStrips() {
  const track = keysTrack().id, when = liveWhen();
  if (strips.track && strips.track !== track) engine.voices.expression(strips.track, 0, 0, when);
  strips.track = track;
  engine.voices.expression(track, strips.bend * bendRangePref.get() * 100, strips.mod, when);
}

/** The Pitch strip: -8192..8191, 0 in the middle (it springs back there). */
export function bendKeys(value: number) {
  strips.bend = Math.max(-1, Math.min(1, value / 8192));
  applyStrips();
}

/** The Mod strip (CC 1): 0..127, stays where it's left. */
export function modKeys(value: number) {
  strips.mod = Math.max(0, Math.min(1, value / 127));
  applyStrips();
}

/** Latch note repeat on or off (double-press Scene on the Launchkey, or Repeat by the on-screen pads). */
export function setRepeatLatch(on: boolean) {
  if (get().repeatLatch !== on) set({ repeatLatch: on });
  sequencer.repeatOn = on;
  if (!on) sequencer.repeatPads.clear();
}

/** An on-screen drum pad pressed while note repeat is latched: it repeats until let go. */
export function repeatPadDown(i: number, vel: number) {
  const track = drumTrack().id;
  set({ selectedPad: i });
  sequencer.repeatPads.set(`${track}:${i}`, { track, pad: i, vel });
  sequencer.ensureRepeatClock();
}

export function repeatPadUp(i: number) {
  sequencer.repeatPads.delete(`${drumTrack().id}:${i}`);
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
  else {
    // Punching in starts a new take: one undo step for what it records.
    if (!s.recording) sequencer.newTake();
    set({ recording: !s.recording });
  }
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
  set({ userPresets: [...others, { name, params, folder: USER_FOLDER, user: true }].sort((a, b) => a.name.localeCompare(b.name)), status: `Saved preset ${name}` });
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
      set({ tabShared: false, status: TAB_WORDS.stopped });
      void finishSampling();
    });
  } catch (err) {
    set({ tabShared: false, status: `${TAB_WORDS.failed}: ${(err as Error).message}` });
    return false;
  }
  set({ tabShared: true, status: `${TAB_WORDS.shared} – Shift + Record on the Launchkey starts and stops takes` });
  return true;
}

export function unshareTab() {
  if (get().sampling !== "idle") void finishSampling();
  disconnectTab();
  set({ tabShared: false, status: TAB_WORDS.stopped });
}

/** Start or stop sampling. Sharing a tab needs a click on the page; once shared, the hardware can run takes. */
export async function toggleSampling(fromHardware = false) {
  const s = get();
  if (s.sampling !== "idle") return finishSampling();
  if (starting) return;
  const tab = s.sampleSource === "tab";
  if (tab && !tabConnected()) {
    if (fromHardware) return set({ status: TAB_WORDS.first });
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
    set({ chop: { ...newChop(id, markers), firstPad: 0 }, tab: "Chop", status: `Captured ${buf.duration.toFixed(1)} s · ${n} chops · the keys play them; hold a key and tap a pad to keep one, Func when done` });
    showTemp(`${n} chops`, "Keys play them");
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

/**
 * Write slices to consecutive pads from `firstPad`, keeping each pad's colour. With `opts` (the chops' pitch and choke),
 * the choking ones share a choke group the other pads don't use. Returns how many fitted.
 */
export function slicesToPads(sampleId: string, markers: number[], firstPad: number, baseName: string, opts?: SliceOpts[]): number {
  const n = Math.min(markers.length - 1, PAD_COUNT - firstPad);
  changePads((pads) => slicePads(pads, sampleId, markers, firstPad, baseName, opts, freeChokeGroup(pads.filter((_, i) => i < firstPad || i >= firstPad + n))));
  return n;
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
  const { slices } = c;
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
  const id = addTrack("drum", { name, pads: slicePads(empty, sampleId, markers, 0, "Chop", slices) });
  let msg: string;
  if (id) {
    msg = `${name}: ${n} chop${n === 1 ? "" : "s"} on pads 1–${n}`;
  } else {
    changePads((pads) => slicePads(pads, sampleId, markers, 0, "Chop", slices, freeChokeGroup(pads.slice(n))));
    msg = `${MAX_TRACKS} tracks already – ${n} slices sent to ${drumTrack().name} pads 1–${n}`;
  }
  // Leaving Chop (the controller follows the session) lands on Play, so the new rack is playable at once.
  set({ chop: null, selectedPad: 0, tab: "Track", status: msg, ...(get().hwMode === "chop" && { prevHwMode: "play" as const }) });
  showTemp(id ? "New rack" : `${MAX_TRACKS} tracks`, id ? `${name}, ${n} pads` : `Sent to ${drumTrack().name}`);
}

/**
 * Done chopping (Func on the Chop page): with chops put on pads (key + pad), go to that rack; otherwise chops 1-16 go to
 * a new rack. Either way back to playing.
 */
export function finishChop() {
  const rack = chopRack();
  if (!rack) return void sendChopToNewTrack();
  chopStop();
  selectTrack(rack.id);
  const n = rack.pads.filter((p) => p.sampleId).length;
  set({ chop: null, selectedPad: 0, tab: "Track", status: `${rack.name}: ${n} pad${n === 1 ? "" : "s"}`, ...(get().hwMode === "chop" && { prevHwMode: "play" as const }) });
  showTemp("Done", rack.name);
}

let stretching = false;

/**
 * Stretch the chop's region to the session's tempo, keeping the pitch (Func on the Tempo page): a new sample of just the
 * region, with every chop marker landing on its stretched position. The session moves to it; the original stays.
 */
export async function stretchChop() {
  const c = get().chop, buf = chopBuffer();
  if (!c || !buf || stretching) return;
  const t = chopTempo(c, buf);
  if (Math.abs(t.bpm - c.toBpm) < 0.05) return showTemp("Stretch", "Already at that tempo");
  const [a, b] = [c.markers[0], c.markers[c.markers.length - 1]];
  const i0 = Math.floor(a * buf.length), i1 = Math.max(i0 + 1, Math.floor(b * buf.length));
  const inLen = i1 - i0, outLen = Math.round((inLen * t.bpm) / c.toBpm);
  const anchors = c.markers.slice(1, -1).map((m) => Math.round(m * buf.length) - i0);
  const label = `${bpmText(t.bpm)} > ${bpmText(c.toBpm)}`;
  stretching = true;
  chopStop();
  showTemp("Stretching", label, { hold: true });
  set({ status: `Stretching ${label} BPM…` });
  try {
    const channels = Array.from({ length: buf.numberOfChannels }, (_, ch) => buf.getChannelData(ch).slice(i0, i1));
    const out = await stretchAsync(channels, buf.sampleRate, outLen, anchors);
    const audio = new AudioBuffer({ length: outLen, numberOfChannels: out.length, sampleRate: buf.sampleRate });
    out.forEach((data, ch) => audio.copyToChannel(data, ch));
    const base = (get().samples[c.sampleId]?.name ?? "Sample").replace(/ \d+(\.\d)?bpm$/, "");
    const id = await engine.addBuffer(`${base.slice(0, 32)} ${bpmText(c.toBpm)}bpm`, audio);
    // Closed or moved on meanwhile: the new sample stays in the library, the session is left alone.
    const now = get().chop;
    if (now?.sampleId !== c.sampleId) return;
    const markers = [0, ...anchors.map((x) => Math.round((x * outLen) / inLen) / outLen), 1];
    set({
      chop: { ...now, sampleId: id, markers, slices: c.slices, view: [0, 1], sel: null, beats: t.beats, from: { sampleId: c.sampleId, markers: c.markers, slices: c.slices, beats: c.beats } },
      status: `Stretched ${label} BPM: ${(outLen / buf.sampleRate).toFixed(2)} s, ${t.beats / 4} bars`,
    });
    showTemp("Stretched", `${label} BPM`);
  } catch (err) {
    set({ status: `Stretch failed: ${(err as Error).message}` });
    showTemp("Stretch", "Failed");
  } finally {
    stretching = false;
  }
}

/** Back to the sample before the last stretch. */
export function chopOriginal() {
  const c = get().chop;
  if (!c?.from || !engine.buffer(c.from.sampleId)) return;
  chopStop();
  const { sampleId, markers, slices, beats } = c.from;
  set({ chop: { ...c, sampleId, markers, slices, beats, view: [0, 1], sel: null, from: undefined } });
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

/** Pads and Keys zones using any of the samples, on every track. */
export function sampleUsers(id: string | Set<string>) {
  const ids = typeof id === "string" ? new Set([id]) : id;
  const has = (x: string | null) => x !== null && ids.has(x);
  const tracks = get().project.tracks;
  return {
    pads: tracks.reduce((n, t) => n + t.pads.filter((pad) => has(pad.sampleId)).length, 0),
    zones: tracks.reduce((n, t) => n + (t.keys?.zones.filter((z) => has(z.sampleId)).length ?? 0) + (t.keys && has(t.keys.sample.sampleId) ? 1 : 0), 0),
  };
}

/** "3 pads and 1 Keys zone", or "" when nothing uses them. */
function usersText({ pads, zones }: { pads: number; zones: number }) {
  return [pads && `${pads} pad${pads === 1 ? "" : "s"}`, zones && `${zones} Keys zone${zones === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
}

/**
 * Delete samples for good: clears the pads and Keys zones that use them and closes them in the chop editor.
 * Not undoable (the audio is gone), so the pad changes skip the undo stack.
 */
async function deleteSamplesEverywhere(ids: Set<string>) {
  const chop = get().chop;
  if (chop && ids.has(chop.sampleId)) {
    chopStop();
    set({ chop: null });
  }
  const strip = (p: Project): Project => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      pads: t.pads.map((pad, i) => (pad.sampleId && ids.has(pad.sampleId) ? { ...pad, sampleId: null, name: `Pad ${i + 1}`, start: 0, end: 1 } : pad)),
      keys: t.keys && {
        ...t.keys,
        zones: t.keys.zones.filter((z) => !ids.has(z.sampleId)),
        sample: t.keys.sample.sampleId && ids.has(t.keys.sample.sampleId) ? { ...t.keys.sample, sampleId: null } : t.keys.sample,
      },
    })),
  });
  updateProject(strip, false);
  // Undo must not bring back pads pointing at audio that no longer exists.
  set({ undo: get().undo.map(strip) });
  await engine.removeSamples([...ids]);
  dropSampleFavorites([...ids]);
}

export async function deleteSampleEverywhere(id: string) {
  const name = get().samples[id]?.name ?? "sample";
  await deleteSamplesEverywhere(new Set([id]));
  set({ status: `Deleted ${name}` });
}

/** Ask, then delete. Says how many pads / Keys zones lose the sample. */
export async function confirmDeleteSample(id: string) {
  const name = get().samples[id]?.name ?? "this sample";
  const used = usersText(sampleUsers(id));
  if (!(await ask({
    title: "Delete sample",
    message: `Delete “${name}” from the library?${used ? ` It is used by ${used}, which will be cleared.` : ""} This can't be undone.`,
    ok: "Delete",
    danger: true,
  }))) return;
  void deleteSampleEverywhere(id);
}

/** Samples something still needs: the project and its undo steps, the chop editor, saved kits and the factory kit. */
async function samplesInUse() {
  const s = get();
  const ids = new Set(usedSampleIds(s.project));
  for (const p of s.undo) for (const id of usedSampleIds(p)) ids.add(id);
  if (s.chop) ids.add(s.chop.sampleId);
  for (const name of s.kits) (await loadKit(name))?.forEach((pad) => pad.sampleId && ids.add(pad.sampleId));
  // The current Factory kit is what new drum tracks get: keep it (older renders of it may go).
  for (const x of Object.values(s.samples)) if (x.folder === FACTORY_KIT && isCurrentStock(x)) ids.add(x.id);
  return ids;
}

/** Ask, then delete every library sample nothing uses (a pack imported whole, old takes). */
export async function removeUnusedSamples() {
  const used = await samplesInUse();
  const all = Object.keys(get().samples);
  const unused = all.filter((id) => !used.has(id));
  if (!unused.length) return set({ status: "Every sample in the library is in use" });
  if (!(await ask({
    title: "Remove unused samples",
    message: `Remove ${unused.length} of ${all.length} samples that no track, undo step or saved kit uses?\n\n` +
      "Exported project and kit files keep their own copies, and connected folders aren't touched. This can't be undone.",
    ok: "Remove",
    danger: true,
  }))) return;
  await engine.removeSamples(unused);
  dropSampleFavorites(unused);
  set({ status: `Removed ${unused.length} unused sample${unused.length === 1 ? "" : "s"}` });
}

// ---------- organising the library (ui/Library.tsx) ----------

const libFolder = (path: string) => (path === SAMPLES ? "" : path.slice(SAMPLES.length + 1));
const inLibFolder = (s: SampleInfo, folder: string) => !folder || s.folder === folder || !!s.folder?.startsWith(folder + "/");

/** Write new names and folders into the stored samples too, so a rebuilt index keeps them. In the background. */
async function restamp(ids: string[]) {
  for (const id of ids) {
    const info = get().samples[id];
    const stored = info && (await loadSample(id).catch(() => undefined));
    // Deleted meanwhile: never write it back.
    if (stored && get().samples[id]) await saveSample(id, { ...stored, name: info.name, folder: info.folder }).catch(() => undefined);
  }
}

function patchSamples(patch: Record<string, Partial<SampleInfo>>) {
  const samples = { ...get().samples };
  for (const [id, p] of Object.entries(patch)) if (samples[id]) samples[id] = { ...samples[id], ...p };
  set({ samples });
  void restamp(Object.keys(patch));
}

/** A folder path as the library keeps it: no empty parts, no slashes at the ends. */
export const cleanFolder = (folder: string) => folder.split("/").map((p) => p.trim()).filter(Boolean).join("/");

export function renameSample(id: string, name: string) {
  const n = name.trim();
  if (!n || !get().samples[id] || get().samples[id].name === n) return;
  patchSamples({ [id]: { name: n } });
}

/** Move a sample into a library folder ("Drums/Kicks"; "" is the top). */
export function moveSample(id: string, folder: string) {
  const f = cleanFolder(folder);
  patchSamples({ [id]: { folder: f || undefined } });
  set({ status: `Moved ${get().samples[id]?.name ?? "the sample"} to ${[SAMPLES, f].filter(Boolean).join(" / ")}` });
}

/** Rename (or move) a library folder, given as a tree path ("Samples/Drums"), with everything in it. */
export function renameLibraryFolder(path: string, to: string) {
  const from = libFolder(path), dest = cleanFolder(to);
  if (!from || !dest || from === dest || dest.startsWith(from + "/")) return;
  const patch: Record<string, Partial<SampleInfo>> = {};
  for (const s of Object.values(get().samples)) if (inLibFolder(s, from)) patch[s.id] = { folder: dest + s.folder!.slice(from.length) };
  patchSamples(patch);
  moveFavorites(path, `${SAMPLES}/${dest}`);
}

/** Ask, then delete a library folder's samples, its subfolders' too. */
export async function confirmDeleteLibraryFolder(path: string) {
  const folder = libFolder(path);
  const ids = new Set(Object.values(get().samples).filter((s) => inLibFolder(s, folder)).map((s) => s.id));
  if (!ids.size) return;
  const used = usersText(sampleUsers(ids));
  const label = folder || SAMPLES;
  if (!(await ask({
    title: "Delete folder",
    message: `Delete “${label}” and its ${ids.size} sample${ids.size === 1 ? "" : "s"} from the library?${used ? ` They are used by ${used}, which will be cleared.` : ""}` +
      " Connected folders aren't touched. This can't be undone.",
    ok: "Delete",
    danger: true,
  }))) return;
  await deleteSamplesEverywhere(ids);
  set({ status: `Deleted ${label} (${ids.size} sample${ids.size === 1 ? "" : "s"})` });
}

/**
 * Something dropped on a pad from the library drawer: a sample or file goes on that pad, a folder's samples on the
 * pads from there on. One undo step.
 */
export async function entryToPads(e: Entry, firstPad: number) {
  try {
    const loaded = e.kind === "folder" ? await folderSamples(e.path, PAD_COUNT - firstPad) : [{ id: await entrySample(e), name: e.name }];
    if (!loaded.length) return set({ status: "No samples in that folder" });
    samplesOnPads(loaded, firstPad);
  } catch (err) {
    set({ status: `${e.name}: ${(err as Error).message}` });
  }
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

const isAudioFile = (f: File) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.name);
const byPath = (a: File, b: File) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { sensitivity: "base", numeric: true });

/** Load files onto consecutive pads from `firstPad`, in name order. One undo step. */
export async function loadFilesToPads(files: File[], firstPad: number) {
  const audio = files.filter(isAudioFile).sort(byPath).slice(0, PAD_COUNT - firstPad);
  const loaded: SampleInfo[] = [];
  for (const f of audio) {
    const id = await engine.addFile(f).catch(() => undefined);
    if (id) loaded.push(get().samples[id]);
  }
  samplesOnPads(loaded, firstPad);
}

/** Samples on consecutive pads from `firstPad`, each pad keeping its other settings. One undo step. */
function samplesOnPads(samples: { id: string; name: string }[], firstPad: number) {
  changePads((pads) => pads.map((pad, i) => {
    const s = samples[i - firstPad];
    return s ? { ...pad, sampleId: s.id, name: s.name.slice(0, 12), start: 0, end: 1, reverse: false } : pad;
  }));
}

/** A folder's first 16 samples on pads 1–16 as a kit, named after the folder. */
export async function folderToPads(path: string) {
  const loaded = await folderSamples(path, PAD_COUNT);
  if (!loaded.length) return set({ status: "No samples in that folder" });
  const n = samplesToPads(loaded, folderLabel(path));
  set({ status: `${n} samples on ${drumTrack().name} pads 1–${n}` });
}

/** Put up to 16 library samples on the pads as a kit (in the given order, hats choked). One undo step. Returns how many. */
export function samplesToPads(samples: { id: string; name: string }[], kit = "") {
  updateTrack(drumTrack().id, (t) => ({ ...t, pads: padsFromSamples(samples), kit }), true);
  return Math.min(samples.length, PAD_COUNT);
}

const isStockKit = (name: string) => STOCK_KITS.includes(name);
/** Marks a stock kit's samples with the version of the sounds that made them (SampleInfo.src). */
const stockSrc = (kit: string) => `stock:${kit}:${STOCK_REV}`;
const isCurrentStock = (s: SampleInfo) => s.src?.startsWith("stock:") && s.src.endsWith(`:${STOCK_REV}`);

/** Remove a stock kit's samples rendered by an older version of the sounds, once nothing uses them. */
async function pruneOldStock(kit: string) {
  const folder = stockFolder(kit);
  const old = Object.values(get().samples).filter((s) => s.folder === folder && !isCurrentStock(s));
  if (!old.length) return;
  const used = await samplesInUse();
  const gone = old.filter((s) => !used.has(s.id)).map((s) => s.id);
  if (gone.length) await engine.removeSamples(gone);
}
const QUIET = /hat|shaker|maraca|tamb|ride|crash|cymbal|brush/i;

/** Where a stock sound sits in the stereo field, as seen from the drummer's seat: kick, snare, claps and basses in the
 *  middle, hats a little left, ride and shakers right, toms from high (left) to low (right), hand percussion around. */
const STOCK_PANS: [RegExp, number][] = [
  [/^hat/i, -0.2],
  [/ride/i, 0.3],
  [/crash|cymbal/i, 0.2],
  [/shaker|maraca/i, 0.3],
  [/tamb/i, -0.3],
  [/tom hi/i, -0.3],
  [/tom lo/i, 0.3],
  [/conga hi/i, -0.2],
  [/conga lo/i, 0.2],
  [/conga|cowbell|clave|perc/i, 0.15],
  [/wood|bell/i, -0.15],
];
export const stockPan = (name: string) => STOCK_PANS.find(([re]) => re.test(name))?.[1] ?? 0;

/** A stock kit's pads (Factory or a genre kit). Reuses its samples in the library and renders the kit when any are missing. */
export async function stockKitPads(kit = FACTORY_KIT): Promise<Pad[]> {
  const folder = stockFolder(kit), names = stockSounds(kit), lengths = stockLengths(kit), src = stockSrc(kit);
  // Only samples rendered by this version of the sounds; older renders are re-made (and pruned, see pruneOldStock).
  const lib = Object.values(get().samples).filter((s) => s.folder === folder && s.src === src);
  const found = await Promise.all(names.map(async (name) => {
    const id = lib.find((s) => s.name === name)?.id;
    return id && (await engine.ensure(id)) ? id : undefined;
  }));
  const ids = found.every(Boolean)
    ? (found as string[])
    : await renderStockKit(kit).then((sounds) => Promise.all(sounds.map(({ name, buffer }, i) => found[i] ?? engine.addBuffer(name, buffer, folder, src))));
  // Long sounds (808s, cymbals) ring out instead of being cut at the default tail.
  // Stock kit samples are normalized, so hats, shakers and cymbals sit lower on their pads.
  const quiet = (name: string) => QUIET.test(name);
  const pads = ids.map((sampleId, i) => ({
    ...defaultPad(i), name: names[i], sampleId,
    // Longer than the default tail: the maximum, which plays the whole sound.
    decay: (engine.buffer(sampleId)?.duration ?? lengths[i]) > defaultPad(i).decay ? DECAY_MAX : defaultPad(i).decay,
    ...(quiet(names[i]) && { volume: 0.5 }),
    pan: stockPan(names[i]),
  }));
  const closed = names.indexOf("Hat Cl"), open = names.indexOf("Hat Op");
  if (closed >= 0 && open >= 0) pads[closed].choke = pads[open].choke = 1; // closed hat chokes open hat
  return pads;
}

/** The factory kit's pads. */
export const factoryPads = () => stockKitPads(FACTORY_KIT);

/** Kits in browsing order: the stock kits, then the saved ones (a saved kit can't take a stock kit's name). */
export const kitNames = () => [...STOCK_KITS, ...get().kits.filter((k) => !isStockKit(k))];

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

/** Load a stock kit or a saved kit onto the pads' drum track and remember it there. */
export async function loadNamedKit(name: string, undoable = true) {
  const req = ++kitRequest;
  const track = drumTrack().id;
  // A request that overtakes an undoable one inherits the undo step, so quick steps still leave one.
  pendingKit = { name, track, undoable: undoable || (pendingKit?.track === track && pendingKit.undoable) };
  let pads: Pad[] | undefined;
  try {
    pads = isStockKit(name) ? await stockKitPads(name) : await loadKit(name);
    await engine.ensureAll(pads?.flatMap((pad) => (pad.sampleId ? [pad.sampleId] : [])) ?? []);
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
  if (isStockKit(name)) void pruneOldStock(name);
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
  if (isStockKit(name)) return set({ status: `“${name}” is a built-in kit – pick another name` });
  if (get().kits.includes(name) && !(await ask({ title: "Replace kit", message: `A kit called “${name}” already exists. Replace it with these pads?`, ok: "Replace" }))) return;
  await saveKit(name, drumPads());
  await refreshKits();
  updateTrack(drumTrack().id, { kit: name });
  set({ status: `Saved kit ${name}` });
}

/** Rename a saved kit. Asks before replacing another kit with the new name. */
export async function renameSavedKit(from: string, to: string) {
  to = to.trim();
  if (!to || to === from) return false;
  if (isStockKit(to)) {
    set({ status: `“${to}” is a built-in kit – pick another name` });
    return false;
  }
  if (get().kits.includes(to) && !(await ask({ title: "Replace kit", message: `A kit called “${to}” already exists. Replace it with “${from}”?`, ok: "Replace" }))) return false;
  if (!(await renameKit(from, to))) return false;
  await refreshKits();
  // Tracks playing the kit keep showing it under its new name.
  updateProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.kit === from ? { ...t, kit: to } : t)) }), false);
  set({ status: `Renamed kit ${from} → ${to}` });
  return true;
}

export async function deleteSavedKit(name: string) {
  if (!(await ask({ title: "Delete kit", message: `Delete the kit “${name}”? Its samples stay in the library.`, ok: "Delete", danger: true }))) return;
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
