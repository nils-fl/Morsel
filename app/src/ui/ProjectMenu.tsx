// The Project menu in the header: the project's name, export, import and New project, and where the samples live.
// Esc or a click outside closes it.
import { useEffect, useRef, useState } from "react";
import { engine } from "../audio/engine";
import { download } from "../seq/render";
import { PROJECT_ACCEPT, PROJECT_EXT } from "../state/fileFormat";
import { exportProject, importProject, newProject } from "../state/projectFile";
import { get, set, updateProject, useApp } from "../state/store";

export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const name = useApp((s) => s.project.name);
  const count = useApp((s) => Object.keys(s.samples).length);
  const box = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

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
      <button className={open ? "on" : ""} onClick={() => setOpen(!open)} aria-expanded={open} title="Name, export, import or start a new project">Project</button>
      {open && (
        <div className="menu-panel" role="dialog" aria-label="Project">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => updateProject((p) => ({ ...p, name: e.target.value }), false)} />
          </label>
          <div className="menu-actions">
            <button onClick={async () => download(await exportProject(), `${get().project.name}${PROJECT_EXT}`)} title="One file with the patterns and every sample">Export…</button>
            <button onClick={() => importInput.current?.click()}>Import…</button>
            <button onClick={() => { setOpen(false); void newProject(); }} title="Start over with the Factory kit (asks first)">New…</button>
          </div>
          <input ref={importInput} type="file" accept={PROJECT_ACCEPT} hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setOpen(false);
            try {
              await importProject(f, engine);
            } catch (err) {
              set({ status: `Project import failed: ${(err as Error).message}` });
            }
          }} />
          <p className="hint">
            Autosaves in this browser, with its {count} sample{count === 1 ? "" : "s"}. Clearing the site's data deletes them along with
            the project, so export projects you want to keep. For big sample packs, connect a folder in the Library instead of importing.
          </p>
        </div>
      )}
    </div>
  );
}
