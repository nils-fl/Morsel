// The desktop app (macOS first): Morsel's web build in a Chromium window, plus what a browser can't give it. MIDI,
// SysEx and the microphone without prompts, sample folders that stay readable, a settings file, an app menu, and no
// throttling while the window is in the background. The page talks to this through electron/preload.ts.
import {
  BrowserWindow, Menu, app, desktopCapturer, dialog, ipcMain, net, powerSaveBlocker, protocol, screen, session, shell,
  type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle,
} from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { MenuCommand, NativeEntry, NativeResult } from "../src/platform/nativeApi";

const SCHEME = "app";
const ORIGIN = `${SCHEME}://morsel`;
/** Vite's dev server, when started by `npm run desktop:dev` (scripts/electron.mjs). */
const DEV_URL = process.env.MORSEL_DEV_URL;
/** The web build (npm run build), next to this file's dist-electron/. */
const DIST = resolve(__dirname, "..", "dist");

const isOurs = (url: string | undefined) =>
  !!url && (url.startsWith(ORIGIN) || (!!DEV_URL && url.startsWith(new URL(DEV_URL).origin)));
/** Only Morsel's own page may use the bridge (not a page a link navigated to). */
const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => isOurs(e.senderFrame?.url);

// ---------- settings files (in ~/Library/Application Support/Morsel) ----------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A small JSON file, read once and written shortly after each change (and at quit). */
function jsonFile<T>(name: string, fallback: T, valid: (v: unknown) => boolean) {
  const file = join(app.getPath("userData"), name);
  let value = fallback;
  try {
    const read: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (valid(read)) value = read as T;
  } catch {
    // First start, or a damaged file: the defaults.
  }
  let timer: NodeJS.Timeout | undefined;
  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    try {
      // Through a temporary file, so a crash mid-write can't leave half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(`Couldn't save ${name}`, err);
    }
  };
  return {
    get: () => value,
    set(v: T) {
      value = v;
      clearTimeout(timer);
      timer = setTimeout(write, 200);
    },
    flush: () => timer && write(),
  };
}

// Created when the app is ready (userData isn't final before the app's name is).
let prefs: ReturnType<typeof jsonFile<Record<string, unknown>>>;
/** Folders the person picked: the only ones the page may read. */
let folders: ReturnType<typeof jsonFile<string[]>>;
let windowState: ReturnType<typeof jsonFile<Partial<Rectangle>>>;

function inPickedFolder(path: string) {
  const full = resolve(path);
  return folders.get().some((root) => {
    const r = relative(root, full);
    return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  });
}

// ---------- the page's bridge ----------

function failed(err: unknown): NativeResult<never> {
  const code = (err as NodeJS.ErrnoException).code;
  const name = code === "ENOENT" || code === "ENOTDIR" ? "NotFoundError" : code === "EACCES" || code === "EPERM" ? "NotAllowedError" : "Error";
  return { err: name, message: (err as Error).message };
}

let napBlocker = -1;

function bridge() {
  ipcMain.on("prefs:load", (e) => {
    e.returnValue = trusted(e) ? prefs.get() : {};
  });
  ipcMain.on("prefs:set", (e, key: unknown, value: unknown) => {
    if (trusted(e) && typeof key === "string") prefs.set({ ...prefs.get(), [key]: value });
  });

  ipcMain.handle("folder:pick", async (e, defaultPath: unknown) => {
    if (!trusted(e)) return undefined;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Connect a sample folder", buttonLabel: "Connect", properties: ["openDirectory"],
      defaultPath: typeof defaultPath === "string" ? defaultPath : undefined,
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = r.filePaths[0];
    if (r.canceled || !path) return undefined;
    if (!folders.get().includes(path)) folders.set([...folders.get(), path]);
    return { name: basename(path) || path, path };
  });
  // Ableton Live's library (Live Lite comes with the Launchkey): found, not picked, and then readable like a picked
  // folder. The newest Live in /Applications (or ~/Applications) that has a Core Library.
  ipcMain.handle("live:find", async (e) => {
    if (!trusted(e)) return undefined;
    for (const apps of ["/Applications", join(app.getPath("home"), "Applications")]) {
      const lives = (await readdir(apps).catch(() => [] as string[])).filter((n) => /^Ableton Live 1\d.*\.app$/.test(n)).sort().reverse();
      for (const live of lives) {
        const path = join(apps, live, "Contents/App-Resources/Core Library");
        if (!(await stat(path).then((s) => s.isDirectory(), () => false))) continue;
        if (!folders.get().includes(path)) folders.set([...folders.get(), path]);
        return { name: "Ableton Live", path };
      }
    }
    return undefined;
  });
  ipcMain.on("folder:forget", (e, path: unknown) => {
    if (trusted(e)) folders.set(folders.get().filter((p) => p !== path));
  });
  ipcMain.handle("folder:list", async (e, path: unknown): Promise<NativeResult<NativeEntry[]>> => {
    if (!trusted(e) || typeof path !== "string" || !inPickedFolder(path)) return { err: "NotAllowedError" };
    try {
      const entries = await readdir(path, { withFileTypes: true });
      // A link to a folder browses as a folder.
      const isDir = async (d: (typeof entries)[number]) =>
        d.isDirectory() || (d.isSymbolicLink() && (await stat(join(path, d.name)).then((s) => s.isDirectory(), () => false)));
      return { ok: await Promise.all(entries.map(async (d) => ({ name: d.name, dir: await isDir(d) }))) };
    } catch (err) {
      return failed(err);
    }
  });
  ipcMain.handle("file:read", async (e, path: unknown): Promise<NativeResult<Uint8Array>> => {
    if (!trusted(e) || typeof path !== "string" || !inPickedFolder(path)) return { err: "NotAllowedError" };
    try {
      return { ok: await readFile(path) };
    } catch (err) {
      return failed(err);
    }
  });

  // macOS naps apps it thinks are idle; a playing sequencer isn't.
  ipcMain.on("app:playing", (e, playing: unknown) => {
    if (!trusted(e)) return;
    if (playing && napBlocker < 0) napBlocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!playing && napBlocker >= 0) {
      powerSaveBlocker.stop(napBlocker);
      napBlocker = -1;
    }
  });
}

// ---------- window ----------

/** Saved bounds that are still on a screen (a monitor may have been unplugged since). */
function savedBounds(): Partial<Rectangle> {
  const b = windowState.get();
  if (b.width === undefined || b.height === undefined) return {};
  if (b.x === undefined || b.y === undefined) return { width: b.width, height: b.height };
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x! < a.x + a.width && b.x! + b.width! > a.x && b.y! < a.y + a.height && b.y! + b.height! > a.y);
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 960, ...savedBounds(), minWidth: 720, minHeight: 560,
    fullscreen: prefs.get()["morsel.fullScreen"] === true,
    title: "Morsel",
    // The page's --bg (index.css), so opening doesn't flash the other theme.
    backgroundColor: prefs.get()["morsel:theme"] === "dark" ? "#1c1f23" : "#e8eaed",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // The sequencer keeps time on a Worker's timer; keep it steady while the window is hidden.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  const remember = () => !win.isFullScreen() && !win.isMinimized() && windowState.set(win.getNormalBounds());
  win.on("resized", remember);
  win.on("moved", remember);

  // Links leave for the browser; the window only ever shows Morsel.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isOurs(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  // Before closing, the page saves the project (its autosave waits half a second after an edit).
  let saved = false;
  win.on("close", (e) => {
    if (saved) return;
    e.preventDefault();
    const close = () => {
      if (saved) return;
      saved = true;
      clearTimeout(timer);
      ipcMain.off("app:flushed", close);
      win.close();
    };
    const timer = setTimeout(close, 3000);
    ipcMain.on("app:flushed", close);
    win.webContents.send("app:flush");
  });

  void win.loadURL(DEV_URL ?? `${ORIGIN}/`);
  return win;
}

function menu(win: () => BrowserWindow | undefined) {
  const item = (label: string, cmd: MenuCommand, accelerator?: string): MenuItemConstructorOptions =>
    ({ label, accelerator, click: () => win()?.webContents.send("menu", cmd) });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" }, { type: "separator" },
        item("Preferences…", "preferences", "CmdOrCtrl+,"), { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [item("New Project…", "newProject", "CmdOrCtrl+N"), { type: "separator" }, { role: "close" }] },
    {
      label: "Edit",
      submenu: [
        // The project's undo, or the text's in a text field (App.tsx).
        item("Undo", "undo", "CmdOrCtrl+Z"), item("Redo", "redo", "Shift+CmdOrCtrl+Z"), { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        item("Show / Hide Library", "toggleLibrary", "CmdOrCtrl+L"), { type: "separator" },
        item("Light / Dark Theme", "toggleTheme"), item("Show / Hide Tips", "toggleTips"), { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" },
        ...(DEV_URL ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] satisfies MenuItemConstructorOptions[] : []),
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [item("Morsel Guide", "guide")] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- app ----------

// Audio starts without a click first (a browser waits for one).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Sampling "system audio" captures the Mac's sound output (ScreenCaptureKit).
app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare");

// app:// serves the web build from a fixed origin, so its storage (the library, projects, kits) stays put, and the
// page counts as secure (Web MIDI, AudioWorklet).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

/** What the page may use without asking. */
const GRANTED = new Set(["midi", "midiSysex", "media", "speaker-selection", "fullscreen", "clipboard-sanitized-write"]);

// One Morsel at a time: two would fight over the Launchkey.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let main: BrowserWindow | undefined;
  app.on("second-instance", () => {
    if (main?.isMinimized()) main.restore();
    main?.focus();
  });

  void app.whenReady().then(() => {
    prefs = jsonFile("preferences.json", {}, isRecord);
    folders = jsonFile<string[]>("folders.json", [], (v) => Array.isArray(v) && v.every((p) => typeof p === "string"));
    windowState = jsonFile("window.json", {}, isRecord);

    protocol.handle(SCHEME, async (req) => {
      const { pathname } = new URL(req.url);
      const file = resolve(DIST, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
      if (!file.startsWith(DIST + sep)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString()).catch(() => new Response("Not found", { status: 404 }));
    });

    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, done, details) => done(GRANTED.has(permission) && isOurs(details.requestingUrl)));
    ses.setPermissionCheckHandler((_wc, permission, origin) => GRANTED.has(permission) && isOurs(origin));
    // "System audio" sampling (audio/recorder.ts): no picker, the main screen with the Mac's sound. The video is ignored.
    ses.setDisplayMediaRequestHandler((_req, done) => {
      desktopCapturer.getSources({ types: ["screen"] }).then(
        ([source]) => (source ? done({ video: source, audio: "loopback" }) : done({})),
        () => done({}),
      );
    });

    // A packaged app has its icon in the bundle; the dev build runs as Electron.app, so give its Dock tile Morsel's.
    if (!app.isPackaged) app.dock?.setIcon(join(__dirname, "..", "electron", "icon.png"));
    bridge();
    menu(() => main);
    main = createWindow();
    main.on("closed", () => (main = undefined));
  });

  // A single-window app: closing it quits, on the Mac too.
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    prefs?.flush();
    folders?.flush();
    windowState?.flush();
  });
}
