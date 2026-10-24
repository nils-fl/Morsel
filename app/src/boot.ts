import { engine } from "./audio/engine";
import { applyStrips, factoryPads, refreshKits } from "./actions";
import { USER_FOLDER } from "./audio/synthPresets";
import { launchkey } from "./midi/launchkey";
import { initController } from "./modes/controller";
import { initDisk } from "./browse/disk";
import { initFavorites } from "./browse/favorites";
import { native } from "./platform/native";
import { loadProject, loadSynthPresets, saveProject, saveSampleIndex } from "./state/persist";
import { DRUMS_ID, defaultProject, fixSelection, get, normalizeProject, set, store, updateTrack, usedSampleIds } from "./state/store";
import { FACTORY_KIT } from "./state/types";

export async function boot() {
  await engine.init();
  await engine.loadLibrary();
  await initDisk();
  await initFavorites();
  set({ userPresets: (await loadSynthPresets()).map((p) => ({ ...p, folder: USER_FOLDER, user: true })) });
  await refreshKits();

  const saved = await loadProject();
  if (saved) {
    set({ project: normalizeProject(saved) });
  } else {
    const pads = await factoryPads();
    set({ project: defaultProject() });
    updateTrack(DRUMS_ID, { pads, kit: FACTORY_KIT });
  }
  // Only the samples the project plays are read into memory; the rest of the library loads when used.
  await engine.ensureAll(usedSampleIds(get().project));
  // The saved project may not have the track ids the session starts with.
  fixSelection();
  engine.voices.updateMix();

  // Autosave (debounced) and keep the mixer in sync with the tracks, their FX and the returns.
  let timer = 0;
  let dirty = false;
  const save = async () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    await saveProject(get().project).catch((err) => set({ status: `Couldn't save the project: ${(err as Error).message}` }));
  };
  let indexTimer = 0;
  const saveIndex = () => {
    clearTimeout(indexTimer);
    indexTimer = 0;
    return saveSampleIndex(get().samples).catch((err) => set({ status: `Couldn't save the sample list: ${(err as Error).message}` }));
  };
  store.subscribe((s, prev) => {
    if (s.samples !== prev.samples) {
      clearTimeout(indexTimer);
      indexTimer = window.setTimeout(saveIndex, 1000);
    }
    // The strips follow the keybed to another keys track.
    if (s.keysTrack !== prev.keysTrack) applyStrips();
    // Whatever puts a sample on a pad, a zone or the chop editor (undo, kits, imports), its audio gets loaded.
    if (s.chop?.sampleId !== prev.chop?.sampleId && s.chop) void engine.ensure(s.chop.sampleId);
    if (s.project === prev.project) return;
    if (s.project.tracks !== prev.project.tracks) void engine.ensureAll(usedSampleIds(s.project));
    const p = s.project, q = prev.project;
    if (p.tracks !== q.tracks) fixSelection();
    if (p.tracks !== q.tracks || p.returns !== q.returns || p.bpm !== q.bpm) engine.voices.updateMix();
    dirty = true;
    clearTimeout(timer);
    timer = window.setTimeout(save, 500);
  });
  // The debounce must not lose the last edits when the tab closes or is put away.
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && save());
  // A sample missing from the index is found and indexed at the next start, so losing this save costs only time.
  window.addEventListener("pagehide", () => indexTimer && saveIndex());

  if (native) {
    // The desktop app waits for the saves before it closes the window, so quitting right after an edit keeps it.
    native.onFlush(async () => {
      await Promise.all([save(), indexTimer ? saveIndex() : undefined]);
    });
    // macOS naps apps it thinks are idle, which would make the sequencer stutter.
    store.subscribe((s, prev) => s.playing !== prev.playing && native!.setPlaying(s.playing));
  }

  initController();
  // Preview copies from a dev build that never shipped: remove the database if it was ever made.
  indexedDB.deleteDatabase("morsel-proxies");
  // Samples stored before 16-bit storage get rewritten at half the size, in the background.
  window.setTimeout(() => void engine.compactLibrary(), 5000);
  // Not awaited: the MIDI permission prompt must not block the UI.
  launchkey.init().catch((err) => set({ status: `MIDI unavailable: ${(err as Error).message}. Use Chrome and allow MIDI + SysEx.` }));
}

if (import.meta.env.DEV) {
  // Debug handle for the browser console.
  import("./seq/sequencer").then(({ sequencer }) => Object.assign(window, { lk: { engine, sequencer, store, launchkey } }));
}
