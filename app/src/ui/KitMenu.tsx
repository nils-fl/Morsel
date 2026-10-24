// The drum track's kit, in the bar over the pads: pick or step through kits (like the Keys presets; Launchkey: encoder
// page Kit, encoder 1), and a Kits… menu to save, rename, import, export and delete your own. Esc or a click outside
// closes the menu.
import { useEffect, useRef, useState } from "react";
import { deleteSavedKit, kitNames, loadNamedKit, renameSavedKit, saveCurrentKit, stepKit } from "../actions";
import { engine } from "../audio/engine";
import { download } from "../seq/render";
import { KIT_ACCEPT, KIT_EXT } from "../state/fileFormat";
import { exportKit, importKit } from "../state/projectFile";
import { drumPads, drumTrack, set, useApp } from "../state/store";
import { STOCK_KITS } from "../state/types";

export function KitPicker() {
  const kit = useApp((s) => drumTrack(s).kit);
  useApp((s) => s.kits); // re-render when kits are saved or deleted
  const list = kitNames();
  const saved = list.slice(STOCK_KITS.length);
  const at = list.indexOf(kit);
  return (
    <div className="kit-picker" role="group" aria-label="Kit">
      <span className="tool-label">Kit</span>
      <button onClick={() => stepKit(-1)} disabled={at === 0} aria-label="Previous kit">◀</button>
      <select value={at >= 0 ? kit : ""} title="Load a kit onto this drum track (Undo brings the pads back). Built-in kits are synthesized; your saved kits follow them." onChange={(e) => e.target.value && void loadNamedKit(e.target.value)}>
        {at < 0 && <option value="">{kit || "—"}</option>}
        <optgroup label="Built-in">{STOCK_KITS.map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>
        {saved.length > 0 && <optgroup label="Saved">{saved.map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>}
      </select>
      <button onClick={() => stepKit(1)} disabled={at >= list.length - 1} aria-label="Next kit">▶</button>
      <KitMenu />
    </div>
  );
}

function KitMenu() {
  const [open, setOpen] = useState(false);
  const kit = useApp((s) => drumTrack(s).kit);
  const kits = useApp((s) => s.kits);
  const [name, setName] = useState("");
  // The saved kit last picked here: the one Rename renames.
  const [picked, setPicked] = useState<string | null>(null);
  const canRename = !!picked && kits.includes(picked) && !!name.trim() && name.trim() !== picked;
  const box = useRef<HTMLDivElement>(null);
  const kitInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={box}>
      <button className={open ? "on" : ""} onClick={() => setOpen(!open)} aria-expanded={open} title="Save, rename, import, export or delete kits">Kits…</button>
      <input ref={kitInput} type="file" accept={KIT_ACCEPT} multiple hidden onChange={async (e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        const failed: string[] = [];
        let last = "";
        for (const f of files) {
          try {
            last = await importKit(f, engine);
          } catch (err) {
            failed.push(`${f.name}: ${(err as Error).message}`);
          }
        }
        const ok = files.length - failed.length;
        if (files.length > 1 || failed.length) {
          set({ status: `Imported ${ok} kit${ok === 1 ? "" : "s"}${ok ? ` (${last} is on the pads)` : ""}${failed.length ? ` · failed: ${failed.join("; ")}` : ""}` });
        }
      }} />
      {open && (
        <div className="menu-panel" role="dialog" aria-label="Kits">
          <div className="row">
            <input placeholder="Save the pads as…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Kit name" />
            {/* Save and Rename show once they can do something: a name typed, and for Rename a saved kit picked below. */}
            {name.trim() && <button onClick={() => void saveCurrentKit(name)}>Save</button>}
            {canRename && <button title={`Rename “${picked}” to the name typed here`} onClick={async () => {
              if (picked && (await renameSavedKit(picked, name))) setPicked(name.trim());
            }}>Rename</button>}
          </div>
          <div className="menu-actions">
            <button onClick={() => kitInput.current?.click()} title="Import one or more .morsel-kit files">Import…</button>
            <button title="Save the pads as a kit file with their samples, to share or keep (named as typed above, or after the kit)" onClick={() => {
              const file = name.trim() || kit || "Kit";
              void exportKit(file, drumPads()).then((blob) => download(blob, `${file}${KIT_EXT}`));
            }}>Export…</button>
          </div>
          {kits.length > 0 && <>
            <h4 className="sub-head">Saved kits</h4>
            <div className="row wrap">
              {kits.map((k) => (
                <span key={k} className="kit-chip">
                  <button className={k === picked ? "on" : ""} onClick={() => { setName(k); setPicked(k); void loadNamedKit(k); }}>{k}</button>
                  <button onClick={() => void deleteSavedKit(k)} aria-label={`Delete kit ${k}`} title="Delete this kit">✕</button>
                </span>
              ))}
            </div>
          </>}
          <p className="hint">
            ◀ ▶ load the previous / next kit. Launchkey: encoder page <b>Kit</b>, encoder 1 scrolls the kits; Shift + Encoder ⌃ →
            Kits. On a sample folder, Shift + Function puts it on the pads.
          </p>
        </div>
      )}
    </div>
  );
}
