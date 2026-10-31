// The helper screen: the 800x480 picture the screen box will show, over the whole window at the largest 5:3 size that
// fits, so it's always completely visible. Played with the Launchkey; the app behind it is for settings. Drawn in the
// screen's own coordinates and scaled up sharp. Clicks and drags on it are its touches (helper/input.ts).
import { useEffect, useRef } from "react";
import { drawHelper } from "../helper/draw";
import { helperCancel, helperPointer, helperShown, helperWheel } from "../helper/input";
import { SH, SW } from "../helper/layout";
import { buildView } from "../helper/view";
import { applyHelperScreen } from "./helperToggle";

const WHEEL_PX = 40;

export function HelperScreen() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    // The largest 5:3 box in the window; the canvas's own pixels match the screen's, so it stays sharp.
    const fit = () => {
      const w = Math.min(window.innerWidth, (window.innerHeight * SW) / SH);
      const dpr = window.devicePixelRatio || 1;
      c.style.width = `${w}px`;
      c.style.height = `${(w * SH) / SW}px`;
      c.width = Math.round(w * dpr);
      c.height = Math.round(((w * SH) / SW) * dpr);
    };
    fit();
    window.addEventListener("resize", fit);
    // The Launchkey's screen updates about 30 times a second (the controller's render loop); so does this one.
    let raf = 0, last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 30 && !dragging.current) return;
      last = now;
      const v = buildView();
      helperShown(v);
      g.setTransform(c.width / SW, 0, 0, c.height / SH, 0, 0);
      drawHelper(g, v);
    };
    raf = requestAnimationFrame(tick);

    // Not a React onWheel: that one is passive, and the page would scroll too.
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc -= (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
      const d = Math.trunc(acc / WHEEL_PX);
      acc -= d * WHEEL_PX;
      if (!d) return;
      const [x, y] = toScreen(c, e.clientX, e.clientY);
      helperWheel(x, y, d, e.shiftKey);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(raf);
      c.removeEventListener("wheel", onWheel);
      helperCancel();
    };
  }, []);

  const pointer = (phase: "down" | "move" | "up") => (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (phase === "down") {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
    } else if (!dragging.current) return;
    if (phase === "up") dragging.current = false;
    const [x, y] = toScreen(e.currentTarget, e.clientX, e.clientY);
    helperPointer(phase, x, y, e.shiftKey);
  };

  return (
    <div className="helper-overlay" role="dialog" aria-label="Helper screen">
      <canvas
        ref={canvas}
        className="helper-screen"
        onPointerDown={pointer("down")}
        onPointerMove={pointer("move")}
        onPointerUp={pointer("up")}
        onPointerCancel={() => {
          dragging.current = false;
          helperCancel();
        }}
      />
      <button className="helper-close" onClick={() => applyHelperScreen(false)} title="Back to the app (Esc, H)" aria-label="Close the helper screen">×</button>
    </div>
  );
}

/** Client coordinates to the screen's own 800x480 pixels. */
function toScreen(c: HTMLCanvasElement, clientX: number, clientY: number): [number, number] {
  const r = c.getBoundingClientRect();
  return [((clientX - r.left) / r.width) * SW, ((clientY - r.top) / r.height) * SH];
}
