// Questions before destructive steps, asked in the app's own dialog (ui/ConfirmDialog.tsx) rather than the
// browser's confirm(), which looks foreign and blocks the page.
import { set, type ConfirmRequest } from "./store";

let pending: ((ok: boolean) => void) | null = null;

/** Show the dialog; resolves true when the user goes ahead. A newer question cancels an open one. */
export function ask(req: ConfirmRequest): Promise<boolean> {
  pending?.(false);
  set({ confirm: req });
  return new Promise((resolve) => (pending = resolve));
}

/** The dialog's answer (its buttons, Esc, the backdrop). */
export function answer(ok: boolean) {
  const resolve = pending;
  pending = null;
  set({ confirm: null });
  resolve?.(ok);
}
