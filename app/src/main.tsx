import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { boot } from "./boot";
import { applyTheme, savedTheme } from "./ui/theme";
import { applyTips, savedTips } from "./ui/tips";

// Before anything renders, so a light page doesn't flash dark.
applyTheme(savedTheme());
applyTips(savedTips());

// Offline start and installing as an app (sw.js, written by the build). Not in dev, where it would serve stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("Morsel: no offline support", err));
  });
}

const root = document.getElementById("root")!;

boot().then(
  () => {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  },
  (err: unknown) => {
    // Usually IndexedDB being unavailable (private window, blocked site data, full disk).
    console.error("Morsel failed to start", err);
    const box = document.createElement("div");
    box.className = "boot-error";
    const title = document.createElement("strong");
    title.textContent = "Morsel couldn't start";
    const msg = document.createElement("p");
    msg.textContent = `${err instanceof Error ? err.message : String(err)}. Morsel stores samples and projects in the browser's storage (IndexedDB). Private windows or blocked site data can prevent that. Use a normal Chrome window and reload.`;
    box.append(title, msg);
    root.replaceChildren(box);
  },
);
