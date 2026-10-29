// The bridge between the page and electron/main.ts, as window.morselNative (src/platform/native.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { MenuCommand, MorselNative } from "../src/platform/nativeApi";

let flush: (() => Promise<void>) | undefined;
// The window waits for this before it closes; answered at once if the page never got as far as saving.
ipcRenderer.on("app:flush", async () => {
  try {
    await flush?.();
  } finally {
    ipcRenderer.send("app:flushed");
  }
});

const api: MorselNative = {
  // Synchronous, so the saved theme applies before the page first paints.
  prefs: ipcRenderer.sendSync("prefs:load") ?? {},
  setPref: (key, value) => ipcRenderer.send("prefs:set", key, value),
  pickFolder: (defaultPath) => ipcRenderer.invoke("folder:pick", defaultPath),
  findLiveLibrary: () => ipcRenderer.invoke("live:find"),
  forgetFolder: (path) => ipcRenderer.send("folder:forget", path),
  listFolder: (path) => ipcRenderer.invoke("folder:list", path),
  readFile: (path) => ipcRenderer.invoke("file:read", path),
  setPlaying: (playing) => ipcRenderer.send("app:playing", playing),
  onMenu(fn) {
    const on = (_e: IpcRendererEvent, cmd: MenuCommand) => fn(cmd);
    ipcRenderer.on("menu", on);
    return () => void ipcRenderer.off("menu", on);
  },
  onFlush(fn) {
    flush = fn;
  },
};

contextBridge.exposeInMainWorld("morselNative", api);
