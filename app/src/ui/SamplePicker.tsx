// Sample picker: the sample's name on a fixed-width button, opening a small folder browser over the library and the
// connected folders (the same tree Browse shows on the Launchkey). Click listens, double-click or Load uses it.
// A folder action ("Folder → pads", "Use this folder") works on the folder that's open.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { DISK, connectFolder, diskSupported, disconnectFolder, isDiskPath, reconnectFolder, rootPath } from "../browse/disk";
import { entrySample, isSampleFolder, listAt, previewEntry, stopPreview } from "../browse/source";
import { ROOT, SAMPLES, parentOf, type Entry } from "../browse/tree";
import { set, useApp } from "../state/store";
import type { SampleInfo } from "../state/types";

const W = 320, H = 380;

// Where the picker opens when the sample gives no better place.
let lastPath = SAMPLES;

/** The folder a sample came from: its connected folder when it's still there, else its library folder. */
function startPath(info: SampleInfo | undefined, connected: string[]) {
  const inRoot = (path: string) => connected.includes(path.slice(DISK.length).split("/")[0]);
  if (!info) return isDiskPath(lastPath) && !inRoot(lastPath) ? SAMPLES : lastPath;
  if (info.src && inRoot(info.src)) return parentOf(info.src);
  return info.folder ? `${SAMPLES}/${info.folder}` : SAMPLES;
}

const keyOf = (e: Entry) => `${e.kind}:${e.kind === "sample" ? e.id : e.kind === "kit" ? e.name : e.path}`;

/** Something to do with the open folder; `only` hides Load, so the picker picks folders. */
export interface FolderAction { label: string; title?: string; only?: boolean; run: (path: string) => Promise<void> }

export function SamplePicker({ value, onPick = () => undefined, allowNone = false, placeholder = "—", folderAction }: {
  value: string | null;
  onPick?: (id: string | null) => void;
  allowNone?: boolean;
  placeholder?: string;
  folderAction?: FolderAction;
}) {
  const info = useApp((s) => (value ? s.samples[value] : undefined));
  const folders = useApp((s) => s.folders);
  // The button the panel hangs from while it's open.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="sample-pick" aria-expanded={!!anchor} title={info ? [info.folder, info.name].filter(Boolean).join(" / ") : undefined}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <span>{info?.name ?? (value ? "Sample" : placeholder)}</span>
        <span aria-hidden>▾</span>
      </button>
      {anchor && (
        <PickerPanel
          anchor={anchor}
          start={startPath(info, folders.map((f) => f.name))}
          allowNone={allowNone}
          folderAction={folderAction}
          onClose={() => setAnchor(null)}
          onPick={(id) => {
            setAnchor(null);
            onPick(id);
          }}
        />
      )}
    </>
  );
}

function PickerPanel({ anchor, start, allowNone, folderAction, onPick, onClose }: {
  anchor: HTMLElement;
  start: string;
  allowNone: boolean;
  folderAction?: FolderAction;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(start);
  const [sel, setSel] = useState(-1);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // listAt reads the store: re-render when what it depends on changes.
  useApp((s) => s.samples);
  useApp((s) => s.diskTick);
  const folders = useApp((s) => s.folders);
  const listing = listAt(path, null);
  const q = filter.trim().toLowerCase();
  const items = q ? listing.entries.filter((e) => e.name.toLowerCase().includes(q)) : listing.entries;
  const current = items[sel] as Entry | undefined;

  // A click outside closes it; closing stops the preview. (onClose is a new function every render.)
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.contains(t)) close.current();
    };
    window.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("pointerdown", down);
      stopPreview();
    };
  }, [anchor]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => {
    lastPath = path;
  }, [path]);

  const go = (p: string) => {
    setPath(p);
    setSel(-1);
    setFilter("");
  };

  const select = (i: number) => {
    setSel(i);
    previewEntry(items[i]);
  };

  async function take(e: Entry | undefined) {
    if (!e) return;
    if (e.kind === "folder") return go(e.path);
    setBusy(true);
    try {
      onPick(await entrySample(e));
    } catch (err) {
      set({ status: `${e.name}: ${(err as Error).message}` });
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) select(Math.max(0, Math.min(items.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void take(current);
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && !filter && path !== ROOT) {
      e.preventDefault();
      go(parentOf(path));
    } else if (e.key === "ArrowRight" && current?.kind === "folder") {
      e.preventDefault();
      go(current.path);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  // Below the button, or above it when there's no room; never off the side of the window.
  const r = anchor.getBoundingClientRect();
  const style: CSSProperties = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
    top: r.bottom + 4 + H < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - 4 - H),
  };
  const access = (e: Entry) => (e.kind === "folder" && isDiskPath(e.path) && !e.path.includes("/") ? folders.find((f) => rootPath(f.name) === e.path) : undefined);

  return createPortal(
    <div className="picker" ref={panel} style={style} onKeyDown={onKey}>
      <div className="picker-head">
        <button disabled={path === ROOT} onClick={() => go(parentOf(path))} aria-label="Up one folder" title="Up one folder (←)">↑</button>
        <span className="picker-path" title={path.replace(DISK, "")}>{path ? path.replace(DISK, "") : "All sources"}</span>
      </div>
      <input className="picker-filter" placeholder="Filter this folder" value={filter} autoFocus onChange={(e) => {
        setFilter(e.target.value);
        setSel(-1);
      }} />
      <ul className="picker-list" role="listbox" ref={list}>
        {items.map((e, i) => {
          const root = access(e);
          return (
            <li key={keyOf(e)} role="option" aria-selected={i === sel} className={e.kind === "folder" ? "folder" : ""}
              onClick={() => (e.kind === "folder" ? go(e.path) : select(i))} onDoubleClick={() => void take(e)}>
              <span className="picker-icon" aria-hidden>{e.kind === "folder" ? "▸" : "♪"}</span>
              <span className="picker-name">{e.name}</span>
              {root && root.access !== "granted" && (
                <button onClick={(ev) => {
                  ev.stopPropagation();
                  if (root.access === "prompt") void reconnectFolder(root.name);
                  else void disconnectFolder(root.name);
                }}>{root.access === "prompt" ? "Reconnect" : "Remove"}</button>
              )}
              {root?.access === "granted" && (
                <button className="picker-x" aria-label={`Disconnect ${root.name}`} title="Disconnect (samples you used stay in the library)" onClick={(ev) => {
                  ev.stopPropagation();
                  void disconnectFolder(root.name);
                }}>✕</button>
              )}
            </li>
          );
        })}
        {!items.length && <li className="picker-note">{listing.note ?? (q ? "No match" : "Empty folder")}</li>}
      </ul>
      <div className="picker-foot">
        {path === ROOT && diskSupported() && (
          <button title="Browse a folder on this computer in place; a sample is copied in only when you use it" onClick={() => void connectFolder().then((n) => n && go(rootPath(n)))}>Connect folder…</button>
        )}
        {allowNone && <button onClick={() => onPick(null)}>None</button>}
        <span className="picker-spacer" />
        {folderAction && (
          <button className={folderAction.only ? "primary" : ""} title={folderAction.title} disabled={busy || !isSampleFolder(path)} onClick={async () => {
            setBusy(true);
            await folderAction.run(path).finally(() => setBusy(false));
            onClose();
          }}>{folderAction.label}</button>
        )}
        {!folderAction?.only && (
          <button className="primary" disabled={busy || !current || current.kind === "folder"} onClick={() => void take(current)}>{busy ? "Loading…" : "Load"}</button>
        )}
      </div>
    </div>,
    document.body,
  );
}
