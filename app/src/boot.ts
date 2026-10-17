import { engine } from "./audio/engine";
import { renderFactoryKit } from "./audio/kit";
import { launchkey } from "./midi/launchkey";
import { initController } from "./modes/controller";
import { loadProject, saveProject } from "./state/persist";
import { defaultPad, defaultProject, get, normalizeProject, set, store } from "./state/store";

export async function boot() {
  engine.init();
  await engine.loadAllSamples();

  const saved = await loadProject();
  if (saved) {
    set({ project: normalizeProject(saved) });
  } else {
    const kit = await renderFactoryKit();
    const pads = await Promise.all(kit.map(async ({ name, buffer }, i) => ({ ...defaultPad(i), name, sampleId: await engine.addBuffer(name, buffer, "Factory") })));
    pads[4].choke = pads[5].choke = 1; // closed hat chokes open hat
    pads[12].decay = 2;
    set({ project: { ...defaultProject(), pads } });
  }
  engine.voices.updateMix();

  // Autosave (debounced) and keep the mixer in sync with mutes/levels.
  let timer = 0;
  store.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    if (s.project.mutes !== prev.project.mutes || s.project.solos !== prev.project.solos || s.project.levels !== prev.project.levels) {
      engine.voices.updateMix();
    }
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
