import { useEffect } from "react";
import { answer } from "../state/confirm";
import { useApp } from "../state/store";

/** The in-app confirmation dialog (state/confirm.ts). Esc or the backdrop cancels. */
export function ConfirmDialog() {
  const req = useApp((s) => s.confirm);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && answer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="g-overlay" onClick={() => answer(false)}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{req.title}</h2>
        <p id="confirm-msg">{req.message}</p>
        <div className="confirm-buttons">
          {/* Destructive: Enter shouldn't go ahead by accident, so Cancel has the focus. */}
          <button autoFocus={req.danger} onClick={() => answer(false)}>Cancel</button>
          <button autoFocus={!req.danger} className={req.danger ? "primary danger" : "primary"} onClick={() => answer(true)}>{req.ok}</button>
        </div>
      </div>
    </div>
  );
}
