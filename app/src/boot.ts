import { engine } from "./audio/engine";
import { factoryPads, refreshKits } from "./actions";
import { launchkey } from "./midi/launchkey";
import { initController } from "./modes/controller";
import { loadProject, loadSynthPresets, saveProject } from "./state/persist";
import { DRUMS_ID, defaultProject, fixSelection, get, normalizeProject, set, store, updateTrack } from "./state/store";
import { FACTORY_KIT } from "./state/types";

export async function boot() {
  engine.init();
  await engine.loadAllSamples();
  set({ userPresets: (await loadSynthPresets()).map((p) => ({ ...p, user: true })) });
  await refreshKits();

  const saved = await loadProject();
  if (saved) {
    set({ project: normalizeProject(saved) });
  } else {
    const pads = await factoryPads();
    set({ project: defaultProject() });
    updateTrack(DRUMS_ID, { pads, kit: FACTORY_KIT });
  }
  // The saved project may not have the track ids the session starts with.
  fixSelection();
  engine.voices.updateMix();

  // Autosave (debounced) and keep the mixer in sync with the tracks, their FX and the returns.
  let timer = 0;
  let dirty = false;
  const save = () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    saveProject(get().project).catch((err) => set({ status: `Couldn't save the project: ${(err as Error).message}` }));
  };
  store.subscribe((s, prev) => {
    if (s.project === prev.project) return;
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

  initController();
  // Not awaited: the MIDI permission prompt must not block the UI.
  launchkey.init().catch((err) => set({ status: `MIDI unavailable: ${(err as Error).message}. Use Chrome and allow MIDI + SysEx.` }));
}

if (import.meta.env.DEV) {
  // Debug handle for the browser console.
  import("./seq/sequencer").then(({ sequencer }) => Object.assign(window, { lk: { engine, sequencer, store, launchkey } }));
}
