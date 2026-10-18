import { engine } from "./audio/engine";
import { factoryPads, refreshKits } from "./actions";
import { launchkey } from "./midi/launchkey";
import { initController } from "./modes/controller";
import { loadProject, loadSynthPresets, saveProject } from "./state/persist";
import { DRUMS_ID, defaultProject, get, normalizeProject, set, store, updatePads } from "./state/store";

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
    updatePads(() => pads, false, DRUMS_ID);
  }
  engine.voices.updateMix();

  // Autosave (debounced) and keep the mixer in sync with the tracks, their FX and the returns.
  let timer = 0;
  store.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    const p = s.project, q = prev.project;
    if (p.tracks !== q.tracks || p.returns !== q.returns || p.bpm !== q.bpm) engine.voices.updateMix();
    clearTimeout(timer);
    timer = window.setTimeout(() => saveProject(get().project), 500);
  });

  initController();
  // Not awaited: the MIDI permission prompt must not block the UI.
  launchkey.init().catch((err) => set({ status: `MIDI unavailable: ${(err as Error).message}. Use Chrome and allow MIDI + SysEx.` }));
}

if (import.meta.env.DEV) {
  // Debug handle for the browser console.
  import("./seq/sequencer").then(({ sequencer }) => Object.assign(window, { lk: { engine, sequencer, store, launchkey } }));
}
