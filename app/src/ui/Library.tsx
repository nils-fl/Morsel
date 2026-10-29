// Library drawer: the connected folders and the sample library, docked on the right while the rest of the app keeps
// working. It lists what the selected track can use (no Live kits on a keys track, no Live instruments on a drum track).
// Click listens, double-click (or Enter) loads onto the selected track: the selected pad, or the keys. Rows drag onto
// pads and the Keys panel.
// Search covers every connected folder (indexed once, browse/search.ts) and the library.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  cleanFolder, confirmDeleteLibraryFolder, confirmDeleteSample, entryToKeys, entryToPads, folderToPads, loadLivePreset, moveSample, removeUnusedSamples,
  renameLibraryFolder,
  renameSample, sampleUsers,
} from "../actions";
import { engine } from "../audio/engine";
import {
  connectFolder, connectLiveLibrary, diskSupported, disconnectFolder, fileDetails, fileSample, folderNameProblem, isDiskPath, liveRoot, reconnectFolder,
  refreshFolder, renameFolder, rootPath,
} from "../browse/disk";
import { toggleFavorite } from "../browse/favorites";
import { scanFolder, search, type SearchResult } from "../browse/search";
import { fitsTrack, folderSamples, folderToMulti, listAt, previewEntry, stopPreview } from "../browse/source";
import { FAVORITES, SAMPLES, entryKey, parentOf, type Entry } from "../browse/tree";
import { native } from "../platform/native";
import { get, selectedTrack, set, useApp, type FolderAccess } from "../state/store";
import type { TrackKind } from "../state/types";
import { applyDrawerWidth, applyLibrary, dragEntry } from "./drawer";
import { drawPeaks, drawWaveBg } from "./wave";

interface Root { name: string; access: FolderAccess }

type Row =
  /** `section`: a heading (Favorites, Library); `root`: a connected folder; `sub`: where a search hit lives. */
  | { id: string; kind: "entry"; entry: Entry; depth: number; section?: true; root?: Root; sub?: string }
  | { id: string; kind: "note"; text: string; depth: number };

// Section headers start open, folders below them closed; a toggle flips that. Kept while the drawer is closed.
const toggled = new Set<string>();
const isOpen = (row: { id: string; depth: number }) => (row.depth === 0) !== toggled.has(row.id);
let lastSel: string | null = null;

const LIBRARY = "Library";
const libRoot: Entry = { kind: "folder", name: LIBRARY, path: SAMPLES };
const favRoot: Entry = { kind: "folder", name: FAVORITES, path: FAVORITES };

const isLibFolder = (e: Entry) => e.kind === "folder" && e.path.startsWith(SAMPLES + "/");
const isDiskFolder = (e: Entry) => e.kind === "folder" && isDiskPath(e.path);
const canLoad = (e: Entry) => e.kind === "sample" || e.kind === "file";
const hasMenu = (row: { entry: Entry; root?: Root }) =>
  !!row.root || canLoad(row.entry) || row.entry.kind === "preset" || isDiskFolder(row.entry) || isLibFolder(row.entry);

/** The rows the tree shows: each section, and the folders opened in it, with what a `kind` track can use. */
function treeRows(favorites: boolean, roots: Root[], kind: TrackKind): Row[] {
  const rows: Row[] = [];
  const add = (section: string, e: Entry, depth: number, root?: Root, heading?: true) => {
    const id = `${section}>${entryKey(e)}`;
    const row: Row = { id, kind: "entry", entry: e, depth, root, section: heading };
    rows.push(row);
    if (e.kind !== "folder" || !isOpen(row)) return;
    const { entries, note } = listAt(e.path, null, kind);
    for (const c of entries) add(section, c, depth + 1);
    if (!entries.length) rows.push({ id: `${id}>note`, kind: "note", text: note ?? "Empty folder", depth: depth + 1 });
  };
  if (favorites) add("fav", favRoot, 0, undefined, true);
  for (const r of roots) add("disk", { kind: "folder", name: r.name, path: rootPath(r.name) }, 0, r);
  add("lib", libRoot, 0, undefined, true);
  return rows;
}

/** Where a search hit lives, for the line under its name. */
function hitWhere(e: Entry, samples: Record<string, { folder?: string }>) {
  if (e.kind === "sample") return [LIBRARY, samples[e.id]?.folder].filter(Boolean).join(" / ");
  return e.kind === "file" ? parentOf(e.path).replace(/^disk:/, "").replaceAll("/", " / ") : "";
}

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

interface Editing { id: string; mode: "rename" | "move"; value: string }
interface MenuItem { label: string; run?: () => unknown; danger?: boolean }

export function Library() {
  const open = useApp((s) => s.library);
  return open ? <Drawer /> : null;
}

function Drawer() {
  // listAt reads the store: re-render when what it depends on changes.
  const samples = useApp((s) => s.samples);
  useApp((s) => s.diskTick);
  useApp((s) => s.bufferTick);
  const folders = useApp((s) => s.folders);
  const favorites = useApp((s) => s.favorites);
  const scans = useApp((s) => s.scans);
  const selectedPad = useApp((s) => s.selectedPad);
  const trackId = useApp((s) => s.selectedTrack);
  const kind = useApp((s) => selectedTrack(s).kind);
  const [, redraw] = useState(0);
  const [sel, setSel] = useState<string | null>(lastSel);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  // Enter commits an edit and the input's blur would commit it again.
  const committed = useRef<Editing | null>(null);
  const q = query.trim();

  useEffect(() => () => stopPreview(), []);
  useEffect(() => {
    lastSel = sel;
    tree.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Search again when a folder's index is done, not on every progress step.
  const indexed = Object.entries(scans).filter(([, v]) => v === "done").map(([k]) => k).join("/");
  useEffect(() => {
    // Without a query the tree shows; the last results stay until the next ones are in.
    if (!q) return;
    let live = true;
    const t = window.setTimeout(() => void search(q).then((r) => live && setResults(r)), 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, indexed, samples, folders]);

  // Built every render: folder listings are cached (browse/disk.ts), and opening a folder only redraws.
  const rows: Row[] = (() => {
    if (!q) return treeRows(favorites.length > 0, folders, kind);
    const out: Row[] = (results?.entries ?? []).filter((e) => fitsTrack(e, kind)).map((e) => ({ id: `hit>${entryKey(e)}`, kind: "entry", entry: e, depth: 0, sub: hitWhere(e, samples) }));
    for (const f of folders) {
      const n = scans[f.name];
      if (f.access !== "granted") out.push({ id: `note>${f.name}`, kind: "note", text: `${f.name}: reconnect it to search it`, depth: 0 });
      else if (typeof n === "number") out.push({ id: `note>${f.name}`, kind: "note", text: `Indexing ${f.name}… ${n} files`, depth: 0 });
    }
    if (results && !results.entries.length) out.unshift({ id: "note>none", kind: "note", text: "No match", depth: 0 });
    if (results?.more) out.push({ id: "note>more", kind: "note", text: "More than 300 matches: add a word", depth: 0 });
    return out;
  })();

  const entryRows = rows.filter((r): r is Extract<Row, { kind: "entry" }> => r.kind === "entry");
  const current = entryRows.find((r) => r.id === sel);

  const toggle = (id: string) => {
    if (toggled.has(id)) toggled.delete(id);
    else toggled.add(id);
    redraw((n) => n + 1);
  };

  const select = (row: Extract<Row, { kind: "entry" }>, listen = true) => {
    setSel(row.id);
    if (listen && canLoad(row.entry)) previewEntry(row.entry);
  };

  const load = (e: Entry) => {
    if (e.kind === "preset") void loadLivePreset(e.path, trackId);
    else if (canLoad(e)) void (kind === "keys" ? entryToKeys(e, trackId) : entryToPads(e, get().selectedPad));
  };

  function onKey(ev: KeyboardEvent) {
    // Typing in a field, or a row's own buttons.
    if (editing || ev.target instanceof HTMLInputElement || ev.target instanceof HTMLButtonElement) return;
    const i = current ? entryRows.indexOf(current) : -1;
    const k = ev.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      const next = entryRows[Math.max(0, Math.min(entryRows.length - 1, i + (k === "ArrowDown" ? 1 : -1)))];
      if (next) select(next);
    } else if (k === "ArrowRight" && current?.entry.kind === "folder" && !q) {
      if (!isOpen(current)) toggle(current.id);
    } else if (k === "ArrowLeft" && current && !q) {
      if (current.entry.kind === "folder" && isOpen(current)) toggle(current.id);
      else {
        // To the folder it's in.
        const parent = entryRows.slice(0, i).reverse().find((r) => r.depth < current.depth);
        if (parent) select(parent, false);
      }
    } else if (k === "Enter" && current) {
      if (current.entry.kind === "folder") toggle(current.id);
      else load(current.entry);
    } else if (k === " " && current) {
      previewEntry(current.entry);
    } else if (k === "Escape") {
      stopPreview();
    } else return;
    // Keep Space and the arrows from also playing the transport or scrolling the page.
    ev.preventDefault();
    ev.stopPropagation();
  }

  function commit(ed: Editing) {
    if (committed.current === ed) return;
    committed.current = ed;
    setEditing(null);
    const row = entryRows.find((r) => r.id === ed.id);
    if (!row) return;
    const e = row.entry;
    if (row.root) {
      const problem = folderNameProblem(ed.value, row.root.name);
      if (problem) return set({ status: problem });
      void renameFolder(row.root.name, ed.value).then(() => {
        // The folder's rows have new ids now: keep it open and selected.
        const id = `disk>folder:${rootPath(ed.value.trim())}`;
        if (toggled.has(row.id)) toggled.add(id);
        setSel(id);
      });
    } else if (e.kind === "sample" && ed.mode === "rename") renameSample(e.id, ed.value);
    else if (e.kind === "sample") moveSample(e.id, ed.value);
    else if (e.kind === "folder" && isLibFolder(e)) {
      const to = cleanFolder(ed.value);
      if (to) renameLibraryFolder(e.path, to);
    }
  }

  function menuItems(row: Extract<Row, { kind: "entry" }>): MenuItem[] {
    const e = row.entry;
    const edit = (mode: Editing["mode"], value: string) => () => setEditing({ id: row.id, mode, value });
    const pad = kind === "keys" ? "Load onto Keys" : `Load on pad ${selectedPad + 1}`;
    // A folder goes on the pads, or on a keys track becomes its multisample (its note-named samples).
    const folderTo = (path: string): MenuItem => kind === "keys"
      ? { label: "Folder → Keys multisample", run: async () => set({ status: (await folderToMulti(path, trackId)) ? `${path.split("/").pop()} is the Keys multisample` : "No note-named samples (Piano_C4) in that folder" }) }
      : { label: "Folder → pads", run: () => folderToPads(path) };
    if (row.root) {
      const r = row.root;
      return [
        ...(r.access === "prompt" ? [{ label: "Reconnect", run: () => reconnectFolder(r.name) }] : []),
        { label: "Rescan", run: () => (refreshFolder(r.name), scanFolder(r.name)) },
        { label: "Rename…", run: edit("rename", r.name) },
        folderTo(rootPath(r.name)),
        { label: "Disconnect", run: () => disconnectFolder(r.name), danger: true },
      ];
    }
    if (e.kind === "folder" && isDiskFolder(e)) {
      return [
        folderTo(e.path),
        {
          label: "Copy folder to library",
          run: async () => {
            const n = (await folderSamples(e.path)).length;
            set({ status: n ? `Copied ${n} sample${n === 1 ? "" : "s"} from ${e.name} to the library` : "No samples in that folder" });
          },
        },
      ];
    }
    if (e.kind === "preset") return [{ label: e.preset === "kit" ? "Load as the drum kit" : "Load onto Keys", run: () => load(e) }];
    if (e.kind === "file") {
      return [
        { label: pad, run: () => load(e) },
        {
          label: "Copy to library",
          run: () => fileSample(e.path).then(() => set({ status: `Copied ${e.name} to the library` }), (err: Error) => set({ status: `${e.name}: ${err.message}` })),
        },
      ];
    }
    if (e.kind === "sample") {
      const { pads, zones } = sampleUsers(e.id);
      const used = [pads && `${pads} pad${pads === 1 ? "" : "s"}`, zones && `${zones} Keys zone${zones === 1 ? "" : "s"}`].filter(Boolean).join(", ");
      return [
        { label: used ? `Used by ${used}` : "Not on any pad or zone" },
        { label: pad, run: () => load(e) },
        { label: "Rename…", run: edit("rename", e.name) },
        { label: "Move to…", run: edit("move", get().samples[e.id]?.folder ?? "") },
        { label: "Delete…", run: () => confirmDeleteSample(e.id), danger: true },
      ];
    }
    if (e.kind === "folder" && isLibFolder(e)) {
      return [
        folderTo(e.path),
        { label: "Rename…", run: edit("rename", e.path.slice(SAMPLES.length + 1)) },
        { label: "Delete folder…", run: () => confirmDeleteLibraryFolder(e.path), danger: true },
      ];
    }
    return [];
  }

  // Every library folder, for Move to….
  const libFolders = useMemo(() => {
    const all = new Set<string>();
    for (const s of Object.values(samples)) {
      const parts = (s.folder ?? "").split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
    }
    return [...all].sort();
  }, [samples]);

  const menuRow = menu && entryRows.find((r) => r.id === menu.id);

  return (
    <aside className="library" aria-label="Library" onKeyDown={onKey}>
      <Resizer />
      <div className="lib-head">
        <strong>Library</strong>
        <span className="picker-spacer" />
        {diskSupported() && !liveRoot() && (
          <button title="Ableton Live's library (Live Lite comes with the Launchkey): its drum kits and sampled instruments, read in place, for your own use"
            onClick={() => void connectLiveLibrary().then((n) => n && setSel(`disk>folder:${rootPath(n)}`))}>Ableton Live</button>
        )}
        {diskSupported() && (
          <button title="Browse a folder on this computer in place; a sample is copied in only when you use it" onClick={() => void connectFolder().then((n) => {
            if (!n) return;
            setQuery("");
            setSel(`disk>folder:${rootPath(n)}`);
            void scanFolder(n);
          })}>Connect folder…</button>
        )}
        <button className="icon-btn" aria-label="Close the library" title={native ? "Close (⌘L or B)" : "Close (B)"} onClick={() => applyLibrary(false)}>✕</button>
      </div>
      <input className="lib-search" type="search" placeholder="Search folders and library" value={query} onChange={(e) => {
        setQuery(e.target.value);
        setSel(null);
      }} onKeyDown={(e) => {
        if (e.key === "ArrowDown" && entryRows[0]) {
          e.preventDefault();
          select(entryRows[0]);
          tree.current?.focus();
        } else if (e.key === "Escape" && query) {
          e.stopPropagation();
          setQuery("");
        }
      }} />
      <ul className="lib-tree" role="tree" tabIndex={0} ref={tree} onScroll={() => setMenu(null)}>
        {rows.map((row) => row.kind === "note"
          ? <li key={row.id} className="lib-note" style={{ "--depth": row.depth } as CSSProperties}>{row.text}</li>
          : (
            <TreeRow key={row.id} row={row} selected={row.id === sel} open={row.entry.kind === "folder" && !q && isOpen(row)}
              favorite={favorites.includes(entryKey(row.entry))} scan={row.root ? scans[row.root.name] : undefined}
              editing={editing?.id === row.id ? editing : null} folders={libFolders}
              onEdit={(value) => setEditing(editing && { ...editing, value })} onCommit={() => editing && commit(editing)} onCancel={() => setEditing(null)}
              onClick={() => {
                select(row);
                if (row.entry.kind === "folder" && !q) toggle(row.id);
              }}
              onDoubleClick={() => load(row.entry)}
              onMenu={(x, y) => setMenu(menu?.id === row.id ? null : { id: row.id, x, y })}
              hasMenu={hasMenu(row)}
            />
          ))}
      </ul>
      {menuRow && menu && <RowMenu x={menu.x} y={menu.y} items={menuItems(menuRow)} onClose={() => setMenu(null)} />}
      <Info entry={current?.entry} />
      <Footer />
    </aside>
  );
}

function TreeRow({ row, selected, open, favorite, scan, editing, folders, hasMenu, onEdit, onCommit, onCancel, onClick, onDoubleClick, onMenu }: {
  row: Extract<Row, { kind: "entry" }>;
  selected: boolean;
  open: boolean;
  favorite: boolean;
  scan: number | "done" | undefined;
  editing: Editing | null;
  folders: string[];
  hasMenu: boolean;
  onEdit: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onClick: () => void;
  onDoubleClick: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const e = row.entry;
  const section = !!row.section;
  const folder = e.kind === "folder";
  const root = row.root;
  const listId = `lib-folders-${row.id}`;
  let badge: ReactNode = null;
  if (root?.access === "prompt") badge = <button onClick={(ev) => { ev.stopPropagation(); void reconnectFolder(root.name); }}>Reconnect</button>;
  else if (root?.access === "missing") badge = <button onClick={(ev) => { ev.stopPropagation(); void disconnectFolder(root.name); }} title="The folder isn't there any more">Remove</button>;
  else if (typeof scan === "number") badge = <span className="lib-badge" title="Indexing for search">{scan}…</span>;
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={folder && !row.sub ? open : undefined}
      className={`${folder ? "folder" : ""} ${section ? "section-row" : ""}`} style={{ "--depth": row.depth } as CSSProperties}
      draggable={!section && !editing} onDragStart={(ev) => dragEntry(ev.dataTransfer, e)}
      onClick={editing ? undefined : onClick} onDoubleClick={editing ? undefined : onDoubleClick}>
      <span className="picker-icon" aria-hidden>{folder ? (open ? "▾" : "▸") : e.kind === "preset" ? (e.preset === "kit" ? "▦" : "♫") : "♪"}</span>
      {editing ? (
        <>
          <input className="lib-edit" autoFocus value={editing.value} list={editing.mode === "move" || folder ? listId : undefined}
            placeholder={editing.mode === "move" ? "Folder, e.g. Drums/Kicks (empty: top)" : "Name"}
            onChange={(ev) => onEdit(ev.target.value)} onBlur={onCommit} onClick={(ev) => ev.stopPropagation()}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === "Enter") onCommit();
              else if (ev.key === "Escape") onCancel();
            }} />
          {(editing.mode === "move" || folder) && <datalist id={listId}>{folders.map((f) => <option key={f} value={f} />)}</datalist>}
        </>
      ) : (
        <span className="lib-name">
          <span className="picker-name">{e.name}</span>
          {row.sub && <span className="lib-sub">{row.sub}</span>}
        </span>
      )}
      {badge}
      {!section && !editing && (
        <button className={`lib-star ${favorite ? "on-star" : ""}`} aria-label={favorite ? `Unstar ${e.name}` : `Star ${e.name}`} aria-pressed={favorite}
          title={favorite ? "Remove from Favorites" : "Add to Favorites"} onClick={(ev) => { ev.stopPropagation(); toggleFavorite(e); }}>{favorite ? "★" : "☆"}</button>
      )}
      {hasMenu && !editing && (
        <button className="lib-more" aria-label={`More for ${e.name}`} title="More" onClick={(ev) => {
          ev.stopPropagation();
          const r = ev.currentTarget.getBoundingClientRect();
          onMenu(r.right, r.bottom);
        }}>⋯</button>
      )}
    </li>
  );
}

/** A row's actions, hanging from its ⋯ button; a click outside or Esc closes it. */
function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close.current();
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close.current();
    // After the click that opened it.
    const t = window.setTimeout(() => window.addEventListener("pointerdown", down));
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const h = items.length * 26 + 8;
  const style: CSSProperties = { right: Math.max(8, window.innerWidth - x), top: y + h < window.innerHeight ? y + 2 : Math.max(8, y - h - 24) };
  return (
    <div className="lib-menu" role="menu" ref={box} style={style}>
      {items.map((it) => it.run
        ? <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} onClick={() => {
          onClose();
          void it.run!();
        }}>{it.label}</button>
        : <span key={it.label} className="lib-menu-note">{it.label}</span>)}
    </div>
  );
}

/** Drag the drawer's left edge to make it wider or narrower. */
function Resizer() {
  return (
    <div className="lib-resize" aria-hidden onPointerDown={(e) => {
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => applyDrawerWidth(window.innerWidth - ev.clientX, false);
      const up = (ev: PointerEvent) => {
        applyDrawerWidth(window.innerWidth - ev.clientX);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    }} />
  );
}

/** The selected sample or file: its waveform, length and format. */
function Info({ entry }: { entry: Entry | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useApp((s) => s.theme);
  const key = entry && canLoad(entry) ? entryKey(entry) : "";
  const [info, setInfo] = useState<{ key: string; buffer?: AudioBuffer; size?: number; error?: string } | null>(null);

  useEffect(() => {
    // What's drawn is matched by key, so nothing needs clearing.
    if (!entry || !key) return;
    let live = true;
    // Not on every row arrowed past: a file is decoded to be drawn.
    const t = window.setTimeout(() => {
      const got = entry.kind === "sample"
        ? engine.ensure(entry.id).then((buffer) => ({ buffer, error: buffer ? undefined : "Can't load it" }))
        : entry.kind === "file" ? fileDetails(entry.path) : Promise.resolve({});
      got.then((r) => live && setInfo({ key, ...r }), (err: Error) => live && setInfo({ key, error: err.message }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const buffer = info?.key === key ? info.buffer : undefined;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    drawWaveBg(g, css, w, h, dpr);
    if (!buffer) return;
    const d = buffer.getChannelData(0);
    drawPeaks(g, d, 0, d.length, w, h, css.getPropertyValue("--wave-fg") || "#4cf");
  }, [buffer, theme]);

  if (!key || !entry) return <div className="lib-info empty"><span className="hint">Select a sample or file to see it here.</span></div>;
  const here = info?.key === key ? info : null;
  const facts = [
    buffer && `${buffer.duration < 10 ? buffer.duration.toFixed(2) : buffer.duration.toFixed(1)} s`,
    buffer && `${(buffer.sampleRate / 1000).toFixed(1)} kHz`,
    buffer && (buffer.numberOfChannels === 1 ? "mono" : buffer.numberOfChannels === 2 ? "stereo" : `${buffer.numberOfChannels} ch`),
    here?.size !== undefined && bytes(here.size),
  ].filter(Boolean).join(" · ");
  return (
    <div className="lib-info">
      <canvas ref={canvas} className="lib-wave" />
      <div className="lib-facts">
        <span className="picker-name" title={entry.name}>{entry.name}</span>
        <span className="hint">{here?.error ?? (facts || (here ? "Too big to draw" : "Loading…"))}</span>
      </div>
    </div>
  );
}

/** How big the library is, and clearing out what nothing uses. */
function Footer() {
  const count = useApp((s) => Object.keys(s.samples).length);
  const [usage, setUsage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Whole site: samples, projects, kits. Unavailable in some browsers.
    navigator.storage?.estimate?.().then((e) => setUsage(e.usage ?? null), () => undefined);
  }, [count]);
  return (
    <div className="lib-foot">
      <span className="hint" title="Samples you use are copied into Morsel's own storage; connected folders are read in place">
        {count} sample{count === 1 ? "" : "s"}{usage !== null && ` · ${bytes(usage)}`}
      </span>
      <span className="picker-spacer" />
      <button disabled={busy || !count} title="Delete samples no track, undo step or saved kit uses" onClick={async () => {
        setBusy(true);
        await removeUnusedSamples().finally(() => setBusy(false));
      }}>Remove unused…</button>
    </div>
  );
}
